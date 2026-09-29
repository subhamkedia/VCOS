import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { normalizeDomain } from "../../lib/text.js";
import { extractClaims } from "../../agents/extractor/index.js";
import { resolveOrCreate } from "../../agents/resolver/index.js";
import { getEntity, insertEvidence, audit } from "../../ledger/repository.js";
import {
  attachMeetingEvidence, companiesByDomain, companyNames, findMeeting, firmEmailDomains, getMeeting, insertMeeting, knownContacts,
  learnContact, listMeetings, markExtracted, meetingCounts, sameConference, setMeetingMatch,
  type MeetingMatch, type MeetingRow, type MeetingStatus,
} from "../../ledger/meetings.js";
import { feedsForConnector, finishRun, getFeed, insertFeed, lastSuccessfulRunAt, startRun, updateFeed, type FeedRow } from "../../ledger/workspace.js";
import { CONNECTORS, getConnector } from "../../connectors/registry.js";
import { meetingEvidence, type MeetingRecord } from "../../connectors/meetings.js";
import { withFirmCredentials } from "../connections/index.js";
import { getProfile } from "../firm/profile.js";
import { isFreeMail, matchMeeting, MATCHER_VERSION, registrableDomain, type MatchContext } from "./match.js";

/**
 * Meetings: every call the firm's meeting tools know about, matched to the
 * company it was with. Connect a tool once and it syncs on its own; the
 * words (notes, transcripts) become confidential Evidence on the right
 * company, and the extractor turns them into cited claims.
 *
 * A meeting the matcher can't place with confidence waits for a person on
 * the Meetings screen. What they decide is remembered (the attendee's
 * address now belongs to that company), so the next call with the same
 * people matches on its own.
 */

export interface SyncStats {
  meetings: number;
  new: number;
  matched: number;
  needsReview: number;
  internal: number;
  withWords: number;
  extracted: number;
  errors: number;
  errorSamples: string[];
}

export class MeetingInvalid extends Error {}

/** Connectors that are meeting tools. */
export const MEETING_CONNECTORS = CONNECTORS.filter((c) => c.meetings);

/** Make sure a connected meeting tool has its sync schedule. Called when a tool is connected. */
export async function ensureSync(db: Db, connectorId: string, by: string): Promise<string | null> {
  const c = getConnector(connectorId);
  if (!c.meetings) return null;
  const existing = await feedsForConnector(db, connectorId);
  if (existing[0]) return existing[0].id;
  return insertFeed(db, { connectorId, name: `${c.name}: ${c.meetings.summary}`, params: {}, cadence: c.meetings.defaultCadence, nextRunAt: new Date(), createdBy: by });
}

/** The matcher's view of the firm: its own domains, companies by domain, learned contacts and company names. */
async function matchContext(db: Db, records: MeetingRecord[]): Promise<MatchContext> {
  const profile = await getProfile(db);
  const firmDomains = new Set(
    [...(profile?.profile.firm.emailDomains ?? []), normalizeDomain(profile?.profile.firm.website) ?? "", ...(await firmEmailDomains(db))]
      .map((d) => normalizeDomain(d) ?? "")
      .filter((d) => d && !isFreeMail(d)),
  );
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const r of records) {
    for (const p of [...r.attendees, ...(r.organizer ? [r.organizer] : [])]) {
      if (!p.email) continue;
      emails.add(p.email.toLowerCase());
      const d = normalizeDomain(p.email);
      if (d) {
        domains.add(d);
        domains.add(registrableDomain(d));
      }
    }
  }
  const byDomain = await companiesByDomain(db, [...domains]);
  const contacts = await knownContacts(db, [...emails]);
  const byEmail = new Map<string, { id: string; name: string }>();
  for (const [email, id] of contacts) {
    const e = await getEntity(db, id);
    if (e) byEmail.set(email, { id: e.id, name: e.name });
  }
  return { firmDomains, byDomain, byEmail, names: await companyNames(db) };
}

async function extractMeeting(db: Db, meetingId: string, llm?: Llm): Promise<boolean> {
  const m = await getMeeting(db, meetingId);
  if (!m || !m.evidence_id || !m.company_id || m.extracted || m.status !== "matched") return false;
  if (!llm) return false;
  await extractClaims(db, llm, m.evidence_id, m.company_id);
  await markExtracted(db, meetingId);
  return true;
}

