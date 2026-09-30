import { getPredicate, PREDICATE_GROUPS, PREDICATE_LABELS, PREDICATES, predicateLabel } from "./predicates.js";

/**
 * Human-readable names for everything the ledger stores as an id. The web
 * app, the CLI and generated text (contradiction details) all read these,
 * so a person never sees `self_reported` or `team.headcount`.
 */

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  primary: "Primary source",
  third_party: "Third party",
  self_reported: "Self-reported",
  inference: "Model inference",
  internal: "Internal",
};

export const SOURCE_TYPE_HELP: Record<string, string> = {
  primary: "An official record, such as a regulatory filing.",
  third_party: "Reported by someone other than the company: press, data vendors, directories.",
  self_reported: "Said by the company itself: founder calls, decks, emails, its own website.",
  inference: "Inferred by a model. Never outranks a sourced fact.",
  internal: "Your firm's own notes and records.",
};

export const SCOPE_LABELS: Record<string, string> = {
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  nda: "Under NDA",
  vendor: "Vendor data",
};

export const SCOPE_HELP: Record<string, string> = {
  public: "From public sources. May appear in shareable documents.",
  internal: "Your firm's own records. Stays inside the firm.",
  confidential: "Shared with you privately. Never in shareable documents.",
  nda: "Covered by an NDA. Never in shareable documents.",
  vendor: "Licensed from a data vendor. Stays inside your firm.",
};

export const EVIDENCE_KIND_LABELS: Record<string, string> = {
  transcript: "Call transcript",
  deck: "Pitch deck",
  filing: "Regulatory filing",
  web_page: "Web page",
  api_record: "Data record",
  email: "Email",
  message: "Message",
  document: "Document",
  note: "Note",
};

export const IDENTIFIER_LABELS: Record<string, string> = {
  domain: "Website",
  linkedin: "LinkedIn",
  pitchbook: "PitchBook ID",
  harmonic: "Harmonic ID",
  crunchbase: "Crunchbase",
  dealroom: "Dealroom ID",
  carta: "Carta ID",
  affinity: "Affinity ID",
  cik: "SEC CIK",
  email: "Email",
  twitter: "X (Twitter)",
};

/** Evidence `source` values that aren't connector ids. Connector names come from the registry. */
export const SOURCE_LABELS: Record<string, string> = {
  "transcript-file": "Transcript upload",
  document: "Document upload",
  "portfolio-page": "Portfolio page",
  "sec-edgar": "SEC EDGAR",
  web: "Web page",
  "diligence-note": "Diligence note",
  "company-site": "Company website",
  news: "News",
  uspto: "USPTO",
  sbir: "SBIR.gov",
  usaspending: "USAspending.gov",
  jobs: "Job board",
};

export const ENUM_VALUE_LABELS: Record<string, string> = {
  pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C",
  series_d_plus: "Series D or later", grant: "Grant", debt: "Debt", other: "Other", growth: "Growth",
  operating: "Operating", acquired: "Acquired", shut_down: "Shut down", stealth: "Stealth", ipo: "Public (IPO)",
  concept: "Concept", prototype: "Prototype", beta: "Beta", ga: "Generally available", scaled: "Scaled",
  conversation: "In conversation", unpaid_trial: "Unpaid trial", paid_pilot: "Paid pilot",
  production_contract: "Production contract", expansion: "Expansion",
};

export const FIT_CRITERION_LABELS: Record<string, string> = {
  sector: "Sector", geography: "Geography", stage: "Stage", age: "Company age", exclusion: "Exclusion",
};

export const SEVERITY_LABELS: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

export const sourceTypeLabel = (t: string) => SOURCE_TYPE_LABELS[t] ?? t.replace(/_/g, " ");
export const scopeLabel = (s: string) => SCOPE_LABELS[s] ?? s;

/** A claim value as a person would write it: "$9,000,000", "Series A", "34", "Turner: paid pilot". */
export function formatValue(predicate: string, value: unknown): string {
  const def = PREDICATES.get(predicate);
  if (value === null || value === undefined) return "—";
  if (def?.kind === "money" && typeof value === "number") return `$${value.toLocaleString("en-US")}`;
  if (def?.kind === "percent" && typeof value === "number") return `${value}%`;
  if (typeof value === "number") return predicate.endsWith("_year") ? String(value) : value.toLocaleString("en-US");
  if (typeof value === "string") return def?.kind === "enum" ? (ENUM_VALUE_LABELS[value] ?? value.replace(/_/g, " ")) : value;
  if (typeof value === "object" && value && "customer" in value && "rung" in value) {
    const v = value as { customer: string; rung: string };
    return `${v.customer}: ${(ENUM_VALUE_LABELS[v.rung] ?? v.rung).toLowerCase()}`;
  }
  return JSON.stringify(value);
}

