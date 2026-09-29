import { createHash, randomBytes } from "node:crypto";
import { config, requireKey, rotateCredential, setting, type ConfigKey } from "../lib/config.js";
import { sha256 } from "../lib/text.js";
import { requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * OAuth for Google Workspace, Microsoft 365 and Zoom, used three ways:
 *
 * 1. Sign-in to VC OS (Google and Microsoft: openid email profile).
 * 2. Connecting a firm's tools. One consent can cover several products
 *    (Gmail, Drive, Calendar and Meet are one Google consent), and adding a
 *    product later asks only for the new scopes: Google's incremental
 *    authorization (include_granted_scopes) keeps the earlier grants on the
 *    same refresh token. The token is stored encrypted on the firm's
 *    connections.
 * 3. Refreshing access tokens for connector calls. Providers that rotate
 *    refresh tokens (Zoom, Microsoft) hand back a new one; it's saved for
 *    the firm through `rotateCredential`.
 *
 * The app's client ids and secrets are platform settings (one registration
 * for all firms). Refresh tokens belong to one firm's connection.
 *
 * Scopes are read-only plus drafts. No connector calls a send endpoint.
 */

export type Provider = "google" | "microsoft" | "zoom";

export const PROVIDER_NAMES: Record<Provider, string> = { google: "Google", microsoft: "Microsoft", zoom: "Zoom" };

export const SCOPES = {
  signin: { google: ["openid", "email", "profile"], microsoft: ["openid", "email", "profile", "User.Read"] },
} as const;

export const REFRESH_KEY = { google: "googleRefreshToken", microsoft: "msRefreshToken", zoom: "zoomRefreshToken" } as const satisfies Record<Provider, ConfigKey>;

// Access tokens by provider and refresh token (hashed), so two firms never share one.
const cache = new Map<string, { token: string; expiresAt: number }>();

const tenant = () => encodeURIComponent(setting("msTenant") || "common");
const tokenUrl = (p: Provider) =>
  p === "google" ? "https://oauth2.googleapis.com/token"
  : p === "zoom" ? "https://zoom.us/oauth/token"
  : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;

function clientParams(p: Provider) {
  if (p === "google") return { client_id: requireKey("googleClientId"), client_secret: requireKey("googleClientSecret") };
  if (p === "zoom") return { client_id: requireKey("zoomClientId"), client_secret: requireKey("zoomClientSecret") };
  return { client_id: requireKey("msClientId"), client_secret: requireKey("msClientSecret") };
}

/** Zoom wants the client credentials as HTTP Basic auth; Google and Microsoft take them in the body. */
function tokenRequest(p: Provider, fields: Record<string, string>): { headers: Record<string, string>; body: URLSearchParams } {
  const { client_id, client_secret } = clientParams(p);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (p === "zoom") {
    headers.Authorization = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString("base64")}`;
    return { headers, body: new URLSearchParams(fields) };
  }
  return { headers, body: new URLSearchParams({ ...fields, client_id, client_secret }) };
}

/** A valid access token for the current firm's connection, refreshed a minute before it expires. */
export async function accessToken(provider: Provider, fetchImpl?: FetchLike): Promise<string> {
  const refresh = requireKey(REFRESH_KEY[provider]);
  const key = `${provider}:${sha256(refresh)}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const fields: Record<string, string> = { grant_type: "refresh_token", refresh_token: refresh };
  // `.default` asks for every Graph permission this firm has consented to, so one token serves mail, calendar and Teams.
  if (provider === "microsoft") fields.scope = "https://graph.microsoft.com/.default offline_access";
  const { headers, body } = tokenRequest(provider, fields);
  const res = await requestJson<{ access_token?: string; expires_in?: number; refresh_token?: string }>(`${provider} oauth`, tokenUrl(provider), {
    method: "POST", headers, body, fetchImpl,
  });
  if (!res.access_token) throw new Error(`${provider} oauth: no access_token in response`);
  const expiresAt = Date.now() + (res.expires_in ?? 3600) * 1000;
  if (res.refresh_token && res.refresh_token !== refresh) {
    await rotateCredential(REFRESH_KEY[provider], res.refresh_token);
    cache.set(`${provider}:${sha256(res.refresh_token)}`, { token: res.access_token, expiresAt });
  }
  cache.set(key, { token: res.access_token, expiresAt });
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
  if (p === "google") return Boolean(config.googleClientId && config.googleClientSecret);
  if (p === "zoom") return Boolean(config.zoomClientId && config.zoomClientSecret);
  return Boolean(config.msClientId && config.msClientSecret);
}

/** Where to send the browser. `offline` asks for a refresh token (connections, not sign-in). */
export function authorizeUrl(p: Provider, o: { scopes: readonly string[]; state: string; challenge: string; redirectUri: string; offline: boolean; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: clientParams(p).client_id,
    response_type: "code",
    redirect_uri: o.redirectUri,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  // Zoom scopes are set on the app registration, not per request.
  if (p !== "zoom") q.set("scope", o.scopes.join(" "));
  if (o.loginHint && p !== "zoom") q.set("login_hint", o.loginHint);
  if (p === "zoom") return `https://zoom.us/oauth/authorize?${q}`;
  if (p === "google") {
    if (o.offline) {
      q.set("access_type", "offline");
      q.set("prompt", "consent");
      q.set("include_granted_scopes", "true");
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
  const fields: Record<string, string> = { grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier };
  if (p === "microsoft") fields.scope = o.scopes.join(" ");
  const { headers, body } = tokenRequest(p, fields);
  const res = await requestJson<{ access_token?: string; refresh_token?: string; scope?: string }>(`${p} oauth`, tokenUrl(p), {
    method: "POST", headers, body, fetchImpl,
  });
  if (!res.access_token) throw new Error(`${p} oauth: no access_token in response`);
  return { accessToken: res.access_token, refreshToken: res.refresh_token, scope: res.scope };
}

/**
 * Scopes a connector asked for that the person didn't grant. Google lets
 * people untick individual permissions on the consent screen, so a
 * connection can come back narrower than requested.
 */
export function missingScopes(requested: readonly string[], granted: string | undefined): string[] {
  if (granted === undefined) return [];
  const have = new Set(granted.split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase()));
  const aliases: Record<string, string[]> = {
    email: ["https://www.googleapis.com/auth/userinfo.email"],
    profile: ["https://www.googleapis.com/auth/userinfo.profile"],
  };
  const ignore = new Set(["openid", "offline_access"]);
  return requested.filter((r) => {
    const x = r.toLowerCase();
    if (ignore.has(x) || have.has(x)) return false;
    if (aliases[x]?.some((a) => have.has(a))) return false;
    // Microsoft reports Graph scopes with the resource prefix.
    return !have.has(`https://graph.microsoft.com/${x}`);
  });
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
  if (p === "zoom") {
    const z = await requestJson<{ id?: string; email?: string; display_name?: string; first_name?: string; last_name?: string }>(
      "zoom", "https://api.zoom.us/v2/users/me", { headers, fetchImpl },
    );
    if (!z.id || !z.email) throw new Error("Zoom did not return an account email.");
    return { provider: p, subject: z.id, email: z.email.toLowerCase(), name: z.display_name ?? ([z.first_name, z.last_name].filter(Boolean).join(" ") || undefined) };
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
export const zoomConfigured = () => Boolean(setting("zoomClientId") && setting("zoomClientSecret") && setting("zoomRefreshToken"));
