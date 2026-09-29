import { setting, type ConfigKey } from "../lib/config.js";
import type { AccessScope } from "../ledger/repository.js";
import type { SourceRecord } from "./types.js";
import { fetchFormD, searchFormD } from "./edgar.js";
import { batchSlug, fetchYcBatch, fetchYcFounders, ycToRecord } from "./yc.js";
import { affinityCheck, affinityListOrgs, affinityOrgRecord } from "./affinity.js";
import { gmailCheck, gmailSearch } from "./gmail.js";
import { affinityNoteRecord, affinityNotes, affinitySearchOrgs } from "./affinity.js";
import { driveRecord, driveSearch } from "./gdrive.js";
import { googleCalendarCheck, googleCalendarMeetings } from "./google-calendar.js";
import { googleMeetCheck, googleMeetTranscripts } from "./google-meet.js";
import { teamsCheck, teamsMeetings } from "./teams.js";
import { zoomCheck, zoomMeetings } from "./zoom.js";
import { granolaCheck, granolaMeetings } from "./granola.js";
import { firefliesCheck, firefliesMeetings } from "./fireflies.js";
import type { MeetingRecord } from "./meetings.js";
import { companySite } from "./company-site.js";
import { companyNews } from "./news.js";
import { companyPatents } from "./patents.js";
import { companySbir } from "./sbir.js";
import { companyFederalAwards } from "./usaspending.js";
import { companyJobs } from "./jobs.js";
import { sameCompanyName, type CompanyRef } from "./research.js";
import { docusignCheck } from "./docusign.js";
import { cartaCheck } from "./carta.js";
import { ofacCheck } from "./ofac.js";
import { outlookCheck, outlookSearch } from "./outlook.js";
import { emailToRecord } from "./email.js";
import { driveCheck } from "./gdrive.js";
import { crunchbaseByDomain, crunchbaseCheck } from "./crunchbase.js";
import { pitchbookByDomain, pitchbookCheck } from "./pitchbook.js";
import { dealroomByDomain, dealroomCheck } from "./dealroom.js";
import { harmonicEnrichByDomain } from "./harmonic.js";
import type { Provider } from "./oauth.js";
import { discoverFromPortfolioPage, ORG_TYPES, type OrgType } from "./portfolio-pages.js";

/**
 * Every source VC OS can read: how a firm connects it, what scope its
 * evidence gets, and what it can do for sourcing. The Connections screen,
 * the Sourcing screen and `pnpm connectors` all render from this list.
 */

export type Category = "data vendor" | "public" | "crm" | "email" | "documents" | "meetings" | "closing";

/** What diligence knows about the company it's researching. */
export interface ResearchTarget extends CompanyRef {
  founders?: string[];
}

/** Pull everything this source has on one company, for diligence. */
export interface ResearchSpec {
  summary: string;
  /** Can't search without the company's website domain. */
  needsDomain?: boolean;
  run: (c: ResearchTarget) => Promise<SourceRecord[]>;
}

