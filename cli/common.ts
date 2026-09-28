import { connect, migrate, type Db } from "../lib/db.js";
import { companyProfile, findByIdentifier, findEntityByAlias, getEntity, type AccessScope } from "../ledger/repository.js";

export function parseArgs(argv = process.argv.slice(2)) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  return { positional, flags, str };
}

export async function openDb(): Promise<Db> {
  const db = await connect();
  await migrate(db);
  return db;
}

export async function run(main: () => Promise<void>) {
  try {
    await main();
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/** Find a company by domain, id, or name. */
export async function findCompany(db: Db, query: string) {
  if (/^[0-9a-f-]{36}$/i.test(query)) return getEntity(db, query);
  return (await findByIdentifier(db, "domain", query)) ?? findEntityByAlias(db, "company", query);
}

const fmt = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 10_000 ? v.toLocaleString("en-US") : String(v)) : typeof v === "string" ? v : JSON.stringify(v));

/** Print what the ledger knows about a company, grouped by predicate, with sources. */
export async function printCompany(db: Db, entityId: string, opts: { scopes?: AccessScope[] } = {}) {
  const p = await companyProfile(db, entityId, opts);
  console.log(`\n${p.entity.name}  (${p.entity.id})`);
  if (p.identifiers.length) console.log(p.identifiers.map((r) => `${r.kind}: ${r.value}`).join("  ·  "));
  if (opts.scopes) console.log(`Showing ${opts.scopes.join(", ")} claims only.`);

  const byPred = new Map<string, typeof p.claims>();
  for (const c of p.claims) byPred.set(c.predicate, [...(byPred.get(c.predicate) ?? []), c]);
  console.log("");
  for (const [pred, list] of [...byPred].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [i, c] of list.entries()) {
      const label = i === 0 ? pred.padEnd(28) : "".padEnd(28);
      const when = c.as_of ? ` as of ${c.as_of}` : "";
      console.log(`  ${label} ${fmt(c.value).slice(0, 60).padEnd(40)} ${c.source_type.padEnd(13)} ${c.evidence.source}/${c.evidence.kind}${when}`);
      if (c.cited_text) console.log(`  ${"".padEnd(28)}   “${c.cited_text.slice(0, 90)}”`);
    }
  }
  if (p.contradictions.length) {
    console.log(`\n  Open contradictions (${p.contradictions.length}):`);
    for (const o of p.contradictions) console.log(`    [${o.severity.toUpperCase()}] ${o.detail}`);
  } else console.log("\n  No open contradictions.");
}
