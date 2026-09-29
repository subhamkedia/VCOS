import { formatValue, predicateLabel, sourceTypeLabel } from "../../ledger/labels.js";
import { PREDICATES } from "../../ledger/predicates.js";
import { checkMemo, numbersIn, valuesFrom, type Citable, type MemoDoc, type MemoSection, type MemoSentence } from "./memo-check.js";

/**
 * The IC memo, drafted from the ledger. The deterministic writer turns
 * claims into plain sentences, each citing the claims it states; the
 * Claude writer (agents/memo-writer) can do better prose from the same
 * inputs. Both go through the same citation check before anything is saved.
 *
 * Drafting reads claims, never raw evidence: a deck or transcript can't
 * talk to the memo writer.
 */

export const WRITER_VERSION = "memo-writer:deterministic@1";

export interface MemoClaim {
  id: string;
  predicate: string;
  value: unknown;
  as_of: string | null;
  source_type: string;
  evidence: { source: string; title: string | null; occurred_at: string | null };
}

export interface Calc {
  id: string;
  label: string;
  text: string;
  values: number[];
}

export interface MemoInputs {
  company: string;
  claims: MemoClaim[];
  contradictions: { id: string; detail: string; claim_ids: string[] }[];
  calcs: Calc[];
  openItems: string[];
  redFlags: string[];
  shareable: boolean;
}

