import type { ClaimRow, SourceType } from "../../ledger/contradictions.js";
import type { DealFlags, ItemRow, ItemStatus } from "../../ledger/diligence.js";

/**
 * The diligence checklist: what a firm checks before a deal goes to IC.
 *
 * Workstreams follow how early-stage investors actually decide. Team comes
 * first: in Gompers, Gornall, Kaplan and Strebulaev's survey of 885 VCs
 * (Journal of Financial Economics, 2020), the management team was the
 * factor most often called most important. Reference checks, including
 * backchannel references the founder didn't offer, and calls with the
 * company's customers are where conviction is built. For hardware and
 * physical-world companies, technology and manufacturing readiness use the
 * NASA/DoD TRL and DoD MRL scales. The legal workstream includes US export
 * controls and Treasury's Outbound Investment Security Program (in force
 * since 2 January 2025 for AI, semiconductors and quantum).
 *
 * Items are evaluated against the ledger: an item backed by claims shows
 * as evidenced; one that needs independent verification shows as
 * self-reported until a primary or third-party source agrees. A person's
 * status (done, not applicable, red flag) always wins.
 */

export type Workstream = "team" | "market" | "product" | "traction" | "economics" | "financing" | "legal" | "fit";

export const WORKSTREAMS: { id: Workstream; label: string }[] = [
  { id: "team", label: "Team" },
  { id: "market", label: "Market and competition" },
  { id: "product", label: "Product and technology" },
  { id: "traction", label: "Customers and traction" },
  { id: "economics", label: "Business model and unit economics" },
  { id: "financing", label: "Round and terms" },
  { id: "legal", label: "Legal, regulatory and compliance" },
  { id: "fit", label: "Fit with the fund" },
];

export type NoteKind = "reference" | "customer_call" | "expert_call" | "site_visit" | "note";

export const NOTE_KINDS: { id: NoteKind; label: string; help: string }[] = [
  { id: "reference", label: "Founder reference", help: "A reference or backchannel call about a founder." },
  { id: "customer_call", label: "Customer call", help: "A call with a customer or pilot partner." },
  { id: "expert_call", label: "Expert call", help: "A technical or market expert's view." },
  { id: "site_visit", label: "Site visit", help: "What you saw at the company, a deployment or the factory." },
  { id: "note", label: "Other note", help: "Anything else worth keeping." },
];

export type Flag = Exclude<keyof DealFlags, "follow_on">;

export const FLAG_LABELS: Record<Flag, { label: string; help: string }> = {
  hardware: { label: "Hardware or physical product", help: "Adds manufacturing, bill of materials, pilots and readiness levels." },
  regulated: { label: "Regulated market", help: "Adds certifications and approvals." },
  sensitive_tech: { label: "Sensitive technology", help: "Adds export controls, CFIUS and outbound investment rules (AI, chips, quantum, robotics, defense)." },
};

export interface ChecklistItem {
  key: string;
  workstream: Workstream;
  title: string;
  why: string;
  /** Evidenced by current claims on any of these. */
  predicates?: string[];
  /** Needs an independent source (a filing, a customer, a vendor) to count as verified. */
  verify?: boolean;
  /** Evidenced by diligence notes of these kinds. */
  notes?: NoteKind[];
  /** How many such notes before it counts (reference calls: several). */
  minNotes?: number;
  /** Computed from the deal rather than claims. */
  auto?: "fit" | "fund_fit";
  /** Only for deals with this flag. */
  applies?: Flag;
  /** Must be complete (or marked not applicable) before IC. */
  required?: boolean;
  /** Question for the founders when nothing is known. */
  ask?: string;
  /** Question when only the company itself has said it. */
  askVerify?: string;
}

