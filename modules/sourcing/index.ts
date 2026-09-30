import { scopedDb, type Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { currentClaims, entityIdentifiers, PASS_REASONS, recordDecision } from "../../ledger/repository.js";
import {
  deleteFeed as removeFeed, dueFeeds, finishRun, getFeed, insertFeed, insertHit, latestHits, listFeeds, recentRuns, startRun,
  updateFeed as patchFeed, type Cadence, type FeedRow,
} from "../../ledger/workspace.js";
import { ingest } from "../../connectors/ingest.js";
import { problemText } from "../../connectors/http.js";
import { getConnector, type ParamSpec, type Params } from "../../connectors/registry.js";
import type { SourceRecord } from "../../connectors/types.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { getProfile } from "../firm/profile.js";
import { thesisFit, type Fit } from "./fit.js";

/**
 * Sourcing: feeds pull companies from connected sources on a cadence. Each
 * run ingests what it finds into the ledger (resolving to existing
 * companies, so nothing is counted twice), scores each company against the
 * firm's current thesis, and records the hits. Enrichment feeds (Harmonic,
 * PitchBook, Crunchbase, Dealroom) fill in companies other feeds found.
 */

export const CADENCES: Cadence[] = ["hourly", "daily", "weekly", "monthly", "manual"];
export const MAX_RECORDS_PER_RUN = 500;

export function nextRunAt(cadence: Cadence, from = new Date()): Date | null {
  const t = new Date(from);
  switch (cadence) {
    case "manual": return null;
    case "hourly": t.setUTCHours(t.getUTCHours() + 1); break;
    case "daily": t.setUTCDate(t.getUTCDate() + 1); break;
    case "weekly": t.setUTCDate(t.getUTCDate() + 7); break;
    case "monthly": t.setUTCMonth(t.getUTCMonth() + 1); break;
  }
  return t;
}

export class FeedInvalid extends Error {}

/** Check params against the connector's spec and coerce types. */
export function cleanParams(specs: ParamSpec[], input: Params): Params {
  const out: Params = {};
  for (const s of specs) {
    let v = input[s.name] ?? s.default;
    if (s.kind === "list" && typeof v === "string") v = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (s.kind === "number" && v !== undefined && v !== "") v = Number(v);
    if (s.kind === "boolean" && typeof v === "string") v = v === "true";
    if ((s.kind === "text" || s.kind === "url" || s.kind === "select") && typeof v === "string") v = v.trim();
    if (s.kind === "select" && v !== undefined && v !== "" && !s.options?.some((o) => o.id === v)) throw new FeedInvalid(`${s.label}: pick one of the options.`);
    if (s.kind === "url" && typeof v === "string" && v) {
      try {
        const u = new URL(v);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      } catch {
        throw new FeedInvalid(`${s.label} must be a full web address, starting with https://`);
      }
    }
    const empty = v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (s.kind === "number" && !Number.isFinite(v));
    if (empty) {
      if (s.required) throw new FeedInvalid(`${s.label} is required.`);
      continue;
    }
    out[s.name] = v;
  }
  return out;
}

export async function createFeed(
  db: Db,
  input: { connectorId: string; name?: string; params?: Params; cadence?: Cadence },
  by: string,
): Promise<string> {
  const c = getConnector(input.connectorId);
  if (!c.sourcing) throw new FeedInvalid(`${c.name} can't be used for sourcing.`);
  if (!(await isReady(db, c.id))) throw new FeedInvalid(`Connect ${c.name} first.`);
  const cadence = input.cadence ?? c.sourcing.defaultCadence;
  if (!CADENCES.includes(cadence)) throw new FeedInvalid(`Unknown cadence "${cadence}".`);
  const params = cleanParams(c.sourcing.params, input.params ?? {});
  return insertFeed(db, {
    connectorId: c.id, name: input.name?.trim() || `${c.name}: ${c.sourcing.summary}`, params, cadence,
    nextRunAt: cadence === "manual" ? null : new Date(), createdBy: by,
  });
}

export async function updateFeed(db: Db, id: string, patch: { name?: string; params?: Params; cadence?: Cadence; enabled?: boolean }) {
  const feed = await getFeed(db, id);
  if (!feed) throw new FeedInvalid("No such feed.");
  const c = getConnector(feed.connector_id);
  const params = patch.params && c.sourcing ? cleanParams(c.sourcing.params, patch.params) : undefined;
  const cadence = patch.cadence;
  if (cadence && !CADENCES.includes(cadence)) throw new FeedInvalid(`Unknown cadence "${cadence}".`);
  await patchFeed(db, id, {
    name: patch.name, params, cadence, enabled: patch.enabled,
    nextRunAt: cadence ? nextRunAt(cadence) : patch.enabled === false ? null : undefined,
  });
}

export const deleteFeed = removeFeed;

/** Sourcing feeds. Meeting-tool syncs share the scheduler but are listed on the Meetings screen. */
export async function feeds(db: Db, opts: { includeMeetings?: boolean } = {}) {
  return (await listFeeds(db))
    .filter((f) => opts.includeMeetings || !getConnector(f.connector_id).meetings)
    .map((f) => ({ ...f, connector: getConnector(f.connector_id).name }));
}

export interface RunStats {
  records: number;
  newCompanies: number;
  knownCompanies: number;
  unchanged: number;
  skipped: number;
  errors: number;
  errorSamples: string[];
  strongFits: number;
}

export interface RunDeps {
  llm?: Llm;
  /** For tests: replace the connector's network call. */
  discover?: (feed: FeedRow) => Promise<SourceRecord[]>;
  enrich?: (feed: FeedRow, domain: string) => Promise<SourceRecord>;
}

async function scoreCompany(db: Db, entityId: string, profile: Awaited<ReturnType<typeof getProfile>>) {
  if (!profile) return null;
  const fit: Fit = thesisFit(profile.profile, await currentClaims(db, entityId));
  return { score: fit.score, verdict: fit.verdict, thesisVersion: profile.version, detail: fit };
}

/** Run one feed now. Safe to call from the worker, a button, or the CLI. */
export async function runFeed(db: Db, feedId: string, triggeredBy: string, deps: RunDeps = {}): Promise<{ runId: string; ok: boolean; stats: RunStats; error?: string }> {
  const feed = await getFeed(db, feedId);
  if (!feed) throw new FeedInvalid("No such feed.");
  const c = getConnector(feed.connector_id);
  if (c.meetings) {
    const { syncMeetings } = await import("../meetings/index.js");
    const r = await syncMeetings(db, feedId, triggeredBy, { llm: deps.llm });
    const empty: RunStats = { records: r.stats.meetings, newCompanies: 0, knownCompanies: r.stats.matched, unchanged: 0, skipped: 0, errors: r.stats.errors, errorSamples: r.stats.errorSamples, strongFits: 0 };
    return { runId: r.runId, ok: r.ok, stats: empty, error: r.error };
  }
  if (!c.sourcing) throw new FeedInvalid(`${c.name} can't be used for sourcing.`);
  const runId = await startRun(db, { feedId, kind: `sourcing:${c.sourcing.mode}`, triggeredBy });
  const stats: RunStats = { records: 0, newCompanies: 0, knownCompanies: 0, unchanged: 0, skipped: 0, errors: 0, errorSamples: [], strongFits: 0 };
  const profile = await getProfile(db);
  const fail = (msg: string) => {
    stats.errors++;
    if (stats.errorSamples.length < 5) stats.errorSamples.push(msg.slice(0, 300));
  };

  const take = async (rec: SourceRecord) => {
    stats.records++;
    try {
      const r = await ingest(db, rec, { llm: deps.llm });
      if (!r.subject) {
        stats.skipped++;
        return;
      }
      if (r.duplicate) stats.unchanged++;
      if (r.subject.created) stats.newCompanies++;
      else stats.knownCompanies++;
      const fit = await scoreCompany(db, r.subject.entity.id, profile);
      if (fit?.verdict === "strong") stats.strongFits++;
      await insertHit(db, { runId, feedId, entityId: r.subject.entity.id, isNew: r.subject.created, fit });
    } catch (err) {
      fail((err as Error).message);
    }
  };

  let error: string | undefined;
  try {
    await withFirmCredentials(db, [c.id], async () => {
      if (c.sourcing!.mode === "discover") {
        const discover = deps.discover ?? ((f: FeedRow) => (c.sourcing as { discover: (p: Params) => Promise<SourceRecord[]> }).discover(f.params));
        const records = (await discover(feed)).slice(0, MAX_RECORDS_PER_RUN);
        for (const rec of records) await take(rec);
      } else {
        // Enrich companies other feeds found in the last 30 days that have a domain.
        const enrich = deps.enrich ?? ((_f: FeedRow, d: string) => (c.sourcing as { enrich: (d: string) => Promise<SourceRecord> }).enrich(d));
        const targets = (await latestHits(db, { limit: MAX_RECORDS_PER_RUN }))
          .filter((h) => h.connector_id !== c.id && Date.now() - new Date(String(h.created_at)).getTime() < 30 * 86_400_000);
        for (const h of targets) {
          const domain = await domainOf(db, h.entity_id);
          if (!domain) {
            stats.skipped++;
            continue;
          }
          try {
            await take(await enrich(feed, domain));
          } catch (err) {
            fail(`${h.name}: ${problemText(err, c.name)}`);
          }
        }
      }
    });
  } catch (err) {
    error = problemText(err, c.name);
  }
  const ok = !error;
  await finishRun(db, runId, { ok, stats: stats as unknown as Record<string, unknown>, error });
  if (feed.enabled && feed.cadence !== "manual") await patchFeed(db, feedId, { nextRunAt: nextRunAt(feed.cadence) });
  return { runId, ok, stats, error };
}

async function domainOf(db: Db, entityId: string): Promise<string | null> {
  return (await entityIdentifiers(db, entityId, "domain"))[0]?.value ?? null;
}

/** The worker's tick: run every due feed, each inside its own firm. */
export async function runDueFeeds(root: Db, deps: (firmId: string) => RunDeps = () => ({}), now = new Date()) {
  const due = await dueFeeds(root, now);
  const results: { feedId: string; firmId: string; ok: boolean; error?: string }[] = [];
  for (const f of due) {
    const db = scopedDb(root, f.firm_id);
    try {
      const r = await runFeed(db, f.id, "scheduler", deps(f.firm_id));
      results.push({ feedId: f.id, firmId: f.firm_id, ok: r.ok, error: r.error });
    } catch (err) {
      results.push({ feedId: f.id, firmId: f.firm_id, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

export async function discovered(db: Db, opts: { verdict?: string; limit?: number } = {}) {
  return latestHits(db, opts);
}

export const runs = recentRuns;

/**
 * Pass on a company straight from sourcing, before any diligence: the
 * reason code and a sentence are required (judgment is data). Starting
 * diligence later is still possible; the pass stays on record.
 */
export async function passOnCompany(db: Db, entityId: string, input: { reasonCode?: unknown; rationale?: unknown }, by: string) {
  const reason = String(input.reasonCode ?? "");
  if (!(PASS_REASONS as readonly string[]).includes(reason)) throw new FeedInvalid("Pick the main reason for passing.");
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale.length < 10) throw new FeedInvalid("Say why in a sentence: it's how the firm learns from what it passed on.");
  const profile = await getProfile(db);
  return { id: await recordDecision(db, { entityId, kind: "pass", actor: by, reasonCode: reason as (typeof PASS_REASONS)[number], rationale, value: { stage: "sourcing", thesisVersion: profile?.version ?? null } }) };
}
