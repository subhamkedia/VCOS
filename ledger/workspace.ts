import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * A firm's configuration: thesis versions, connections, sourcing feeds and
 * their runs. Every function takes a firm-scoped Db except `dueFeeds`, which
 * the scheduler runs on the root Db to find work across firms.
 */

// ---------------------------------------------------------------------------
// Thesis
// ---------------------------------------------------------------------------

export interface ThesisRow<P = unknown> {
  version: number;
  profile: P;
  created_by: string;
  created_at: unknown;
}

export async function latestThesis<P>(db: Db): Promise<ThesisRow<P> | null> {
  const { rows } = await db.query<ThesisRow<P>>(
    "select version, profile, created_by, created_at from thesis_versions order by version desc limit 1",
  );
  return rows[0] ?? null;
}

export async function thesisHistory(db: Db): Promise<{ version: number; created_by: string; created_at: unknown }[]> {
  return (await db.query<{ version: number; created_by: string; created_at: unknown }>(
    "select version, created_by, created_at from thesis_versions order by version desc",
  )).rows;
}

/** Save a new version. Returns its number. */
export async function insertThesisVersion(db: Db, profile: unknown, createdBy: string): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ version: number }>(
      `insert into thesis_versions(version, profile, created_by)
       values ((select coalesce(max(version), 0) + 1 from thesis_versions), $1, $2) returning version`,
      [JSON.stringify(profile), createdBy],
    );
    await audit(tx, createdBy, "thesis.save", String(rows[0]!.version));
    return rows[0]!.version;
  });
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  connector_id: string;
  status: "connected" | "error" | "disconnected";
  credentials: string | null;
  account_label: string | null;
  connected_by: string;
  connected_at: unknown;
  last_checked_at: unknown;
  last_error: string | null;
}

export async function listConnections(db: Db): Promise<ConnectionRow[]> {
  return (await db.query<ConnectionRow>("select * from connections order by connector_id")).rows;
}

export async function getConnection(db: Db, connectorId: string): Promise<ConnectionRow | null> {
  return (await db.query<ConnectionRow>("select * from connections where connector_id=$1", [connectorId])).rows[0] ?? null;
}

export async function saveConnection(
  db: Db,
  c: { connectorId: string; credentials: string | null; accountLabel?: string | null; connectedBy: string },
): Promise<void> {
  await db.query(
    `insert into connections(connector_id, status, credentials, account_label, connected_by, connected_at, last_error)
     values ($1, 'connected', $2, $3, $4, now(), null)
     on conflict (firm_id, connector_id) do update set status='connected', credentials=excluded.credentials,
       account_label=excluded.account_label, connected_by=excluded.connected_by, connected_at=now(), last_error=null`,
    [c.connectorId, c.credentials, c.accountLabel ?? null, c.connectedBy],
  );
  await audit(db, c.connectedBy, "connection.save", c.connectorId);
}

export async function recordConnectionCheck(db: Db, connectorId: string, outcome: { ok: boolean; detail: string }): Promise<void> {
  await db.query(
    `update connections set last_checked_at=now(), status=$2, last_error=$3, account_label=coalesce($4, account_label)
      where connector_id=$1`,
    [connectorId, outcome.ok ? "connected" : "error", outcome.ok ? null : outcome.detail.slice(0, 500), outcome.ok ? outcome.detail.slice(0, 200) : null],
  );
}

/** Replace a connection's (encrypted) credentials in place: a rotated refresh token, or a wider grant from a new consent. */
export async function updateConnectionCredentials(db: Db, connectorId: string, credentials: string): Promise<void> {
  await db.query("update connections set credentials=$2 where connector_id=$1 and status <> 'disconnected'", [connectorId, credentials]);
}

/** Forget the credentials. The row stays, marked disconnected, for the audit trail. */
export async function disconnect(db: Db, connectorId: string, by: string): Promise<void> {
  await db.query("update connections set status='disconnected', credentials=null where connector_id=$1", [connectorId]);
  await audit(db, by, "connection.disconnect", connectorId);
}

