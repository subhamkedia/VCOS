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
  };
}

export { predicateLabel, PREDICATE_LABELS };
