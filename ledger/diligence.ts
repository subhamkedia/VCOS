import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Diligence workflow tables: deals, checklist statuses, founder questions,
 * memo versions and research runs, plus the contradiction board's writes.
 * Firm-scoped Db only. Facts about the company stay in `claims`; these
 * tables hold the firm's process and judgment around them.
 */

export type DealStage = "screening" | "diligence" | "ic" | "approved" | "closing" | "passed" | "closed";
export const DEAL_STAGES: DealStage[] = ["screening", "diligence", "ic", "approved", "closing", "passed", "closed"];
export type ItemStatus = "open" | "in_progress" | "done" | "na" | "red_flag";
export type QuestionStatus = "open" | "asked" | "answered" | "dropped";
export type QuestionOrigin = "gap" | "unverified" | "contradiction" | "pilot" | "risk" | "custom";

export interface DealFlags {
  hardware?: boolean;
  regulated?: boolean;
  sensitive_tech?: boolean;
}

export interface DealRow {
  id: string;
  company_id: string;
  company_name: string;
  stage: DealStage;
  lead: string | null;
  team: string[];
  our_check_usd: number | null;
  flags: DealFlags;
  target_ic_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));

const DEAL_SELECT = `select d.id, d.company_id, e.name as company_name, d.stage, d.lead, d.team, d.our_check_usd, d.flags,
       d.target_ic_date, d.created_by, d.created_at, d.updated_at
  from deals d join entities e on e.id = d.company_id`;

const deal = (r: DealRow): DealRow => ({
  ...r, our_check_usd: r.our_check_usd === null ? null : Number(r.our_check_usd), target_ic_date: dateOnly(r.target_ic_date),
  created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
});

export async function insertDeal(db: Db, d: { companyId: string; lead: string | null; flags: DealFlags; createdBy: string; stage?: DealStage }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into deals(company_id, lead, flags, created_by, stage) values ($1,$2,$3,$4,$5) returning id",
    [d.companyId, d.lead, JSON.stringify(d.flags), d.createdBy, d.stage ?? "diligence"],
  );
  await audit(db, d.createdBy, "deal.start", rows[0]!.id, { company: d.companyId });
  return rows[0]!.id;
}

export async function getDeal(db: Db, id: string): Promise<DealRow | null> {
  const { rows } = await db.query<DealRow>(`${DEAL_SELECT} where d.id = $1`, [id]);
  return rows[0] ? deal(rows[0]) : null;
}

export async function openDealFor(db: Db, companyId: string): Promise<DealRow | null> {
  const { rows } = await db.query<DealRow>(
    `${DEAL_SELECT} where d.company_id in (select id from entities where id = $1 or merged_into = $1)
       and d.stage not in ('passed','closed') order by d.created_at desc limit 1`,
    [companyId],
  );
  return rows[0] ? deal(rows[0]) : null;
}

export interface DealListRow extends DealRow {
  domain: string | null;
  open_contradictions: number;
  open_questions: number;
  meetings: number;
  last_activity: string | null;
}

export async function listDeals(db: Db, opts: { stages?: DealStage[] } = {}): Promise<DealListRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.stages?.length) {
    params.push(opts.stages);
    where = `where d.stage = any($1::text[])`;
  }
  const { rows } = await db.query<DealListRow>(
    `select d.id, d.company_id, e.name as company_name, d.stage, d.lead, d.team, d.our_check_usd, d.flags, d.target_ic_date,
            d.created_by, d.created_at, d.updated_at,
            (select value from entity_identifiers i where i.entity_id = d.company_id and i.kind = 'domain' limit 1) as domain,
            (select count(*)::int from contradictions x where x.subject_id in (select id from entities where id = d.company_id or merged_into = d.company_id) and x.status = 'open') as open_contradictions,
            (select count(*)::int from deal_questions q where q.deal_id = d.id and q.status in ('open','asked')) as open_questions,
            (select count(*)::int from meetings m where m.company_id = d.company_id) as meetings,
            greatest(d.updated_at, (select max(created_at) from claims c where c.subject_id = d.company_id)) as last_activity
       from deals d join entities e on e.id = d.company_id ${where}
      order by case d.stage when 'ic' then 0 when 'diligence' then 1 when 'screening' then 2 when 'approved' then 3 else 4 end, d.updated_at desc`,
    params,
  );
  return rows.map((r) => ({ ...r, ...deal(r), last_activity: iso(r.last_activity) }));
}

