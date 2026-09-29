// Shapes the API returns. Kept by hand next to server/app.ts.

export type Role = "admin" | "partner" | "analyst";
export type Action =
  | "read" | "queue" | "upload" | "work_deals" | "triage_meetings" | "edit_thesis" | "manage_feeds" | "manage_connections"
  | "approve_outbox" | "decide_merges" | "decide_deals" | "manage_team" | "manage_firm";

export interface Me {
  user: { id: string; email: string; name: string | null };
  firm: { id: string; name: string; slug: string; role: Role } | null;
  firms: { id: string; name: string; slug: string; role: Role }[];
  can: Partial<Record<Action, boolean>>;
  onboarded: boolean;
}

export interface Sector { id: string; label: string; keywords: string[]; priority: "core" | "opportunistic" }
export interface Dimension { id: string; label: string; weight: number; guide: string }

export type Opt = { id: string; label: string };

export interface Profile {
  firm: {
    name: string; legalName?: string; type: string; website?: string; linkedin?: string; emailDomains?: string[]; hq?: string; offices: string[];
    foundedYear?: number; aumUsd?: number; fundsRaised?: number; teamSize?: number; investmentTeamSize?: number; description?: string;
  };
  fund: {
    name: string; number?: string; structure: string; legalForm?: string; domicile?: string; currency: string; vintage?: number;
    targetSizeUsd?: number; hardCapUsd?: number; committedUsd?: number; firstCloseDate?: string; finalCloseDate?: string; gpCommitmentPct?: number;
    investmentPeriodYears?: number; termYears?: number; extensionYears?: number;
    managementFeePct?: number; feeStepDownPct?: number; feeBasisAfterPeriod: string; fundExpensesPct?: number; recyclingPct?: number;
    carryPct?: number; hurdlePct?: number; waterfall?: string;
    reservesPct?: number; targetInvestments?: number; avgInitialCheckUsd?: number; maxConcentrationPct?: number; followOnStrategy?: string;
    lpTypes: string[]; icMembers?: number; icApproval?: string;
  };
  mandate: {
    stages: string[]; checkSizeUsd: { min: number; max: number }; followOnCheckUsd?: { min: number; max: number };
    targetOwnershipPct?: { min: number; max: number }; leadPreference: string; boardSeat?: string;
    geographies: string[]; sectors: Sector[]; businessModels: string[]; customerTypes: string[];
    traction?: string; minArrUsd?: number; maxCompanyAgeYears?: number; impact?: string; exclusions: string[]; thesis: string;
  };
  scoring: { dimensions: Dimension[] };
}

export interface ProfileOptions {
  stages: Opt[]; structures: Opt[]; firmTypes: Opt[]; currencies: Opt[]; feeBasis: Opt[]; waterfall: Opt[]; followOn: Opt[];
  icApproval: Opt[]; lead: Opt[]; board: Opt[]; traction: Opt[]; impact: Opt[];
  suggestions: { lpTypes: string[]; businessModels: string[]; customerTypes: string[]; geographies: string[] };
}

export interface Construction {
  sizeUsd: number; managementFeesUsd: number; feeLoadPct: number; expensesUsd: number; recycledUsd: number; investableUsd: number;
  initialCapitalUsd: number; reserveCapitalUsd: number; reserveRatio: number | null; impliedInvestments: number | null;
  impliedAvgInitialCheckUsd: number | null; avgReservePerCompanyUsd: number | null; avgPositionPct: number | null; warnings: string[];
}

export interface ProfileResponse {
  current: { version: number; profile: Profile } | null;
  options: ProfileOptions;
  construction: Construction | null;
}

export interface ProfileCheck { ok: boolean; errors?: { path: string; message: string }[]; construction: Construction | null }

export interface ParamSpec { name: string; label: string; kind: "text" | "list" | "number" | "boolean" | "select" | "url"; options?: Opt[]; placeholder?: string; help?: string; required?: boolean; default?: unknown }

export interface Connector {
  id: string; name: string; category: string; description: string; scope: string; docsUrl?: string; writes?: string; manual: boolean;
  auth:
    | { kind: "none" }
    | { kind: "platform"; note: string; ready: boolean }
    | { kind: "api_key"; fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string }[] }
    | { kind: "oauth"; provider: "google" | "microsoft" | "zoom"; available: boolean; product?: string };
  sourcing?: { mode: "discover" | "enrich"; summary: string; params: ParamSpec[]; defaultCadence: Cadence };
  research?: { summary: string; needsDomain: boolean };
  meetings?: { summary: string; defaultCadence: Cadence };
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
  confidence: number; extracted_by: string; access_scope: string; label: string; display: string;
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

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export type MeetingStatus = "matched" | "needs_review" | "internal" | "ignored";

export interface Meeting {
  id: string; source: string; sourceName: string; external_id: string; title: string; started_at: string | null; ended_at: string | null;
  organizer: string | null; attendees: { name?: string; email?: string; self?: boolean }[]; join_key: string | null; url: string | null;
  evidence_id: string | null; company_id: string | null; company_name: string | null; status: MeetingStatus;
  match: { method?: string; confidence?: number; reasons?: string[]; candidates?: { entityId: string; name: string; why: string }[]; newDomain?: string };
  matched_by: string | null; extracted: boolean; has_words: boolean;
}

