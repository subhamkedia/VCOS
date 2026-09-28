import { connect, migrate, type Db } from "../lib/db.js";
import { currentClaims, openContradictions, findByIdentifier, getEntity } from "../ledger/repository.js";
import { normalizeCompanyName } from "../lib/text.js";

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
  const byDomain = await findByIdentifier(db, "domain", query);
  if (byDomain) return byDomain;
  const { rows } = await db.query<{ entity_id: string }>(
    `select a.entity_id from entity_aliases a join entities e on e.id=a.entity_id
      where e.merged_into is null and a.normalized = $1 limit 1`,
    [normalizeCompanyName(query)],
  );
  return rows[0] ? getEntity(db, rows[0].entity_id) : null;
}

const fmt = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 10_000 ? v.toLocaleString("en-US") : String(v)) : typeof v === "string" ? v : JSON.stringify(v));

/** Print what the ledger knows about a company, grouped by predicate, with sources. */
export async function printCompany(db: Db, entityId: string) {
  const e = await getEntity(db, entityId);
  if (!e) throw new Error(`No entity ${entityId}`);
  const ids = await db.query<{ kind: string; value: string }>(
    "select kind, value from entity_identifiers where entity_id in (select id from entities where id=$1 or merged_into=$1)", [e.id],
  );
  console.log(`\n${e.name}  (${e.id})`);
  if (ids.rows.length) console.log(ids.rows.map((r) => `${r.kind}: ${r.value}`).join("  ·  "));

  const claims = await currentClaims(db, e.id);
  const sources = await db.query<{ id: string; source: string; kind: string }>(
    "select id, source, kind from evidence where id = any($1::uuid[])", [[...new Set(claims.map((c) => c.evidence_id))]],
  );
  const src = new Map(sources.rows.map((r) => [r.id, `${r.source}/${r.kind}`]));
  const byPred = new Map<string, typeof claims>();
  for (const c of claims) byPred.set(c.predicate, [...(byPred.get(c.predicate) ?? []), c]);
  console.log("");
  for (const [pred, list] of [...byPred].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [i, c] of list.entries()) {
      const label = i === 0 ? pred.padEnd(28) : "".padEnd(28);
      const when = c.as_of ? ` as of ${c.as_of}` : "";
      console.log(`  ${label} ${fmt(c.value).slice(0, 60).padEnd(40)} ${c.source_type.padEnd(13)} ${src.get(c.evidence_id) ?? ""}${when}`);
      if (c.cited_text) console.log(`  ${"".padEnd(28)}   “${c.cited_text.slice(0, 90)}”`);
    }
  }
  const open = await openContradictions(db, e.id);
  if (open.length) {
    console.log(`\n  Open contradictions (${open.length}):`);
    for (const o of open) console.log(`    [${o.severity.toUpperCase()}] ${o.detail}`);
  } else console.log("\n  No open contradictions.");
}
