import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Investment Execution's tables: term sheet versions, cap tables, IC
 * meetings, the closing checklist, wire controls and the investment
 * record. Firm-scoped Db only. IC votes live in `decisions`.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Term sheets
// ---------------------------------------------------------------------------

export type TermSheetStatus = "draft" | "proposed" | "negotiating" | "signed" | "superseded";

export interface TermSheetRow {
  id: string;
  version: number;
  status: TermSheetStatus;
  terms: Record<string, unknown>;
  source: "entered" | "extracted";
  evidence_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export async function insertTermSheet(db: Db, dealId: string, t: { terms: unknown; status: TermSheetStatus; source: "entered" | "extracted"; evidenceId?: string | null; note?: string | null }, by: string): Promise<TermSheetRow> {
  const { rows } = await db.query<TermSheetRow>(
    `insert into term_sheets(deal_id, version, status, terms, source, evidence_id, note, created_by)
     values ($1, (select coalesce(max(version), 0) + 1 from term_sheets where deal_id = $1), $2, $3, $4, $5, $6, $7)
     returning id, version, status, terms, source, evidence_id, note, created_by, created_at`,
    [dealId, t.status, JSON.stringify(t.terms), t.source, t.evidenceId ?? null, t.note ?? null, by],
  );
  await audit(db, by, "term_sheet.version", dealId, { version: rows[0]!.version, status: t.status });
  return { ...rows[0]!, created_at: iso(rows[0]!.created_at)! };
}

export async function termSheets(db: Db, dealId: string): Promise<TermSheetRow[]> {
  const { rows } = await db.query<TermSheetRow>(
    "select id, version, status, terms, source, evidence_id, note, created_by, created_at from term_sheets where deal_id = $1 order by version desc",
    [dealId],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}

export async function setTermSheetStatus(db: Db, dealId: string, version: number, status: TermSheetStatus, by: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>("update term_sheets set status = $3 where deal_id = $1 and version = $2 returning id", [dealId, version, status]);
  if (!rows[0]) throw new Error("No such term sheet version.");
  // Signing one version supersedes the others.
  if (status === "signed") await db.query("update term_sheets set status = 'superseded' where deal_id = $1 and version <> $2 and status <> 'superseded'", [dealId, version]);
  await audit(db, by, "term_sheet.status", dealId, { version, status });
}

// ---------------------------------------------------------------------------
// Cap tables
// ---------------------------------------------------------------------------

export interface CapTableRow {
  id: string;
  version: number;
  holdings: unknown[];
  safes: unknown[];
  notes: unknown[];
  series_terms: unknown[];
  source: "entered" | "csv" | "carta";
  evidence_id: string | null;
  created_by: string;
  created_at: string;
}

export async function insertCapTable(db: Db, dealId: string, c: { holdings: unknown[]; safes: unknown[]; notes: unknown[]; seriesTerms: unknown[]; source: CapTableRow["source"]; evidenceId?: string | null }, by: string): Promise<CapTableRow> {
  const { rows } = await db.query<CapTableRow>(
    `insert into cap_tables(deal_id, version, holdings, safes, notes, series_terms, source, evidence_id, created_by)
     values ($1, (select coalesce(max(version), 0) + 1 from cap_tables where deal_id = $1), $2, $3, $4, $5, $6, $7, $8)
     returning id, version, holdings, safes, notes, series_terms, source, evidence_id, created_by, created_at`,
    [dealId, JSON.stringify(c.holdings), JSON.stringify(c.safes), JSON.stringify(c.notes), JSON.stringify(c.seriesTerms), c.source, c.evidenceId ?? null, by],
  );
  await audit(db, by, "cap_table.version", dealId, { version: rows[0]!.version, source: c.source });
  return { ...rows[0]!, created_at: iso(rows[0]!.created_at)! };
}

export async function latestCapTable(db: Db, dealId: string): Promise<CapTableRow | null> {
  const { rows } = await db.query<CapTableRow>(
    "select id, version, holdings, safes, notes, series_terms, source, evidence_id, created_by, created_at from cap_tables where deal_id = $1 order by version desc limit 1",
    [dealId],
  );
  return rows[0] ? { ...rows[0], created_at: iso(rows[0].created_at)! } : null;
}

// ---------------------------------------------------------------------------
// IC meetings
// ---------------------------------------------------------------------------

export type IcPhase = "pre_vote" | "discussion" | "post_vote" | "decided" | "cancelled";

export interface IcMeetingRow {
  id: string;
  deal_id: string;
  scheduled_for: string | null;
  members: string[];
  chair: string;
  rule: string;
  memo_version: number | null;
  term_sheet_version: number | null;
  phase: IcPhase;
  outcome: "approved" | "declined" | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

const meeting = (r: IcMeetingRow): IcMeetingRow => ({ ...r, scheduled_for: iso(r.scheduled_for), created_at: iso(r.created_at)!, decided_at: iso(r.decided_at) });

export async function insertIcMeeting(db: Db, dealId: string, m: { scheduledFor?: string | null; members: string[]; chair: string; rule: string; memoVersion?: number | null; termSheetVersion?: number | null }, by: string): Promise<IcMeetingRow> {
  const { rows } = await db.query<IcMeetingRow>(
    `insert into ic_meetings(deal_id, scheduled_for, members, chair, rule, memo_version, term_sheet_version, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [dealId, m.scheduledFor ?? null, m.members, m.chair, m.rule, m.memoVersion ?? null, m.termSheetVersion ?? null, by],
  );
  await audit(db, by, "ic.schedule", dealId, { meeting: rows[0]!.id });
  return meeting(rows[0]!);
}

export async function icMeetings(db: Db, dealId: string): Promise<IcMeetingRow[]> {
  return (await db.query<IcMeetingRow>("select * from ic_meetings where deal_id = $1 order by created_at desc", [dealId])).rows.map(meeting);
}

export async function getIcMeeting(db: Db, id: string): Promise<IcMeetingRow | null> {
  const r = (await db.query<IcMeetingRow>("select * from ic_meetings where id = $1", [id])).rows[0];
  return r ? meeting(r) : null;
}

export async function updateIcMeeting(db: Db, id: string, patch: { phase?: IcPhase; outcome?: "approved" | "declined"; notes?: string }, by: string): Promise<void> {
  await db.query(
    `update ic_meetings set phase = coalesce($2, phase), outcome = coalesce($3, outcome), notes = coalesce($4, notes),
            decided_at = case when $2 = 'decided' then now() else decided_at end where id = $1`,
    [id, patch.phase ?? null, patch.outcome ?? null, patch.notes ?? null],
  );
  await audit(db, by, "ic.update", id, patch);
}

/** IC votes recorded for a meeting, from `decisions`. */
export async function icVotes(db: Db, meetingId: string) {
  const { rows } = await db.query<{ id: string; kind: "ic_vote_pre" | "ic_vote_post"; actor: string; value: { vote: string; conviction?: number; meetingId: string; note?: string; recused?: boolean }; rationale: string | null; created_at: unknown }>(
    `select id, kind, actor, value, rationale, created_at from decisions
      where kind in ('ic_vote_pre','ic_vote_post') and value->>'meetingId' = $1 order by created_at`,
    [meetingId],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

// ---------------------------------------------------------------------------
// Closing checklist
// ---------------------------------------------------------------------------

export type ClosingStatus = "open" | "requested" | "received" | "signed" | "filed" | "done" | "waived" | "na" | "red_flag";

export interface ClosingItemRow {
  id: string;
  key: string;
  category: string;
  title: string;
  required: boolean;
  status: ClosingStatus;
  owner: string | null;
  due_date: string | null;
  evidence_id: string | null;
  envelope_id: string | null;
  note: string | null;
  custom: boolean;
  updated_by: string;
  updated_at: string;
}

export async function closingItems(db: Db, dealId: string): Promise<ClosingItemRow[]> {
  const { rows } = await db.query<ClosingItemRow>("select * from closing_items where deal_id = $1 order by category, key", [dealId]);
  return rows.map((r) => ({ ...r, due_date: day(r.due_date), updated_at: iso(r.updated_at)! }));
}

/** Add checklist items that aren't there yet (idempotent). People's statuses are never touched. */
export async function seedClosingItems(db: Db, dealId: string, items: { key: string; category: string; title: string; required: boolean }[], by: string): Promise<void> {
  for (const i of items) {
    await db.query(
      `insert into closing_items(deal_id, key, category, title, required, updated_by) values ($1,$2,$3,$4,$5,$6)
       on conflict (deal_id, key) do update set title = excluded.title, category = excluded.category, required = excluded.required
         where closing_items.custom = false`,
      [dealId, i.key, i.category, i.title, i.required, by],
    );
  }
}

export async function updateClosingItem(
  db: Db,
  dealId: string,
  key: string,
  patch: { status?: ClosingStatus; owner?: string | null; dueDate?: string | null; evidenceId?: string | null; envelopeId?: string | null; note?: string | null },
  by: string,
): Promise<void> {
  const sets: string[] = ["updated_by = $3", "updated_at = now()"];
  const params: unknown[] = [dealId, key, by];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.owner !== undefined) set("owner", patch.owner);
  if (patch.dueDate !== undefined) set("due_date", patch.dueDate);
  if (patch.evidenceId !== undefined) set("evidence_id", patch.evidenceId);
  if (patch.envelopeId !== undefined) set("envelope_id", patch.envelopeId);
  if (patch.note !== undefined) set("note", patch.note);
  const { rows } = await db.query<{ id: string }>(`update closing_items set ${sets.join(", ")} where deal_id = $1 and key = $2 returning id`, params);
  if (!rows[0]) throw new Error("No such closing item.");
  await audit(db, by, "closing.item", dealId, { item: key, status: patch.status });
}

export async function insertCustomClosingItem(db: Db, dealId: string, i: { key: string; category: string; title: string; required: boolean }, by: string): Promise<void> {
  await db.query("insert into closing_items(deal_id, key, category, title, required, custom, updated_by) values ($1,$2,$3,$4,$5,true,$6)", [dealId, i.key, i.category, i.title, i.required, by]);
  await audit(db, by, "closing.item.add", dealId, { item: i.key });
}

/** Closing items across deals that wait on a DocuSign envelope. */
export async function itemsWithEnvelopes(db: Db): Promise<{ deal_id: string; key: string; envelope_id: string; status: ClosingStatus }[]> {
  return (await db.query<{ deal_id: string; key: string; envelope_id: string; status: ClosingStatus }>(
    "select deal_id, key, envelope_id, status from closing_items where envelope_id is not null",
  )).rows;
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

export type WireStatus = "received" | "verified" | "approved" | "sent" | "confirmed" | "cancelled";

export interface WireRow {
  id: string;
  amount_usd: number;
  beneficiary: string;
  bank_name: string;
  account_last4: string;
  instructions_evidence_id: string | null;
  instructions_received_at: string;
  callback_by: string | null;
  callback_number_source: string | null;
  callback_at: string | null;
  approvals: string[];
  status: WireStatus;
  bank_reference: string | null;
  sent_at: string | null;
  confirmed_at: string | null;
  created_by: string;
  created_at: string;
}

const wire = (r: WireRow): WireRow => ({
  ...r, amount_usd: Number(r.amount_usd), instructions_received_at: iso(r.instructions_received_at)!, callback_at: iso(r.callback_at),
  sent_at: iso(r.sent_at), confirmed_at: iso(r.confirmed_at), created_at: iso(r.created_at)!,
});

export async function insertWire(db: Db, dealId: string, w: { amountUsd: number; beneficiary: string; bankName: string; accountLast4: string; evidenceId?: string | null }, by: string): Promise<WireRow> {
  const { rows } = await db.query<WireRow>(
    `insert into wires(deal_id, amount_usd, beneficiary, bank_name, account_last4, instructions_evidence_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [dealId, w.amountUsd, w.beneficiary, w.bankName, w.accountLast4, w.evidenceId ?? null, by],
  );
  await audit(db, by, "wire.instructions", dealId, { wire: rows[0]!.id, amount: w.amountUsd });
  return wire(rows[0]!);
}

export async function wires(db: Db, dealId: string): Promise<WireRow[]> {
  return (await db.query<WireRow>("select * from wires where deal_id = $1 order by created_at desc", [dealId])).rows.map(wire);
}

export async function getWire(db: Db, id: string): Promise<WireRow | null> {
  const r = (await db.query<WireRow>("select * from wires where id = $1", [id])).rows[0];
  return r ? wire(r) : null;
}

export async function updateWire(
  db: Db,
  id: string,
  patch: { status?: WireStatus; callbackBy?: string; callbackNumberSource?: string; callback?: boolean; approvals?: string[]; bankReference?: string; sent?: boolean; confirmed?: boolean },
  by: string,
): Promise<void> {
  await db.query(
    `update wires set status = coalesce($2, status),
            callback_by = coalesce($3, callback_by), callback_number_source = coalesce($4, callback_number_source),
            callback_at = case when $5 then now() else callback_at end,
            approvals = coalesce($6, approvals), bank_reference = coalesce($7, bank_reference),
            sent_at = case when $8 then now() else sent_at end, confirmed_at = case when $9 then now() else confirmed_at end
      where id = $1`,
    [id, patch.status ?? null, patch.callbackBy ?? null, patch.callbackNumberSource ?? null, Boolean(patch.callback), patch.approvals ?? null,
      patch.bankReference ?? null, Boolean(patch.sent), Boolean(patch.confirmed)],
  );
  await audit(db, by, `wire.${patch.status ?? "update"}`, id, { status: patch.status });
}

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

export interface InvestmentRow {
  id: string;
  deal_id: string;
  company_id: string;
  company_name?: string;
  fund_name: string;
  security: string;
  series_name: string | null;
  close_date: string;
  amount_usd: number;
  shares: number | null;
  price_per_share: number | null;
  post_money_usd: number | null;
  ownership_fd_pct: number | null;
  board_role: string | null;
  round_kind: "initial" | "follow_on";
  rights: Record<string, unknown>;
  supersedes: string | null;
  created_by: string;
  created_at: string;
}

const investment = (r: InvestmentRow): InvestmentRow => ({
  ...r, close_date: day(r.close_date)!, amount_usd: Number(r.amount_usd), shares: num(r.shares), price_per_share: num(r.price_per_share),
  post_money_usd: num(r.post_money_usd), ownership_fd_pct: num(r.ownership_fd_pct), created_at: iso(r.created_at)!,
});

export async function insertInvestment(
  db: Db,
  i: { dealId: string; companyId: string; fundName: string; security: string; seriesName?: string | null; closeDate: string; amountUsd: number; shares?: number | null; pricePerShare?: number | null; postMoneyUsd?: number | null; ownershipFdPct?: number | null; boardRole?: string | null; rights: Record<string, unknown>; supersedes?: string | null; roundKind?: "initial" | "follow_on" },
  by: string,
): Promise<InvestmentRow> {
  const { rows } = await db.query<InvestmentRow>(
    `insert into investments(deal_id, company_id, fund_name, security, series_name, close_date, amount_usd, shares, price_per_share, post_money_usd,
       ownership_fd_pct, board_role, rights, supersedes, created_by, round_kind)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [i.dealId, i.companyId, i.fundName, i.security, i.seriesName ?? null, i.closeDate, i.amountUsd, i.shares ?? null, i.pricePerShare ?? null,
      i.postMoneyUsd ?? null, i.ownershipFdPct ?? null, i.boardRole ?? null, JSON.stringify(i.rights), i.supersedes ?? null, by, i.roundKind ?? "initial"],
  );
  await audit(db, by, "investment.record", i.dealId, { investment: rows[0]!.id, amount: i.amountUsd });
  return investment(rows[0]!);
}

/** Current investments (not superseded), newest first, with company names. */
export async function listInvestments(db: Db, opts: { dealId?: string; companyId?: string } = {}): Promise<InvestmentRow[]> {
  const where = opts.dealId ? "and i.deal_id = $1" : opts.companyId ? "and i.company_id = $1" : "";
  const { rows } = await db.query<InvestmentRow>(
    `select i.*, e.name as company_name from investments i join entities e on e.id = i.company_id
      where not exists (select 1 from investments s where s.supersedes = i.id) ${where}
      order by i.close_date desc, i.created_at desc`,
    opts.dealId ? [opts.dealId] : opts.companyId ? [opts.companyId] : [],
  );
  return rows.map(investment);
}
