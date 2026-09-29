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

  // Meeting notes
  granolaMcpUrl: env("GRANOLA_MCP_URL", "https://mcp.granola.ai/mcp"),
  granolaToken: env("GRANOLA_TOKEN"),
};

export type ConfigKey = keyof typeof config;

/**
 * Keys the platform supplies to every firm: the app's own OAuth
 * registrations, the SEC contact string and the Claude key. Everything else
 * (vendor API keys, refresh tokens) belongs to one firm.
 */
export const PLATFORM_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "anthropicApiKey", "extractionModel", "reasoningModel", "secUserAgent",
  "googleClientId", "googleClientSecret", "msClientId", "msClientSecret", "msTenant", "granolaMcpUrl",
]);

const firmCredentials = new AsyncLocalStorage<Partial<Record<ConfigKey, string>>>();

/**
 * Run `fn` with one firm's credentials. Inside, connectors see that firm's
 * keys and the platform keys, and never another firm's or the operator's
 * vendor keys from .env. Outside any firm (the local CLI), .env is used.
 */
export function withCredentials<T>(creds: Partial<Record<ConfigKey, string>>, fn: () => Promise<T>): Promise<T> {
  return firmCredentials.run({ ...creds }, fn);
}

export function setting(name: ConfigKey): string {
  const firm = firmCredentials.getStore();
  if (!firm) return config[name];
  if (firm[name]) return firm[name]!;
  return PLATFORM_KEYS.has(name) ? config[name] : "";
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