// ---------------------------------------------------------------------------
// Sourcing feeds, runs and hits
// ---------------------------------------------------------------------------

export type Cadence = "hourly" | "daily" | "weekly" | "monthly" | "manual";

export interface FeedRow {
  id: string;
  firm_id: string;
  connector_id: string;
  name: string;
  params: Record<string, unknown>;
  cadence: Cadence;
  enabled: boolean;
  next_run_at: unknown;
  created_by: string;
  created_at: unknown;
}

export async function listFeeds(db: Db): Promise<(FeedRow & { last_run: { status: string; finished_at: unknown; stats: Record<string, unknown>; error: string | null } | null })[]> {
  const { rows } = await db.query<FeedRow & { last_run: never }>(
    `select f.*, (select to_jsonb(r) from (select status, finished_at, stats, error from job_runs
                   where feed_id = f.id order by started_at desc limit 1) r) as last_run
       from sourcing_feeds f order by f.created_at`,
  );
  return rows;
}

export async function getFeed(db: Db, id: string): Promise<FeedRow | null> {
  return (await db.query<FeedRow>("select * from sourcing_feeds where id=$1", [id])).rows[0] ?? null;
}

export async function insertFeed(
  db: Db,
  f: { connectorId: string; name: string; params: Record<string, unknown>; cadence: Cadence; nextRunAt: Date | null; createdBy: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into sourcing_feeds(connector_id, name, params, cadence, next_run_at, created_by)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [f.connectorId, f.name, JSON.stringify(f.params), f.cadence, f.nextRunAt, f.createdBy],
  );
  await audit(db, f.createdBy, "feed.create", rows[0]!.id, { connector: f.connectorId, cadence: f.cadence });
  return rows[0]!.id;
}

export async function updateFeed(
  db: Db,
  id: string,
  patch: { name?: string; params?: Record<string, unknown>; cadence?: Cadence; enabled?: boolean; nextRunAt?: Date | null },
): Promise<void> {
  await db.query(
    `update sourcing_feeds set
       name = coalesce($2, name), params = coalesce($3, params), cadence = coalesce($4, cadence),
       enabled = coalesce($5, enabled), next_run_at = case when $6::boolean then $7 else next_run_at end
     where id=$1`,
    [id, patch.name ?? null, patch.params ? JSON.stringify(patch.params) : null, patch.cadence ?? null,
      patch.enabled ?? null, patch.nextRunAt !== undefined, patch.nextRunAt ?? null],
  );
}

export async function deleteFeed(db: Db, id: string, by: string): Promise<void> {
  await db.query("delete from sourcing_feeds where id=$1", [id]);
  await audit(db, by, "feed.delete", id);
}

/** Feeds whose time has come, across all firms. ROOT Db only: this is the scheduler's view. */
export async function dueFeeds(root: Db, now = new Date(), limit = 20): Promise<{ id: string; firm_id: string }[]> {
  return (await root.query<{ id: string; firm_id: string }>(
    `select id, firm_id from sourcing_feeds
      where enabled and cadence <> 'manual' and next_run_at is not null and next_run_at <= $1
        and not exists (select 1 from job_runs r where r.feed_id = sourcing_feeds.id and r.status = 'running'
                          and r.started_at > now() - interval '2 hours')
      order by next_run_at limit $2`,
    [now, limit],
  )).rows;
}

export async function startRun(db: Db, r: { feedId: string | null; kind: string; triggeredBy: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into job_runs(feed_id, kind, triggered_by) values ($1,$2,$3) returning id",
    [r.feedId, r.kind, r.triggeredBy],
  );
  return rows[0]!.id;
}

export async function finishRun(db: Db, id: string, outcome: { ok: boolean; stats: Record<string, unknown>; error?: string }): Promise<void> {
  await db.query(
    "update job_runs set status=$2, finished_at=now(), stats=$3, error=$4 where id=$1",
    [id, outcome.ok ? "done" : "failed", JSON.stringify(outcome.stats), outcome.error ?? null],
  );
}

