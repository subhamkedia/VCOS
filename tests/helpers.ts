import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { migrate, wrapPglite, type Db } from "../lib/db.js";

let shared: Promise<{ db: Db; tables: string[] }> | null = null;

/**
 * An empty, migrated in-memory Postgres. Booting PGlite costs seconds, so
 * each test file boots it once; every call after that empties the tables
 * instead (milliseconds). The returned `close()` is a no-op so tests can
 * keep their usual teardown.
 */
export async function testDb(): Promise<Db> {
  shared ??= (async () => {
    const db = wrapPglite(await PGlite.create({ extensions: { pg_trgm } }));
    await migrate(db);
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
    );
    return { db, tables: rows.map((r) => r.tablename) };
  })();
  const { db, tables } = await shared;
  // The append-only triggers block TRUNCATE. Replica mode skips them, and
  // `set local` ends with the transaction, so the guard is back even if this fails.
  await db.transaction((tx) =>
    tx.exec(`set local session_replication_role = replica; truncate ${tables.join(", ")} restart identity cascade;`),
  );
  return { ...db, close: async () => {} };
}
