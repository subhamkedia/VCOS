import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createPgliteDb, migrate } from "../lib/db.js";
import { claude, hasClaude, type Llm } from "../lib/llm.js";
import { replayLlm } from "../lib/replay-llm.js";
import { ingest } from "../connectors/ingest.js";
import { harmonicToRecord } from "../connectors/harmonic.js";
import { formDToRecord } from "../connectors/edgar.js";
import { htmlToText } from "../connectors/web.js";
import { transcriptFromFile } from "../connectors/transcripts.js";
import { resolveOrCreate } from "../agents/resolver/index.js";
import { recordDecision, SHAREABLE_SCOPES } from "../ledger/repository.js";
import { printCompany, run } from "./common.js";

/**
 * Offline walk-through of Phase 0 on fictional data, in a throwaway
 * in-memory database. Uses real Claude for extraction if ANTHROPIC_API_KEY
 * is set; otherwise replays scripted extractions so it runs anywhere.
 */
run(async () => {
  const live = hasClaude() && !process.argv.includes("--replay");
  const llm: Llm = live
    ? claude()
    : replayLlm({
        "We closed September": [
          ["CLAIM | revenue.arr | 4100000 | 2026-09-30 | self_reported | ", "We closed September at $4.1M ARR."],
          ["CLAIM | team.headcount | 34 |  | self_reported | ", "We're 34 people now."],
        ],
        "Kestrel Robotics today announced": [
          ["CLAIM | funding.round.amount | 9000000 | 2026-06-10 | third_party | ", "Kestrel Robotics today announced a $9 million Series A led by Ironbridge Ventures."],
          ["CLAIM | funding.round.stage | series_a | 2026-06-10 | third_party | ", "Kestrel Robotics today announced a $9 million Series A led by Ironbridge Ventures."],
          ["CLAIM | team.headcount | 18 | 2026-06-10 | third_party | ", "The company employs 18 people."],
        ],
      });

  const step = (n: number, s: string) => console.log(`\n── ${n}. ${s}`);
  console.log(`VC OS Phase 0 demo — fictional data, in-memory database, extraction: ${live ? "live Claude" : "replay (set ANTHROPIC_API_KEY for live)"}`);
  const db = await createPgliteDb();
  await migrate(db);
  const fx = (f: string) => readFile(`tests/fixtures/${f}`, "utf8");

  step(1, "Harmonic enrichment creates the company");
  const h = await ingest(db, harmonicToRecord(JSON.parse(await fx("harmonic-company.json")), "2026-09-20T00:00:00Z"));
  const id = h.subject!.entity.id;
  console.log(`   ${h.subject!.entity.name}: ${h.structuredClaims} claims from Harmonic (vendor scope)`);

  step(2, "SEC Form D resolves to the same company by name and city");
  const f = await ingest(db, formDToRecord(await fx("formd.xml"), { cik: "0001999001", adsh: "0001999001-26-000002", fileDate: "2026-06-15" }));
  console.log(`   ${f.subject!.resolution.decision} (${f.subject!.resolution.explanation})`);
  console.log(`   $8.75M sold per the filing vs $9M announced: within tolerance, no contradiction`);

  step(3, "A press article is snapshotted and read by the extractor");
  const { title, text } = htmlToText(await fx("press.html"));
  const p = await ingest(
    db,
    { evidence: { kind: "web_page", source: "web", uri: "https://buildweekly.example/kestrel", title: title ?? "press", content: text, accessScope: "public", occurredAt: "2026-06-10" },
      subject: { type: "company", name: "Kestrel Robotics", source: "web" }, extract: true },
    { llm },
  );
  console.log(`   ${p.extraction?.claimIds.length ?? 0} cited claims extracted`);

  step(4, "A founder call transcript is ingested");
  const t = await ingest(db, await transcriptFromFile("tests/fixtures/call.vtt", { company: "Kestrel", companyDomain: "kestrelrobotics.com", date: "2026-10-02" }), { llm });
  console.log(`   matched by domain; ${t.extraction?.claimIds.length ?? 0} cited claims`);
  for (const c of t.contradictions) console.log(`   CONTRADICTION [${c.severity}] ${c.detail}`);

  step(5, "The resolver handles a typo and a look-alike");
  const typo = await resolveOrCreate(db, { type: "company", name: "Kestral Robotics", founders: ["Maya Lindqvist"], source: "accelerator-cohort" });
  console.log(`   "Kestral Robotics" + founder Maya Lindqvist -> ${typo.resolution.decision}: ${typo.resolution.explanation}`);
  const other = await resolveOrCreate(db, { type: "company", name: "Kestrel Energy", domain: "kestrelenergy.com", founders: ["Paul Grant"], source: "accelerator-cohort" });
  console.log(`   "Kestrel Energy" -> ${other.resolution.decision}: ${other.resolution.explanation}`);

  step(6, "Judgment is logged as data");
  await recordDecision(db, { entityId: other.entity.id, kind: "pass", actor: "demo", reasonCode: "thesis_fit", rationale: "Energy storage, outside thesis." });
  console.log(`   pass on Kestrel Energy recorded with reason code thesis_fit`);

  step(7, "What the ledger now knows");
  await printCompany(db, id);

  step(8, "The shareable view: public sources only, filtered in SQL");
  await printCompany(db, id, { scopes: SHAREABLE_SCOPES });
  await db.close();
});