/** A meeting tool: list meetings since a date. Matching to companies happens in modules/meetings. */
export interface MeetingsSpec {
  summary: string;
  defaultCadence: Cadence;
  /** How far back the first sync reaches. */
  backfillDays: number;
  list: (since: Date) => Promise<MeetingRecord[]>;
}
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
  kind: "text" | "list" | "number" | "boolean" | "select" | "url";
  options?: readonly { id: string; label: string }[];
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
  research?: ResearchSpec;
  meetings?: MeetingsSpec;
  /** Used by Investment Execution (signatures, cap tables, screening). */
  execution?: { summary: string };
  /** OAuth products that share one account consent (Gmail, Drive, Calendar, Meet). */
  product?: string;
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
    description: "Company and people data: headcount, funding, founders. Enriches companies your feeds find and every company in diligence.",
    auth: { kind: "api_key", fields: [key("harmonicApiKey", "API key", "console.harmonic.ai → API")] },
    docsUrl: "https://console.harmonic.ai/docs",
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "daily", enrich: harmonicEnrichByDomain },
    research: { summary: "Company record by website domain", needsDomain: true, run: async (c) => [await harmonicEnrichByDomain(c.domain!)] },
    ingest: "pnpm ingest harmonic <domain>", notes: "No free check endpoint: run `--dry-run` on one domain.",
  },
  {
    id: "pitchbook", name: "PitchBook", category: "data vendor", scope: "vendor",
    description: "Deals, valuations and investors. Licensed per firm.",
    auth: { kind: "api_key", fields: [key("pitchbookApiKey", "API key", "Ask your PitchBook account manager for API access")] },
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: pitchbookByDomain },
    research: { summary: "Company record by website domain", needsDomain: true, run: async (c) => [await pitchbookByDomain(c.domain!)] },
    ingest: "pnpm ingest pitchbook <domain>", check: pitchbookCheck, notes: "Paths in PITCHBOOK_PATHS; verify with --dry-run.",
  },
  {
    id: "crunchbase", name: "Crunchbase", category: "data vendor", scope: "vendor",
    description: "Company profiles, funding rounds and investors.",
    auth: { kind: "api_key", fields: [key("crunchbaseApiKey", "API user key", "Crunchbase Enterprise or API plan")] },
    docsUrl: "https://data.crunchbase.com/docs",
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: crunchbaseByDomain },
    research: { summary: "Company record by website domain", needsDomain: true, run: async (c) => [await crunchbaseByDomain(c.domain!)] },
    ingest: "pnpm ingest crunchbase <domain>", check: crunchbaseCheck,
  },
  {
    id: "dealroom", name: "Dealroom", category: "data vendor", scope: "vendor",
    description: "European and global startup data.",
    auth: { kind: "api_key", fields: [key("dealroomApiKey", "API key")] },
    sourcing: { mode: "enrich", summary: "Enrich newly sourced companies", params: [], defaultCadence: "weekly", enrich: dealroomByDomain },
    research: { summary: "Company record by website domain", needsDomain: true, run: async (c) => [await dealroomByDomain(c.domain!)] },
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
    research: {
      summary: "Form D filings in the company's name",
      run: async (c) => {
        const hits = (await searchFormD(`"${c.name}"`)).filter((h) => sameCompanyName(c, h.name)).slice(0, 5);
        const out: SourceRecord[] = [];
        for (const h of hits) out.push(await fetchFormD(h));
        return out;
      },
    },
    ingest: 'pnpm ingest formd "<company>"', check: async () => `${(await searchFormD("robotics")).length} filings found`,
  },
  {
    id: "websites", name: "Portfolio websites", category: "public", scope: "public",
    description: "Portfolio and cohort pages of accelerators, incubators, venture studios, VCs and CVCs. Each run lists the companies on the page, so new cohorts and new investments show up here.",
    auth: { kind: "none" },
    sourcing: {
      mode: "discover", summary: "Companies listed on a portfolio page", defaultCadence: "weekly",
      params: [
        { name: "orgName", label: "Organization", kind: "text", required: true, placeholder: "Techstars", help: "Recorded on each company as its program or investor." },
        { name: "orgType", label: "Type", kind: "select", required: true, options: ORG_TYPES, default: "accelerator" },
        { name: "url", label: "Portfolio page", kind: "url", required: true, placeholder: "https://example.org/portfolio", help: "The page that lists their companies. robots.txt is respected." },
      ],
      discover: (p) => discoverFromPortfolioPage({ orgName: String(p.orgName), orgType: String(p.orgType) as OrgType, url: String(p.url) }),
    },
    ingest: "Add it as a feed in Sourcing",
  },
  {
    id: "company-site", name: "Company website", category: "public", scope: "public",
    description: "The company's own site: home, about, team, customers, product, careers and press pages. Self-reported.",
    auth: { kind: "none" },
    research: { summary: "Reads up to 8 pages, respecting robots.txt", needsDomain: true, run: (c) => companySite(c) },
    ingest: "Runs in diligence",
  },
  {
    id: "news", name: "News coverage", category: "public", scope: "public",
    description: "Articles from the last three months that name the company, through the GDELT news index. Press is third-party.",
    auth: { kind: "none" }, docsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    research: { summary: "Recent articles naming the company", run: (c) => companyNews(c) },
    ingest: "Runs in diligence",
  },
  {
    id: "uspto", name: "US patents (USPTO)", category: "public", scope: "public",
    description: "Granted US patents assigned to the company, from the USPTO's PatentsView API. A primary source.",
    auth: { kind: "platform", keys: ["patentsviewApiKey"], note: "Uses the platform's free PatentsView key." },
    docsUrl: "https://search.patentsview.org/docs/",
    research: { summary: "Granted patents by assignee", run: (c) => companyPatents(c) },
    ingest: "Runs in diligence",
  },
  {
    id: "sbir", name: "SBIR and STTR awards", category: "public", scope: "public",
    description: "Federal small-business research awards (DoD, DOE, NSF, NASA...), from SBIR.gov. Often a deep-tech company's first customer.",
    auth: { kind: "none" }, docsUrl: "https://www.sbir.gov/api",
    research: { summary: "Awards to the company", run: (c) => companySbir(c) },
    ingest: "Runs in diligence",
  },
  {
    id: "usaspending", name: "Federal contracts and grants", category: "public", scope: "public",
    description: "Contracts and grants the US government awarded the company, from USAspending.gov.",
    auth: { kind: "none" }, docsUrl: "https://api.usaspending.gov/",
    research: { summary: "Awards to the company by recipient name", run: (c) => companyFederalAwards(c) },
    ingest: "Runs in diligence",
  },
  {
    id: "jobs", name: "Job boards", category: "public", scope: "public",
    description: "Open roles from the Greenhouse, Lever or Ashby board the company's own site links to. A hiring signal.",
    auth: { kind: "none" },
    research: { summary: "Open roles, found through the company's careers page", needsDomain: true, run: (c) => companyJobs(c) },
    ingest: "Runs in diligence",
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
    research: {
      summary: "The company's record and your team's notes",
      run: async (c) => {
        const orgs = await affinitySearchOrgs(c.domain ?? c.name);
        const o = orgs.find((x) => (c.domain && x.domain === c.domain) || sameCompanyName(c, x.name));
        if (!o) return [];
        return [affinityOrgRecord(o), ...(await affinityNotes(o.id)).map((n) => affinityNoteRecord(n, o))];
      },
    },
    ingest: "pnpm ingest affinity-list <list id> | affinity <org name>", check: affinityCheck,
  },

  // --- Email --------------------------------------------------------------
  {
    id: "gmail", name: "Gmail", category: "email", scope: "confidential", product: "Mail",
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
    research: {
      summary: "Last year's threads with the company's domain", needsDomain: true,
      run: async (c) => (await gmailSearch(`(from:${c.domain} OR to:${c.domain}) newer_than:1y`, { max: 50 })).map((m) => emailToRecord(m, { company: c.name, companyDomain: c.domain })),
    },
    ingest: 'pnpm ingest gmail "<gmail query>"', check: gmailCheck,
  },
  {
    id: "outlook", name: "Outlook", category: "email", scope: "confidential", product: "Mail",
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
    research: {
      summary: "Threads mentioning the company's domain", needsDomain: true,
      run: async (c) => (await outlookSearch(c.domain!, { max: 50 })).map((m) => emailToRecord(m, { company: c.name, companyDomain: c.domain })),
    },
    ingest: 'pnpm ingest outlook "<search>"', check: outlookCheck,
  },

  // --- Documents ------------------------------------------------------------
  {
    id: "gdrive", name: "Google Drive", category: "documents", scope: "confidential", product: "Drive",
    description: "Decks and data-room files: Google Docs, Slides and PDFs. Read-only.",
    auth: { kind: "oauth", provider: "google", scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"], refreshKey: "googleRefreshToken" },
    research: {
      summary: "Decks and documents that mention the company",
      run: async (c) => {
        const files = (await driveSearch(c.name, { max: 10 })).filter((f) => !/folder|image|video|audio/.test(f.mimeType ?? ""));
        const out: SourceRecord[] = [];
        for (const f of files) out.push(await driveRecord(f.id, { company: c.name, companyDomain: c.domain }));
        return out;
      },
    },
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
  // Synced on a cadence; each meeting is matched to a company by its
  // attendees' email domains (modules/meetings). Words are confidential.
  {
    id: "google-calendar", name: "Google Calendar", category: "meetings", scope: "confidential", product: "Calendar",
    description: "Your meetings and who attended. Attendee emails are how every call, from any tool, is matched to the right company.",
    auth: { kind: "oauth", provider: "google", scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"], refreshKey: "googleRefreshToken" },
    meetings: { summary: "Meetings with people outside the firm", defaultCadence: "hourly", backfillDays: 90, list: (since) => googleCalendarMeetings(since) },
    ingest: "Syncs on its own once connected", check: () => googleCalendarCheck(),
  },
  {
    id: "google-meet", name: "Google Meet", category: "meetings", scope: "confidential", product: "Meet",
    description: "Transcripts of Meet calls (transcription must be on in the call). Meet keeps them for 30 days, so this syncs daily or more.",
    auth: { kind: "oauth", provider: "google", scopes: ["openid", "email", "https://www.googleapis.com/auth/meetings.space.readonly"], refreshKey: "googleRefreshToken" },
    docsUrl: "https://developers.google.com/workspace/meet/api/guides/overview",
    meetings: { summary: "Meet transcripts", defaultCadence: "hourly", backfillDays: 30, list: (since) => googleMeetTranscripts(since) },
    ingest: "Syncs on its own once connected", check: () => googleMeetCheck(),
  },
  {
    id: "microsoft-teams", name: "Microsoft Teams and Outlook Calendar", category: "meetings", scope: "confidential", product: "Calendar and Teams",
    description: "Your Outlook meetings with attendees, and Teams transcripts for meetings you organized. Transcript access needs a Microsoft 365 admin's consent.",
    auth: {
      kind: "oauth", provider: "microsoft",
      scopes: ["openid", "email", "offline_access", "User.Read", "Calendars.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"],
      refreshKey: "msRefreshToken",
    },
    docsUrl: "https://learn.microsoft.com/graph/api/onlinemeeting-list-transcripts",
    meetings: { summary: "Meetings and Teams transcripts", defaultCadence: "hourly", backfillDays: 90, list: (since) => teamsMeetings(since) },
    ingest: "Syncs on its own once connected", check: () => teamsCheck(),
  },
  {
    id: "zoom", name: "Zoom", category: "meetings", scope: "confidential",
    description: "Transcripts of your Zoom cloud recordings, with participants. Needs cloud recording with audio transcripts (Pro plan or above).",
    auth: { kind: "oauth", provider: "zoom", scopes: [], refreshKey: "zoomRefreshToken" },
    docsUrl: "https://developers.zoom.us/docs/api/",
    meetings: { summary: "Recorded meetings with transcripts", defaultCadence: "hourly", backfillDays: 90, list: (since) => zoomMeetings(since) },
    ingest: "Syncs on its own once connected", check: () => zoomCheck(),
  },
  {
    id: "granola", name: "Granola", category: "meetings", scope: "confidential",
    description: "Granola notes, summaries and transcripts, with attendees and the calendar event. Business or Enterprise plan.",
    auth: { kind: "api_key", fields: [key("granolaApiKey", "API key", "Granola → Settings → Connectors → API keys (starts with grn_)")] },
    docsUrl: "https://docs.granola.ai/introduction",
    meetings: { summary: "Notes and transcripts", defaultCadence: "hourly", backfillDays: 90, list: (since) => granolaMeetings(since) },
    ingest: "pnpm ingest granola <note id> --company <name>", check: () => granolaCheck(),
  },
  {
    id: "fireflies", name: "Fireflies.ai", category: "meetings", scope: "confidential",
    description: "Fireflies transcripts and summaries, with attendee emails.",
    auth: { kind: "api_key", fields: [key("firefliesApiKey", "API key", "Fireflies → Integrations → Fireflies API")] },
    docsUrl: "https://docs.fireflies.ai/",
    meetings: { summary: "Transcripts and summaries", defaultCadence: "hourly", backfillDays: 90, list: (since) => firefliesMeetings(since) },
    ingest: "Syncs on its own once connected", check: () => firefliesCheck(),
  },
  {
    id: "transcripts", name: "Transcript uploads", category: "meetings", scope: "confidential", manual: true,
    description: "Upload transcripts exported from any tool, including Otter (.vtt, .txt, .md).",
    auth: { kind: "none" }, ingest: "pnpm ingest transcript <file> --company <name>",
  },

  // --- Closing -----------------------------------------------------------------
  // Used by Investment Execution: signatures, cap tables, sanctions screening.
  {
    id: "docusign", name: "DocuSign", category: "closing", scope: "confidential",
    description: "Tracks signatures on closing documents, and can prepare draft envelopes you review and send yourself. VC OS never sends one.",
    auth: { kind: "oauth", provider: "docusign", scopes: ["signature", "extended"], refreshKey: "docusignRefreshToken" },
    docsUrl: "https://developers.docusign.com/docs/esign-rest-api/", writes: "draft envelopes (never sent)",
    ingest: "Used on the Closing tab", check: () => docusignCheck(),
    execution: { summary: "Signature status on closing documents; draft envelopes after approval" },
  },
  {
    id: "carta", name: "Carta", category: "closing", scope: "vendor",
    description: "Your firm's funds, investments and the cap tables companies share with you, through Carta's API Platform (partner access). Or import any Carta or Pulley export as a file.",
    auth: { kind: "api_key", fields: [key("cartaClientId", "Client id", "Carta developer portal → your app"), key("cartaClientSecret", "Client secret")] },
    docsUrl: "https://docs.carta.com/api-platform/docs/introduction",
    ingest: "Used on the Cap table tab", check: () => cartaCheck(),
    execution: { summary: "Cap tables companies share with your fund" },
    notes: "Carta API access is invite-only; cap table files work without it.",
  },
  {
    id: "ofac", name: "OFAC sanctions lists", category: "closing", scope: "public",
    description: "Screens the company, its founders and co-investors against the US Treasury's SDN and Consolidated sanctions lists before closing.",
    auth: { kind: "none" }, docsUrl: "https://ofac.treasury.gov/sanctions-list-service",
    ingest: "Used on the Closing tab", check: () => ofacCheck(),
    execution: { summary: "Sanctions screening before closing" },
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
      : c.auth.provider === "zoom"
        ? ["zoomClientId", "zoomClientSecret", c.auth.refreshKey]
        : c.auth.provider === "docusign"
        ? ["docusignClientId", "docusignClientSecret", c.auth.refreshKey]
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
  patentsviewApiKey: "PATENTSVIEW_API_KEY", zoomClientId: "ZOOM_CLIENT_ID", zoomClientSecret: "ZOOM_CLIENT_SECRET",
  zoomRefreshToken: "ZOOM_REFRESH_TOKEN", granolaApiKey: "GRANOLA_API_KEY", firefliesApiKey: "FIREFLIES_API_KEY",
  docusignClientId: "DOCUSIGN_CLIENT_ID", docusignClientSecret: "DOCUSIGN_CLIENT_SECRET", docusignAuthServer: "DOCUSIGN_AUTH_SERVER",
  docusignRefreshToken: "DOCUSIGN_REFRESH_TOKEN", cartaClientId: "CARTA_CLIENT_ID", cartaClientSecret: "CARTA_CLIENT_SECRET", cartaApiBase: "CARTA_API_BASE",
};