// ---------------------------------------------------------------------------
// Diligence
// ---------------------------------------------------------------------------

export type DealStage = "screening" | "diligence" | "ic" | "approved" | "passed" | "closed";
export type ItemStatus = "open" | "in_progress" | "done" | "na" | "red_flag";
export type Workstream = "team" | "market" | "product" | "traction" | "economics" | "financing" | "legal" | "fit";
export interface DealFlags { hardware?: boolean; regulated?: boolean; sensitive_tech?: boolean }

export interface Deal {
  id: string; company_id: string; company_name: string; stage: DealStage; lead: string | null; team: string[]; our_check_usd: number | null;
  flags: DealFlags; target_ic_date: string | null; created_by: string; created_at: string; updated_at: string;
}

export interface DealListRow extends Deal {
  domain: string | null; open_contradictions: number; open_questions: number; meetings: number; last_activity: string | null;
  readiness: { ready: boolean; complete: number; total: number; requiredOpen: number };
}

export interface ChecklistItem {
  key: string; workstream: Workstream; title: string; why: string; required?: boolean; applies?: keyof DealFlags;
  state: "missing" | "self_reported" | "evidenced" | "verified" | "done" | "na" | "red_flag" | "in_progress" | "open" | "manual" | "flagged";
  complete: boolean; claimIds: string[]; noteCount: number; detail: string; assignee: string | null; note: string | null;
  person: { status: ItemStatus | null; by: string; at: string } | null; custom: boolean;
}

export interface Readiness {
  ready: boolean; complete: number; total: number; requiredOpen: { key: string; title: string }[]; redFlags: { key: string; title: string }[];
  highContradictions: number; byWorkstream: { id: Workstream; label: string; complete: number; total: number }[];
}

export interface Question {
  id: string; key: string; workstream: Workstream; text: string; origin: "gap" | "unverified" | "contradiction" | "pilot" | "risk" | "custom";
  claim_ids: string[]; status: "open" | "asked" | "answered" | "dropped"; answer: string | null; updated_by: string | null; created_at: string; updated_at: string;
}

export interface SourceResult { id: string; name: string; status: "ok" | "empty" | "skipped" | "failed"; records: number; newEvidence: number; claims: number; detail?: string }

export interface DealRun { id: string; kind: string; status: string; started_at: string | null; finished_at: string | null; stats: { sources?: SourceResult[] }; error: string | null; triggered_by: string }

export interface Check { ok: boolean; detail: string }

export interface DealView {
  deal: Deal;
  company: { id: string; name: string; identifiers: { kind: string; value: string }[] };
  fit: Hit | null;
  claims: Claim[];
  contradictions: CompanyProfile["contradictions"];
  settled: { id: string; predicate: string; severity: string; status: string; detail: string | null; claim_ids: string[]; resolution_note: string | null; resolved_by: string | null; resolved_at: string | null }[];
  checklist: ChecklistItem[];
  readiness: Readiness;
  workstreams: { id: Workstream; label: string }[];
  flags: DealFlags;
  flagLabels: Record<keyof DealFlags, { label: string; help: string }>;
  round: {
    raise: { id: string; predicate: string; label: string; display: string; source_type: string }[];
    ourCheckUsd: number | null;
    math: { postMoneyUsd?: number; ownershipPct?: number; shareOfRoundPct?: number; totalExposureUsd?: number; exposurePctOfFund?: number; checks: Partial<Record<"checkSize" | "ownership" | "concentration" | "roundFit", Check>> };
  };
  questions: Question[];
  notes: { id: string; kind: string; title: string | null; with: string | null; occurred_at: string | null; excerpt: string }[];
  noteKinds: { id: string; label: string; help: string }[];
  meetings: Meeting[];
  sources: { source: string; kind: string; items: number; claims: number; latest: string | null }[];
  runs: DealRun[];
  memos: MemoVersion[];
  decisions: CompanyProfile["decisions"] & { value?: unknown }[];
  activity: { at: string | null; actor: string; action: string; target: string | null; detail: Record<string, unknown> }[];
  passReasons: string[];
}

export interface MemoVersion {
  id: string; version: number; shareable: boolean; drafted_by: string; created_by: string; created_at: string;
  check_result: { ok: boolean; sentences: number; facts: number; cited: number; citations: number; rejected: { section: string; text: string; reason: string }[] };
}

export interface MemoSentence { text: string; cites: string[]; kind: "fact" | "view" }
export interface Memo extends MemoVersion {
  body: { title: string; sections: { id: string; heading: string; sentences: MemoSentence[] }[] };
  refs: Record<string, { label: string; display: string; source: string; evidenceId?: string; sourceType?: string; superseded?: boolean }>;
  markdown: string;
}

export interface ResearchSource { id: string; name: string; category: string; summary: string; needsDomain: boolean; ready: boolean; reason?: string }
