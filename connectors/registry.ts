import { setting, type ConfigKey } from "../lib/config.js";
import type { AccessScope } from "../ledger/repository.js";
import type { SourceRecord } from "./types.js";
import { fetchFormD, searchFormD } from "./edgar.js";
import { listGranolaTools } from "./transcripts.js";
import { batchSlug, fetchYcBatch, fetchYcFounders, ycToRecord } from "./yc.js";
import { affinityCheck, affinityListOrgs, affinityOrgRecord } from "./affinity.js";
import { gmailCheck, gmailSearch } from "./gmail.js";
import { outlookCheck, outlookSearch } from "./outlook.js";
import { emailToRecord } from "./email.js";
import { driveCheck } from "./gdrive.js";
import { crunchbaseByDomain, crunchbaseCheck } from "./crunchbase.js";
import { pitchbookByDomain, pitchbookCheck } from "./pitchbook.js";
import { dealroomByDomain, dealroomCheck } from "./dealroom.js";
import { harmonicEnrichByDomain } from "./harmonic.js";
import type { Provider } from "./oauth.js";

/**
 * Every source VC OS can read: how a firm connects it, what scope its
 * evidence gets, and what it can do for sourcing. The Connections screen,
 * the Sourcing screen and `pnpm connectors` all render from this list.
 */

export type Category = "data vendor" | "public" | "crm" | "email" | "documents" | "meetings";
export type Cadence = "hourly" | "daily" | "weekly" | "monthly" | "manual";

