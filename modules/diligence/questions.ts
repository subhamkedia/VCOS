import type { ClaimRow } from "../../ledger/contradictions.js";
import type { QuestionOrigin } from "../../ledger/diligence.js";
import { formatValue } from "../../ledger/labels.js";
import type { EvaluatedItem, Workstream } from "./checklist.js";

/**
 * Questions for the next founder call, drawn from the ledger: what's
 * missing, what only the company has said, where sources disagree, and
 * pilots that haven't turned into contracts. Each has a stable key, so a
 * question keeps its status and answer as the ledger changes, and closes
 * itself when new evidence answers it. Pure.
 */

export interface GeneratedQuestion {
  key: string;
  workstream: Workstream;
  text: string;
  origin: QuestionOrigin;
  claimIds: string[];
}

const RUNG_ORDER = ["conversation", "unpaid_trial", "paid_pilot", "production_contract", "expansion"];

export function generateQuestions(x: {
  items: EvaluatedItem[];
  contradictions: { id: string; predicate: string; detail: string; claim_ids: string[] }[];
  claims: ClaimRow[];
}): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const i of x.items) {
    if (i.person && ["done", "na"].includes(i.person.status ?? "")) continue;
    if (i.state === "missing" && i.ask) out.push({ key: `gap:${i.key}`, workstream: i.workstream, text: i.ask, origin: "gap", claimIds: [] });
    if (i.state === "self_reported" && i.askVerify) out.push({ key: `verify:${i.key}`, workstream: i.workstream, text: i.askVerify, origin: "unverified", claimIds: i.claimIds });
  }
  for (const c of x.contradictions) {
    out.push({
      key: `contradiction:${c.id}`, workstream: workstreamOf(c.predicate),
      text: `Sources disagree. ${c.detail}. Which is right today, and what explains the difference?`,
      origin: "contradiction", claimIds: c.claim_ids,
    });
  }
  // Pilots below a production contract: what converts them?
  const latest = new Map<string, ClaimRow>();
  for (const c of x.claims.filter((c) => c.predicate === "pilot.status")) {
    const v = c.value as { customer: string; rung: string };
    const k = v.customer.toLowerCase();
    const prev = latest.get(k);
    if (!prev || RUNG_ORDER.indexOf(v.rung) > RUNG_ORDER.indexOf((prev.value as { rung: string }).rung)) latest.set(k, c);
  }
  for (const [k, c] of latest) {
    const v = c.value as { customer: string; rung: string };
    if (RUNG_ORDER.indexOf(v.rung) >= RUNG_ORDER.indexOf("production_contract")) continue;
    out.push({
      key: `pilot:${k}`, workstream: "traction", origin: "pilot", claimIds: [c.id],
      text: `${v.customer} is at "${formatValue("pilot.status", v).split(": ").pop()}". What are the success criteria, who signs the production contract, and by when?`,
    });
  }
  const runway = x.claims.filter((c) => c.predicate === "runway.months").pop();
  if (runway && Number(runway.value) < 12) {
    out.push({
      key: "risk:runway", workstream: "economics", origin: "risk", claimIds: [runway.id],
      text: `Runway is ${formatValue("runway.months", runway.value)} months. What happens if this round closes three months later than planned?`,
    });
  }
  return out;
}

export function workstreamOf(predicate: string): Workstream {
  if (/^(team|person)\./.test(predicate)) return "team";
  if (/^(market|competition)\./.test(predicate)) return "market";
  if (/^(product|tech|ip)\./.test(predicate)) return "product";
  if (/^(revenue|customers|pilot)\./.test(predicate)) return "traction";
  if (/^(unit_economics|burn|cash|runway)\./.test(predicate)) return "economics";
  if (/^(raise|funding)\./.test(predicate)) return "financing";
  if (/^(compliance|contract|grant)\./.test(predicate)) return "legal";
  return "fit";
}