export const CHECKLIST: ChecklistItem[] = [
  // Team
  { key: "team.founders", workstream: "team", title: "Founders identified", why: "Who you're backing.", predicates: ["team.founder"], required: true,
    ask: "Who are the founders, and how did you come to work together?" },
  { key: "team.headcount", workstream: "team", title: "Team size", why: "Checks burn and hiring claims against reality.", predicates: ["team.headcount"], verify: true,
    ask: "How many full-time people are on the team today, and how many do you plan to hire in the next 12 months?",
    askVerify: "Can you share a current org chart or payroll headcount?" },
  { key: "team.key_hires", workstream: "team", title: "Key hires and gaps", why: "Who is missing for the next stage.", predicates: ["team.key_hire", "team.open_roles"],
    ask: "Which senior roles are open, and who is doing that work today?" },
  { key: "team.references", workstream: "team", title: "Founder references, including backchannel", why: "Most conviction on founders comes from references they didn't offer.",
    notes: ["reference"], minNotes: 3, required: true },

  // Market
  { key: "market.size", workstream: "market", title: "Market size, bottom-up", why: "Claimed TAMs are rarely primary; rebuild it from customers and prices.", predicates: ["market.tam"],
    ask: "How many customers could buy this in the next five years, and at what annual price?" },
  { key: "market.competition", workstream: "market", title: "Competitors mapped", why: "Who else wins these deals, and why you'd lose.", predicates: ["competition.competitor"], required: true,
    ask: "Who do you lose deals to, and why?" },
  { key: "market.expert", workstream: "market", title: "Independent market view", why: "Someone with no stake in the deal.", notes: ["expert_call"] },

  // Product and technology
  { key: "product.stage", workstream: "product", title: "Product maturity", why: "What exists today versus on the roadmap.", predicates: ["product.stage"], required: true,
    ask: "What is in customers' hands today, and what is still on the roadmap?" },
  { key: "product.trl", workstream: "product", title: "Technology readiness (TRL)", why: "NASA/DoD scale, 1 to 9: how far from lab to field.", predicates: ["tech.readiness_level"], applies: "hardware",
    ask: "Where has the system been tested: lab, relevant environment, or in real operations, and for how long?" },
  { key: "product.benchmarks", workstream: "product", title: "Performance claims tested", why: "Benchmarks the company states, checked against a source or a demo.", predicates: ["tech.benchmark"], verify: true,
    ask: "What are the two or three performance numbers that matter most, and under what conditions were they measured?",
    askVerify: "Can we see test data or a live demo for the performance numbers you quoted?" },
  { key: "product.ip", workstream: "product", title: "IP: patents and filings", why: "What's protected, and who owns it.", predicates: ["ip.patent", "ip.patent_count"],
    ask: "What have you filed or been granted, and is all IP assigned to the company?" },
  { key: "product.technical_review", workstream: "product", title: "Technical expert review", why: "An outside expert's read of the technology risk.", notes: ["expert_call", "site_visit"] },
  { key: "product.manufacturing", workstream: "product", title: "Manufacturing and supply chain readiness", why: "DoD MRL scale, 1 to 10: can it be built at volume and cost.",
    predicates: ["tech.manufacturing_readiness", "unit_economics.bom_cost"], applies: "hardware",
    ask: "Who builds the product today, what are the single-source parts, and what does it take to go from tens to thousands of units?" },

  // Customers and traction
  { key: "traction.revenue", workstream: "traction", title: "Revenue or ARR verified", why: "The number that sets the price; verify it against invoices or a bank statement.",
    predicates: ["revenue.arr", "revenue.annual"], verify: true, required: true,
    ask: "What is your current ARR or trailing-twelve-month revenue?",
    askVerify: "Can you share the revenue schedule or invoices behind the revenue figure?" },
  { key: "traction.customers", workstream: "traction", title: "Paying customers", why: "How many, and who.", predicates: ["customers.paying.count", "customers.named"], verify: true,
    ask: "How many paying customers do you have, and who are the largest?",
    askVerify: "Could we speak with two customers of our choosing?" },
  { key: "traction.pilots", workstream: "traction", title: "Pilots and deployments on the ladder", why: "Conversation, unpaid trial, paid pilot, production contract, expansion: where each customer really is.",
    predicates: ["pilot.status", "pilot.site_count"], applies: "hardware",
    ask: "For each pilot: is it paid, what are the success criteria, and when does it convert to a production contract?" },
  { key: "traction.customer_calls", workstream: "traction", title: "Customer reference calls", why: "Customers you pick, not only the ones the founder offers.", notes: ["customer_call"], minNotes: 2, required: true },
  { key: "traction.growth", workstream: "traction", title: "Growth rate", why: "Trajectory, not a snapshot.", predicates: ["revenue.growth_yoy"],
    ask: "What was revenue a year ago, and what drove the change?" },

  // Unit economics
  { key: "economics.margin", workstream: "economics", title: "Gross margin", why: "Whether growth makes money.", predicates: ["unit_economics.gross_margin"], verify: true,
    ask: "What is your gross margin today, and what does it look like at scale?",
    askVerify: "Can you share the cost of goods sold behind the gross margin?" },
  { key: "economics.pricing", workstream: "economics", title: "Pricing and contract value", why: "What a customer pays and why.", predicates: ["unit_economics.asp", "revenue.contracted_backlog"],
    ask: "How do you price, and what is the average contract value?" },
  { key: "economics.cash", workstream: "economics", title: "Burn, cash and runway", why: "How long this money lasts.", predicates: ["burn.monthly", "cash.balance", "runway.months"], required: true, verify: true,
    ask: "What is your monthly net burn and cash in the bank today?",
    askVerify: "Can you share a recent bank statement or management accounts?" },
  { key: "economics.hardware_costs", workstream: "economics", title: "Bill of materials and cost-down path", why: "Hardware margins are made in the BOM.", predicates: ["unit_economics.bom_cost"], applies: "hardware",
    ask: "What is the bill of materials per unit today, and at 1,000 units?" },

  // Round and terms
  { key: "financing.round", workstream: "financing", title: "Round size, stage and lead", why: "What's being raised and who sets terms.", predicates: ["raise.amount", "raise.stage", "raise.lead_investor"], required: true,
    ask: "How much are you raising, at what stage, and who is leading?" },
  { key: "financing.valuation", workstream: "financing", title: "Valuation", why: "Pre-money and what it implies.", predicates: ["raise.pre_money"], required: true,
    ask: "What pre-money valuation are you proposing?" },
  { key: "financing.history", workstream: "financing", title: "Prior financing and investors", why: "Who's on the cap table and what they paid.", predicates: ["funding.total_raised", "funding.investor", "funding.round.post_money"], verify: true,
    ask: "Who has invested so far, how much, and on what terms?" },
  { key: "financing.cap_table", workstream: "financing", title: "Cap table reviewed", why: "Fully diluted ownership, option pool, and any side letters." },
  { key: "financing.fund_fit", workstream: "financing", title: "Check size and ownership fit the fund", why: "Math from your fund model: entry ownership, concentration and reserves.", auto: "fund_fit", required: true },

  // Legal
  { key: "legal.corporate", workstream: "legal", title: "Corporate documents and good standing", why: "Charter, prior financing documents, board consents." },
  { key: "legal.ip_assignment", workstream: "legal", title: "IP assigned to the company", why: "Founder and employee invention assignment agreements.", required: true },
  { key: "legal.litigation", workstream: "legal", title: "Litigation and liabilities", why: "Anything pending or threatened." },
  { key: "legal.government", workstream: "legal", title: "Government contracts and grants", why: "Public awards (SBIR, federal contracts) and their obligations.", predicates: ["contract.government", "grant.award"] },
  { key: "legal.certifications", workstream: "legal", title: "Regulatory approvals and certifications", why: "What the product needs to be sold and used.", predicates: ["compliance.certification"], applies: "regulated",
    ask: "Which certifications or approvals does the product need, and where are you in getting each?" },
  { key: "legal.export", workstream: "legal", title: "Export controls, CFIUS and outbound investment rules", why: "Treasury's Outbound Investment Security Program covers AI, semiconductors and quantum; also check EAR/ITAR and foreign ownership.",
    applies: "sensitive_tech", required: true,
    ask: "Does any part of the business, its investors or its suppliers involve China, Hong Kong or Macau, and is any of the technology export-controlled?" },

  // Fit
  { key: "fit.thesis", workstream: "fit", title: "Fit with your thesis", why: "Scored against the firm's current thesis.", auto: "fit", required: true },
  { key: "fit.conflicts", workstream: "fit", title: "Portfolio conflicts checked", why: "No competing portfolio company, or it's disclosed and accepted." },
];