/** "$12M", "$4.1M", "$750K": short money a reader expects in a memo. */
export function shortMoney(n: number): string {
  const abs = Math.abs(n);
  const fmt = (x: number) => (Number.isInteger(Math.round(x * 10) / 10) ? String(Math.round(x)) : (Math.round(x * 10) / 10).toFixed(1));
  if (abs >= 1e9) return `$${fmt(n / 1e9)}B`;
  if (abs >= 1e6) return `$${fmt(n / 1e6)}M`;
  if (abs >= 1e4) return `$${fmt(n / 1e3)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

/** A claim's value the way a memo says it. */
export function say(c: Pick<MemoClaim, "predicate" | "value">): string {
  const def = PREDICATES.get(c.predicate);
  if (def?.kind === "money" && typeof c.value === "number") return shortMoney(c.value);
  return formatValue(c.predicate, c.value);
}

const titleNumbers = (c: MemoClaim) => (c.evidence.title ? numbersIn(c.evidence.title).map((n) => n.value) : []);

/** What a memo may cite: its claims (with the numbers and dates each carries) and the calculations. */
export function citables(x: Pick<MemoInputs, "claims" | "calcs">): Map<string, Citable> {
  const m = new Map<string, Citable>();
  for (const c of x.claims) {
    m.set(c.id, {
      id: c.id, label: predicateLabel(c.predicate),
      values: [...valuesFrom(c.value), ...titleNumbers(c)],
      dates: [c.as_of, c.evidence.occurred_at?.slice(0, 10)].filter((d): d is string => Boolean(d)),
    });
  }
  for (const k of x.calcs) m.set(k.id, { id: k.id, label: k.label, values: [...k.values, ...numbersIn(k.text).map((n) => n.value)], dates: [] });
  return m;
}

function source(c: MemoClaim): string {
  const who = sourceTypeLabel(c.source_type).toLowerCase();
  const where = c.evidence.title ?? c.evidence.source;
  return `${who}, ${where}${c.as_of ? `, as of ${c.as_of}` : ""}`;
}

const INDEPENDENT = ["primary", "third_party", "internal"];

/** The deterministic draft. Every fact sentence cites the claims it states. Pure. */
export function draftMemo(x: MemoInputs): MemoDoc {
  const byPred = (p: string) => x.claims.filter((c) => c.predicate === p);
  const one = (p: string) => byPred(p).at(-1);
  const fact = (text: string, cites: string[]): MemoSentence => ({ text, cites, kind: "fact" });
  // One sentence per fact, however many sources state it: newest first, each with who said it.
  const each = (preds: string[], opts: { verify?: boolean } = {}): MemoSentence[] =>
    preds.flatMap((p) => {
      const cs = byPred(p);
      if (!cs.length) return [];
      const def = PREDICATES.get(p);
      if (def?.cardinality === "many" && p !== "pilot.status") {
        return [fact(`${predicateLabel(p)}: ${[...new Set(cs.map(say))].join("; ")}.`, cs.map((c) => c.id))];
      }
      const sorted = [...cs].sort((a, b) => (b.as_of ?? "").localeCompare(a.as_of ?? ""));
      const unverified = opts.verify && !cs.some((o) => INDEPENDENT.includes(o.source_type));
      const values = sorted.map((c) => `${say(c)} (${source(c)})`);
      const text = values.length === 1
        ? `${predicateLabel(p)}: ${values[0]}.`
        : `${predicateLabel(p)}, by source: ${values.join("; ")}.`;
      return [fact(`${text}${unverified ? " Not yet verified by an independent source." : ""}`, sorted.map((c) => c.id))];
    });

  const sections: MemoSection[] = [];
  const add = (id: string, heading: string, sentences: MemoSentence[]) => {
    if (sentences.length) sections.push({ id, heading, sentences });
  };

  // Summary
  const summary: MemoSentence[] = [];
  const desc = one("company.description");
  if (desc) summary.push(fact(`${x.company}: ${String(desc.value).replace(/\.$/, "")}.`, [desc.id]));
  const founded = one("company.founded_year");
  const hq = one("company.hq_location");
  if (founded && hq) summary.push(fact(`Founded in ${founded.value} and based in ${hq.value}.`, [founded.id, hq.id]));
  else if (founded) summary.push(fact(`Founded in ${founded.value}.`, [founded.id]));
  else if (hq) summary.push(fact(`Based in ${hq.value}.`, [hq.id]));
  const raise = one("raise.amount");
  const stage = one("raise.stage");
  const pre = one("raise.pre_money");
  const lead = one("raise.lead_investor");
  if (raise || stage || pre) {
    const parts = [
      raise ? `Raising ${say(raise)}` : "Raising",
      stage ? ` in a ${say(stage)} round` : "",
      pre ? ` at a proposed ${say(pre)} pre-money valuation` : "",
      lead ? `, led by ${say(lead)}` : "",
    ];
    summary.push(fact(`${parts.join("")}.`, [raise, stage, pre, lead].filter(Boolean).map((c) => c!.id)));
  }
  const round = x.calcs.find((k) => k.id === "calc:round");
  if (round && !x.shareable) summary.push(fact(round.text, [round.id]));
  if (!x.shareable) summary.push({ text: "Recommendation: for the deal team to write.", cites: [], kind: "view" });
  add("summary", "Summary", summary);

  add("team", "Team", [
    ...each(["team.founder", "team.headcount", "team.key_hire", "team.open_roles"], { verify: true }),
    ...x.calcs.filter((k) => k.id === "calc:references" && !x.shareable).map((k) => fact(k.text, [k.id])),
  ]);
  add("market", "Market and competition", [
    ...byPred("market.tam").map((c) => fact(`Total addressable market as claimed: ${say(c)} (${source(c)}). Rebuild it bottom-up before relying on it.`, [c.id])),
    ...each(["competition.competitor"]),
  ]);
  add("product", "Product and technology", each(["product.stage", "tech.readiness_level", "tech.manufacturing_readiness", "tech.benchmark", "ip.patent", "ip.patent_count", "compliance.certification"], { verify: true }));
  add("traction", "Customers and traction", [
    ...each(["revenue.arr", "revenue.annual", "revenue.growth_yoy", "customers.paying.count"], { verify: true }),
    ...each(["customers.named"]),
    ...byPred("pilot.status").map((c) => fact(`Pilot or deployment: ${say(c)} (${source(c)}).`, [c.id])),
    ...each(["pilot.site_count", "revenue.contracted_backlog", "contract.government", "grant.award"]),
  ]);
  add("economics", "Business model and unit economics", each(["unit_economics.gross_margin", "unit_economics.asp", "unit_economics.bom_cost", "burn.monthly", "cash.balance", "runway.months"], { verify: true }));
  add("history", "Financing history", each(["funding.total_raised", "funding.round.stage", "funding.round.amount", "funding.round.post_money", "funding.investor"]));

  if (!x.shareable) {
    add("fit", "Fit with the fund", x.calcs.filter((k) => k.id.startsWith("calc:fit") || k.id.startsWith("calc:check:")).map((k) => fact(k.text, [k.id])));
  }
  add("conflicts", "Where sources disagree", x.contradictions.map((c) => fact(`${c.detail}.`, c.claim_ids)));
  if (!x.shareable) {
    const risks: MemoSentence[] = [
      ...(x.redFlags.length ? [{ text: `Red ${x.redFlags.length === 1 ? "flag" : "flags"}: ${x.redFlags.join("; ")}.`, cites: [], kind: "view" as const }] : []),
      ...(x.openItems.length ? [{ text: `Required diligence still open: ${x.openItems.join("; ")}.`, cites: [], kind: "view" as const }] : []),
    ];
    add("risks", "Risks and open diligence", risks.filter((r) => !/\d/.test(r.text)));
    const status = x.calcs.find((k) => k.id === "calc:status");
    if (status) add("status", "Diligence status", [fact(status.text, [status.id])]);
  }
  return { title: `${x.company}: investment memo${x.shareable ? " (shareable)" : ""}`, sections };
}

/** Draft deterministically and check it. */
export function draftAndCheck(x: MemoInputs) {
  return checkMemo(draftMemo(x), citables(x));
}

/** The memo as Markdown, with numbered footnotes for every citation. */
export function memoMarkdown(doc: MemoDoc, sources: Map<string, string>): string {
  const notes: string[] = [];
  const noteOf = new Map<string, number>();
  const ref = (id: string) => {
    if (!noteOf.has(id)) {
      notes.push(sources.get(id) ?? id);
      noteOf.set(id, notes.length);
    }
    return `[^${noteOf.get(id)}]`;
  };
  const body = doc.sections
    .map((s) => `## ${s.heading}\n\n${s.sentences.map((x) => `${x.kind === "view" ? `_${x.text}_` : x.text}${x.cites.map(ref).join("")}`).join(" ")}`)
    .join("\n\n");
  return `# ${doc.title}\n\n${body}\n\n${notes.map((n, i) => `[^${i + 1}]: ${n}`).join("\n")}\n`;
}
