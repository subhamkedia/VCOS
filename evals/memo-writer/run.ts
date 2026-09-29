import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMemo, type Citable } from "../../modules/diligence/memo-check.js";

/**
 * Memo citation-check eval: labeled sentences, each with the claims it
 * cites and whether a careful reviewer would let it stand. The gate is 100%:
 * the check is code, and every case is a rule.
 *
 *   pnpm eval:memo
 */

interface EvalSet {
  claims: Record<string, { label: string; values: number[]; dates: string[] }>;
  cases: { text: string; cites: string[]; kind: "fact" | "view"; ok: boolean; why?: string }[];
}

export function runMemoEval(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases.json")) {
  const set = JSON.parse(readFileSync(file, "utf8")) as EvalSet;
  const allowed = new Map<string, Citable>(Object.entries(set.claims).map(([id, c]) => [id, { id, ...c }]));
  const results = set.cases.map((c) => {
    const { result } = checkMemo({ title: "t", sections: [{ id: "s", heading: "S", sentences: [{ text: c.text, cites: c.cites, kind: c.kind }] }] }, allowed);
    return { ...c, got: result.ok, reason: result.rejected[0]?.reason };
  });
  const wrong = results.filter((r) => r.got !== r.ok);
  return { cases: results.length, accuracy: (results.length - wrong.length) / results.length, wrong };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = runMemoEval();
  console.log(`Memo citation check: ${(r.accuracy * 100).toFixed(1)}% of ${r.cases} cases`);
  for (const w of r.wrong) console.log(`  "${w.text}": got ${w.got ? "accepted" : `rejected (${w.reason})`}, want ${w.ok ? "accepted" : `rejected (${w.why})`}`);
  process.exit(r.wrong.length ? 1 : 0);
}
