/**
 * Resolver eval. Loads known entities, runs the resolver on labeled
 * mentions, and scores each decision.
 *
 *   pnpm eval:resolver                       # synthetic demo set
 *   pnpm eval:resolver --set evals/resolver/real --gate 0.95
 *
 * A labeled set is a folder with entities.jsonl and cases.jsonl (see
 * evals/resolver/README.md). The Phase 0 gate is 95% on 200 real cases
 * and zero false merges.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPgliteDb, migrate, type Db } from "../../lib/db.js";
import { createEntity, insertClaim, insertEvidence, type IdentifierKind } from "../../ledger/repository.js";
import { resolve, type Candidate } from "../../agents/resolver/resolve.js";

interface SeedEntity {
  key: string;
  name: string;
  aliases?: string[];
  domain?: string;
  founders?: string[];
  location?: string;
}

interface Case {
  name: string;
  domain?: string;
  founders?: string[];
  location?: string;
  expected: string; // entity key, or "NEW"
  acceptReview?: boolean; // review pointing at the expected entity counts as correct
  mustReview?: boolean;   // only review counts: the record is genuinely ambiguous
  kind?: string;          // mention format, for the per-kind breakdown
  note?: string;
}

export type Verdict = "correct" | "false_merge" | "unsafe_auto_merge" | "missed_match" | "needless_review";

export interface CaseResult {
  case: Case;
  decision: string;
  got: string;
  probability: number;
  verdict: Verdict;
  explanation: string;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as T);
}

async function seed(db: Db, seeds: SeedEntity[]): Promise<Map<string, string>> {
  const keyById = new Map<string, string>();
  for (const s of seeds) {
    const identifiers: { kind: IdentifierKind; value: string }[] = s.domain ? [{ kind: "domain", value: s.domain }] : [];
    const e = await createEntity(db, { type: "company", name: s.name, source: "eval-seed", identifiers, aliases: s.aliases });
    keyById.set(e.id, s.key);
    if (s.founders?.length || s.location) {
      const { evidence } = await insertEvidence(db, { kind: "note", source: "eval-seed", content: JSON.stringify(s) });
      for (const f of s.founders ?? [])
        await insertClaim(db, { subjectId: e.id, predicate: "team.founder", value: f, evidenceId: evidence.id, sourceType: "internal", extractedBy: "eval-seed" });
      if (s.location)
        await insertClaim(db, { subjectId: e.id, predicate: "company.hq_location", value: s.location, evidenceId: evidence.id, sourceType: "internal", extractedBy: "eval-seed" });
    }
  }
  return keyById;
}

export function judge(c: Case, decision: string, gotKey: string): Verdict {
  if (c.expected === "NEW") {
    if (decision === "new") return "correct";
    if (decision === "review") return "needless_review";
    return "false_merge";
  }
  if (decision === "match") {
    if (gotKey !== c.expected) return "false_merge";
    return c.mustReview ? "unsafe_auto_merge" : "correct";
  }
  if (decision === "review") return (c.acceptReview || c.mustReview) && gotKey === c.expected ? "correct" : "needless_review";
  return "missed_match";
}

export async function runResolverEval(setDir: string): Promise<{ results: CaseResult[]; accuracy: number; falseMerges: number }> {
  const seeds = await readJsonl<SeedEntity>(path.join(setDir, "entities.jsonl"));
  const cases = await readJsonl<Case>(path.join(setDir, "cases.jsonl"));
  const db = await createPgliteDb();
  await migrate(db);
  const keyById = await seed(db, seeds);

  const results: CaseResult[] = [];
  for (const c of cases) {
    const { kind: _kind, note: _note, expected: _expected, acceptReview: _a, mustReview: _m, ...mention } = c;
    const candidate: Candidate = { type: "company", source: "eval", ...mention };
    const r = await resolve(db, candidate);
    const gotKey = r.entityId ? (keyById.get(r.entityId) ?? "?") : "NEW";
    results.push({
      case: c,
      decision: r.decision,
      got: r.decision === "new" ? "NEW" : gotKey,
      probability: r.probability,
      verdict: judge(c, r.decision, gotKey),
      explanation: r.explanation,
    });
  }
  await db.close();
  const correct = results.filter((r) => r.verdict === "correct").length;
  return {
    results,
    accuracy: results.length ? correct / results.length : 0,
    falseMerges: results.filter((r) => r.verdict === "false_merge" || r.verdict === "unsafe_auto_merge").length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const setDir = args.includes("--set") ? args[args.indexOf("--set") + 1]! : "evals/resolver/synthetic";
  const gate = args.includes("--gate") ? Number(args[args.indexOf("--gate") + 1]) : null;

  const { results, accuracy, falseMerges } = await runResolverEval(setDir);
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;

  console.log(`\nResolver eval: ${setDir} (${results.length} cases)\n`);
  for (const r of results) {
    const mark = r.verdict === "correct" ? "ok  " : r.verdict === "false_merge" ? "XX  " : "--  ";
    console.log(
      `${mark}${r.case.name.padEnd(28)} expected ${r.case.expected.padEnd(13)} got ${r.decision.padEnd(6)} ${r.got.padEnd(13)} p=${r.probability.toFixed(2)}`,
    );
    if (r.verdict !== "correct") console.log(`      ${r.verdict}: ${r.explanation}${r.case.note ? `  [${r.case.note}]` : ""}`);
  }
  console.log(`\nAccuracy        ${(accuracy * 100).toFixed(1)}%`);
  console.log(`False merges    ${falseMerges}   (the dangerous error: two companies become one)`);
  console.log(`Unsafe merges   ${count("unsafe_auto_merge")}   (right answer, but the evidence couldn't justify it)`);
  console.log(`Missed matches  ${count("missed_match")}`);
  console.log(`Needless review ${count("needless_review")}`);

  const kinds = [...new Set(results.map((r) => r.case.kind).filter((k): k is string => Boolean(k)))].sort();
  if (kinds.length) {
    console.log("\nBy mention kind");
    for (const k of kinds) {
      const rs = results.filter((r) => r.case.kind === k);
      const ok = rs.filter((r) => r.verdict === "correct").length;
      console.log(`  ${k.padEnd(15)} ${String(ok).padStart(4)}/${String(rs.length).padEnd(4)} ${((ok / rs.length) * 100).toFixed(1)}%`);
    }
  }

  if (gate !== null) {
    const pass = accuracy >= gate && falseMerges === 0 && results.length >= 200;
    console.log(
      `\nPhase 0 gate (>= ${gate * 100}% on >= 200 cases, zero false merges): ${pass ? "PASS" : "NOT YET"}` +
        (results.length < 200 ? ` — only ${results.length} cases; label more from your pipeline` : ""),
    );
    process.exitCode = pass ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
