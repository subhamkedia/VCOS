import "dotenv/config";

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

export function requireKey(name: ConfigKey): string {
  const v = config[name];
  if (!v) throw new Error(`Missing config: ${name}. Set it in .env (see .env.example), then check with \`pnpm connectors\`.`);
  return v;
}
