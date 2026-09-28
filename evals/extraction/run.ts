/**
 * Extraction eval. Runs the real extractor (Claude API) over labeled
 * documents and scores precision, recall, citation validity, and
 * consistency across repeated runs (pass^k).
 *
 *   pnpm eval:extraction              # one run per fixture
 *   pnpm eval:extraction --runs 3     # pass^3: all three runs must be right
 *
 * Needs ANTHROPIC_API_KEY. Add fixtures from your own past deals; the Phase 1
 * gate is 95% precision on numbers.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createPgliteDb, migrate } from "../../lib/db.js";
import { claude, hasClaude } from "../../lib/llm.js";
import { createEntity, insertEvidence, type EvidenceKind } from "../../ledger/repository.js";
import { extractClaims } from "../../agents/extractor/index.js";

export interface Expected {
  predicate: string;
  value: unknown;
  optional?: boolean;
}

export interface Fixture {
  id: string;
  kind: EvidenceKind;
  title?: string;
  date?: string;
  subject: string;
  document: string;
  expected: Expected[];
  forbidden?: { predicate: string; reason: string }[];
}

export interface Got {
  predicate: string;
  value: unknown;
}

/** Values match if numbers are within 1%, strings share a normalized prefix, objects match field-wise. */
export function valuesMatch(expected: unknown, got: unknown): boolean {
  if (typeof expected === "number" && typeof got === "number") {
    const d = Math.max(Math.abs(expected), Math.abs(got));
    return d === 0 || Math.abs(expected - got) / d <= 0.01;
  }
  if (expected && got && typeof expected === "object" && typeof got === "object") {
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => valuesMatch(v, (got as Record<string, unknown>)[k]));
  }
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const e = norm(expected);
  const g = norm(got);
  return e === g || (e.length >= 4 && (g.startsWith(e) || e.startsWith(g)));
}

export function score(fx: Fixture, got: Got[]) {
  const used = new Set<number>();
  let hits = 0;
  const missed: Expected[] = [];
  for (const exp of fx.expected) {
    const i = got.findIndex((g, idx) => !used.has(idx) && g.predicate === exp.predicate && valuesMatch(exp.value, g.value));
    if (i >= 0) {
      used.add(i);
      hits++;
    } else if (!exp.optional) missed.push(exp);
  }
  const forbiddenHits = got.filter((g) => fx.forbidden?.some((f) => f.predicate === g.predicate));
  // Extra claims that match nothing expected count against precision.
  const extras = got.filter((_, idx) => !used.has(idx));
  const required = fx.expected.filter((e) => !e.optional).length;
  return {
    precision: got.length ? hits / got.length : 1,
    recall: required ? (required - missed.length) / required : 1,
    missed,
    extras,
    forbiddenHits,
    perfect: missed.length === 0 && forbiddenHits.length === 0 && extras.length === 0,
  };
}

async function runOnce(fx: Fixture) {
  const db = await createPgliteDb();
  await migrate(db);
  const subject = await createEntity(db, { type: "company", name: fx.subject, source: "eval" });
  const { evidence } = await insertEvidence(db, {
    kind: fx.kind, source: "eval", content: fx.document, title: fx.title, occurredAt: fx.date,
  });
  const out = await extractClaims(db, claude(), evidence.id, subject.id);
  const { rows } = await db.query<{ predicate: string; value: unknown; span_start: number; span_end: number; cited_text: string }>(
    "select predicate, value, span_start, span_end, cited_text from claims where evidence_id=$1", [evidence.id],
  );
  const citationsValid = rows.every((r) => fx.document.slice(r.span_start, r.span_end) === r.cited_text);
  await db.close();
  return { got: rows.map((r) => ({ predicate: r.predicate, value: r.value })), rejected: out.rejected, citationsValid };
}

async function main() {
  if (!hasClaude()) {
    console.log("ANTHROPIC_API_KEY is not set. The extraction eval calls the real model; add a key to .env and rerun.");
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 1;
  const dir = "evals/extraction/fixtures";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

  let tp = 0, total = 0, req = 0, found = 0, allPerfect = 0;
  for (const f of files) {
    const fx = JSON.parse(await readFile(path.join(dir, f), "utf8")) as Fixture;
    let perfectRuns = 0;
    for (let r = 0; r < runs; r++) {
      const { got, rejected, citationsValid } = await runOnce(fx);
      const s = score(fx, got);
      tp += Math.round(s.precision * got.length);
      total += got.length;
      const required = fx.expected.filter((e) => !e.optional).length;
      req += required;
      found += required - s.missed.length;
      if (s.perfect && citationsValid) perfectRuns++;
      console.log(`\n${fx.id} run ${r + 1}: precision ${(s.precision * 100).toFixed(0)}%  recall ${(s.recall * 100).toFixed(0)}%  citations ${citationsValid ? "valid" : "INVALID"}`);
      for (const m of s.missed) console.log(`  missed   ${m.predicate} = ${JSON.stringify(m.value)}`);
      for (const e of s.extras) console.log(`  extra    ${e.predicate} = ${JSON.stringify(e.value)}`);
      for (const b of s.forbiddenHits) console.log(`  FORBIDDEN ${b.predicate} = ${JSON.stringify(b.value)}`);
      for (const rj of rejected) console.log(`  rejected ${rj.line} (${rj.reason})`);
    }
    if (perfectRuns === runs) allPerfect++;
  }
  console.log(`\nOverall precision ${total ? ((tp / total) * 100).toFixed(1) : "n/a"}%  recall ${req ? ((found / req) * 100).toFixed(1) : "n/a"}%`);
  console.log(`pass^${runs}: ${allPerfect}/${files.length} fixtures perfect on every run`);
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
