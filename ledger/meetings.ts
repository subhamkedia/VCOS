import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Meetings a firm's tools reported, and what the firm taught the matcher.
 * Firm-scoped Db only.
 */

export type MeetingStatus = "matched" | "needs_review" | "internal" | "ignored";

export interface MeetingMatch {
  method: string;
  confidence: number;
  reasons: string[];
  candidates: { entityId: string; name: string; why: string }[];
  /** A company domain nobody in the ledger has yet. */
  newDomain?: string;
}

export interface MeetingRow {
  id: string;
  source: string;
  external_id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  organizer: string | null;
  attendees: { name?: string; email?: string; self?: boolean }[];
  join_key: string | null;
  url: string | null;
  evidence_id: string | null;
  company_id: string | null;
  company_name: string | null;
  status: MeetingStatus;
  match: MeetingMatch | Record<string, never>;
  matched_by: string | null;
  extracted: boolean;
  has_words: boolean;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));

const SELECT = `select m.id, m.source, m.external_id, m.title, m.started_at, m.ended_at, m.organizer, m.attendees, m.join_key, m.url,
       m.evidence_id, m.company_id, e.name as company_name, m.status, m.match, m.matched_by, m.extracted,
       (m.evidence_id is not null) as has_words
  from meetings m left join entities e on e.id = m.company_id`;

const row = (r: MeetingRow) => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at) });

export async function getMeeting(db: Db, id: string): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(`${SELECT} where m.id = $1`, [id]);
  return rows[0] ? row(rows[0]) : null;
}

export async function findMeeting(db: Db, source: string, externalId: string): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(`${SELECT} where m.source = $1 and m.external_id = $2`, [source, externalId]);
  return rows[0] ? row(rows[0]) : null;
}

/** Other meetings on the same conference link within 12 hours: the invite for a recording, or the other way round. */
export async function sameConference(db: Db, joinKey: string, at: string | null, exceptId?: string): Promise<MeetingRow[]> {
  const { rows } = await db.query<MeetingRow>(
    `${SELECT} where m.join_key = $1 and ($2::timestamptz is null or m.started_at is null or abs(extract(epoch from (m.started_at - $2::timestamptz))) < 43200)
       and ($3::uuid is null or m.id <> $3::uuid) order by m.synced_at`,
    [joinKey, at, exceptId ?? null],
  );
  return rows.map(row);
}

export async function insertMeeting(
  db: Db,
  m: {
    source: string; externalId: string; title: string; startedAt?: string; endedAt?: string; organizer?: string;
    attendees: unknown[]; joinKey?: string; url?: string; evidenceId?: string | null;
    companyId: string | null; status: MeetingStatus; match: MeetingMatch; matchedBy: string | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into meetings(source, external_id, title, started_at, ended_at, organizer, attendees, join_key, url, evidence_id, company_id, status, match, matched_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [m.source, m.externalId, m.title, m.startedAt ?? null, m.endedAt ?? null, m.organizer ?? null, JSON.stringify(m.attendees), m.joinKey ?? null,
      m.url ?? null, m.evidenceId ?? null, m.companyId, m.status, JSON.stringify(m.match), m.matchedBy],
  );
  return rows[0]!.id;
}

/** A later sync found words for a meeting that had none (a transcript finished processing). */
export async function attachMeetingEvidence(db: Db, id: string, evidenceId: string): Promise<void> {
  await db.query("update meetings set evidence_id = $2, extracted = false, synced_at = now() where id = $1", [id, evidenceId]);
}

export async function setMeetingMatch(
  db: Db,
  id: string,
  m: { companyId: string | null; status: MeetingStatus; matchedBy: string; match?: MeetingMatch },
): Promise<void> {
  await db.query(
    `update meetings set company_id = $2, status = $3, matched_by = $4, match = coalesce($5, match) where id = $1`,
    [id, m.companyId, m.status, m.matchedBy, m.match ? JSON.stringify(m.match) : null],
  );
  await audit(db, m.matchedBy, "meeting.match", id, { company: m.companyId, status: m.status });
}

export async function markExtracted(db: Db, id: string): Promise<void> {
  await db.query("update meetings set extracted = true where id = $1", [id]);
}

export async function listMeetings(
  db: Db,
  opts: { status?: MeetingStatus; companyId?: string; limit?: number; search?: string } = {},
): Promise<MeetingRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`m.status = $${params.length}`);
  }
  if (opts.companyId) {
    params.push(opts.companyId);
    where.push(`m.company_id in (select id from entities where id = $${params.length} or merged_into = $${params.length})`);
  }
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    where.push(`(lower(m.title) like $${params.length} or lower(m.attendees::text) like $${params.length})`);
  }
  params.push(opts.limit ?? 200);
  const { rows } = await db.query<MeetingRow>(
    `${SELECT} ${where.length ? `where ${where.join(" and ")}` : ""} order by m.started_at desc nulls last limit $${params.length}`,
    params,
  );
  return rows.map(row);
}