/** Store one reported meeting (or update one seen before) and match it. */
async function take(db: Db, r: MeetingRecord, ctx: MatchContext, stats: SyncStats, llm?: Llm) {
  stats.meetings++;
  const ev = meetingEvidence(r);
  const existing = await findMeeting(db, r.source, r.externalId);
  if (existing) {
    // Seen before. People may have decided its company since, so it isn't re-matched;
    // only words that weren't ready last time (a transcript still processing) are added.
    if (!existing.evidence_id && ev) {
      const { evidence } = await insertEvidence(db, ev);
      await attachMeetingEvidence(db, existing.id, evidence.id);
      stats.withWords++;
      if (await extractMeeting(db, existing.id, llm)) stats.extracted++;
    }
    return;
  }
  stats.new++;
  const evidenceId = ev ? (await insertEvidence(db, ev)).evidence.id : null;
  if (evidenceId) stats.withWords++;

  // The same call from another tool (the invite for a recording, or the other way round).
  const siblings = r.joinKey ? await sameConference(db, r.joinKey, r.startedAt ?? null) : [];
  const decided = siblings.find((s) => s.status === "matched" || s.status === "internal");
  let status: MeetingStatus;
  let companyId: string | null;
  let match: MeetingMatch;
  let matchedBy: string | null;
  if (decided) {
    status = decided.status;
    companyId = decided.company_id;
    match = { method: "same_conference", confidence: 0.97, reasons: [`Same call as "${decided.title}" from ${getConnector(decided.source).name}, which was ${decided.status === "internal" ? "marked internal" : `matched to ${decided.company_name}`}.`], candidates: [] };
    matchedBy = `auto:${MATCHER_VERSION}:same_conference`;
  } else {
    const people = [...r.attendees, ...siblings.flatMap((s) => s.attendees)];
    const title = [r.title, ...siblings.map((s) => s.title)].join(" · ");
    const out = matchMeeting({ title, attendees: people, organizer: r.organizer }, ctx);
    ({ status, companyId, match } = out);
    matchedBy = out.status === "matched" || out.status === "internal" ? `auto:${MATCHER_VERSION}:${out.match.method}` : null;
  }
  const id = await insertMeeting(db, {
    source: r.source, externalId: r.externalId, title: r.title, startedAt: r.startedAt, endedAt: r.endedAt,
    organizer: r.organizer?.email, attendees: r.attendees, joinKey: r.joinKey, url: r.url, evidenceId, companyId, status, match, matchedBy,
  });
  if (status === "matched") stats.matched++;
  else if (status === "internal") stats.internal++;
  else stats.needsReview++;
  if (await extractMeeting(db, id, llm)) stats.extracted++;
  // A decision here settles the same call from other tools that were waiting.
  if (status === "matched" || status === "internal") {
    for (const s of siblings.filter((x) => x.status === "needs_review")) {
      await setMeetingMatch(db, s.id, { companyId, status, matchedBy: `auto:${MATCHER_VERSION}:same_conference`, match: { ...match, method: "same_conference" } });
      if (await extractMeeting(db, s.id, llm)) stats.extracted++;
    }
  }
}

export interface SyncDeps {
  llm?: Llm;
  /** For tests: replace the tool's network call. */
  list?: (since: Date) => Promise<MeetingRecord[]>;
  now?: Date;
}

/** Sync one meeting tool now: from a little before the last good run, or the backfill window the first time. */
export async function syncMeetings(db: Db, feedId: string, triggeredBy: string, deps: SyncDeps = {}) {
  const feed = await getFeed(db, feedId);
  if (!feed) throw new MeetingInvalid("No such sync.");
  const c = getConnector(feed.connector_id);
  if (!c.meetings) throw new MeetingInvalid(`${c.name} isn't a meeting tool.`);
  const now = deps.now ?? new Date();
  const last = await lastSuccessfulRunAt(db, feedId);
  // Two days of overlap: transcripts often finish processing hours after the call.
  const since = last ? new Date(last.getTime() - 2 * 86_400_000) : new Date(now.getTime() - c.meetings.backfillDays * 86_400_000);
  const runId = await startRun(db, { feedId, kind: "meetings:sync", triggeredBy });
  const stats: SyncStats = { meetings: 0, new: 0, matched: 0, needsReview: 0, internal: 0, withWords: 0, extracted: 0, errors: 0, errorSamples: [] };
  let error: string | undefined;
  try {
    const records = await withFirmCredentials(db, [c.id], () => (deps.list ?? c.meetings!.list)(since));
    // Invites before recordings, so a recording finds its invite already matched.
    records.sort((a, b) => Number(Boolean(a.transcript || a.notes)) - Number(Boolean(b.transcript || b.notes)));
    const ctx = await matchContext(db, records);
    for (const r of records) {
      try {
        await take(db, r, ctx, stats, deps.llm);
      } catch (err) {
        stats.errors++;
        if (stats.errorSamples.length < 5) stats.errorSamples.push(`${r.title}: ${(err as Error).message}`.slice(0, 300));
      }
    }
  } catch (err) {
    error = (err as Error).message;
  }
  await finishRun(db, runId, { ok: !error, stats: stats as unknown as Record<string, unknown>, error });
  if (feed.enabled && feed.cadence !== "manual") {
    const { nextRunAt } = await import("../sourcing/index.js");
    await updateFeed(db, feedId, { nextRunAt: nextRunAt(feed.cadence, now) });
  }
  return { runId, ok: !error, stats, error };
}

