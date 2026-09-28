import { config, requireKey } from "../lib/config.js";
import { requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * OAuth for Google Workspace and Microsoft 365. Both use the same pattern:
 * you authorize once in a browser, paste the long-lived refresh token into
 * .env, and this module trades it for short-lived access tokens.
 *
 * Scopes to grant (read-only plus drafts; never send):
 *   Google:    gmail.readonly, gmail.compose, drive.readonly
 *   Microsoft: offline_access, Mail.Read, Mail.ReadWrite, User.Read
 * Mail.ReadWrite and gmail.compose are needed to create drafts. Neither
 * connector calls a send endpoint.
 */

type Provider = "google" | "microsoft";

const cache = new Map<Provider, { token: string; expiresAt: number }>();

function tokenRequest(provider: Provider): { url: string; body: URLSearchParams } {
  if (provider === "google") {
    return {
      url: "https://oauth2.googleapis.com/token",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: requireKey("googleClientId"),
        client_secret: requireKey("googleClientSecret"),
        refresh_token: requireKey("googleRefreshToken"),
      }),
    };
  }
  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(config.msTenant || "common")}/oauth2/v2.0/token`,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requireKey("msClientId"),
      client_secret: requireKey("msClientSecret"),
      refresh_token: requireKey("msRefreshToken"),
      scope: "offline_access Mail.Read Mail.ReadWrite User.Read",
    }),
  };
}

/** A valid access token, refreshed a minute before it expires. */
export async function accessToken(provider: Provider, fetchImpl?: FetchLike): Promise<string> {
  const hit = cache.get(provider);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const { url, body } = tokenRequest(provider);
  const res = await requestJson<{ access_token?: string; expires_in?: number }>(`${provider} oauth`, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    fetchImpl,
  });
  if (!res.access_token) throw new Error(`${provider} oauth: no access_token in response`);
  cache.set(provider, { token: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000 });
  return res.access_token;
}

export function clearTokenCache() {
  cache.clear();
}

export const googleConfigured = () => Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
export const microsoftConfigured = () => Boolean(config.msClientId && config.msClientSecret && config.msRefreshToken);
