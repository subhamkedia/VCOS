import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchMeeting, type MatchContext } from "../../modules/meetings/match.js";
import type { MeetingPerson } from "../../connectors/meetings.js";

/**
 * Meeting-matcher eval. Every case is a meeting a person has labeled with
 * the company they'd file it under (or none). Reports accuracy and, most
 * important, wrong automatic matches: a call filed under the wrong company
 * without anyone asked. The gate is zero of those.
 *
 *   pnpm eval:meetings
 */

interface Case {
  id: string;
  meeting: { title: string; attendees: MeetingPerson[]; organizer?: MeetingPerson };
  expect: { status: string; company: string | null; newDomain?: string };
}

interface EvalSet {
  firmDomains: string[];
  companies: { id: string; name: string; domains: string[]; aliases: string[] }[];
  contacts: Record<string, string>;
  cases: Case[];
}

export function loadSet(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases.json")): EvalSet {
  return JSON.parse(readFileSync(file, "utf8")) as EvalSet;
}

export function contextFor(set: EvalSet): MatchContext {
  const byId = new Map(set.companies.map((c) => [c.id, c]));
  return {
    firmDomains: new Set(set.firmDomains),
    byDomain: new Map(set.companies.flatMap((c) => c.domains.map((d) => [d, { id: c.id, name: c.name }] as const))),
    byEmail: new Map(Object.entries(set.contacts).map(([email, id]) => [email, { id, name: byId.get(id)!.name }])),
    names: set.companies.flatMap((c) => c.aliases.map((alias) => ({ id: c.id, name: c.name, alias }))),
  };
}

export function runEval(set = loadSet()) {
  const ctx = contextFor(set);
  const results = set.cases.map((c) => {
    const out = matchMeeting(c.meeting, ctx);
    const ok = out.status === c.expect.status && out.companyId === c.expect.company && (!c.expect.newDomain || out.match.newDomain === c.expect.newDomain);
    const wrongAuto = out.status === "matched" && out.companyId !== c.expect.company;
    return { id: c.id, ok, wrongAuto, got: { status: out.status, company: out.companyId, newDomain: out.match.newDomain }, want: c.expect, reasons: out.match.reasons };
  });
  const correct = results.filter((r) => r.ok).length;
  return { cases: results.length, accuracy: correct / results.length, wrongAutoMatches: results.filter((r) => r.wrongAuto).length, failures: results.filter((r) => !r.ok) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = runEval();
  console.log(`Meeting matcher: ${(r.accuracy * 100).toFixed(1)}% of ${r.cases} cases, ${r.wrongAutoMatches} wrong automatic matches`);
  for (const f of r.failures) console.log(`  ${f.id}: got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}\n    ${f.reasons.join(" ")}`);
  const pass = r.wrongAutoMatches === 0 && r.accuracy >= 0.95;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