export async function meetingCounts(db: Db): Promise<Record<MeetingStatus, number>> {
  const { rows } = await db.query<{ status: MeetingStatus; n: number }>("select status, count(*)::int as n from meetings group by status");
  const out: Record<MeetingStatus, number> = { matched: 0, needs_review: 0, internal: 0, ignored: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// What people taught the matcher
// ---------------------------------------------------------------------------

export async function learnContact(db: Db, email: string, entityId: string, by: string): Promise<void> {
  await db.query(
    `insert into meeting_contacts(email, entity_id, learned_by) values ($1,$2,$3)
     on conflict (firm_id, email) do update set entity_id = excluded.entity_id, learned_by = excluded.learned_by, created_at = now()`,
    [email.toLowerCase(), entityId, by],
  );
}

export async function knownContacts(db: Db, emails: string[]): Promise<Map<string, string>> {
  if (!emails.length) return new Map();
  const { rows } = await db.query<{ email: string; entity_id: string }>(
    `select c.email, coalesce(e.merged_into, e.id) as entity_id from meeting_contacts c join entities e on e.id = c.entity_id
      where c.email = any($1::text[])`,
    [emails.map((e) => e.toLowerCase())],
  );
  return new Map(rows.map((r) => [r.email, r.entity_id]));
}

/** Companies owning these domains (read through merges). */
export async function companiesByDomain(db: Db, domains: string[]): Promise<Map<string, { id: string; name: string }>> {
  if (!domains.length) return new Map();
  const { rows } = await db.query<{ value: string; id: string; name: string }>(
    `select i.value, coalesce(e.merged_into, e.id) as id, coalesce(t.name, e.name) as name
       from entity_identifiers i join entities e on e.id = i.entity_id left join entities t on t.id = e.merged_into
      where i.kind = 'domain' and i.value = any($1::text[]) and e.type = 'company'`,
    [domains],
  );
  return new Map(rows.map((r) => [r.value, { id: r.id, name: r.name }]));
}

/** Every active company's names, for spotting a company in a meeting title. */
export async function companyNames(db: Db): Promise<{ id: string; name: string; alias: string }[]> {
  return (await db.query<{ id: string; name: string; alias: string }>(
    `select e.id, e.name, a.alias from entities e join entity_aliases a on a.entity_id = e.id
      where e.type = 'company' and e.merged_into is null`,
  )).rows;
}

/** Email domains the firm's own people use, from who connected tools and who acts in the app. */
export async function firmEmailDomains(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ d: string }>(
    `select distinct lower(split_part(x, '@', 2)) as d from (
       select regexp_replace(connected_by, '^human:', '') as x from connections
       union select account_label from connections where account_label like '%@%'
       union select regexp_replace(actor, '^human:', '') from audit_log where actor like 'human:%@%'
     ) s where x like '%@%'`,
  );
  return rows.map((r) => r.d).filter(Boolean);
}
