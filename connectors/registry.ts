import { config, type ConfigKey } from "../lib/config.js";
import type { AccessScope } from "../ledger/repository.js";
import { searchFormD } from "./edgar.js";
import { listGranolaTools } from "./transcripts.js";
import { fetchYcBatch } from "./yc.js";
import { affinityCheck } from "./affinity.js";
import { gmailCheck } from "./gmail.js";
import { outlookCheck } from "./outlook.js";
import { driveCheck } from "./gdrive.js";
import { crunchbaseCheck } from "./crunchbase.js";
import { pitchbookCheck } from "./pitchbook.js";
import { dealroomCheck } from "./dealroom.js";

/**
 * Every source VC OS can read, what it needs, and what scope its evidence
 * gets. `pnpm connectors` prints this; `--check` makes one cheap live call
 * per configured connector.
 */
export interface ConnectorInfo {
  id: string;
  name: string;
  category: "data vendor" | "public" | "crm" | "email" | "documents" | "meetings";
  scope: AccessScope;
  /** All of these must be set. Empty = works without keys. */
  keys: ConfigKey[];
  /** What it can write, always through the approval outbox. */
  writes?: string;
  ingest: string;
  check?: () => Promise<string>;
  notes?: string;
}

export const CONNECTORS: ConnectorInfo[] = [
  { id: "harmonic", name: "Harmonic", category: "data vendor", scope: "vendor", keys: ["harmonicApiKey"],
    ingest: "pnpm ingest harmonic <domain>", notes: "No free check endpoint: run `--dry-run` on one domain." },
  { id: "pitchbook", name: "PitchBook", category: "data vendor", scope: "vendor", keys: ["pitchbookApiKey"],
    ingest: "pnpm ingest pitchbook <domain>", check: pitchbookCheck, notes: "Paths in PITCHBOOK_PATHS; verify with --dry-run." },
  { id: "crunchbase", name: "Crunchbase", category: "data vendor", scope: "vendor", keys: ["crunchbaseApiKey"],
    ingest: "pnpm ingest crunchbase <domain>", check: crunchbaseCheck },
  { id: "dealroom", name: "Dealroom", category: "data vendor", scope: "vendor", keys: ["dealroomApiKey"],
    ingest: "pnpm ingest dealroom <domain>", check: dealroomCheck },
  { id: "sec-edgar", name: "SEC EDGAR (Form D)", category: "public", scope: "public", keys: ["secUserAgent"],
    ingest: 'pnpm ingest formd "<company>"', check: async () => `${(await searchFormD("robotics")).length} filings found` },
  { id: "yc", name: "Y Combinator directory", category: "public", scope: "public", keys: [],
    ingest: "pnpm ingest yc <batch, e.g. W26>", check: async () => `${(await fetchYcBatch("W26")).length} W26 companies` },
  { id: "web", name: "Web pages", category: "public", scope: "public", keys: [],
    ingest: "pnpm ingest web <url> --company <name>" },
  { id: "affinity", name: "Affinity (CRM)", category: "crm", scope: "internal", keys: ["affinityApiKey"],
    writes: "notes on organizations", ingest: "pnpm ingest affinity-list <list id> | affinity <org name>", check: affinityCheck },
  { id: "gmail", name: "Gmail", category: "email", scope: "confidential", keys: ["googleClientId", "googleClientSecret", "googleRefreshToken"],
    writes: "drafts in your mailbox (never sends)", ingest: 'pnpm ingest gmail "<gmail query>"', check: gmailCheck },
  { id: "outlook", name: "Outlook (Microsoft 365)", category: "email", scope: "confidential", keys: ["msClientId", "msClientSecret", "msRefreshToken"],
    writes: "drafts in your mailbox (never sends)", ingest: 'pnpm ingest outlook "<search>"', check: outlookCheck },
  { id: "gdrive", name: "Google Drive", category: "documents", scope: "confidential", keys: ["googleClientId", "googleClientSecret", "googleRefreshToken"],
    ingest: "pnpm ingest drive <file id> --company <name> | drive-search <text>", check: driveCheck },
  { id: "docsend", name: "DocSend and local files", category: "documents", scope: "confidential", keys: [],
    ingest: "pnpm ingest document <file.pdf> --company <name> [--url <docsend link>]",
    notes: "DocSend has no viewer API: download the deck and ingest the file with its link." },
  { id: "transcripts", name: "Transcript files", category: "meetings", scope: "confidential", keys: [],
    ingest: "pnpm ingest transcript <file> --company <name>" },
  { id: "granola", name: "Granola", category: "meetings", scope: "confidential", keys: ["granolaToken"],
    ingest: "pnpm ingest granola <meeting id> --company <name>", check: async () => `${(await listGranolaTools()).length} tools` },
];

export function missingKeys(c: ConnectorInfo): ConfigKey[] {
  return c.keys.filter((k) => !config[k]);
}

export const ENV_NAMES: Record<ConfigKey, string> = {
  anthropicApiKey: "ANTHROPIC_API_KEY", extractionModel: "EXTRACTION_MODEL", reasoningModel: "REASONING_MODEL",
  harmonicApiKey: "HARMONIC_API_KEY", pitchbookApiKey: "PITCHBOOK_API_KEY", crunchbaseApiKey: "CRUNCHBASE_API_KEY",
  dealroomApiKey: "DEALROOM_API_KEY", secUserAgent: "SEC_USER_AGENT", affinityApiKey: "AFFINITY_API_KEY",
  googleClientId: "GOOGLE_CLIENT_ID", googleClientSecret: "GOOGLE_CLIENT_SECRET", googleRefreshToken: "GOOGLE_REFRESH_TOKEN",
  msClientId: "MS_CLIENT_ID", msClientSecret: "MS_CLIENT_SECRET", msRefreshToken: "MS_REFRESH_TOKEN", msTenant: "MS_TENANT",
  granolaMcpUrl: "GRANOLA_MCP_URL", granolaToken: "GRANOLA_TOKEN",
};
