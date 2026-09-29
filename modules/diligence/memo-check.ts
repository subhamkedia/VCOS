import { parseNumber } from "../../ledger/predicates.js";

/**
 * The citation check for IC memos: principle 2 ("every output cites"),
 * enforced in code rather than asked of a model.
 *
 * - A fact sentence must cite at least one claim (or a calculation done in
 *   code), and every citation must exist in the set the memo was allowed to
 *   use. A shareable memo is only allowed public claims.
 * - Every number in a sentence must match a value in what it cites, at the
 *   precision it's written ("$4.1M" matches 4,100,000 and 4,120,000, not
 *   4,300,000). A made-up or mistyped number is rejected.
 * - A view sentence (the team's judgment) may cite, but can't carry a
 *   number that isn't grounded the same way.
 *
 * Rejected sentences are dropped from the memo and listed, so the person
 * reviewing it sees exactly what the drafter tried to say without support.
 */

export interface MemoSentence {
  text: string;
  cites: string[];
  kind: "fact" | "view";
}

export interface MemoSection {
  id: string;
  heading: string;
  sentences: MemoSentence[];
}

export interface MemoDoc {
  title: string;
  sections: MemoSection[];
}

/** Something a sentence may cite: a claim, or a calculation done in code ("calc:ownership"). */
export interface Citable {
  id: string;
  label: string;
  /** Numbers a sentence citing this may state. */
  values: number[];
  /** Dates it may state, YYYY-MM-DD or YYYY-MM. */
  dates: string[];
}

export interface Rejection {
  section: string;
  text: string;
  reason: string;
}

export interface CheckResult {
  ok: boolean;
  sentences: number;
  facts: number;
  cited: number;
  citations: number;
  rejected: Rejection[];
}

// "$4.1M", "12,500", "34%", "1.2bn", "5.0%": a number with an optional currency and scale.
const NUMBER = /(?<![\w.])([$€£]?\s?\d[\d,]*(?:\.\d+)?)(\s?(?:k|m|mm|mn|bn|b|million|billion|thousand)\b|%)?/gi;
const ISO_DATE = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g;

export interface WrittenNumber {
  raw: string;
  value: number;
  /** Half a unit in the last written digit, at the written scale. */
  tolerance: number;
}

/** Numbers as written in a sentence, with the precision each was written to. Dates are handled separately. Pure. */
export function numbersIn(text: string): WrittenNumber[] {
  const out: WrittenNumber[] = [];
  const clean = text.replace(ISO_DATE, " ");
  for (const m of clean.matchAll(NUMBER)) {
    const raw = `${m[1]}${m[2] ?? ""}`.trim();
    const value = parseNumber(raw.replace(/\s/g, ""));
    if (value === null) continue;
    const digits = m[1]!.replace(/[$€£\s,]/g, "");
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    const scale = (() => {
      const s = (m[2] ?? "").trim().toLowerCase();
      if (["k", "thousand"].includes(s)) return 1e3;
      if (["m", "mm", "mn", "million"].includes(s)) return 1e6;
      if (["b", "bn", "billion"].includes(s)) return 1e9;
      return 1;
    })();
    out.push({ raw, value, tolerance: 0.5 * 10 ** -decimals * scale });
  }
  return out;
}

export function datesIn(text: string): string[] {
  return [...text.matchAll(ISO_DATE)].map((m) => m[0]);
}

/** Every number in a string value ("US 11999001: ...", "$199,500, 2025"). */
export function valuesFrom(v: unknown): number[] {
  if (typeof v === "number") return [v];
  if (typeof v === "string") return numbersIn(v).map((n) => n.value);
  if (v && typeof v === "object") return Object.values(v).flatMap(valuesFrom);
  return [];
}

function grounded(n: WrittenNumber, cited: Citable[]): boolean {
  return cited.some((c) =>
    c.values.some((v) => Math.abs(n.value - v) <= n.tolerance + 1e-9) ||
    c.dates.some((d) => Number(d.slice(0, 4)) === n.value && n.tolerance <= 0.5),
  );
}

export function checkMemo(doc: MemoDoc, allowed: Map<string, Citable>): { doc: MemoDoc; result: CheckResult } {
  const rejected: Rejection[] = [];
  let sentences = 0;
  let facts = 0;
  let cited = 0;
  let citations = 0;
  const sections = doc.sections.map((s) => ({
    ...s,
    sentences: s.sentences.filter((x) => {
      sentences++;
      if (x.kind === "fact") facts++;
      const reject = (reason: string) => {
        rejected.push({ section: s.heading, text: x.text, reason });
        return false;
      };
      if (!x.text.trim()) return reject("Empty sentence.");
      const unknown = x.cites.filter((id) => !allowed.has(id));
      if (unknown.length) return reject(`Cites something this memo can't use (${unknown.join(", ")}): unknown, superseded or out of scope.`);
      const cites = x.cites.map((id) => allowed.get(id)!);
      if (x.kind === "fact" && !cites.length) return reject("A factual sentence with no citation.");
      for (const n of numbersIn(x.text)) {
        if (!grounded(n, cites)) return reject(`"${n.raw}" isn't in what the sentence cites.`);
      }
      for (const d of datesIn(x.text)) {
        if (!cites.some((c) => c.dates.some((cd) => cd.startsWith(d) || d.startsWith(cd)))) return reject(`The date ${d} isn't in what the sentence cites.`);
      }
      if (cites.length) {
        cited++;
        citations += cites.length;
      }
      return true;
    }),
  }));
  return { doc: { ...doc, sections }, result: { ok: rejected.length === 0, sentences, facts, cited, citations, rejected } };
}
