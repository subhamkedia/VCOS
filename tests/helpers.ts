import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { migrate, scopedDb, wrapPglite, type Db } from "../lib/db.js";
import { createFirm, type Firm } from "../ledger/platform.js";

let shared: Promise<{ root: Db; tables: string[] }> | null = null;

/**
 * An empty, migrated in-memory Postgres. Booting PGlite costs seconds, so
 * each test file boots it once; every call after that empties the tables
 * instead (milliseconds).
 */
export async function testRoot(): Promise<Db> {
  shared ??= (async () => {
    const root = wrapPglite(await PGlite.create({ extensions: { pg_trgm } }));
    await migrate(root);
    const { rows } = await root.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
    );
    return { root, tables: rows.map((r) => r.tablename) };
  })();
  const { root, tables } = await shared;
  // The append-only triggers block TRUNCATE. Replica mode skips them, and
  // `set local` ends with the transaction, so the guard is back even if this fails.
  await root.transaction((tx) =>
    tx.exec(`set local session_replication_role = replica; truncate ${tables.join(", ")} restart identity cascade;`),
  );
  return { ...root, close: async () => {} };
}

/** The root Db without emptying it, for checks that must bypass the app role. */
export async function testRootNoReset(): Promise<Db> {
  if (!shared) throw new Error("Call testDb() or testFirm() first");
  const { root } = await shared;
  return { ...root, close: async () => {} };
}

/** A fresh firm and a Db scoped to it, the way the app hands one to every request. */
export async function testFirm(name = "Test Fund"): Promise<{ root: Db; db: Db; firm: Firm }> {
  const root = await testRoot();
  const firm = await createFirm(root, { name });
  return { root, db: scopedDb(root, firm.id), firm };
}

/** Most tests only need a firm-scoped Db. `close()` is a no-op so tests keep their usual teardown. */
export async function testDb(): Promise<Db> {
  return (await testFirm()).db;
}