/** The whole vocabulary, for the web app. */
/** LP Reporting's enums: investor types, ILPA expense categories, statuses. */
export const LP_LABELS = {
  partnerKinds: {
    pension: "Pension plan", endowment_foundation: "Endowment or foundation", insurance: "Insurance company", fund_of_funds: "Fund of funds",
    family_office: "Family office", individual: "Individual", corporate: "Corporation", sovereign: "Sovereign wealth fund", gp: "General partner commitment", other: "Other",
  } as Record<string, string>,
  // The ILPA Reporting Template's partnership expense lines (v2.0).
  expenseCategories: {
    organizational: "Organizational costs", legal: "Legal", audit_tax: "Audit and tax", fund_admin: "Fund administration",
    insurance: "Insurance", bank_interest: "Credit facility interest and fees", broken_deal: "Broken deal costs", other: "Other partnership expenses",
  } as Record<string, string>,
  taxStatus: { taxable: "Taxable", tax_exempt: "Tax-exempt", foreign: "Non-US" } as Record<string, string>,
  investorStatus: { accredited: "Accredited investor", qualified_client: "Qualified client", qualified_purchaser: "Qualified purchaser" } as Record<string, string>,
  taxDocKinds: { k1: "Schedule K-1", k3: "Schedule K-3", estimate: "Tax estimate" } as Record<string, string>,
  taxDocStatus: { pending: "Pending", delivered: "Delivered" } as Record<string, string>,
  callStatus: { draft: "Draft", approved: "Approved", cancelled: "Cancelled" } as Record<string, string>,
  distributionStatus: { draft: "Draft", approved: "Approved", paid: "Paid", cancelled: "Cancelled" } as Record<string, string>,
  distributionKinds: { cash: "Cash", in_kind: "In kind (shares)" } as Record<string, string>,
  reportStatus: { draft: "Draft", approved: "Approved", withdrawn: "Withdrawn" } as Record<string, string>,
  waterfalls: { european: "Whole of fund (European)", american: "Deal by deal (American)" } as Record<string, string>,
  feeBasis: { committed: "Committed capital", invested: "Invested capital" } as Record<string, string>,
};