export async function updateDeal(
  db: Db,
  id: string,
  patch: { stage?: DealStage; lead?: string | null; team?: string[]; ourCheckUsd?: number | null; flags?: DealFlags; targetIcDate?: string | null },
  by: string,
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.stage !== undefined) set("stage", patch.stage);
  if (patch.lead !== undefined) set("lead", patch.lead);
  if (patch.team !== undefined) set("team", patch.team);
  if (patch.ourCheckUsd !== undefined) set("our_check_usd", patch.ourCheckUsd);
  if (patch.flags !== undefined) set("flags", JSON.stringify(patch.flags));
  if (patch.targetIcDate !== undefined) set("target_ic_date", patch.targetIcDate);
  await db.query(`update deals set ${sets.join(", ")} where id = $1`, params);
  await audit(db, by, "deal.update", id, { fields: Object.keys(patch) });
}

export const touchDeal = (db: Db, id: string) => db.query("update deals set updated_at = now() where id = $1", [id]);

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export interface ItemRow {
  item_key: string;
  workstream: string;
  title: string | null;
  custom: boolean;
  status: ItemStatus | null;
  assignee: string | null;
  note: string | null;
  updated_by: string;
  updated_at: string;
}

export async function dealItems(db: Db, dealId: string): Promise<ItemRow[]> {
  const { rows } = await db.query<ItemRow>(
    "select item_key, workstream, title, custom, status, assignee, note, updated_by, updated_at from deal_items where deal_id = $1 order by updated_at",
    [dealId],
  );
  return rows.map((r) => ({ ...r, updated_at: iso(r.updated_at)! }));
}

export async function upsertItem(
  db: Db,
  dealId: string,
  i: { key: string; workstream: string; title?: string; custom?: boolean; status?: ItemStatus | null; assignee?: string | null; note?: string | null },
  by: string,
): Promise<void> {
  await db.query(
    `insert into deal_items(deal_id, item_key, workstream, title, custom, status, assignee, note, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (deal_id, item_key) do update set
       status = case when $10 then excluded.status else deal_items.status end,
       assignee = case when $11 then excluded.assignee else deal_items.assignee end,
       note = case when $12 then excluded.note else deal_items.note end,
       title = coalesce(excluded.title, deal_items.title),
       updated_by = excluded.updated_by, updated_at = now()`,
    [dealId, i.key, i.workstream, i.title ?? null, i.custom ?? false, i.status ?? null, i.assignee ?? null, i.note ?? null, by,
      i.status !== undefined, i.assignee !== undefined, i.note !== undefined],
  );
  await audit(db, by, "deal.item", dealId, { item: i.key, status: i.status, assignee: i.assignee });
  await touchDeal(db, dealId);
}

export async function deleteCustomItem(db: Db, dealId: string, key: string, by: string): Promise<void> {
  await db.query("delete from deal_items where deal_id = $1 and item_key = $2 and custom", [dealId, key]);
  await audit(db, by, "deal.item.delete", dealId, { item: key });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface QuestionRow {
  id: string;
  key: string;
  workstream: string;
  text: string;
  origin: QuestionOrigin;
  claim_ids: string[];
  status: QuestionStatus;
  answer: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function dealQuestions(db: Db, dealId: string): Promise<QuestionRow[]> {
  const { rows } = await db.query<QuestionRow>(
    `select id, key, workstream, text, origin, claim_ids, status, answer, updated_by, created_at, updated_at from deal_questions
      where deal_id = $1 order by case status when 'open' then 0 when 'asked' then 1 when 'answered' then 2 else 3 end, created_at`,
    [dealId],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! }));
}

/** Add generated questions that aren't there yet; refresh the wording of open ones. People's answers are never touched. */
export async function upsertGeneratedQuestion(
  db: Db,
  dealId: string,
  q: { key: string; workstream: string; text: string; origin: QuestionOrigin; claimIds: string[] },
): Promise<void> {
  await db.query(
    `insert into deal_questions(deal_id, key, workstream, text, origin, claim_ids) values ($1,$2,$3,$4,$5,$6)
     on conflict (deal_id, key) do update set text = excluded.text, claim_ids = excluded.claim_ids, updated_at = now()
       where deal_questions.status = 'open' and deal_questions.origin <> 'custom'`,
    [dealId, q.key, q.workstream, q.text, q.origin, q.claimIds],
  );
}

