import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { currentClaims, entityAliases, entityIdentifiers, getEntity } from "../../ledger/repository.js";
import { finishRun } from "../../ledger/workspace.js";
import { getDeal, startDealRun, touchDeal, updateRunStats } from "../../ledger/diligence.js";
import { feedsForConnector } from "../../ledger/workspace.js";
import { ingest } from "../../connectors/ingest.js";
import { getConnector, type ResearchTarget } from "../../connectors/registry.js";
import type { SourceRecord } from "../../connectors/types.js";
import type { MeetingRecord } from "../../connectors/meetings.js";
import { researchSources, withFirmCredentials } from "../connections/index.js";
import { MEETING_CONNECTORS, syncMeetings } from "../meetings/index.js";

/**
 * "Gather everything": one run that pulls what every source the firm has
 * connected knows about the company in diligence. Internal sources (the
 * CRM, email, Drive, and every meeting tool, synced first so the latest
 * calls are in) and external ones (vendors like PitchBook or Harmonic, the
 * company's website, news, patents, SBIR and federal awards, job boards,
 * SEC filings). Each source runs as the firm, with the firm's own keys,
 * and writes through the same ingest pipeline as sourcing, onto this
 * company: no source can file its findings under a namesake.
 *
 * A firm connects a tool once, in setup or Connections; diligence uses it.
 * Sources that aren't connected are listed as skipped, with the reason.
 */

export const MAX_RECORDS_PER_SOURCE = 60;

export interface SourceResult {
  id: string;
  name: string;
  status: "ok" | "empty" | "skipped" | "failed";
  records: number;
  newEvidence: number;
  claims: number;
  detail?: string;
}

export interface GatherDeps {
  llm?: Llm;
  /** For tests: replace a source's network call. */
  run?: Record<string, (t: ResearchTarget) => Promise<SourceRecord[]>>;
  meetings?: Record<string, (since: Date) => Promise<MeetingRecord[]>>;
  /** Only these sources. */
  only?: string[];
}

export async function researchTarget(db: Db, companyId: string): Promise<ResearchTarget> {
  const e = await getEntity(db, companyId);
  if (!e) throw new Error(`No entity ${companyId}`);
  const domain = (await entityIdentifiers(db, e.id, "domain"))[0]?.value;
  const aliases = (await entityAliases(db, e.id)).map((a) => a.alias).filter((a) => a.toLowerCase() !== e.name.toLowerCase());
  const legal = (await currentClaims(db, e.id, "company.legal_name")).map((c) => String(c.value));
  const founders = (await currentClaims(db, e.id, "team.founder")).map((c) => String(c.value));
  return { name: e.name, domain, aliases: [...new Set([...aliases, ...legal])], founders };
}

/** Start a run and return its id; the work continues in the background unless awaited. */
export async function gather(db: Db, dealId: string, by: string, deps: GatherDeps = {}): Promise<{ runId: string; done: Promise<SourceResult[]> }> {
  const deal = await getDeal(db, dealId);
  if (!deal) throw new Error("No such deal.");
  const runId = await startDealRun(db, dealId, "diligence:gather", by);
  const done = run(db, dealId, deal.company_id, runId, by, deps);
  return { runId, done };
}

async function run(db: Db, dealId: string, companyId: string, runId: string, by: string, deps: GatherDeps): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  const save = () => updateRunStats(db, runId, { sources: results });
  let error: string | undefined;
  try {
    const target = await researchTarget(db, companyId);

    // 1. Meeting tools: sync first so the latest calls are matched and extracted.
    for (const c of MEETING_CONNECTORS) {
      if (deps.only && !deps.only.includes(c.id)) continue;
      const [feed] = await feedsForConnector(db, c.id);
      if (!feed) continue; // not connected
      const r: SourceResult = { id: c.id, name: c.name, status: "ok", records: 0, newEvidence: 0, claims: 0 };
      try {
        const out = await syncMeetings(db, feed.id, by, { llm: deps.llm, list: deps.meetings?.[c.id] });
        if (!out.ok) throw new Error(out.error);
        r.records = out.stats.meetings;
        r.newEvidence = out.stats.withWords;
        r.status = out.stats.meetings ? "ok" : "empty";
        r.detail = `${out.stats.new} new meetings, ${out.stats.matched} matched to companies, ${out.stats.needsReview} waiting for you on the Meetings screen.`;
      } catch (err) {
        r.status = "failed";
        r.detail = (err as Error).message.slice(0, 300);
      }
      results.push(r);
      await save();
    }

    // 2. Research sources: everything the firm has connected, plus public sources.
    for (const s of await researchSources(db)) {
      if (deps.only && !deps.only.includes(s.id)) continue;
      const r: SourceResult = { id: s.id, name: s.name, status: "ok", records: 0, newEvidence: 0, claims: 0 };
      if (!s.ready) {
        results.push({ ...r, status: "skipped", detail: s.reason });
        continue;
      }
      if (s.needsDomain && !target.domain) {
        results.push({ ...r, status: "skipped", detail: "Needs the company's website domain." });
        continue;
      }
      try {
        const c = getConnector(s.id);
        const fetchRecords = deps.run?.[s.id] ?? c.research!.run;
        const records = (await withFirmCredentials(db, [s.id], () => fetchRecords(target))).slice(0, MAX_RECORDS_PER_SOURCE);
        const rejected: string[] = [];
        for (const rec of records) {
          r.records++;
          const out = await ingest(db, rec, { llm: deps.llm, subjectId: companyId });
          if (!out.duplicate) r.newEvidence++;
          r.claims += out.structuredClaims + (out.extraction?.claimIds.length ?? 0);
          rejected.push(...out.structuredRejected.map((x) => x.reason));
        }
        r.status = r.records ? "ok" : "empty";
        if (!r.records) r.detail = "Nothing found for this company.";
        // Never drop a fact silently: say what was refused and why.
        if (rejected.length) r.detail = `${rejected.length} ${rejected.length === 1 ? "fact" : "facts"} refused: ${rejected[0]!.slice(0, 160)}`;
      } catch (err) {
        r.status = "failed";
        r.detail = (err as Error).message.slice(0, 300);
      }
      results.push(r);
      await save();
    }
  } catch (err) {
    error = (err as Error).message;
  }
  await finishRun(db, runId, { ok: !error, stats: { sources: results }, error });
  await touchDeal(db, dealId);
  // New evidence may answer questions or raise new ones.
  const { refreshQuestions } = await import("./index.js");
  await refreshQuestions(db, dealId).catch(() => undefined);
  return results;
}