/** Meeting syncs, one per connected meeting tool. */
export async function syncs(db: Db): Promise<(FeedRow & { connector: string })[]> {
  const { feeds } = await import("../sourcing/index.js");
  return (await feeds(db, { includeMeetings: true })).filter((f) => getConnector(f.connector_id).meetings);
}

// ---------------------------------------------------------------------------
// People decide
// ---------------------------------------------------------------------------

/**
 * A person says which company a meeting was with (an existing one, or a new
 * one from the attendees' domain). The attendees' addresses are remembered
 * for next time, the same call from other tools follows, and the words are
 * extracted onto the company.
 */
export async function assignMeeting(
  db: Db,
  meetingId: string,
  to: { companyId?: string; newCompany?: { name: string; domain?: string } },
  by: string,
  llm?: Llm,
): Promise<MeetingRow> {
  const m = await getMeeting(db, meetingId);
  if (!m) throw new MeetingInvalid("No such meeting.");
  let companyId = to.companyId;
  if (!companyId && to.newCompany?.name.trim()) {
    const domain = normalizeDomain(to.newCompany.domain) ?? undefined;
    if (domain && isFreeMail(domain)) throw new MeetingInvalid(`${domain} is a personal email domain, not a company's.`);
    const r = await resolveOrCreate(db, { type: "company", name: to.newCompany.name.trim(), domain, source: "meetings" }, { seedClaims: false });
    companyId = r.entity.id;
  }
  if (!companyId) throw new MeetingInvalid("Pick a company, or name a new one.");
  const company = await getEntity(db, companyId);
  if (!company || company.type !== "company") throw new MeetingInvalid("No such company.");
  await setMeetingMatch(db, meetingId, {
    companyId: company.id, status: "matched", matchedBy: by,
    match: { ...(m.match as MeetingMatch), method: "person", reasons: [`Matched by ${by.replace(/^human:/, "")}.`] },
  });
  // Remember the people outside the firm who were there.
  const ctx = await matchContext(db, [{ source: m.source, externalId: m.external_id, title: m.title, attendees: m.attendees }]);
  const firm = new Set([...ctx.firmDomains].map(registrableDomain));
  for (const a of m.attendees) {
    const d = a.email ? normalizeDomain(a.email) : null;
    if (a.email && d && !a.self && !firm.has(registrableDomain(d))) await learnContact(db, a.email, company.id, by);
  }
  await extractMeeting(db, meetingId, llm);
  if (m.join_key) {
    for (const s of await sameConference(db, m.join_key, m.started_at, m.id)) {
      if (s.matched_by?.startsWith("human:")) continue;
      await setMeetingMatch(db, s.id, { companyId: company.id, status: "matched", matchedBy: by, match: { method: "same_conference", confidence: 0.97, reasons: [`Same call as "${m.title}".`], candidates: [] } });
      await extractMeeting(db, s.id, llm);
    }
  }
  return (await getMeeting(db, meetingId))!;
}

/** Internal (partners only) or not worth keeping (a dentist appointment). Nothing is extracted from either. */
export async function markMeeting(db: Db, meetingId: string, status: "internal" | "ignored" | "needs_review", by: string): Promise<MeetingRow> {
  const m = await getMeeting(db, meetingId);
  if (!m) throw new MeetingInvalid("No such meeting.");
  if (m.status === "matched" && m.extracted && status !== "needs_review") {
    // Claims already extracted stay in the ledger (it's append-only); say so in the audit trail.
    await audit(db, by, "meeting.unmatch_after_extraction", meetingId, { company: m.company_id });
  }
  await setMeetingMatch(db, meetingId, { companyId: null, status, matchedBy: by });
  return (await getMeeting(db, meetingId))!;
}

export async function meetings(db: Db, opts: { status?: MeetingStatus; companyId?: string; search?: string; limit?: number } = {}) {
  return (await listMeetings(db, opts)).map((m) => ({ ...m, sourceName: getConnector(m.source).name }));
}

export const counts = meetingCounts;
export const meeting = getMeeting;
