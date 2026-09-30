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
  terms?: HouseTerms;
}

export interface ProfileOptions {
  stages: Opt[]; structures: Opt[]; firmTypes: Opt[]; currencies: Opt[]; feeBasis: Opt[]; waterfall: Opt[]; followOn: Opt[];
  icApproval: Opt[]; lead: Opt[]; board: Opt[]; traction: Opt[]; impact: Opt[];
  suggestions: { lpTypes: string[]; businessModels: string[]; customerTypes: string[]; geographies: string[] };
  houseTermDefaults: HouseTerms;
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
    | { kind: "oauth"; provider: "google" | "microsoft" | "zoom" | "docusign"; available: boolean; product?: string };
  sourcing?: { mode: "discover" | "enrich"; summary: string; params: ParamSpec[]; defaultCadence: Cadence };
  research?: { summary: string; needsDomain: boolean };
  meetings?: { summary: string; defaultCadence: Cadence };
  execution?: { summary: string };
  portfolio?: { summary: string; perCompany: boolean };
  lp?: { summary: string };
  fundraising?: { summary: string };
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

export type DealStage = "screening" | "diligence" | "ic" | "approved" | "closing" | "passed" | "closed";
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

// Investment Execution

export type Security = "preferred" | "safe_post" | "safe_pre" | "note";
export interface TermSheetTerms {
  security: Security; seriesName: string; preMoneyUsd?: number; raiseUsd?: number; ourAllocationUsd?: number; leadInvestor?: string; poolTopUpPostPct?: number;
  valuationCapUsd?: number; discountPct?: number; noteRatePct?: number; noteMaturityMonths?: number;
  liquidation: { multiple: number; participation: "none" | "full" | "capped"; capMultiple?: number; seniority: "pari_passu" | "senior" | "stacked" };
  dividends: { kind: "none" | "non_cumulative" | "cumulative"; ratePct?: number };
  antiDilution: "broad_wa" | "narrow_wa" | "full_ratchet" | "none"; redemption: boolean; payToPlay: boolean;
  board: { size?: number; investorSeats?: number; commonSeats?: number; independentSeats?: number; ours: "seat" | "observer" | "none" };
  protectiveProvisions: "standard" | "expanded" | "limited"; dragAlong: boolean;
  proRata: "major_investors" | "all" | "super" | "none"; informationRights: boolean; managementRightsLetter: boolean; mfn: boolean;
  founderVesting: { years: number; cliffMonths: number; acceleration: "none" | "single" | "double" };
  noShopDays?: number; investorCounselCapUsd?: number; oispRepresentation: boolean; qsbsRepresentation: boolean; tranched: boolean; otherTerms?: string;
}
export type Standing = "standard" | "investor_friendly" | "founder_friendly" | "off_market";
export interface TermCheck { key: string; label: string; value: string; nvca: Standing; reference: string; house: "ok" | "outside" | "n/a"; note?: string }
export type TermSheetStatus = "draft" | "proposed" | "negotiating" | "signed" | "superseded";
export interface TermSheetVersion { id: string; version: number; status: TermSheetStatus; terms: TermSheetTerms; source: string; note: string | null; created_by: string; created_at: string; checks: TermCheck[] }
export interface HouseTerms {
  maxLiquidationMultiple: number; acceptParticipation: "never" | "capped" | "any"; acceptAntiDilution: TermSheetTerms["antiDilution"][];
  acceptCumulativeDividends: boolean; acceptRedemption: boolean; requireProRata: boolean; requireInformationRights: boolean; requireManagementRightsLetter: boolean;
  maxPoolTopUpPostPct: number; requireFounderVesting: boolean; maxNoShopDays: number; requireOisp: boolean;
}

export interface Holding { holder: string; className: string; shares: number; kind: "common" | "preferred" | "options" | "pool" }
export interface SafeRow { holder: string; amount: number; kind: "post" | "pre" | "mfn"; cap?: number; discountPct?: number }
export interface NoteRow { holder: string; principal: number; ratePct: number; issueDate: string; cap?: number; discountPct?: number }
export interface SeriesTerms { name: string; issuePrice: number; multiple: number; participating: boolean; capMultiple?: number; seniority: number }
export interface CapTable { id: string; version: number; holdings: Holding[]; safes: SafeRow[]; notes: NoteRow[]; series_terms: SeriesTerms[]; source: "entered" | "csv" | "carta"; created_by: string; created_at: string }
export interface ProForma {
  pricePerShare: number; preMoneyFullyDiluted: number; postMoneyFullyDiluted: number; newMoney: number; postMoneyImplied: number; headlinePostMoney: number;
  pool: { before: number; increase: number; after: number; afterPct: number };
  conversions: { holder: string; instrument: string; converting: number; interest: number; price: number; basis: "cap" | "discount" | "round"; shares: number }[];
  rows: { holder: string; className: string; preShares: number; postShares: number; prePct: number; postPct: number }[];
  newShares: { holder: string; amount: number; shares: number }[];
  conventions: string[];
}
export interface ExecModel {
  proForma: ProForma | null; ours: { holder: string; amount: number; shares: number; postPct: number } | null;
  scenarios: { exit: number; proceeds: number; multiple: number; converted: boolean }[]; error: string | null;
  basedOn: { termSheetVersion: number | null; capTableVersion: number | null };
}

export type IcPhase = "pre_vote" | "discussion" | "post_vote" | "decided" | "cancelled";
export interface IcVote { member: string; vote: "yes" | "no" | "abstain" | "recused"; conviction: number | null; note: string | null; at: string }
export interface IcTally { outcome: "approved" | "declined" | "no_quorum"; yes: number; no: number; abstain: number; recused: number; notVoted: string[]; detail: string }
export interface IcMeeting {
  id: string; deal_id: string; scheduled_for: string | null; members: string[]; chair: string; rule: string; ruleLabel: string; memo_version: number | null;
  phase: IcPhase; outcome: "approved" | "declined" | null; notes: string | null; created_at: string; decided_at: string | null;
  voted: { pre: string[]; post: string[] }; preVotes: IcVote[]; postVotes: IcVote[]; preTally: IcTally | null; postTally: IcTally | null;
  shifts: { member: string; from: string; to: string; conviction: [number | null, number | null] }[]; isMember: boolean; isChair: boolean;
}

export type ClosingStatus = "open" | "requested" | "received" | "signed" | "filed" | "done" | "waived" | "na" | "red_flag";
export interface ClosingItem {
  id: string; key: string; category: string; title: string; required: boolean; status: ClosingStatus; owner: string | null; due_date: string | null;
  evidence_id: string | null; envelope_id: string | null; note: string | null; custom: boolean; updated_by: string; updated_at: string;
}
export type WireStatus = "received" | "verified" | "approved" | "sent" | "confirmed" | "cancelled";
export interface Wire {
  id: string; amount_usd: number; beneficiary: string; bank_name: string; account_last4: string; instructions_received_at: string;
  callback_by: string | null; callback_number_source: string | null; callback_at: string | null; approvals: string[]; status: WireStatus;
  bank_reference: string | null; sent_at: string | null; confirmed_at: string | null; created_by: string; created_at: string;
}
export interface Investment {
  id: string; deal_id: string; company_id: string; company_name?: string; fund_name: string; security: Security; series_name: string | null; close_date: string;
  amount_usd: number; shares: number | null; price_per_share: number | null; post_money_usd: number | null; ownership_fd_pct: number | null; board_role: string | null; round_kind?: "initial" | "follow_on"; created_by: string; created_at: string;
}
export interface ExecutionView {
  deal: Deal; termSheets: TermSheetVersion[]; house: HouseTerms; capTable: CapTable | null; model: ExecModel; meetings: IcMeeting[]; icRule: string;
  closing: { items: ClosingItem[]; categories: Record<string, string>; ready: { ready: boolean; open: string[] } };
  regulatory: { required: boolean; screening: { outbound: string; cfius: string; exportControl: string; screenedAt: string } | null; blocked: string | null };
  wires: Wire[]; investments: Investment[]; passReasons: string[];
}
export interface ExecutionRow extends Deal {
  termSheet: { version: number; status: TermSheetStatus } | null; ic: { phase: IcPhase; outcome: "approved" | "declined" | null } | null;
  closing: { done: number; total: number; redFlags: number } | null; investment: { amount: number; closeDate: string } | null;
}

// Portfolio

export type Health = "on_track" | "watch" | "at_risk";
export type Severity = "high" | "medium" | "low";
export interface KpiPoint { month: string; value: number; claimId: string; sourceType: string }
export interface Signal { key: string; severity: Severity; title: string; detail: string; claimIds: string[] }
export interface FundMetrics {
  asOf: string; invested: number; realized: number; unrealized: number; totalValue: number; moic: number | null; dpi: number | null; rvpi: number | null; tvpi: number | null;
  irr: number | null; lossRatioPct: number | null; topPositionPct: number | null; basis: string;
  positions: { company: string; invested: number; realized: number; fairValue: number; totalValue: number; moic: number | null; irr: number | null; shareOfValuePct: number }[];
}
export interface ReservePool { budget: number; deployed: number; committedRemaining: number; unallocated: number; overAllocated: boolean; byCompany: { company: string; planned: number; deployed: number; remaining: number }[] }
export interface PortfolioRow {
  companyId: string; name: string; dealId: string; firstInvested: string; invested: number; realized: number; fairValue: number; valueBasis: ValueBasis; pendingUsd: number; publicUsd: number;
  moic: number | null; ownershipPct: number | null; boardRole: string | null; status: "active" | "exited" | "public";
  health: { rating: Health; by: string; at: string } | null; suggested: Health; signals: { key: string; severity: Severity; title: string }[];
  runwayMonths: number | null; notBurning: boolean; cash: number | null; revenue: number | null; revenueMoM: number | null; arr: number | null; latestMonth: string | null;
  mark: { value: number; asOf: string; method: string } | null; reservePlanned: number | null;
}
export interface PortfolioOverview {
  asOf: string; fund: { name: string; sizeUsd: number; reservesPct: number }; metrics: FundMetrics; reserves: ReservePool; companies: PortfolioRow[];
  counts: { companies: number; atRisk: number; watch: number; marksToReview: number; openRequests: number; overdueRequests: number };
  healthLabels: Record<Health, string>;
}
export interface Mark {
  id: string; company_id: string; company_name?: string; as_of: string; method: string; fair_value_usd: number; inputs: Record<string, unknown>; steps: string[]; warnings: string[];
  rationale: string; status: "proposed" | "approved" | "rejected"; prepared_by: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
}
export interface PortfolioDecision { id: string; entity_id: string; kind: string; actor: string; value: Record<string, unknown>; rationale: string | null; created_at: string }
export interface KpiRequest { id: string; company_id: string; company_name?: string; period: string; metrics: string[]; due_on: string; recipients: string[]; status: "open" | "received" | "cancelled"; outbox_id: string | null; created_by: string; created_at: string; received_at: string | null }
export interface BoardMeetingRow { id: string; held_on: string; kind: string; our_role: string; attendees: string[]; agenda: string | null; notes: string | null; resolutions: { title: string; kind: string; outcome: string }[]; conflict_review: string | null; created_by: string; created_at: string }
export interface InitiativeRow { id: string; company_id: string; company_name?: string; kind: string; title: string; detail: string | null; owner: string | null; status: "proposed" | "in_progress" | "done" | "dropped"; due_on: string | null; outcome: string | null; value_usd: number | null; outbox_id: string | null; created_by: string; updated_at: string }
export interface PortfolioCompanyView {
  company: { id: string; name: string; domain: string | null; dealId: string };
  investments: Investment[];
  position: FundMetrics["positions"][number] | null;
  valueBasis: ValueBasis;
  value: { value: number; basis: ValueBasis; privateUsd: number; pendingUsd: number; publicUsd: number; privateShares: number | null };
  series: Partial<Record<string, KpiPoint[]>>;
  metricLabels: Record<string, string>;
  burn: { month: string; value: number; basis: string; claimIds: string[] }[];
  summary: {
    latestMonth: string | null; monthsSinceUpdate: number | null; cash: KpiPoint | null; avgBurn: number | null; burnBasis: string | null; runwayMonths: number | null; notBurning: boolean;
    zeroCashMonth: string | null; revenue: KpiPoint | null; revenueMoM: number | null; revenueYoY: number | null; arr: KpiPoint | null; netNewArr3m: number | null; burnMultiple: number | null;
    planRevenueVarPct: number | null; planBurnVarPct: number | null; headcount: KpiPoint | null; grossMargin: KpiPoint | null; nrr: KpiPoint | null; units: KpiPoint | null; uptime: KpiPoint | null;
  };
  signals: Signal[];
  suggested: Health;
  rules: Record<string, number>;
  cites: Record<string, { evidenceId: string; citedText: string | null; sourceType: string }>;
  health: PortfolioDecision[]; reservePlans: PortfolioDecision[]; followOns: PortfolioDecision[];
  marks: Mark[]; methods: Record<string, string>;
  realizations: { id: string; occurred_on: string; amount_usd: number; kind: string; note: string | null; created_by: string }[];
  board: BoardMeetingRow[]; initiatives: InitiativeRow[];
  contacts: { id: string; name: string; email: string; role: string | null; reporting: boolean }[];
  requests: KpiRequest[];
  accounting: { id: string; provider: "quickbooks" | "xero"; external_name: string | null; status: string; connected_at: string; last_sync_at: string | null; last_error: string | null }[];
  portalLinks: { id: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; createdBy: string }[];
  sources: { id: string; name: string; summary: string; perCompany: boolean; ready: boolean }[];
  options: { reportable: { id: string; label: string }[]; initiativeKinds: string[]; resolutionKinds: string[]; conflictKinds: string[]; healthLabels: Record<Health, string> };
}
export interface PortalInfo {
  company: string; firm: string;
  requests: { period: string; dueOn: string; metrics: string[] }[];
  metrics: { id: string; label: string; percent: boolean; count: boolean; plan: boolean }[];
  accounting: { provider: "quickbooks" | "xero"; name: string; available: boolean; connected: { status: string; connectedAt: string; lastSyncAt: string | null } | null }[];
}

// ---------------------------------------------------------------------------
// LP Reporting
// ---------------------------------------------------------------------------

export interface FundTermsView {
  managementFeePct: number; feeStepDownPct?: number; feeBasisAfterPeriod: "committed" | "invested"; investmentPeriodEnd: string;
  carryPct: number; hurdlePct: number; catchUpPct: number; waterfall: "european" | "american"; escrowPct?: number; gpCommitmentPct?: number;
}
export interface LpLabels {
  partnerKinds: Record<string, string>; expenseCategories: Record<string, string>; taxStatus: Record<string, string>; investorStatus: Record<string, string>;
  taxDocKinds: Record<string, string>; taxDocStatus: Record<string, string>; callStatus: Record<string, string>; distributionStatus: Record<string, string>;
  distributionKinds: Record<string, string>; reportStatus: Record<string, string>; waterfalls: Record<string, string>; feeBasis: Record<string, string>;
}
export interface NetReturns { paidIn: number; distributed: number; nav: number; dpi: number | null; rvpi: number | null; tvpi: number | null; irr: number | null }
export interface CarryPosition { entitled: number; paid: number; accrued: number; clawbackExposure: number }
export interface LpFundSummary {
  id: string; name: string; vintage: number | null; inception: string; investors: number; commitments: number; called: number; calledPct: number;
  distributed: number; nav: number; net: { tvpi: number | null; dpi: number | null; irr: number | null };
  pending: { calls: number; distributions: number; reports: number }; lastReport: string | null;
}
export interface LpOverview { asOf: string; funds: LpFundSummary[]; profileFund: { name: string; exists: boolean } | null }
export interface StatementColumn { beginning: number; contributions: number; distributions: number; managementFees: number; expenses: number; closeInterest: number; realizedGain: number; unrealizedGain: number; carriedInterest: number; ending: number }
export interface LpStatement {
  partnerId: string; name: string; kind: string; feePaying: boolean; commitment: number; contributedToDate: number; unfunded: number; distributedToDate: number; carryAccrued: number;
  quarter: StatementColumn; year: StatementColumn; inception: StatementColumn;
}
export interface LpInvestor {
  id: string; name: string; kind: string; commitment_usd: number; fee_paying: boolean; closing: number; admitted_on: string; emails: string[];
  tax_status: string | null; erisa: boolean; investor_status: string | null; kyc_verified_on: string | null; side_letter: string | null;
  contributed: number; unfunded: number; distributed: number; balance: number; returns: (NetReturns & { partnerId: string }) | null;
  portal: { expiresAt: string; lastUsedAt: string | null } | null;
}
export interface CallItem { id: string; call_id: string; partner_id: string; partner_name?: string; investment_usd: number; fee_usd: number; expense_usd: number; amount_usd: number; received_usd: number; received_on: string | null; bank_txn_id: string | null }
export interface CapitalCall {
  id: string; number: number; notice_date: string; due_date: string; investments_usd: number; fees_usd: number; expenses_usd: number;
  fee_detail: { from?: string; to?: string; lines?: string[]; offsets?: number; gross?: number }; purpose: string | null;
  status: "draft" | "approved" | "cancelled"; created_by: string; approved_by: string | null; items: CallItem[]; received: number;
}
export interface DistributionItem { id: string; partner_id: string; partner_name?: string; gross_usd: number; carry_usd: number; net_usd: number }
export interface Distribution {
  id: string; number: number; paid_on: string; gross_usd: number; kind: "cash" | "in_kind"; company_id: string | null; company_name?: string | null; purpose: string | null;
  carry_usd: number; escrow_usd: number; waterfall: string[]; status: "draft" | "approved" | "paid" | "cancelled"; created_by: string; approved_by: string | null; items: DistributionItem[];
}
export interface FundExpense { id: string; incurred_on: string; amount_usd: number; category: string; description: string; related_party: boolean; fee_offset: boolean; created_by: string }
export interface BankTxn { id: string; provider: string; posted_on: string; amount_usd: number; counterparty: string | null; memo: string | null; matched_item_id: string | null }
export interface ScheduleRow { companyId: string; company: string; firstInvested: string; cost: number; realized: number; fairValue: number; totalValue: number; moic: number | null; status: "held" | "exited"; basis: string; markDate: string | null }
export interface LpReportRow { id: string; period: string; version: number; as_of: string; commentary: string | null; status: "draft" | "approved" | "withdrawn"; prepared_by: string; created_at: string; approved_by: string | null; approved_at: string | null }
export interface Deadline { key: string; title: string; due: string; basis: string; done: boolean | null; progress: string | null; state: "done" | "past" | "overdue" | "upcoming" }
export interface TaxDoc { id: string; partner_id: string; tax_year: number; kind: "k1" | "k3" | "estimate"; status: "pending" | "delivered"; delivered_on: string | null; note: string | null }
export interface Performance {
  asOf: string;
  net: NetReturns & { basis: string };
  gross: { invested: number; realized: number; unrealized: number; moic: number | null; irr: number | null; tvpi: number | null; dpi: number | null; basis: string };
  marketingNote: string;
  cashFlows: { date: string; type: "contribution" | "distribution" | "nav"; amount: number }[];
  gpCarry: CarryPosition;
  nav: number;
}
export interface LpFundView {
  asOf: string;
  fund: { id: string; name: string; vintage: number | null; currency: string; inception: string; terms: FundTermsView };
  labels: LpLabels;
  summary: { commitments: number; called: number; uncalled: number; distributed: number; nav: number; calledPct: number; receivable: number };
  performance: Performance;
  gpCarry: CarryPosition;
  investors: LpInvestor[];
  statements: { statements: LpStatement[]; total: Omit<LpStatement, "partnerId" | "name" | "kind" | "feePaying">; gpCarry: CarryPosition; nav: number };
  calls: CapitalCall[];
  distributions: Distribution[];
  expenses: FundExpense[];
  bank: { unmatched: BankTxn[]; recent: BankTxn[] };
  schedule: ScheduleRow[];
  reports: LpReportRow[];
  suggestedPeriod: string;
  calendar: Deadline[];
  taxDocuments: TaxDoc[];
  sources: { id: string; name: string; summary: string; manual: boolean; ready: boolean }[];
}
export interface LetterSentence { text: string; cites: string[]; kind: "fact" | "view" }
export interface Letter {
  title: string;
  sections: { id: string; heading: string; sentences: LetterSentence[] }[];
  sources: Record<string, { label: string; detail: string }>;
  check: { ok: boolean; sentences: number; facts: number; cited: number; citations: number };
}
export interface ReportSnapshot {
  fund: { name: string; vintage: number | null; termsText: string[] };
  period: string; asOf: string;
  summary: { investors: number; commitments: number; gpCommitment: number; called: number; calledPct: number; uncalled: number; distributed: number; nav: number; companies: number };
  performance: { net: NetReturns & { basis: string }; gross: Performance["gross"]; marketingNote: string; cashFlows: Performance["cashFlows"] };
  schedule: ScheduleRow[];
  activity: {
    calls: { number: number; noticeDate: string; dueDate: string; investments: number; fees: number; expenses: number; total: number; purpose: string | null }[];
    distributions: { number: number; paidOn: string; gross: number; carry: number; net: number; kind: string; company: string | null }[];
  };
  feesExpenses: {
    managementFees: { quarter: { gross: number; offsets: number; net: number }; year: { gross: number; offsets: number; net: number }; inception: { gross: number; offsets: number; net: number }; offsetsUnapplied: number };
    expenses: { category: string; label: string; quarter: number; year: number; inception: number }[];
    relatedParty: { date: string; description: string; amount: number; category: string }[];
    carry: { paidQuarter: number; paidYear: number; paidInception: number; escrowInception: number; entitled: number; accrued: number; clawbackExposure: number };
  };
  statements: LpStatement[];
  total: LpFundView["statements"]["total"];
  notes: string[];
}
export interface LpReport extends LpReportRow { snapshot: ReportSnapshot; letter: Letter }
export interface InvestorPortal {
  firm: string;
  investor: { name: string; commitment: number; admittedOn: string };
  fund: { name: string; vintage: number | null; currency: string };
  reports: {
    id: string; period: string; asOf: string; approvedAt: string | null; letter: Letter;
    fund: { name: string; vintage: number | null; termsText: string[] };
    summary: ReportSnapshot["summary"]; performance: { net: ReportSnapshot["performance"]["net"]; gross: ReportSnapshot["performance"]["gross"]; marketingNote: string };
    schedule: ScheduleRow[]; feesExpenses: ReportSnapshot["feesExpenses"]; statement: LpStatement | null; returns: (NetReturns & { partnerId: string }) | null; notes: string[];
  }[];
  calls: { number: number; noticeDate: string; dueDate: string; purpose: string | null; investment: number; fee: number; expense: number; amount: number; received: number; receivedOn: string | null }[];
  distributions: { number: number; paidOn: string; kind: string; company: string | null; status: string; gross: number; carry: number; net: number }[];
  taxDocuments: { year: number; kind: string; status: string; deliveredOn: string | null }[];
}

// ---------------------------------------------------------------------------
// Fundraising & Investor Relations
// ---------------------------------------------------------------------------

export type FrLabels = Record<"stages" | "activityKinds" | "docCategories" | "docStatus" | "exemptions" | "offerings" | "verification" | "subscriptionStatus" | "kycStatus" | "taxForms" | "accreditedBases" | "qpBases" | "closingStatus" | "termCategories" | "electionStatus" | "consentKinds" | "consentStatus" | "votes" | "requestCategories" | "requestStatus", Record<string, string>>;
export type ProspectStage = "identified" | "contacted" | "meeting" | "diligence" | "soft_circle" | "committed" | "closed" | "declined";
export interface RaiseSummary { id: string; name: string; status: "open" | "closed"; targetUsd: number; hardCapUsd: number | null; closedUsd: number; weightedUsd: number; coverage: number | null; prospects: number; followUpsDue: number }
export interface Raise {
  id: string; name: string; fund_id: string | null; target_usd: number; hard_cap_usd: number | null; min_commitment_usd: number | null; exemption: string; offering: string; vcoc: boolean;
  equalization_rate_pct: number; first_close_target: string | null; final_close_deadline: string | null; status: "open" | "closed";
}
export interface Prospect {
  id: string; name: string; kind: string; contact_name: string | null; emails: string[]; jurisdiction: string | null; stage: ProspectStage; probability: number | null;
  ask_usd: number | null; soft_circle_usd: number | null; committed_usd: number | null; source: string | null; owner: string | null; next_step: string | null; next_step_on: string | null;
  decline_reason: string | null; overdue: boolean; engagement: { views: number; downloads: number; documents: number; lastViewedAt: string | null } | null;
  dataRoom: { id: string; expires_at: string; acknowledged_at: string | null; last_used_at: string | null } | null;
}
export interface Activity { id: string; prospect_id: string; occurred_on: string; kind: string; summary: string; actor: string }
export interface DataRoomDoc { id: string; title: string; category: string; version: number; file_name: string; size_bytes: number; marketing: boolean; status: "draft" | "approved" | "archived"; uploaded_by: string; approved_by: string | null; created_at: string }
export interface Subscription {
  id: string; prospect_id: string | null; investor_name: string; kind: string; natural_person: boolean; commitment_usd: number | null; status: "invited" | "submitted" | "accepted" | "rejected" | "withdrawn" | "admitted";
  accredited_basis: string | null; qualified_purchaser: boolean; qp_basis: string | null; benefit_plan: boolean; pooled_vehicle: boolean; verification: string | null; tax_form: string | null; jurisdiction: string | null;
  emails: string[]; beneficial_owners: { name: string; pct: number }[]; kyc_status: "pending" | "cleared" | "flagged"; kyc_note: string | null;
  sanctions: { checkedAt: string; names: string[]; hits: { name: string; match: string; score: number }[] } | null; signed_on: string | null; closing_id: string | null;
  rejected_reason: string | null; open: string[];
}
export interface ClosingRow { id: string; number: number; closing_date: string; status: "draft" | "approved" | "cancelled"; created_by: string; approved_by: string | null; note: string | null }
export interface OfferingIssue { key: string; severity: "block" | "warn"; investor?: string; message: string }
export interface RaiseView {
  raise: Raise; labels: FrLabels;
  pipeline: { target: number; closed: number; committed: number; softCircled: number; weighted: number; coverage: number | null; remaining: number; byStage: { stage: ProspectStage; count: number; amount: number; weighted: number }[] };
  prospects: Prospect[]; activity: Activity[]; documents: DataRoomDoc[]; dataRoomViews: { prospect_id: string; title: string; action: string; viewed_at: string }[];
  subscriptions: Subscription[]; closings: ClosingRow[]; admitted: { investors: number; commitments: number }; issues: OfferingIssue[];
  marketing: { checklist: readonly { key: string; label: string }[]; required: boolean };
  sources: { id: string; name: string; summary: string; manual: boolean; ready: boolean }[];
}
export interface ClosingView {
  closing: ClosingRow; investors: { id: string; name: string; commitment: number | null; kind: string }[]; issues: OfferingIssue[];
  perInvestor: { subscriptionId: string; investor: string; open: string[] }[]; blocked: boolean;
  equalization: { id?: string; partner_name?: string; capital_usd: number; fee_usd: number; interest_usd: number; detail: string[]; settled_on?: string | null }[];
}
export interface DdqQuestion { key: string; section: string; question: string; stale: boolean; answer: { answer: string; sources: string[]; status: "draft" | "approved"; updated_by: string; approved_by: string | null; approved_at: string | null } | null }
export interface SideLetterView {
  terms: { id: string; subscription_id: string; investor_name?: string; category: string; text: string; electable: boolean; granted_on: string; elected_from: string | null }[];
  elections: { id: string; subscription_id: string; investor: string; status: "offered" | "elected" | "declined"; window_ends: string; term: { category: string; text: string } | null }[];
  obligations: { investor?: string; category: string; text: string; since: string }[];
}
export interface LpacView {
  members: { id: string; partner_id: string; partner_name?: string; representative: string; email: string | null; since: string; until: string | null }[];
  consents: { id: string; kind: string; topic: string; detail: string; requested_on: string; due_on: string | null; status: string; decided_on: string | null; votes: { member_id: string; vote: string }[]; tally: { members: number; approve: number; decline: number; abstain: number; pending: number; majority: boolean } }[];
  investors: { id: string; name: string }[];
}
export interface InvestorRequest { id: string; fund_id: string | null; from_name: string; category: string; subject: string; detail: string | null; received_on: string; due_on: string | null; status: "open" | "answered" | "closed"; answer: string | null; overdue: boolean }
export interface DataRoomPublic { firm: string; raise: string; investor: string; acknowledged: boolean; notice: string; documents: { id: string; title: string; category: string; version: number; fileName: string; sizeBytes: number; updatedAt: string | null }[] }
export interface SubscribePublic {
  firm: string; raise: string; investor: string; status: string; naturalPerson: boolean; commitmentUsd: number | null; minCommitmentUsd: number | null;
  needsQualifiedPurchaser: boolean; generalSolicitation: boolean; accreditedBases: { id: string; label: string }[]; qpBases: { id: string; label: string }[];
  taxForms: { id: string; label: string }[]; documents: { title: string; category: string }[]; answers: Record<string, unknown>;
}

// Compliance
export type CoLabels = Record<"adviserStatus" | "forms" | "outbound" | "cfius" | "exportControl" | "preclearanceKinds" | "requestStatus" | "conflictKinds" | "conflictStatus" | "policies" | "reportKinds" | "giftKinds", Record<string, string>>;
export interface CoObligation { key: string; title: string; due: string; basis: string; subject?: string; form: string; state: "done" | "overdue" | "upcoming"; filing: CoFiling | null; waitingOn: string[] | null }
export interface CoFiling { id: string; form: string; obligation_key: string | null; subject: string | null; filed_on: string; reference: string | null; note: string | null; created_by: string }
export interface CoScreening { id: string; deal_id: string; company_id: string; company_name?: string; outbound: "not_covered" | "notifiable" | "prohibited"; cfius: "none" | "review" | "declaration_likely"; export_control: "none" | "ear" | "itar"; reasons: string[]; counsel_note: string | null; screened_by: string; created_at: string }
export interface CoRestricted { id: string; company_id: string | null; name: string; ticker: string | null; reason: string; added_on: string; added_by: string; removed_on: string | null }
export interface CoReport { id: string; person: string; kind: "holding" | "transaction" | "no_activity"; security: string | null; ticker: string | null; action: string | null; quantity: number | null; traded_on: string | null; account: string | null; period: string; created_at: string }
interface CoRequestBase { id: string; person: string; status: "pending" | "logged" | "approved" | "denied"; decided_by: string | null; decided_at: string | null; note: string | null; created_at: string }
export interface CoPreclearance extends CoRequestBase { kind: string; security: string; ticker: string | null; amount_usd: number | null; reason: string | null; restricted_hit: boolean }
export interface CoContribution extends CoRequestBase { recipient: string; office: string; jurisdiction: string; election: string; amount_usd: number; can_vote: boolean; contribute_on: string; result: { limit: number; total: number; withinDeMinimis: boolean; timeOut: boolean; message: string } }
export interface CoGift extends CoRequestBase { direction: "given" | "received"; kind: "gift" | "entertainment"; counterparty: string; description: string; value_usd: number; occurred_on: string; over_limit: boolean }
export interface CoConflict { id: string; kind: string; title: string; detail: string; mitigation: string | null; status: "open" | "mitigated" | "closed"; created_by: string; created_at: string; closed_by: string | null; closed_at: string | null }
export interface ComplianceOverview {
  profile: { adviser_status: string; cco_email: string | null; fiscal_year_end: string; require_screening: boolean; gift_limit_usd: number; updated_by: string | null; updated_at: string | null; configured: boolean };
  labels: CoLabels; marketingChecklist: { key: string; label: string }[];
  calendar: CoObligation[]; filings: CoFiling[];
  screenings: CoScreening[]; needsScreening: { id: string; company_id: string; company_name: string }[];
  restricted: CoRestricted[]; restrictedSuggestions: { companyId: string; name: string; reason: string }[];
  reviewer: boolean; person: string;
  reports: CoReport[]; preclearances: CoPreclearance[]; contributions: CoContribution[]; gifts: CoGift[];
  conflicts: CoConflict[];
  attestations: { year: number; policies: string[]; done: { person: string; policy: string; attested_on: string }[]; missing: { person: string; policy: string }[] };
  marketingReviews: { id: string; subject_kind: string; title: string; reviewer: string; created_at: string }[];
}

// Exits and liquidity
export type ValueBasis = "mark" | "cost" | "exited" | "public";
export type ExLabels = Record<"paths" | "kinds" | "stages" | "bidKinds" | "consent" | "receivableKinds" | "receivableStatus" | "realizationKinds" | "qsbsStatus" | "approvedVia" | "windDownStatus" | "elections" | "lifeStage" | "priceMethods", Record<string, string>>;
export interface ExitPlan { id: string; company_id: string; company_name?: string; path: string; target_year: number | null; low_usd: number | null; base_usd: number | null; high_usd: number | null; probability_pct: number | null; buyers: string[]; readiness: Record<string, boolean>; note: string | null; updated_by: string; updated_at: string }
export interface ExitBid { id: string; bidder: string; kind: string; value_usd: number; consideration: string | null; received_on: string; note: string | null; created_by: string }
export interface ExitProcess {
  id: string; company_id: string; company_name?: string; kind: string; stage: string; counterparty: string | null; expected_close: string | null; equity_value_usd: number | null; our_expected_usd: number | null;
  shares: number | null; price_per_share: number | null; note: string | null; consent_decision_id: string | null; closed_on: string | null; closing: Record<string, unknown> | null; abandoned_reason: string | null; created_by: string;
}
export interface Receivable { id: string; exit_id: string; company_id: string; company_name?: string; kind: string; description: string; amount_usd: number; expected_pct: number; due_on: string; status: string; settled_usd: number; settled_on: string | null; note: string | null; valueUsd: number; overdue: boolean }
export interface SaleWindowView { lockupEnds: string; holdingPeriodMet: string; earliestSale: string; volumeLimit: number | null; form144: boolean; reporting: string[]; steps: string[] }
export interface ListedView {
  holding: { id: string; company_id: string; company_name?: string; exit_id: string | null; ticker: string; exchange: string | null; listed_on: string; acquired_on: string; shares: number; shares_outstanding: number | null; lockup_days: number; affiliate: boolean };
  sharesLeft: number; lastPrice: { date: string; close: number; volume: number | null } | null; valueUsd: number | null; window: SaleWindowView; soldLast3Months: number; prices: { date: string; close: number; volume: number | null }[];
}
export interface QsbsLot { investmentId: string; label: string; fund: string; basisUsd: number; acquiredOn: string; review: { status: string; checks: Record<string, boolean>; note: string | null; reviewed_by: string; created_at: string } | null; result: { regime: string; heldDays: number; exclusionPct: number; next: { on: string; pct: number } | null; capUsd: number; tenTimesBasisUsd: number; notes: string[] } }
export interface RealizationRow { id: string; company_id: string; occurred_on: string; amount_usd: number; kind: string; note: string | null; shares: number | null; price_usd: number | null; created_by: string }
export interface CompanyExits {
  plan: ExitPlan | null; readiness: readonly { key: string; label: string }[];
  processes: (ExitProcess & { bids: ExitBid[]; consents: PortfolioDecision[]; needsConsent: boolean })[];
  receivables: Receivable[]; listed: ListedView[]; qsbs: QsbsLot[]; qsbsChecks: readonly { key: string; label: string }[]; realizations: RealizationRow[]; receivedUsd: number; labels: ExLabels;
}
export interface ClosePreview {
  kind: string; on: string; warnings: string[]; cost?: { invested: number; shares: number | null; perShare: number | null };
  split?: { atCloseCashUsd: number; stockUsd: number; receivables: { kind: string; description: string; amountUsd: number; expectedPct: number; dueOn: string }[]; expectedUsd: number; maximumUsd: number; steps: string[] };
  gainUsd?: number | null; shares?: number; ticker?: string; window?: SaleWindowView; valueUsd?: number | null; amountUsd?: number; price?: number; proceedsUsd?: number; costBasisUsd?: number | null; remainingShares?: number | null;
}
export interface InKindPreview { fund: string; ticker: string; shares: number; on: string; price: number; priceSteps: string[]; grossUsd: number; carryUsd: number; allocation: { id: string; name: string; shares: number }[]; warnings: string[] }
export interface LiquidityOverview {
  asOf: string; processes: ExitProcess[]; recent: ExitProcess[]; plans: ExitPlan[]; receivables: Receivable[]; listed: ListedView[];
  forecast: { year: number; receivables: number; publicShares: number; exits: number; total: number }[];
  qsbsSoon: { company: string; companyId: string; label: string; next: { on: string; pct: number }; exclusionPct: number }[];
  undistributed: { companyId: string; name: string; receivedUsd: number; distributedUsd: number }[];
  totals: { pendingUsd: number; listedUsd: number; undistributedUsd: number }; funds: { id: string; name: string }[]; labels: ExLabels;
}
export interface FundLifeView {
  fund: { id: string; name: string; inception: string; vintage: number | null }; termYears: number; maxExtensionYears: number; configured: boolean;
  life: { termEnds: string; endsOn: string; extensionYearsUsed: number; extensionYearsLeft: number; monthsLeft: number; stage: string };
  extensions: { id: string; years: number; approved_via: string; fee_change: string | null; note: string | null; created_by: string; created_at: string }[];
  residual: { companyId: string; name: string; value: number; basis: ValueBasis; privateUsd: number; pendingUsd: number; publicUsd: number }[]; residualNavUsd: number;
  options: { key: string; title: string; detail: string }[];
  windDown: { key: string; label: string; status: "open" | "done" | "na"; note: string | null; updated_by: string | null }[];
  continuation: {
    id: string; name: string; lead_buyer: string; price_pct_of_nav: number; reference_nav_usd: number; launched_on: string; deadline: string; status_quo_offered: boolean; fairness_opinion: string | null; status: string;
    lpacConsent: { topic: string; status: string } | null; names: Record<string, string>;
    tally: { calendarDays: number; businessDays: number; issues: string[]; closed: boolean; investors: { id: string; navUsd: number; choice: string; defaulted: boolean; cashUsd: number }[]; navRolled: number; navStatusQuo: number; navSold: number; navPending: number; cashToSellers: number };
  }[];
  lpacConsents: { id: string; topic: string; status: string }[]; labels: ExLabels;
}