export type ItemState = "missing" | "self_reported" | "evidenced" | "verified" | "done" | "na" | "red_flag" | "in_progress" | "open" | "manual" | "flagged";

export interface EvaluatedItem extends ChecklistItem {
  state: ItemState;
  /** Complete for IC purposes. */
  complete: boolean;
  claimIds: string[];
  noteCount: number;
  detail: string;
  assignee: string | null;
  note: string | null;
  person: { status: ItemStatus | null; by: string; at: string } | null;
  custom: boolean;
}

const INDEPENDENT: SourceType[] = ["primary", "third_party", "internal"];

export interface EvalInputs {
  claims: ClaimRow[];
  notes: { kind: NoteKind }[];
  flags: DealFlags;
  items: ItemRow[];
  fit: { verdict: string; score: number } | null;
  fundFit: { ok: boolean; detail: string } | null;
}

/** Evaluate every applicable item against the ledger and people's statuses. Pure. */
export function evaluateChecklist(x: EvalInputs): EvaluatedItem[] {
  const byKey = new Map(x.items.map((i) => [i.item_key, i]));
  const template = CHECKLIST.filter((i) => !i.applies || x.flags[i.applies]);
  const custom: ChecklistItem[] = x.items
    .filter((i) => i.custom)
    .map((i) => ({ key: i.item_key, workstream: i.workstream as Workstream, title: i.title ?? "Custom item", why: "Added by your team." }));
  return [...template, ...custom].map((item) => {
    const person = byKey.get(item.key);
    const claims = item.predicates ? x.claims.filter((c) => item.predicates!.includes(c.predicate)) : [];
    const noteCount = item.notes ? x.notes.filter((n) => item.notes!.includes(n.kind)).length : 0;
    let state: ItemState;
    let detail: string;
    if (item.auto === "fit") {
      state = x.fit ? "evidenced" : "missing";
      detail = x.fit ? `Scored ${x.fit.score} (${x.fit.verdict}) against your thesis.` : "Save your thesis to score this company.";
    } else if (item.auto === "fund_fit") {
      state = !x.fundFit ? "missing" : x.fundFit.ok ? "evidenced" : "flagged";
      detail = x.fundFit?.detail ?? "Enter the round and your intended check to run the math.";
    } else if (item.predicates) {
      const independent = claims.filter((c) => INDEPENDENT.includes(c.source_type));
      if (!claims.length) {
        state = "missing";
        detail = "Nothing in the ledger yet.";
      } else if (item.verify) {
        state = independent.length ? "verified" : "self_reported";
        detail = independent.length ? `${claims.length} ${plural(claims.length, "fact")}, ${independent.length} from an independent source.` : `${claims.length} ${plural(claims.length, "fact")}, only from the company so far.`;
      } else {
        state = "evidenced";
        detail = `${claims.length} ${plural(claims.length, "fact")} in the ledger.`;
      }
    } else if (item.notes) {
      const need = item.minNotes ?? 1;
      state = noteCount >= need ? "evidenced" : "missing";
      detail = `${noteCount} of ${need} ${plural(need, "note")} logged.`;
    } else {
      state = "manual";
      detail = "Checked by your team.";
    }
    if (person?.status) state = person.status;
    const complete = ["done", "na", "verified", "evidenced"].includes(state);
    return {
      ...item, state, complete, detail, claimIds: claims.map((c) => c.id), noteCount,
      assignee: person?.assignee ?? null, note: person?.note ?? null,
      person: person?.status ? { status: person.status, by: person.updated_by, at: person.updated_at } : null,
      custom: Boolean(person?.custom),
    };
  });
}

