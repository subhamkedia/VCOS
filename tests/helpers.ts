import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { migrate, wrapPglite, type Db } from "../lib/db.js";

let template: Promise<ReturnType<typeof wrapPglite>> | null = null;

/**
 * Fresh in-memory Postgres with all migrations applied. Migrations run once
 * per test file; each test gets a clone of that template.
 */
export async function testDb(): Promise<Db> {
  template ??= (async () => {
    const db = wrapPglite(await PGlite.create({ extensions: { pg_trgm } }));
    await migrate(db);
    return db;
  })();
  return (await template).clone();
}