/** Fundraising and investor relations enums. */
export const FUNDRAISING_LABELS = {
  stages: {
    identified: "Identified", contacted: "Contacted", meeting: "First meeting", diligence: "In diligence", soft_circle: "Soft-circled",
    committed: "Committed", closed: "Closed", declined: "Declined",
  } as Record<string, string>,
  activityKinds: { note: "Note", meeting: "Meeting", call: "Call", email: "Email", stage: "Stage change", data_room: "Data room", document: "Documents", ddq: "DDQ" } as Record<string, string>,
  docCategories: {
    deck: "Fund presentation", ppm: "Private placement memorandum", lpa: "Limited partnership agreement", subscription: "Subscription documents", ddq: "Due diligence questionnaire",
    track_record: "Track record", financials: "Financial statements", legal: "Other legal documents", other: "Other",
  } as Record<string, string>,
  docStatus: { draft: "Waiting for review", approved: "Approved for investors", archived: "Archived" } as Record<string, string>,
  exemptions: { "3c1": "3(c)(1): up to 100 investors", "3c1_qvcf": "3(c)(1) qualifying venture capital fund: up to 250 investors, $12M", "3c7": "3(c)(7): qualified purchasers only" } as Record<string, string>,
  offerings: { "506b": "Rule 506(b): no general solicitation", "506c": "Rule 506(c): general solicitation, verified investors" } as Record<string, string>,
  verification: {
    self_certified: "Self-certified in the questionnaire", minimum_investment: "Minimum investment with written representations (SEC staff, March 2025)",
    third_party_letter: "Letter from a CPA, attorney, broker-dealer or adviser", documents_reviewed: "Tax returns or statements reviewed", platform: "Verification platform",
  } as Record<string, string>,
  subscriptionStatus: { invited: "Invited", submitted: "Submitted", accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn", admitted: "Admitted" } as Record<string, string>,
  kycStatus: { pending: "Not yet cleared", cleared: "Cleared", flagged: "Flagged" } as Record<string, string>,
  taxForms: { w9: "Form W-9 (US person)", w8ben: "Form W-8BEN (non-US individual)", w8bene: "Form W-8BEN-E (non-US entity)", w8imy: "Form W-8IMY (intermediary)", w8exp: "Form W-8EXP (foreign government or exempt)" } as Record<string, string>,
  // Rule 501(a), as amended in 2020.
  accreditedBases: {
    income: "Income over $200,000 ($300,000 with a spouse) in each of the last two years",
    net_worth: "Net worth over $1 million, excluding the primary residence",
    professional: "Holds a Series 7, 65 or 82 license in good standing",
    knowledgeable_employee: "Knowledgeable employee of the fund",
    insider: "Director or executive officer of the general partner",
    institution: "Bank, insurance company, registered investment company, broker-dealer or investment adviser",
    plan: "Employee benefit plan, charity or trust with over $5 million in assets",
    entity_assets: "Entity with over $5 million in assets, not formed to make this investment",
    entity_investments: "Entity with over $5 million in investments, not formed to make this investment",
    family_office: "Family office with over $5 million under management, or its family client",
    all_owners: "Entity whose equity owners are all accredited investors",
  } as Record<string, string>,
  // Investment Company Act section 2(a)(51).
  qpBases: {
    individual: "Natural person with at least $5 million in investments",
    family_company: "Family-owned company with at least $5 million in investments",
    trust: "Trust sponsored and managed by qualified purchasers",
    institution: "Invests at least $25 million on its own account or for other qualified purchasers",
    all_owners: "Entity whose owners are all qualified purchasers",
  } as Record<string, string>,
  closingStatus: { draft: "Draft", approved: "Approved", cancelled: "Cancelled" } as Record<string, string>,
  termCategories: {
    mfn: "Most favored nation", fee: "Fee terms", reporting: "Reporting", lpac_seat: "LPAC seat", co_invest: "Co-investment rights", excuse: "Excuse rights",
    esg: "ESG and responsible investment", transfer: "Transfers", confidentiality: "Confidentiality and public records", tax_regulatory: "Tax and regulatory", other: "Other",
  } as Record<string, string>,
  electionStatus: { offered: "Offered", elected: "Elected", declined: "Not elected" } as Record<string, string>,
  consentKinds: { conflict: "Conflict of interest", valuation: "Valuation", extension: "Term or investment period extension", key_person: "Key person", amendment: "LPA amendment", other: "Other" } as Record<string, string>,
  consentStatus: { open: "Open", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" } as Record<string, string>,
  votes: { approve: "Approve", decline: "Decline", abstain: "Abstain" } as Record<string, string>,
  requestCategories: { ddq: "Due diligence", reporting: "Reporting", tax: "Tax", capital_account: "Capital account", side_letter: "Side letter", transfer: "Transfer", other: "Other" } as Record<string, string>,
  requestStatus: { open: "Open", answered: "Answered", closed: "Closed" } as Record<string, string>,
};

/** Compliance enums. */
export const COMPLIANCE_LABELS = {
  adviserStatus: {
    registered: "Registered with the SEC (RIA)", era: "Exempt reporting adviser (venture capital or under $150M)", state: "Registered with a state", none: "Not an adviser (e.g., a family office)",
  } as Record<string, string>,
  forms: {
    form_adv: "Form ADV", form_d: "Form D", blue_sky: "State notice filing", form_pf: "Form PF", audit: "Audited financial statements", annual_review: "Annual compliance review",
    coe_holdings: "Holdings reports", coe_transactions: "Transaction reports", outbound_notice: "Treasury outbound notification", cfius: "CFIUS filing",
    schedule_13g: "Schedule 13G", schedule_13d: "Schedule 13D", form_345: "Forms 3, 4 and 5", form_13f: "Form 13F", other: "Other",
  } as Record<string, string>,
  outbound: { not_covered: "Not covered", notifiable: "Notifiable: tell Treasury within 30 days of closing", prohibited: "Prohibited" } as Record<string, string>,
  cfius: { none: "No CFIUS trigger identified", review: "Counsel to assess a filing", declaration_likely: "Mandatory declaration likely" } as Record<string, string>,
  exportControl: { none: "Not export-controlled (EAR99)", ear: "Controlled under the EAR", itar: "ITAR (defense article or service)" } as Record<string, string>,
  preclearanceKinds: { ipo: "Initial public offering", private_placement: "Private placement", public_security: "Listed security" } as Record<string, string>,
  requestStatus: { pending: "Waiting for review", logged: "Logged", approved: "Approved", denied: "Denied" } as Record<string, string>,
  conflictKinds: { cross_fund: "Investment by more than one fund", related_party: "Related-party charge", allocation: "Allocation of an opportunity", personal: "Personal interest", outside_activity: "Outside business activity", other: "Other" } as Record<string, string>,
  conflictStatus: { open: "Open", mitigated: "Mitigated", closed: "Closed" } as Record<string, string>,
  policies: { code_of_ethics: "Code of ethics", compliance_manual: "Compliance manual", insider_trading: "Insider trading policy" } as Record<string, string>,
  reportKinds: { holding: "Holding", transaction: "Transaction", no_activity: "No reportable activity" } as Record<string, string>,
  giftKinds: { gift: "Gift", entertainment: "Entertainment" } as Record<string, string>,
};

/** What each audit_log action means, as a phrase after a person's name ("drafted a memo"). */
export const ACTION_LABELS: Record<string, string> = {
  "deal.start": "started diligence", "deal.update": "updated the deal", "deal.item": "updated a checklist item", "deal.item.delete": "removed a checklist item",
  "deal.note": "logged a note", "deal.question.add": "added a question", "deal.question.update": "updated a question", "deal.close": "recorded the close",
  "memo.draft": "drafted a memo", "contradiction.explained": "explained a conflict", "contradiction.resolved": "settled a conflict", "contradiction.open": "found a conflict",
  "meeting.match": "matched a meeting", "meeting.unmatch_after_extraction": "unmatched a meeting", "claim.insert": "added a fact", "evidence.insert": "added a source",
  "decision.pass": "passed", "decision.advance": "sent it to IC", "decision.ic_vote_pre": "voted before discussion", "decision.ic_vote_post": "voted after discussion",
  "decision.invest": "recorded the investment", "decision.follow_on": "decided a follow-on", "decision.score_override": "overrode a score",
  "decision.health_rating": "rated the company's health", "decision.reserve_plan": "planned reserves", "decision.exit_consent": "decided on an exit",
  "ic.schedule": "scheduled IC", "ic.update": "moved IC along", "term_sheet.version": "saved a term sheet version", "term_sheet.status": "updated a term sheet",
  "cap_table.version": "saved a cap table", "closing.item": "updated a closing item", "closing.item.add": "added a closing item", "wire.instructions": "recorded wire instructions",
  "investment.record": "recorded the investment", "outbox.queue": "queued a draft for approval",
  "portfolio.mark.propose": "proposed a mark", "portfolio.realization": "recorded money back", "portfolio.board_meeting": "recorded a board meeting",
  "portfolio.initiative": "added value-creation work", "portfolio.kpi_request": "requested numbers", "portfolio.sync": "synced numbers",
  "exit.plan": "updated the exit plan", "exit.start": "started an exit process", "exit.update": "updated an exit process", "exit.bid": "logged a bid",
  "exit.close": "recorded an exit closing", "exit.receivable": "settled an escrow or earnout", "exit.public_holding": "recorded listed shares", "exit.prices": "added share prices",
  "exit.qsbs": "reviewed QSBS", "compliance.screening": "screened the deal",
};

/** Where a deal stands (deals.stage). */
export const DEAL_STAGE_LABELS: Record<string, string> = {
  screening: "Screening", diligence: "In diligence", ic: "At IC", approved: "Approved", closing: "Closing", passed: "Passed", closed: "Invested",
};

/** The kinds of decision the firm records (decisions.kind). */
export const DECISION_LABELS: Record<string, string> = {
  pass: "Passed", advance: "Sent to IC", ic_vote_pre: "IC vote before discussion", ic_vote_post: "IC vote after discussion", invest: "Invested",
  follow_on: "Follow-on decision", score_override: "Score override", health_rating: "Health rating", reserve_plan: "Reserve plan", exit_consent: "Exit decision",
};

/** Why the firm passed on a company (decisions.reason_code). */
export const PASS_REASON_LABELS: Record<string, string> = {
  team: "Team", market_size: "Market size", timing: "Timing", competition: "Competition", technology_risk: "Technology risk",
  traction: "Traction", valuation: "Valuation", capital_intensity: "Capital intensity", thesis_fit: "Thesis fit", deal_dynamics: "Deal dynamics", other: "Other",
};

export const EXIT_LABELS = {
  paths: { acquisition: "Sale to a buyer", ipo: "IPO", secondary: "Secondary sale of our stake", hold: "Hold for now", wind_down: "Wind down" } as Record<string, string>,
  kinds: { acquisition: "Sale of the company", ipo: "IPO", secondary: "Secondary sale of our shares", tender: "Tender offer", buyback: "Company buyback", wind_down: "Wind-down" } as Record<string, string>,
  stages: { exploring: "Exploring", preparing: "Preparing", marketing: "In market", offers: "Offers in", signed: "Signed", closed: "Closed", abandoned: "Abandoned" } as Record<string, string>,
  bidKinds: { ioi: "Indication of interest", loi: "Letter of intent", final: "Final offer" } as Record<string, string>,
  consent: { approve: "Consent", decline: "Decline", abstain: "Abstain" } as Record<string, string>,
  receivableKinds: {
    escrow: "Indemnity escrow", adjustment_escrow: "Price adjustment escrow", holdback: "Holdback", expense_fund: "Expense fund", earnout: "Earnout", deferred: "Deferred payment",
  } as Record<string, string>,
  receivableStatus: { pending: "Pending", partial: "Partly settled", released: "Released", earned: "Earned", claimed: "Claimed by the buyer", forfeited: "Not earned" } as Record<string, string>,
  realizationKinds: {
    sale: "Sale", partial_sale: "Partial sale", distribution: "Distribution", dividend: "Dividend", write_off: "Write-off", escrow_release: "Escrow release", earnout: "Earnout payment",
    secondary: "Secondary sale", tender: "Tender offer", public_sale: "Sale of listed shares", in_kind: "Distributed in kind",
  } as Record<string, string>,
  qsbsStatus: { eligible: "Eligible", not_eligible: "Not eligible", unclear: "Not yet confirmed" } as Record<string, string>,
  approvedVia: { gp: "The GP's discretion under the LPA", lpac: "The LPAC's consent", investors: "Investors' vote" } as Record<string, string>,
  windDownStatus: { open: "To do", done: "Done", na: "Not needed" } as Record<string, string>,
  elections: { roll: "Roll into the new vehicle", sell: "Sell for cash", status_quo: "Status quo (unchanged terms)" } as Record<string, string>,
  lifeStage: { harvesting: "Harvesting", final_years: "Final two years", extended: "In an extension", past_term: "Past its term" } as Record<string, string>,
  priceMethods: { close: "Closing price on the date", average: "Average closing price over trading days" } as Record<string, string>,
};

export function vocabulary(sourceNames: Record<string, string> = {}) {
  return {
    predicates: Object.fromEntries([...PREDICATES.keys()].map((id) => [id, { label: predicateLabel(id), description: getPredicate(id).description, kind: getPredicate(id).kind }])),
    groups: PREDICATE_GROUPS,
    sourceTypes: SOURCE_TYPE_LABELS,
    sourceTypeHelp: SOURCE_TYPE_HELP,
    scopes: SCOPE_LABELS,
    scopeHelp: SCOPE_HELP,
    evidenceKinds: EVIDENCE_KIND_LABELS,
    identifiers: IDENTIFIER_LABELS,
    sources: { ...sourceNames, ...SOURCE_LABELS },
    enumValues: ENUM_VALUE_LABELS,
    fitCriteria: FIT_CRITERION_LABELS,
    severities: SEVERITY_LABELS,
    lp: LP_LABELS,
    fundraising: FUNDRAISING_LABELS,
    compliance: COMPLIANCE_LABELS,
    exits: EXIT_LABELS,
    passReasons: PASS_REASON_LABELS,
    actions: ACTION_LABELS,
    decisions: DECISION_LABELS,
    dealStages: DEAL_STAGE_LABELS,
  };
}

export { predicateLabel, PREDICATE_LABELS };
