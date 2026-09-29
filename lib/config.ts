import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";

const env = (k: string, fallback = "") => process.env[k] ?? fallback;

export const config = {
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  extractionModel: env("EXTRACTION_MODEL", "claude-haiku-4-5-20251001"),
  reasoningModel: env("REASONING_MODEL", "claude-opus-5-5"),

  // Data vendors (vendor scope: never exported)
  harmonicApiKey: env("HARMONIC_API_KEY"),
  pitchbookApiKey: env("PITCHBOOK_API_KEY"),
  crunchbaseApiKey: env("CRUNCHBASE_API_KEY"),
  dealroomApiKey: env("DEALROOM_API_KEY"),

  // Public sources
  secUserAgent: env("SEC_USER_AGENT"),
  // USPTO PatentsView PatentSearch API (free key from patentsview.org).
  patentsviewApiKey: env("PATENTSVIEW_API_KEY"),

  // CRM
  affinityApiKey: env("AFFINITY_API_KEY"),

  // Google Workspace (Gmail + Drive share one OAuth client)
  googleClientId: env("GOOGLE_CLIENT_ID"),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: env("GOOGLE_REFRESH_TOKEN"),

  // Microsoft 365 (Outlook via Graph)
  msClientId: env("MS_CLIENT_ID"),
  msClientSecret: env("MS_CLIENT_SECRET"),
  msRefreshToken: env("MS_REFRESH_TOKEN"),
  msTenant: env("MS_TENANT", "common"),

  // Zoom (one OAuth app for every firm; each firm's consent gives it a refresh token)
  zoomClientId: env("ZOOM_CLIENT_ID"),
  zoomClientSecret: env("ZOOM_CLIENT_SECRET"),
  zoomRefreshToken: env("ZOOM_REFRESH_TOKEN"),

  // DocuSign (one OAuth app for every firm; account-d.docusign.com for the developer sandbox)
  docusignClientId: env("DOCUSIGN_CLIENT_ID"),
  docusignClientSecret: env("DOCUSIGN_CLIENT_SECRET"),
  docusignAuthServer: env("DOCUSIGN_AUTH_SERVER", "account.docusign.com"),
  docusignRefreshToken: env("DOCUSIGN_REFRESH_TOKEN"),

  // Carta API Platform (partner access; a firm's own client credentials)
  cartaClientId: env("CARTA_CLIENT_ID"),
  cartaClientSecret: env("CARTA_CLIENT_SECRET"),
  cartaApiBase: env("CARTA_API_BASE", "https://api.carta.com"),

  // Meeting notetakers (API keys belong to one firm)
  granolaApiKey: env("GRANOLA_API_KEY"),
  firefliesApiKey: env("FIREFLIES_API_KEY"),
};

export type ConfigKey = keyof typeof config;

/**
 * Keys the platform supplies to every firm: the app's own OAuth
 * registrations, the SEC contact string and the Claude key. Everything else
 * (vendor API keys, refresh tokens) belongs to one firm.
 */
export const PLATFORM_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "anthropicApiKey", "extractionModel", "reasoningModel", "secUserAgent",
  "googleClientId", "googleClientSecret", "msClientId", "msClientSecret", "msTenant",
  "zoomClientId", "zoomClientSecret", "patentsviewApiKey", "docusignClientId", "docusignClientSecret", "docusignAuthServer", "cartaApiBase",
]);

type Creds = Partial<Record<ConfigKey, string>>;
type Rotate = (key: ConfigKey, value: string) => Promise<void>;
const firmCredentials = new AsyncLocalStorage<{ creds: Creds; rotate?: Rotate }>();

/**
 * Run `fn` with one firm's credentials. Inside, connectors see that firm's
 * keys and the platform keys, and never another firm's or the operator's
 * vendor keys from .env. Outside any firm (the local CLI), .env is used.
 * `rotate` saves a credential the provider replaced (a rotated refresh token).
 */
export function withCredentials<T>(creds: Creds, fn: () => Promise<T>, rotate?: Rotate): Promise<T> {
  return firmCredentials.run({ creds: { ...creds }, rotate }, fn);
}

export function setting(name: ConfigKey): string {
  const firm = firmCredentials.getStore();
  if (!firm) return config[name];
  if (firm.creds[name]) return firm.creds[name]!;
  return PLATFORM_KEYS.has(name) ? config[name] : "";
}

/** A provider issued a new credential (Zoom and Microsoft rotate refresh tokens): use it now and save it for the firm. */
export async function rotateCredential(name: ConfigKey, value: string): Promise<void> {
  const firm = firmCredentials.getStore();
  if (!firm) {
    config[name] = value; // the local CLI: this process only
    return;
  }
  firm.creds[name] = value;
  await firm.rotate?.(name, value);
}

export function requireKey(name: ConfigKey): string {
  const v = setting(name);
  if (!v) {
    const hint = firmCredentials.getStore()
      ? "Connect it under Connections."
      : "Set it in .env (see .env.example), then check with `pnpm connectors`.";
    throw new Error(`Missing config: ${name}. ${hint}`);
  }
  return v;
}
