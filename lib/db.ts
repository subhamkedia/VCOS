import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one database interface. Everything else goes through this, so tests
 * can run on in-process PGlite and production on real Postgres.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

/** In-process Postgres (PGlite). `dataDir` omitted = in-memory. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = await PGlite.create(dataDir, { extensions: { pg_trgm } });
  return wrapPglite(pg);
}

type PgliteLike = import("@electric-sql/pglite").PGliteInterface;

/** Wrap an existing PGlite instance. Exposes `clone()` for fast test fixtures. */
export function wrapPglite(pg: PgliteLike): Db & { clone(): Promise<Db> } {
  const wrap = (q: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    exec: (sql: string) => Promise<unknown>;
  }): Omit<Db, "transaction" | "close"> => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await q.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
  });

  const base = wrap(pg);
  return {
    ...base,
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner = wrap(tx);
        const txDb: Db = {
          ...inner,
          transaction: (f) => f(txDb),
          close: async () => {},
        };
        return fn(txDb);
      });
    },
    async close() {
      await pg.close();
    },
    async clone() {
      return wrapPglite(await pg.clone());
    },
  };
}

/** Real Postgres via node-postgres. */
export async function createPgDb(connectionString: string): Promise<Db> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString });

  const make = (runner: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Omit<
    Db,
    "transaction" | "close"
  > => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await runner.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
  });

  return {
    ...make(pool),
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const inner = make(client);
        const txDb: Db = { ...inner, transaction: (f) => f(txDb), close: async () => {} };
        const out = await fn(txDb);
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Db that sees one firm's rows and nothing else. Every statement runs in a
 * transaction as the role `vcos_app` with `app.firm_id` set, so Postgres
 * row-level security filters reads and fills in and checks firm_id on
 * writes (migration 0004). Hand this to modules, agents and connectors;
 * keep the root Db for platform code (sign-in, the scheduler, migrations).
 *
 * `close()` does nothing unless `closeRoot` is set: request handlers share
 * one root pool.
 */
export function scopedDb(root: Db, firmId: string, opts: { closeRoot?: boolean } = {}): Db & { firmId: string } {
  if (!UUID.test(firmId)) throw new Error(`Not a firm id: ${firmId}`);
  const enter = async (tx: Db) => {
    await tx.query("select set_config('app.firm_id', $1, true)", [firmId]);
    await tx.exec("set local role vcos_app");
  };
  const scoped = {
    firmId,
    query<T>(sql: string, params?: unknown[]) {
      return root.transaction(async (tx) => {
        await enter(tx);
        return tx.query<T>(sql, params);
      });
    },
    async exec(sql: string) {
      await root.transaction(async (tx) => {
        await enter(tx);
        await tx.exec(sql);
      });
    },
    transaction<T>(fn: (tx: Db) => Promise<T>) {
      return root.transaction(async (tx) => {
        await enter(tx);
        return fn(tx);
      });
    },
    async close() {
      if (opts.closeRoot) await root.close();
    },
  };
  return scoped;
}

/** Pick Postgres if DATABASE_URL is set, else an on-disk PGlite in .data/. */
export async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return createPgDb(url);
  return createPgliteDb(process.env.PGLITE_DIR ?? ".data/pglite");
}

/** Apply every migration in db/migrations that hasn't run yet, in order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const done = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations(name) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
