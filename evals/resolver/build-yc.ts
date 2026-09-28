/**
 * Build the Phase 0 resolver gate from YC's 2026 batches.
 *
 *   pnpm eval:resolver:build-yc                        # fetch, snapshot, build
 *   pnpm eval:resolver:build-yc --from-snapshot        # rebuild offline from snapshot.json
 *   pnpm eval:resolver:build-yc --batches W26,X26,S26 --size 200 --seed yc2026
 *
 * Writes evals/resolver/yc2026/{entities,cases}.jsonl, snapshot.json (the
 * raw data used) and SUMMARY.md. Then run the gate:
 *
 *   pnpm eval:resolver --set evals/resolver/yc2026 --gate 0.95
 *
 * Network: yc-oss.github.io, www.ycombinator.com, hn.algolia.com.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, run } from "../../cli/common.js";
import { batchCode, batchSlug, fetchLaunchPosts, fetchYcAll, fetchYcBatch, fetchYcFounders, type LaunchPost, type YcCompany } from "../../connectors/yc.js";
import { HttpError } from "../../connectors/http.js";
import { buildGateSet, type GateCase } from "./yc-gate.js";

interface Snapshot {
  fetchedAt: string;
  batches: string[];
  companies: YcCompany[];
  launches: LaunchPost[];
  pool: YcCompany[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSnapshot(batches: string[], withFounders: boolean): Promise<Snapshot> {
  const companies: YcCompany[] = [];
  const found: string[] = [];
  for (const b of batches) {
    try {
      const list = await fetchYcBatch(b);
      console.log(`  ${batchSlug(b)}: ${list.length} companies`);
      if (list.length) found.push(b);
      companies.push(...list);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) console.log(`  ${batchSlug(b)}: not published yet, skipped`);
      else throw err;
    }
  }
  if (!companies.length) throw new Error("No companies fetched. Is yc-oss.github.io reachable?");

  if (withFounders) {
    console.log(`  founders: fetching ${companies.length} company pages (about 4 a second)`);
    let failed = 0;
    for (const [i, c] of companies.entries()) {
      try {
        c.founders = await fetchYcFounders(c.slug);
      } catch {
        failed++;
      }
      if ((i + 1) % 50 === 0) console.log(`    ${i + 1}/${companies.length}`);
      await sleep(250);
    }
    if (failed) console.log(`    ${failed} pages failed; those companies have no founders listed`);
  }

  const launches: LaunchPost[] = [];
  for (const b of found) {
    try {
      const posts = await fetchLaunchPosts(batchCode(batchSlug(b)));
      console.log(`  Launch HN ${batchCode(batchSlug(b))}: ${posts.length} posts`);
      launches.push(...posts);
    } catch (err) {
      console.log(`  Launch HN: skipped (${(err as Error).message.slice(0, 80)})`);
    }
  }

  let pool: YcCompany[] = [];
  try {
    const slugs = new Set(companies.map((c) => c.slug));
    pool = (await fetchYcAll()).filter((c) => !slugs.has(c.slug));
    console.log(`  look-alike pool: ${pool.length} other YC companies`);
  } catch (err) {
    console.log(`  look-alike pool: skipped (${(err as Error).message.slice(0, 80)})`);
  }
  return { fetchedAt: new Date().toISOString(), batches: found, companies, launches, pool };
}

function summary(snap: Snapshot, entities: number, cases: GateCase[], selected: YcCompany[], seed: string): string {
  const count = <T,>(xs: T[], f: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  };
  return [
    "# YC 2026 resolver gate set",
    "",
    `Built from YC's public directory (yc-oss mirror), company pages on ycombinator.com and Launch HN posts, fetched ${snap.fetchedAt.slice(0, 10)}. Seed \`${seed}\`.`,
    "",
    `- Companies drawn: **${selected.length}** (${count(selected, (c) => batchCode(c.batch)).map(([b, n]) => `${b} ${n}`).join(", ")})`,
    `- Known to the fund (entities.jsonl): **${entities}**; held out as never seen: **${selected.length - entities}**`,
    `- Cases: **${cases.length}**`,
    "",
    "| Case kind | Count | Expected | Where the text comes from |",
    "| --- | --- | --- | --- |",
    ...count(cases, (c) => c.kind).map(([k, n]) => `| ${k} | ${n} | ${KIND_NOTES[k as GateCase["kind"]]} |`),
    "",
    "Labels come from YC's identity for each company (its directory slug), not from the resolver.",
    "`launch_hn`, `former_name`, `new_company` and `lookalike` cases are real text. `website`, `legal_name`,",
    "`founder_intro` and `typo` put real names, domains and founders into the formats they arrive in.",
    "Spot-check a sample of cases.jsonl before relying on the result; fix labels only where YC's data is wrong.",
    "",
  ].join("\n");
}

const KIND_NOTES: Record<GateCase["kind"], string> = {
  website: "match | company name + website, as from a data vendor",
  legal_name: "match or review | NAME, INC. + city, as on a Form D",
  founder_intro: "match | name + one founder, as in an intro email",
  typo: "match or review | one swapped letter + founders",
  launch_hn: "match or review | the name as written in the company's Launch HN title",
  former_name: "match or review | a real former name + founders (rebrand)",
  new_company: "NEW | a 2026 company held out of the CRM",
  lookalike: "NEW | a YC company from another batch with a similar name",
};

run(async () => {
  const { flags, str } = parseArgs();
  const out = str("out") ?? "evals/resolver/yc2026";
  const seed = str("seed") ?? "yc2026";
  const size = Number(str("size") ?? 200);
  const batches = (str("batches") ?? "W26,X26,S26,F26").split(",").map((b) => b.trim()).filter(Boolean);
  await mkdir(out, { recursive: true });
  const snapFile = path.join(out, "snapshot.json");

  let snap: Snapshot;
  if (flags["from-snapshot"]) {
    snap = JSON.parse(await readFile(snapFile, "utf8")) as Snapshot;
    console.log(`Using ${snapFile} (fetched ${snap.fetchedAt.slice(0, 10)})`);
  } else {
    console.log(`Fetching YC batches ${batches.join(", ")}`);
    snap = await fetchSnapshot(batches, !flags["no-founders"]);
    await writeFile(snapFile, JSON.stringify(snap, null, 1) + "\n");
  }

  const { entities, cases, selected } = buildGateSet({ companies: snap.companies, launches: snap.launches, pool: snap.pool, size, seed });
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(path.join(out, "entities.jsonl"), jsonl(entities));
  await writeFile(path.join(out, "cases.jsonl"), jsonl(cases));
  await writeFile(path.join(out, "SUMMARY.md"), summary(snap, entities.length, cases, selected, seed));
  console.log(`\nWrote ${entities.length} entities and ${cases.length} cases to ${out}/`);
  console.log(`Run the gate: pnpm eval:resolver --set ${out} --gate 0.95`);
});