export interface CredentialField {
  key: ConfigKey;
  label: string;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export type ConnectorAuth =
  | { kind: "none" }
  | { kind: "platform"; keys: ConfigKey[]; note: string }
  | { kind: "api_key"; fields: CredentialField[] }
  | { kind: "oauth"; provider: Provider; scopes: readonly string[]; refreshKey: ConfigKey };

export interface ParamSpec {
  name: string;
  label: string;
  kind: "text" | "list" | "number" | "boolean";
  placeholder?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
}

export type Params = Record<string, unknown>;

export type SourcingSpec =
  | { mode: "discover"; summary: string; params: ParamSpec[]; defaultCadence: Cadence; discover: (p: Params) => Promise<SourceRecord[]> }
  | { mode: "enrich"; summary: string; params: ParamSpec[]; defaultCadence: Cadence; enrich: (domain: string) => Promise<SourceRecord> };

export interface ConnectorInfo {
  id: string;
  name: string;
  category: Category;
  description: string;
  scope: AccessScope;
  auth: ConnectorAuth;
  docsUrl?: string;
  /** What it can write, always through the approval outbox. */
  writes?: string;
  /** Added by hand (uploads, one-off URLs) rather than synced. */
  manual?: boolean;
  sourcing?: SourcingSpec;
  ingest: string;
  check?: () => Promise<string>;
  notes?: string;
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const key = (k: ConfigKey, label: string, help?: string): CredentialField => ({ key: k, label, secret: true, help });

export const CONNECTORS: ConnectorInfo[] = [
  // --- Data vendors -------------------------------------------------------
  {
    id: "harmonic", name: "Harmonic", category: "data vendor", scope: "vendor",
    description: "Company and people data: headcount, funding, founders. Used to enrich companies your feeds find.",
    auth: { kind: "api_key", fields: [key("harmonicApiKey", "API key", "console.harmonic.ai → API")] },
    docsUrl: "https://console.harmonic.ai/docs",
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "daily", enrich: harmonicEnrichByDomain },
    ingest: "pnpm ingest harmonic <domain>", notes: "No free check endpoint: run `--dry-run` on one domain.",
  },
  {
    id: "pitchbook", name: "PitchBook", category: "data vendor", scope: "vendor",
    description: "Deals, valuations and investors. Licensed per firm.",
    auth: { kind: "api_key", fields: [key("pitchbookApiKey", "API key", "Ask your PitchBook account manager for API access")] },
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: pitchbookByDomain },
    ingest: "pnpm ingest pitchbook <domain>", check: pitchbookCheck, notes: "Paths in PITCHBOOK_PATHS; verify with --dry-run.",
  },
  {
    id: "crunchbase", name: "Crunchbase", category: "data vendor", scope: "vendor",
    description: "Company profiles, funding rounds and investors.",
    auth: { kind: "api_key", fields: [key("crunchbaseApiKey", "API user key", "Crunchbase Enterprise or API plan")] },
    docsUrl: "https://data.crunchbase.com/docs",
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: crunchbaseByDomain },
    ingest: "pnpm ingest crunchbase <domain>", check: crunchbaseCheck,
  },
  {
    id: "dealroom", name: "Dealroom", category: "data vendor", scope: "vendor",
    description: "European and global startup data.",
    auth: { kind: "api_key", fields: [key("dealroomApiKey", "API key")] },
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: dealroomByDomain },
    ingest: "pnpm ingest dealroom <domain>", check: dealroomCheck,
  },

  // --- Public -------------------------------------------------------------
  {
    id: "yc", name: "Y Combinator directory", category: "public", scope: "public",
    description: "Every company in the YC batches you choose, with founders and locations.",
    auth: { kind: "none" },
    sourcing: {
      mode: "discover", summary: "New companies from YC batches", defaultCadence: "weekly",
      params: [
        { name: "batches", label: "Batches", kind: "list", placeholder: "W26, X26, S26", required: true, help: "W = Winter, X = Spring, S = Summer, F = Fall" },
        { name: "founders", label: "Fetch founder names", kind: "boolean", default: true },
      ],
      discover: async (p) => {
        const out: SourceRecord[] = [];
        for (const b of list(p.batches)) {
          for (const c of await fetchYcBatch(batchSlug(b))) {
            if (p.founders !== false) c.founders = await fetchYcFounders(c.slug).catch(() => undefined);
            out.push(ycToRecord(c));
          }
        }
        return out;
      },
    },
    ingest: "pnpm ingest yc <batch, e.g. W26>", check: async () => `${(await fetchYcBatch("W26")).length} W26 companies`,
  },
  {
    id: "sec-edgar", name: "SEC EDGAR (Form D)", category: "public", scope: "public",
    description: "Form D filings: US private raises, often before any announcement.",
    auth: { kind: "platform", keys: ["secUserAgent"], note: "Uses the platform's SEC contact string." },
    sourcing: {
      mode: "discover", summary: "Recent Form D filings matching your keywords", defaultCadence: "daily",
      params: [
        { name: "keywords", label: "Keywords", kind: "list", placeholder: "robotics, construction software", required: true },
        { name: "lookbackDays", label: "Look back (days)", kind: "number", default: 14 },
        { name: "limit", label: "Filings per keyword", kind: "number", default: 10 },
      ],
      discover: async (p) => {
        const out: SourceRecord[] = [];
        for (const k of list(p.keywords)) {
          const hits = (await searchFormD(k, { from: daysAgo(num(p.lookbackDays, 14)) })).slice(0, num(p.limit, 10));
          for (const h of hits) out.push(await fetchFormD(h));
        }
        return out;
      },
    },
    ingest: 'pnpm ingest formd "<company>"', check: async () => `${(await searchFormD("robotics")).length} filings found`,
  },
  {
    id: "web", name: "Web pages", category: "public", scope: "public", manual: true,
    description: "Snapshot any public page (a press article, a company site) and extract cited claims.",
    auth: { kind: "none" }, ingest: "pnpm ingest web <url> --company <name>",
  },

  // --- CRM ----------------------------------------------------------------
  {
    id: "affinity", name: "Affinity", category: "crm", scope: "internal",
    description: "Your pipeline and your team's notes. Notes you approve can be written back.",
    auth: { kind: "api_key", fields: [key("affinityApiKey", "API key", "Affinity → Settings → API")] },
    docsUrl: "https://api-docs.affinity.co", writes: "notes on organizations",
    sourcing: {
      mode: "discover", summary: "Companies on a pipeline list", defaultCadence: "daily",
      params: [{ name: "listId", label: "List id", kind: "number", required: true, help: "The number in the list's URL" }],
      discover: async (p) => (await affinityListOrgs(num(p.listId, 0))).map((o) => affinityOrgRecord(o)),
    },
    ingest: "pnpm ingest affinity-list <list id> | affinity <org name>", check: affinityCheck,
  },

  // --- Email --------------------------------------------------------------
  {
    id: "gmail", name: "Gmail", category: "email", scope: "confidential",
    description: "Founder threads and intros from a Google Workspace mailbox. Drafts only: VC OS never sends.",
    auth: { kind: "oauth", provider: "google", scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"], refreshKey: "googleRefreshToken" },
    writes: "drafts in your mailbox (never sends)",
    sourcing: {
      mode: "discover", summary: "Inbound deal flow from your inbox", defaultCadence: "hourly",
      params: [
        { name: "query", label: "Gmail search", kind: "text", default: "(deck OR intro OR raising OR pitch) newer_than:2d -from:me", help: "Any Gmail search; companies come from senders' work domains" },
        { name: "max", label: "Messages per run", kind: "number", default: 50 },
      ],
      discover: async (p) => (await gmailSearch(String(p.query ?? ""), { max: num(p.max, 50) })).map((m) => emailToRecord(m)),
    },
    ingest: 'pnpm ingest gmail "<gmail query>"', check: gmailCheck,
  },
  {
    id: "outlook", name: "Outlook", category: "email", scope: "confidential",
    description: "Founder threads and intros from a Microsoft 365 mailbox. Drafts only: VC OS never sends.",
    auth: { kind: "oauth", provider: "microsoft", scopes: ["openid", "email", "offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite"], refreshKey: "msRefreshToken" },
    writes: "drafts in your mailbox (never sends)",
    sourcing: {
      mode: "discover", summary: "Inbound deal flow from your inbox", defaultCadence: "hourly",
      params: [
        { name: "search", label: "Search", kind: "text", default: "deck", help: "Searched across subject and body" },
        { name: "max", label: "Messages per run", kind: "number", default: 50 },
      ],
      discover: async (p) => (await outlookSearch(String(p.search ?? "deck"), { max: num(p.max, 50) })).map((m) => emailToRecord(m)),
    },
    ingest: 'pnpm ingest outlook "<search>"', check: outlookCheck,
  },

  // --- Documents ------------------------------------------------------------
  {
    id: "gdrive", name: "Google Drive", category: "documents", scope: "confidential",
    description: "Decks and data-room files: Google Docs, Slides and PDFs. Read-only.",
    auth: { kind: "oauth", provider: "google", scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"], refreshKey: "googleRefreshToken" },
    ingest: "pnpm ingest drive <file id> --company <name> | drive-search <text>", check: driveCheck,
  },
  {
    id: "docsend", name: "DocSend and uploads", category: "documents", scope: "confidential", manual: true,
    description: "Upload a deck (PDF, text or Markdown). For DocSend, download the deck and add the link.",
    auth: { kind: "none" },
    ingest: "pnpm ingest document <file.pdf> --company <name> [--url <docsend link>]",
    notes: "DocSend has no API for people viewing a shared link.",
  },

  // --- Meetings -------------------------------------------------------------
  {
    id: "transcripts", name: "Transcript uploads", category: "meetings", scope: "confidential", manual: true,
    description: "Upload call transcripts exported from Zoom, Meet, Teams or Granola (.vtt, .txt, .md).",
    auth: { kind: "none" }, ingest: "pnpm ingest transcript <file> --company <name>",
  },
  {
    id: "granola", name: "Granola", category: "meetings", scope: "confidential",
    description: "Meeting notes and transcripts through Granola's MCP server.",
    auth: { kind: "api_key", fields: [key("granolaToken", "Access token", "A bearer token for mcp.granola.ai")] },
    ingest: "pnpm ingest granola <meeting id> --company <name>", check: async () => `${(await listGranolaTools()).length} tools`,
  },
];

export function getConnector(id: string): ConnectorInfo {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown connector "${id}"`);
  return c;
}

/** The settings a connector needs, whichever way they're supplied. */
export function requiredKeys(c: ConnectorInfo): ConfigKey[] {
  switch (c.auth.kind) {
    case "none": return [];
    case "platform": return c.auth.keys;
    case "api_key": return c.auth.fields.map((f) => f.key);
    case "oauth": return c.auth.provider === "google"
      ? ["googleClientId", "googleClientSecret", c.auth.refreshKey]
      : ["msClientId", "msClientSecret", c.auth.refreshKey];
  }
}

/** Keys still missing in the current context (a firm's credentials, or .env for the CLI). */
export function missingKeys(c: ConnectorInfo): ConfigKey[] {
  return requiredKeys(c).filter((k) => !setting(k));
}

export const ENV_NAMES: Record<ConfigKey, string> = {
  anthropicApiKey: "ANTHROPIC_API_KEY", extractionModel: "EXTRACTION_MODEL", reasoningModel: "REASONING_MODEL",
  harmonicApiKey: "HARMONIC_API_KEY", pitchbookApiKey: "PITCHBOOK_API_KEY", crunchbaseApiKey: "CRUNCHBASE_API_KEY",
  dealroomApiKey: "DEALROOM_API_KEY", secUserAgent: "SEC_USER_AGENT", affinityApiKey: "AFFINITY_API_KEY",
  googleClientId: "GOOGLE_CLIENT_ID", googleClientSecret: "GOOGLE_CLIENT_SECRET", googleRefreshToken: "GOOGLE_REFRESH_TOKEN",
  msClientId: "MS_CLIENT_ID", msClientSecret: "MS_CLIENT_SECRET", msRefreshToken: "MS_REFRESH_TOKEN", msTenant: "MS_TENANT",
  granolaMcpUrl: "GRANOLA_MCP_URL", granolaToken: "GRANOLA_TOKEN",
};