/** Generated questions the ledger has since answered (the gap filled, the conflict resolved). */
export async function closeGeneratedQuestions(db: Db, dealId: string, keepKeys: string[]): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update deal_questions set status = 'answered', answer = 'Answered by new evidence in the ledger.', updated_by = 'system', updated_at = now()
      where deal_id = $1 and origin <> 'custom' and status = 'open' and not (key = any($2::text[])) returning id`,
    [dealId, keepKeys],
  );
  return rows.length;
}

export async function insertCustomQuestion(db: Db, dealId: string, q: { workstream: string; text: string }, by: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into deal_questions(deal_id, key, workstream, text, origin, updated_by) values ($1, 'custom:' || gen_random_uuid(), $2, $3, 'custom', $4) returning id`,
    [dealId, q.workstream, q.text, by],
  );
  await audit(db, by, "deal.question.add", dealId, { question: rows[0]!.id });
  return rows[0]!.id;
}

export async function updateQuestion(db: Db, dealId: string, id: string, patch: { status?: QuestionStatus; answer?: string | null; text?: string }, by: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update deal_questions set status = coalesce($3, status), answer = case when $4 then $5 else answer end, text = coalesce($6, text),
            updated_by = $7, updated_at = now()
      where id = $1 and deal_id = $2 returning id`,
    [id, dealId, patch.status ?? null, patch.answer !== undefined, patch.answer ?? null, patch.text ?? null, by],
  );
  if (!rows[0]) throw new Error("No such question.");
  await audit(db, by, "deal.question.update", dealId, { question: id, status: patch.status });
}

// ---------------------------------------------------------------------------
// Memos (append-only versions)
// ---------------------------------------------------------------------------

export interface MemoRow {
  id: string;
  version: number;
  shareable: boolean;
  body: unknown;
  check_result: unknown;
  drafted_by: string;
  created_by: string;
  created_at: string;
}

export async function insertMemo(db: Db, dealId: string, m: { shareable: boolean; body: unknown; check: unknown; draftedBy: string; createdBy: string }): Promise<MemoRow> {
  const { rows } = await db.query<MemoRow>(
    `insert into memos(deal_id, version, shareable, body, check_result, drafted_by, created_by)
     values ($1, (select coalesce(max(version), 0) + 1 from memos where deal_id = $1), $2, $3, $4, $5, $6)
     returning id, version, shareable, body, check_result, drafted_by, created_by, created_at`,
    [dealId, m.shareable, JSON.stringify(m.body), JSON.stringify(m.check), m.draftedBy, m.createdBy],
  );
  await audit(db, m.createdBy, "memo.draft", dealId, { version: rows[0]!.version, drafted_by: m.draftedBy });
  await touchDeal(db, dealId);
  return { ...rows[0]!, created_at: iso(rows[0]!.created_at)! };
}

export async function dealMemos(db: Db, dealId: string): Promise<Omit<MemoRow, "body">[]> {
  const { rows } = await db.query<MemoRow>(
    "select id, version, shareable, check_result, drafted_by, created_by, created_at from memos where deal_id = $1 order by version desc",
    [dealId],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}

export async function getMemo(db: Db, dealId: string, version?: number): Promise<MemoRow | null> {
  const { rows } = await db.query<MemoRow>(
    `select id, version, shareable, body, check_result, drafted_by, created_by, created_at from memos where deal_id = $1
       ${version ? "and version = $2" : ""} order by version desc limit 1`,
    version ? [dealId, version] : [dealId],
  );
  return rows[0] ? { ...rows[0], created_at: iso(rows[0].created_at)! } : null;
}

// ---------------------------------------------------------------------------
// Research runs, notes and the activity trail
// ---------------------------------------------------------------------------

export async function startDealRun(db: Db, dealId: string, kind: string, by: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("insert into job_runs(deal_id, kind, triggered_by) values ($1,$2,$3) returning id", [dealId, kind, by]);
  return rows[0]!.id;
}

export async function updateRunStats(db: Db, runId: string, stats: Record<string, unknown>): Promise<void> {
  await db.query("update job_runs set stats = $2 where id = $1", [runId, JSON.stringify(stats)]);
}

export async function dealRuns(db: Db, dealId: string, limit = 10) {
  const { rows } = await db.query<{ id: string; kind: string; status: string; started_at: unknown; finished_at: unknown; stats: Record<string, unknown>; error: string | null; triggered_by: string }>(
    "select id, kind, status, started_at, finished_at, stats, error, triggered_by from job_runs where deal_id = $1 order by started_at desc limit $2",
    [dealId, limit],
  );
  return rows.map((r) => ({ ...r, started_at: iso(r.started_at), finished_at: iso(r.finished_at) }));
}

/** Diligence notes (reference calls, customer calls, expert calls, site visits) about a company. */
export async function companyNotes(db: Db, companyId: string) {
  const { rows } = await db.query<{ id: string; title: string | null; content: string; occurred_at: unknown; captured_at: unknown; metadata: Record<string, unknown> }>(
    `select id, title, content, occurred_at, captured_at, metadata from evidence
      where source = 'diligence-note' and metadata->>'companyId' in (select id::text from entities where id = $1 or merged_into = $1)
      order by coalesce(occurred_at, captured_at) desc`,
    [companyId],
  );
  return rows.map((r) => ({ ...r, occurred_at: iso(r.occurred_at), captured_at: iso(r.captured_at) }));
}

/** Evidence about a company, grouped by source, for "what did we read". */
export async function companySources(db: Db, companyId: string) {
  const { rows } = await db.query<{ source: string; kind: string; items: number; claims: number; latest: unknown }>(
    `select e.source, min(e.kind) as kind, count(distinct e.id)::int as items, count(c.id)::int as claims, max(e.captured_at) as latest
       from evidence e join claims c on c.evidence_id = e.id
      where c.subject_id in (select id from entities where id = $1 or merged_into = $1)
      group by e.source order by latest desc`,
    [companyId],
  );
  return rows.map((r) => ({ ...r, latest: iso(r.latest) }));
}

export async function dealActivity(db: Db, dealId: string, companyId: string, limit = 40) {
  const { rows } = await db.query<{ at: unknown; actor: string; action: string; target: string | null; detail: Record<string, unknown> }>(
    `select at, actor, action, target, detail from audit_log
      where target = $1 or target = $2::text or detail->>'deal' = $1 or detail->>'entity' = $2::text or detail->>'company' = $2::text
      order by at desc limit $3`,
    [dealId, companyId, limit],
  );
  return rows.map((r) => ({ ...r, at: iso(r.at) }));
}

// ---------------------------------------------------------------------------
// The contradiction board
// ---------------------------------------------------------------------------

export async function getContradiction(db: Db, id: string) {
  const { rows } = await db.query<{ id: string; subject_id: string; predicate: string; claim_ids: string[]; severity: string; status: string; detail: string | null }>(
    "select id, subject_id, predicate, claim_ids, severity, status, detail from contradictions where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function setContradictionStatus(db: Db, id: string, status: "open" | "explained" | "resolved", note: string | null, by: string): Promise<void> {
  await db.query(
    `update contradictions set status = $2, resolution_note = $3, resolved_by = $4, resolved_at = case when $2 = 'open' then null else now() end where id = $1`,
    [id, status, note, status === "open" ? null : by],
  );
  await audit(db, by, `contradiction.${status}`, id, { note });
}

/** Contradictions about a company that people have explained or resolved, newest first. */
export async function settledContradictions(db: Db, companyId: string) {
  const { rows } = await db.query<{ id: string; predicate: string; severity: string; status: string; detail: string | null; claim_ids: string[]; resolution_note: string | null; resolved_by: string | null; resolved_at: unknown }>(
    `select id, predicate, severity, status, detail, claim_ids, resolution_note, resolved_by, resolved_at from contradictions
      where subject_id in (select id from entities where id = $1 or merged_into = $1) and status <> 'open' order by resolved_at desc nulls last`,
    [companyId],
  );
  return rows.map((r) => ({ ...r, resolved_at: iso(r.resolved_at) }));
}
