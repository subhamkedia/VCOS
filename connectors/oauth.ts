import { createHash, randomBytes } from "node:crypto";
import { config, requireKey, setting } from "../lib/config.js";
import { sha256 } from "../lib/text.js";
import { requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * OAuth for Google Workspace and Microsoft 365, used three ways:
 *
 * 1. Sign-in to VC OS (openid email profile).
 * 2. Connecting a mailbox or Drive: the person consents in the browser and
 *    the refresh token is stored encrypted on the firm's connection.
 * 3. Refreshing access tokens for connector calls.
 *
 * The app's client id and secret are platform settings (one registration
 * for all firms). Refresh tokens belong to one firm's connection.
 *
 * Scopes are read-only plus drafts. No connector calls a send endpoint.
 */

export type Provider = "google" | "microsoft";

export const SCOPES = {
  signin: { google: ["openid", "email", "profile"], microsoft: ["openid", "email", "profile", "User.Read"] },
  gmail: { google: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] },
  gdrive: { google: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"] },
  outlook: { microsoft: ["openid", "email", "offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite"] },
} as const;

const REFRESH_KEY = { google: "googleRefreshToken", microsoft: "msRefreshToken" } as const;

// Access tokens by provider and refresh token (hashed), so two firms never share one.
const cache = new Map<string, { token: string; expiresAt: number }>();

const tenant = () => encodeURIComponent(setting("msTenant") || "common");
const tokenUrl = (p: Provider) => (p === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`);

function clientParams(p: Provider) {
  return p === "google"
    ? { client_id: requireKey("googleClientId"), client_secret: requireKey("googleClientSecret") }
    : { client_id: requireKey("msClientId"), client_secret: requireKey("msClientSecret") };
}

/** A valid access token for the current firm's connection, refreshed a minute before it expires. */
export async function accessToken(provider: Provider, fetchImpl?: FetchLike): Promise<string> {
  const refresh = requireKey(REFRESH_KEY[provider]);
  const key = `${provider}:${sha256(refresh)}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, ...clientParams(provider) });
  if (provider === "microsoft") body.set("scope", SCOPES.outlook.microsoft.join(" "));
  const res = await requestJson<{ access_token?: string; expires_in?: number }>(`${provider} oauth`, tokenUrl(provider), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, fetchImpl,
  });
  if (!res.access_token) throw new Error(`${provider} oauth: no access_token in response`);
  cache.set(key, { token: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000 });
  return res.access_token;
}

export function clearTokenCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Browser flows: authorization code with PKCE
// ---------------------------------------------------------------------------

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function providerConfigured(p: Provider): boolean {
  return p === "google" ? Boolean(config.googleClientId && config.googleClientSecret) : Boolean(config.msClientId && config.msClientSecret);
}

/** Where to send the browser. `offline` asks for a refresh token (connections, not sign-in). */
export function authorizeUrl(p: Provider, o: { scopes: readonly string[]; state: string; challenge: string; redirectUri: string; offline: boolean; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: clientParams(p).client_id,
    response_type: "code",
    redirect_uri: o.redirectUri,
    scope: o.scopes.join(" "),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  if (o.loginHint) q.set("login_hint", o.loginHint);
  if (p === "google") {
    if (o.offline) {
      q.set("access_type", "offline");
      q.set("prompt", "consent");
    } else q.set("prompt", "select_account");
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  q.set("response_mode", "query");
  if (!o.offline) q.set("prompt", "select_account");
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?${q}`;
}

export interface CodeExchange {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
}

export async function exchangeCode(p: Provider, o: { code: string; verifier: string; redirectUri: string; scopes: readonly string[] }, fetchImpl?: FetchLike): Promise<CodeExchange> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, ...clientParams(p) });
  if (p === "microsoft") body.set("scope", o.scopes.join(" "));
  const res = await requestJson<{ access_token?: string; refresh_token?: string; scope?: string }>(`${p} oauth`, tokenUrl(p), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, fetchImpl,
  });
  if (!res.access_token) throw new Error(`${p} oauth: no access_token in response`);
  return { accessToken: res.access_token, refreshToken: res.refresh_token, scope: res.scope };
}

export interface Identity {
  provider: Provider;
  subject: string; // stable provider id: Google `sub`, Microsoft `tid:oid`
  email: string;
  name?: string;
}

/**
 * Who signed in. Google: the verified email from userinfo. Microsoft: the
 * user principal name, which the tenant controls, not the editable `mail`
 * attribute (so a tenant admin can't impersonate an outside address).
 */
export async function identity(p: Provider, accessTokenValue: string, fetchImpl?: FetchLike): Promise<Identity> {
  const headers = { Authorization: `Bearer ${accessTokenValue}` };
  if (p === "google") {
    const u = await requestJson<{ sub?: string; email?: string; email_verified?: boolean; name?: string }>(
      "google userinfo", "https://openidconnect.googleapis.com/v1/userinfo", { headers, fetchImpl },
    );
    if (!u.sub || !u.email || u.email_verified !== true) throw new Error("Google did not return a verified email address.");
    return { provider: p, subject: u.sub, email: u.email.toLowerCase(), name: u.name };
  }
  const me = await requestJson<{ id?: string; userPrincipalName?: string; displayName?: string }>(
    "microsoft graph", "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,displayName", { headers, fetchImpl },
  );
  const upn = me.userPrincipalName?.toLowerCase();
  if (!me.id || !upn || !upn.includes("@") || upn.includes("#ext#")) throw new Error("Microsoft did not return a usable work account.");
  return { provider: p, subject: me.id, email: upn, name: me.displayName };
}

export const googleConfigured = () => Boolean(setting("googleClientId") && setting("googleClientSecret") && setting("googleRefreshToken"));
export const microsoftConfigured = () => Boolean(setting("msClientId") && setting("msClientSecret") && setting("msRefreshToken"));