const plural = (n: number, w: string) => (n === 1 ? w : `${w}s`);

export interface Readiness {
  ready: boolean;
  complete: number;
  total: number;
  requiredOpen: { key: string; title: string }[];
  redFlags: { key: string; title: string }[];
  highContradictions: number;
  byWorkstream: { id: Workstream; label: string; complete: number; total: number }[];
}

/** Ready for IC: every required item complete (or not applicable), no red flags, no open high-severity conflicts. Pure. */
export function readiness(items: EvaluatedItem[], highContradictions: number): Readiness {
  const requiredOpen = items.filter((i) => i.required && !i.complete).map((i) => ({ key: i.key, title: i.title }));
  const redFlags = items.filter((i) => i.state === "red_flag").map((i) => ({ key: i.key, title: i.title }));
  return {
    ready: requiredOpen.length === 0 && redFlags.length === 0 && highContradictions === 0,
    complete: items.filter((i) => i.complete).length,
    total: items.length,
    requiredOpen,
    redFlags,
    highContradictions,
    byWorkstream: WORKSTREAMS.map((w) => {
      const mine = items.filter((i) => i.workstream === w.id);
      return { ...w, complete: mine.filter((i) => i.complete).length, total: mine.length };
    }).filter((w) => w.total > 0),
  };
}

/** Which extra sections apply, guessed from what the ledger says; a person can change them. Pure. */
export function suggestFlags(claims: ClaimRow[]): DealFlags {
  const text = claims
    .filter((c) => ["company.description", "company.sector", "tech.benchmark", "product.stage"].includes(c.predicate))
    .map((c) => String(typeof c.value === "string" ? c.value : JSON.stringify(c.value)))
    .join(" ")
    .toLowerCase();
  const has = (p: string) => claims.some((c) => c.predicate.startsWith(p));
  const hardware = has("unit_economics.bom_cost") || has("pilot.") || has("tech.manufacturing_readiness") ||
    /\b(robot\w*|hardware|device|sensor\w*|machine\w*|manufactur\w*|factory|drone\w*|vehicle\w*|battery|batteries|construction|industrial|equipment|reactor|satellite\w*)\b/.test(text);
  const regulated = has("compliance.") || /\b(medical|health|clinical|fda|aviation|faa|drone\w*|energy|grid|utility|utilities|nuclear|defense|defence|autonomous|vehicle\w*|construction|building code|insurance|bank\w*|fintech)\b/.test(text);
  const sensitive_tech = /\b(ai|artificial intelligence|machine learning|semiconductor\w*|chip\w*|quantum|robot\w*|autonomy|autonomous|defense|defence|drone\w*|satellite\w*|hypersonic)\b/.test(text);
  return { hardware, regulated, sensitive_tech };
}
