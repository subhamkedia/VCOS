import "dotenv/config";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  extractionModel: process.env.EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001",
  reasoningModel: process.env.REASONING_MODEL ?? "claude-opus-5-5",
  harmonicApiKey: process.env.HARMONIC_API_KEY ?? "",
  secUserAgent: process.env.SEC_USER_AGENT ?? "",
  granolaMcpUrl: process.env.GRANOLA_MCP_URL ?? "https://mcp.granola.ai/mcp",
  granolaToken: process.env.GRANOLA_TOKEN ?? "",
};

export function requireKey(name: keyof typeof config): string {
  const v = config[name];
  if (!v) throw new Error(`Missing config: ${name}. Set it in .env (see .env.example).`);
  return v;
}
