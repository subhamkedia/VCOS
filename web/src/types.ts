// Shapes the API returns. Kept by hand next to server/app.ts.

export type Role = "admin" | "partner" | "analyst";
export type Action =
  | "read" | "queue" | "upload" | "edit_thesis" | "manage_feeds" | "manage_connections"
  | "approve_outbox" | "decide_merges" | "manage_team" | "manage_firm";

export interface Me {
  user: { id: string; email: string; name: string | null };
  firm: { id: string; name: string; slug: string; role: Role } | null;
  firms: { id: string; name: string; slug: string; role: Role }[];
  can: Partial<Record<Action, boolean>>;
  onboarded: boolean;
}

export interface Sector { id: string; label: string; keywords: string[]; priority: "core" | "opportunistic" }
export interface Dimension { id: string; label: string; weight: number; guide: string }

export interface Profile {
  firm: { name: string; website?: string; hq?: string; description?: string };
  fund: {
    name: string; structure: string; vintage?: number; targetSizeUsd?: number; committedUsd?: number;
    investmentPeriodYears?: number; termYears?: number; reservesPct?: number; managementFeePct?: number;
    carryPct?: number; targetInvestments?: number;
  };
  mandate: {
    stages: string[]; checkSizeUsd: { min: number; max: number }; targetOwnershipPct?: { min: number; max: number };
    leadPreference: "lead" | "co_lead" | "follow" | "any"; geographies: string[]; sectors: Sector[];
    exclusions: string[]; thesis: string;
  };
  scoring: { dimensions: Dimension[] };
}

export interface ProfileResponse {
  current: { version: number; profile: Profile } | null;
  options: { stages: { id: string; label: string }[]; structures: { id: string; label: string }[] };
}

export interface ParamSpec { name: string; label: string; kind: "text" | "list" | "number" | "boolean"; placeholder?: string; help?: string; required?: boolean; default?: unknown }

export interface Connector {
  id: string; name: string; category: string; description: string; scope: string; docsUrl?: string; writes?: string; manual: boolean;
  auth:
    | { kind: "none" }
    | { kind: "platform"; note: string; ready: boolean }
    | { kind: "api_key"; fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string }[] }
    | { kind: "oauth"; provider: "google" | "microsoft"; available: boolean };
  sourcing?: { mode: "discover" | "enrich"; summary: string; params: ParamSpec[]; defaultCadence: Cadence };
  status: "available" | "connected" | "error" | "not_configured";
  accountLabel: string | null; connectedBy: string | null; connectedAt: string | null; lastCheckedAt: string | null; lastError: string | null;
}

export type Cadence = "hourly" | "daily" | "weekly" | "monthly" | "manual";

export interface Feed {
  id: string; connector_id: string; connector: string; name: string; params: Record<string, unknown>; cadence: Cadence;
  enabled: boolean; next_run_at: string | null; created_by: string; created_at: string;
  last_run: { status: string; finished_at: string | null; stats: RunStats; error: string | null } | null;
}

export interface RunStats { records: number; newCompanies: number; knownCompanies: number; unchanged: number; skipped: number; errors: number; errorSamples: string[]; strongFits: number }

export interface FitReason { criterion: string; result: "pass" | "fail" | "unknown"; detail: string; claimIds: string[] }
export interface Fit { score: number; verdict: "strong" | "possible" | "weak" | "excluded"; sectors: string[]; reasons: FitReason[]; method: string }

export interface Hit {
  entity_id: string; name: string; is_new: boolean; fit_score: number | null; fit_verdict: Fit["verdict"] | null;
  thesis_version: number | null; fit: Fit | null; feed_name: string | null; connector_id: string | null; created_at: string;
}

export interface CompanyRow { id: string; name: string; claims: number; open_contradictions: number; domain: string | null; updated_at: string }

export interface Claim {
  id: string; predicate: string; value: unknown; as_of: string | null; source_type: string; evidence_id: string; cited_text: string | null;
  confidence: number; extracted_by: string; access_scope: string;
  evidence: { source: string; kind: string; title: string | null; uri: string | null; occurred_at: string | null };
}

export interface CompanyProfile {
  entity: { id: string; name: string };
  identifiers: { kind: string; value: string }[];
  aliases: { alias: string; source: string }[];
  claims: Claim[];
  contradictions: { id: string; predicate: string; severity: "low" | "medium" | "high"; detail: string; claim_ids: string[] }[];
  decisions: { id: string; kind: string; actor: string; reason_code: string | null; rationale: string | null; created_at: string }[];
  fit: Hit | null;
  sources: { id: string; source: string; kind: string; title: string | null; uri: string | null; occurred_at: string | null; claims: number }[];
  shareable: boolean;
}

export interface Evidence {
  id: string; kind: string; source: string; title: string | null; uri: string | null; content: string; access_scope: string;
  spans: { id: string; predicate: string; span_start: number; span_end: number }[];
}

export interface OutboxItem { id: string; channel: string; summary: string; payload: Record<string, unknown>; status: string; proposed_by: string; decided_by: string | null; error: string | null; created_at: string }

export interface ModuleInfo { id: string; name: string; path: string; status: "live" | "next" | "planned"; phase: number; summary: string; does: string[]; reads: string[] }