export async function recentRuns(db: Db, feedId?: string, limit = 20) {
  return (await db.query<{ id: string; feed_id: string | null; kind: string; status: string; started_at: unknown; finished_at: unknown; stats: Record<string, unknown>; error: string | null; triggered_by: string }>(
    `select id, feed_id, kind, status, started_at, finished_at, stats, error, triggered_by from job_runs
      ${feedId ? "where feed_id = $2" : ""} order by started_at desc limit $1`,
    feedId ? [limit, feedId] : [limit],
  )).rows;
}

export async function insertHit(
  db: Db,
  h: { runId: string; feedId: string | null; entityId: string; isNew: boolean; fit: { score: number; verdict: string; thesisVersion: number | null; detail: unknown } | null },
): Promise<void> {
  await db.query(
    `insert into sourcing_hits(run_id, feed_id, entity_id, is_new, fit_score, fit_verdict, thesis_version, fit)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [h.runId, h.feedId, h.entityId, h.isNew, h.fit?.score ?? null, h.fit?.verdict ?? null, h.fit?.thesisVersion ?? null, h.fit ? JSON.stringify(h.fit.detail) : null],
  );
}

export interface HitRow {
  entity_id: string;
  name: string;
  is_new: boolean;
  fit_score: number | null;
  fit_verdict: string | null;
  thesis_version: number | null;
  fit: unknown;
  feed_name: string | null;
  connector_id: string | null;
  created_at: unknown;
}

/** The latest hit per company, best fit first, then newest. */
export async function latestHits(db: Db, opts: { verdict?: string; limit?: number } = {}): Promise<HitRow[]> {
  const params: unknown[] = [opts.limit ?? 100];
  if (opts.verdict) params.push(opts.verdict);
  return (await db.query<HitRow>(
    `select * from (
       select distinct on (h.entity_id) h.entity_id, e.name, h.is_new, h.fit_score, h.fit_verdict, h.thesis_version, h.fit,
              f.name as feed_name, f.connector_id, h.created_at
         from sourcing_hits h join entities e on e.id = h.entity_id left join sourcing_feeds f on f.id = h.feed_id
        where e.merged_into is null
        order by h.entity_id, h.created_at desc
     ) latest ${opts.verdict ? "where fit_verdict = $2" : ""}
     order by fit_score desc nulls last, created_at desc limit $1`,
    params,
  )).rows;
}

/** Companies in the firm's ledger, with how many claims each has. For the Companies screen. */
export async function listCompanies(db: Db, opts: { search?: string; limit?: number } = {}) {
  const params: unknown[] = [opts.limit ?? 200];
  if (opts.search) params.push(`%${opts.search.toLowerCase()}%`);
  return (await db.query<{ id: string; name: string; claims: number; open_contradictions: number; domain: string | null; updated_at: unknown }>(
    `select e.id, e.name,
            (select count(*)::int from claims c where c.subject_id = e.id) as claims,
            (select count(*)::int from contradictions x where x.subject_id = e.id and x.status = 'open') as open_contradictions,
            (select value from entity_identifiers i where i.entity_id = e.id and i.kind = 'domain' limit 1) as domain,
            coalesce((select max(created_at) from claims c where c.subject_id = e.id), e.created_at) as updated_at
       from entities e
      where e.type = 'company' and e.merged_into is null
        ${opts.search ? "and exists (select 1 from entity_aliases a where a.entity_id = e.id and lower(a.alias) like $2)" : ""}
      order by updated_at desc limit $1`,
    params,
  )).rows;
}

export async function feedsForConnector(db: Db, connectorId: string): Promise<FeedRow[]> {
  return (await db.query<FeedRow>("select * from sourcing_feeds where connector_id=$1 order by created_at", [connectorId])).rows;
}

/** When the last successful run of a feed started: the next sync reads from a little before then. */
export async function lastSuccessfulRunAt(db: Db, feedId: string): Promise<Date | null> {
  const { rows } = await db.query<{ started_at: unknown }>(
    "select started_at from job_runs where feed_id=$1 and status='done' order by started_at desc limit 1",
    [feedId],
  );
  const v = rows[0]?.started_at;
  return v ? new Date(v instanceof Date ? v : String(v)) : null;
}
