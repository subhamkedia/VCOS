import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Portfolio Management's tables: company contacts, founder portal links,
 * KPI requests, accounting links, valuation marks, realizations, board
 * meetings and value-creation initiatives. Firm-scoped Db only. KPIs are
 * claims; health ratings, reserve plans and follow-on decisions are
 * decisions.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  company_id: string;
  name: string;
  email: string;
  role: string | null;
  reporting: boolean;
  created_by: string;
  created_at: string;
}

export async function contacts(db: Db, companyId: string): Promise<ContactRow[]> {
  const { rows } = await db.query<ContactRow>("select * from company_contacts where company_id = $1 order by reporting desc, name", [companyId]);
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}

export async function upsertContact(db: Db, companyId: string, c: { name: string; email: string; role?: string | null; reporting?: boolean }, by: string): Promise<ContactRow> {
  const { rows } = await db.query<ContactRow>(
    `insert into company_contacts(company_id, name, email, role, reporting, created_by) values ($1,$2,lower($3),$4,$5,$6)
     on conflict (firm_id, company_id, email) do update set name = excluded.name, role = excluded.role, reporting = excluded.reporting
     returning *`,
    [companyId, c.name, c.email, c.role ?? null, c.reporting ?? false, by],
  );
  await audit(db, by, "portfolio.contact", companyId, { email: c.email.toLowerCase() });
  return { ...rows[0]!, created_at: iso(rows[0]!.created_at)! };
}

export async function removeContact(db: Db, companyId: string, id: string, by: string): Promise<void> {
  const { rows } = await db.query("delete from company_contacts where company_id = $1 and id = $2 returning id", [companyId, id]);
  if (!rows[0]) throw new Error("No such contact.");
  await audit(db, by, "portfolio.contact.remove", companyId, { contact: id });
}

// ---------------------------------------------------------------------------
// Portal links
// ---------------------------------------------------------------------------

export interface PortalLinkRow {
  id: string;
  company_id: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function insertPortalLink(db: Db, companyId: string, tokenHash: string, days: number, by: string): Promise<PortalLinkRow> {
  const { rows } = await db.query<PortalLinkRow>(
    `insert into portal_links(company_id, token_hash, expires_at, created_by) values ($1,$2, now() + ($3 || ' days')::interval, $4)
     returning id, company_id, expires_at, created_by, created_at, revoked_at, last_used_at`,
    [companyId, tokenHash, String(days), by],
  );
  await audit(db, by, "portfolio.portal_link", companyId, { link: rows[0]!.id });
  return portal(rows[0]!);
}

const portal = (r: PortalLinkRow): PortalLinkRow => ({ ...r, expires_at: iso(r.expires_at)!, created_at: iso(r.created_at)!, revoked_at: iso(r.revoked_at), last_used_at: iso(r.last_used_at) });

export async function portalLinks(db: Db, companyId: string): Promise<PortalLinkRow[]> {
  const { rows } = await db.query<PortalLinkRow>(
    "select id, company_id, expires_at, created_by, created_at, revoked_at, last_used_at from portal_links where company_id = $1 order by created_at desc",
    [companyId],
  );
  return rows.map(portal);
}

export async function revokePortalLinks(db: Db, companyId: string, by: string): Promise<number> {
  const { rows } = await db.query("update portal_links set revoked_at = now() where company_id = $1 and revoked_at is null returning id", [companyId]);
  await audit(db, by, "portfolio.portal_link.revoke", companyId, { links: rows.length });
  return rows.length;
}

/** Start an accounting OAuth flow from a portal link; the state is single use (see ledger/platform.ts). */
export async function setPortalOAuth(db: Db, linkId: string, o: { state: string; provider: "quickbooks" | "xero"; verifier: string }): Promise<void> {
  await db.query(
    "update portal_links set oauth_state = $2, oauth_provider = $3, oauth_verifier = $4, oauth_expires_at = now() + interval '15 minutes' where id = $1",
    [linkId, o.state, o.provider, o.verifier],
  );
}

// ---------------------------------------------------------------------------
// KPI requests
// ---------------------------------------------------------------------------

export interface KpiRequestRow {
  id: string;
  company_id: string;
  company_name?: string;
  period: string;
  metrics: string[];
  due_on: string;
  recipients: string[];
  status: "open" | "received" | "cancelled";
  portal_link_id: string | null;
  outbox_id: string | null;
  evidence_id: string | null;
  created_by: string;
  created_at: string;
  received_at: string | null;
}

const request = (r: KpiRequestRow): KpiRequestRow => ({ ...r, due_on: day(r.due_on)!, created_at: iso(r.created_at)!, received_at: iso(r.received_at) });

export async function insertKpiRequest(
  db: Db,
  r: { companyId: string; period: string; metrics: string[]; dueOn: string; recipients: string[]; portalLinkId: string | null },
  by: string,
): Promise<KpiRequestRow> {
  const { rows } = await db.query<KpiRequestRow>(
    `insert into kpi_requests(company_id, period, metrics, due_on, recipients, portal_link_id, created_by) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (firm_id, company_id, period) do update set metrics = excluded.metrics, due_on = excluded.due_on, recipients = excluded.recipients,
       portal_link_id = excluded.portal_link_id, status = case when kpi_requests.status = 'cancelled' then 'open' else kpi_requests.status end
     returning *`,
    [r.companyId, r.period, r.metrics, r.dueOn, r.recipients, r.portalLinkId, by],
  );
  await audit(db, by, "portfolio.kpi_request", r.companyId, { period: r.period });
  return request(rows[0]!);
}

export async function kpiRequests(db: Db, opts: { companyId?: string; status?: KpiRequestRow["status"] } = {}): Promise<KpiRequestRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.companyId) { params.push(opts.companyId); where.push(`r.company_id = $${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`r.status = $${params.length}`); }
  const { rows } = await db.query<KpiRequestRow>(
    `select r.*, e.name as company_name from kpi_requests r join entities e on e.id = r.company_id
      ${where.length ? `where ${where.join(" and ")}` : ""} order by r.period desc, e.name`,
    params,
  );
  return rows.map(request);
}

export async function updateKpiRequest(db: Db, id: string, patch: { status?: KpiRequestRow["status"]; outboxId?: string; evidenceId?: string }, by: string): Promise<void> {
  const { rows } = await db.query(
    `update kpi_requests set status = coalesce($2, status), outbox_id = coalesce($3, outbox_id), evidence_id = coalesce($4, evidence_id),
            received_at = case when $2 = 'received' then now() else received_at end
      where id = $1 returning id, company_id`,
    [id, patch.status ?? null, patch.outboxId ?? null, patch.evidenceId ?? null],
  );
  if (!rows[0]) throw new Error("No such request.");
  await audit(db, by, `portfolio.kpi_request.${patch.status ?? "update"}`, id, {});
}

// ---------------------------------------------------------------------------
// Accounting links
// ---------------------------------------------------------------------------

export interface AccountingLinkRow {
  id: string;
  company_id: string;
  provider: "quickbooks" | "xero";
  external_id: string;
  external_name: string | null;
  status: "active" | "error" | "revoked";
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
}

const link = (r: AccountingLinkRow): AccountingLinkRow => ({ ...r, connected_at: iso(r.connected_at)!, last_sync_at: iso(r.last_sync_at) });

export async function upsertAccountingLink(
  db: Db,
  a: { companyId: string; provider: "quickbooks" | "xero"; externalId: string; externalName?: string | null; secret: string; portalLinkId?: string | null },
  by: string,
): Promise<void> {
  await db.query(
    `insert into accounting_links(company_id, provider, external_id, external_name, secret, portal_link_id) values ($1,$2,$3,$4,$5,$6)
     on conflict (firm_id, company_id, provider) do update set external_id = excluded.external_id, external_name = excluded.external_name,
       secret = excluded.secret, status = 'active', last_error = null, connected_at = now(), portal_link_id = excluded.portal_link_id`,
    [a.companyId, a.provider, a.externalId, a.externalName ?? null, a.secret, a.portalLinkId ?? null],
  );
  await audit(db, by, "portfolio.accounting_link", a.companyId, { provider: a.provider });
}

export async function accountingLinks(db: Db, companyId?: string): Promise<AccountingLinkRow[]> {
  const { rows } = await db.query<AccountingLinkRow>(
    `select id, company_id, provider, external_id, external_name, status, connected_at, last_sync_at, last_error from accounting_links
      ${companyId ? "where company_id = $1" : ""} order by connected_at`,
    companyId ? [companyId] : [],
  );
  return rows.map(link);
}

/** The encrypted refresh token, for the sync only. */
export async function accountingSecret(db: Db, id: string): Promise<{ secret: string; external_id: string; provider: "quickbooks" | "xero"; company_id: string } | null> {
  const { rows } = await db.query<{ secret: string; external_id: string; provider: "quickbooks" | "xero"; company_id: string }>(
    "select secret, external_id, provider, company_id from accounting_links where id = $1 and status <> 'revoked'",
    [id],
  );
  return rows[0] ?? null;
}

export async function updateAccountingLink(db: Db, id: string, patch: { secret?: string; synced?: boolean; error?: string | null; status?: AccountingLinkRow["status"] }): Promise<void> {
  await db.query(
    `update accounting_links set secret = coalesce($2, secret), last_sync_at = case when $3 then now() else last_sync_at end,
            last_error = $4, status = coalesce($5, status) where id = $1`,
    [id, patch.secret ?? null, Boolean(patch.synced), patch.error ?? null, patch.status ?? (patch.error ? "error" : patch.synced ? "active" : null)],
  );
}

// ---------------------------------------------------------------------------
// Valuation marks
// ---------------------------------------------------------------------------

export interface ValuationRow {
  id: string;
  company_id: string;
  company_name?: string;
  as_of: string;
  method: string;
  fair_value_usd: number;
  inputs: Record<string, unknown>;
  steps: string[];
  warnings: string[];
  rationale: string;
  status: "proposed" | "approved" | "rejected";
  prepared_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

const valuation = (r: ValuationRow): ValuationRow => ({
  ...r, as_of: day(r.as_of)!, fair_value_usd: Number(r.fair_value_usd), reviewed_at: iso(r.reviewed_at), created_at: iso(r.created_at)!,
});

export async function insertValuation(
  db: Db,
  v: { companyId: string; asOf: string; method: string; fairValueUsd: number; inputs: unknown; steps: string[]; warnings: string[]; rationale: string },
  by: string,
): Promise<ValuationRow> {
  const { rows } = await db.query<ValuationRow>(
    `insert into valuations(company_id, as_of, method, fair_value_usd, inputs, steps, warnings, rationale, prepared_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [v.companyId, v.asOf, v.method, v.fairValueUsd, JSON.stringify(v.inputs), JSON.stringify(v.steps), JSON.stringify(v.warnings), v.rationale, by],
  );
  await audit(db, by, "portfolio.mark.propose", v.companyId, { mark: rows[0]!.id, value: v.fairValueUsd, method: v.method });
  return valuation(rows[0]!);
}

export async function valuations(db: Db, opts: { companyId?: string; status?: ValuationRow["status"] } = {}): Promise<ValuationRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.companyId) { params.push(opts.companyId); where.push(`v.company_id = $${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`v.status = $${params.length}`); }
  const { rows } = await db.query<ValuationRow>(
    `select v.*, e.name as company_name from valuations v join entities e on e.id = v.company_id
      ${where.length ? `where ${where.join(" and ")}` : ""} order by v.as_of desc, v.created_at desc`,
    params,
  );
  return rows.map(valuation);
}

export async function getValuation(db: Db, id: string): Promise<ValuationRow | null> {
  const { rows } = await db.query<ValuationRow>("select * from valuations where id = $1", [id]);
  return rows[0] ? valuation(rows[0]) : null;
}

export async function reviewValuation(db: Db, id: string, approve: boolean, note: string | null, by: string): Promise<void> {
  await db.query(
    "update valuations set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1",
    [id, approve ? "approved" : "rejected", by, note],
  );
  await audit(db, by, `portfolio.mark.${approve ? "approve" : "reject"}`, id, {});
}

/** The latest approved mark for each company. */
export async function latestMarks(db: Db): Promise<Map<string, ValuationRow>> {
  const { rows } = await db.query<ValuationRow>(
    `select distinct on (company_id) * from valuations where status = 'approved' order by company_id, as_of desc, reviewed_at desc`,
  );
  return new Map(rows.map((r) => [r.company_id, valuation(r)]));
}

// ---------------------------------------------------------------------------
// Realizations
// ---------------------------------------------------------------------------

export type RealizationKind = "sale" | "partial_sale" | "distribution" | "dividend" | "write_off" | "escrow_release" | "earnout" | "secondary" | "tender" | "public_sale" | "in_kind";

export interface RealizationRow {
  id: string;
  company_id: string;
  occurred_on: string;
  amount_usd: number;
  kind: RealizationKind;
  note: string | null;
  exit_id: string | null;
  receivable_id: string | null;
  /** Shares sold or distributed, when it was shares. */
  shares: number | null;
  price_usd: number | null;
  lp_distribution_id: string | null;
  detail: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface NewRealization {
  companyId: string; occurredOn: string; amountUsd: number; kind: RealizationKind; note?: string | null;
  exitId?: string | null; receivableId?: string | null; shares?: number | null; priceUsd?: number | null; lpDistributionId?: string | null; detail?: Record<string, unknown>;
}

const realizationOut = (r: RealizationRow): RealizationRow => ({ ...r, occurred_on: day(r.occurred_on)!, amount_usd: Number(r.amount_usd), shares: num(r.shares), price_usd: num(r.price_usd), created_at: iso(r.created_at)! });

export async function insertRealization(db: Db, r: NewRealization, by: string): Promise<RealizationRow> {
  const { rows } = await db.query<RealizationRow>(
    `insert into realizations(company_id, occurred_on, amount_usd, kind, note, exit_id, receivable_id, shares, price_usd, lp_distribution_id, detail, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [r.companyId, r.occurredOn, r.amountUsd, r.kind, r.note ?? null, r.exitId ?? null, r.receivableId ?? null, r.shares ?? null, r.priceUsd ?? null, r.lpDistributionId ?? null, JSON.stringify(r.detail ?? {}), by],
  );
  await audit(db, by, "portfolio.realization", r.companyId, { amount: r.amountUsd, kind: r.kind });
  return realizationOut(rows[0]!);
}

export async function realizations(db: Db, companyId?: string): Promise<RealizationRow[]> {
  const { rows } = await db.query<RealizationRow>(
    `select * from realizations ${companyId ? "where company_id = $1" : ""} order by occurred_on, created_at`,
    companyId ? [companyId] : [],
  );
  return rows.map(realizationOut);
}

// ---------------------------------------------------------------------------
// Board meetings
// ---------------------------------------------------------------------------

export interface BoardMeetingRow {
  id: string;
  company_id: string;
  held_on: string;
  kind: "regular" | "special" | "annual" | "written_consent";
  our_role: "director" | "observer" | "none";
  attendees: string[];
  agenda: string | null;
  notes: string | null;
  resolutions: { title: string; kind: string; outcome: string }[];
  conflict_review: string | null;
  materials_evidence_id: string | null;
  created_by: string;
  created_at: string;
}

export async function insertBoardMeeting(
  db: Db,
  m: { companyId: string; heldOn: string; kind: BoardMeetingRow["kind"]; ourRole: BoardMeetingRow["our_role"]; attendees: string[]; agenda?: string | null; notes?: string | null; resolutions: BoardMeetingRow["resolutions"]; conflictReview?: string | null; materialsEvidenceId?: string | null },
  by: string,
): Promise<BoardMeetingRow> {
  const { rows } = await db.query<BoardMeetingRow>(
    `insert into board_meetings(company_id, held_on, kind, our_role, attendees, agenda, notes, resolutions, conflict_review, materials_evidence_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [m.companyId, m.heldOn, m.kind, m.ourRole, m.attendees, m.agenda ?? null, m.notes ?? null, JSON.stringify(m.resolutions), m.conflictReview ?? null, m.materialsEvidenceId ?? null, by],
  );
  await audit(db, by, "portfolio.board_meeting", m.companyId, { meeting: rows[0]!.id });
  return { ...rows[0]!, held_on: day(rows[0]!.held_on)!, created_at: iso(rows[0]!.created_at)! };
}

export async function boardMeetings(db: Db, companyId?: string): Promise<(BoardMeetingRow & { company_name: string })[]> {
  const { rows } = await db.query<BoardMeetingRow & { company_name: string }>(
    `select b.*, e.name as company_name from board_meetings b join entities e on e.id = b.company_id
      ${companyId ? "where b.company_id = $1" : ""} order by b.held_on desc`,
    companyId ? [companyId] : [],
  );
  return rows.map((r) => ({ ...r, held_on: day(r.held_on)!, created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Value-creation initiatives
// ---------------------------------------------------------------------------

export interface InitiativeRow {
  id: string;
  company_id: string;
  company_name?: string;
  kind: string;
  title: string;
  detail: string | null;
  owner: string | null;
  status: "proposed" | "in_progress" | "done" | "dropped";
  due_on: string | null;
  outcome: string | null;
  value_usd: number | null;
  outbox_id: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

const initiative = (r: InitiativeRow): InitiativeRow => ({ ...r, due_on: day(r.due_on), value_usd: num(r.value_usd), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! });

export async function insertInitiative(
  db: Db,
  i: { companyId: string; kind: string; title: string; detail?: string | null; owner?: string | null; dueOn?: string | null },
  by: string,
): Promise<InitiativeRow> {
  const { rows } = await db.query<InitiativeRow>(
    "insert into initiatives(company_id, kind, title, detail, owner, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *",
    [i.companyId, i.kind, i.title, i.detail ?? null, i.owner ?? null, i.dueOn ?? null, by],
  );
  await audit(db, by, "portfolio.initiative", i.companyId, { initiative: rows[0]!.id, kind: i.kind });
  return initiative(rows[0]!);
}

export async function getInitiative(db: Db, id: string): Promise<InitiativeRow | null> {
  const { rows } = await db.query<InitiativeRow>("select * from initiatives where id = $1", [id]);
  return rows[0] ? initiative(rows[0]) : null;
}

export async function updateInitiative(
  db: Db,
  id: string,
  p: { status?: InitiativeRow["status"]; outcome?: string | null; valueUsd?: number | null; owner?: string | null; dueOn?: string | null; outboxId?: string },
  by: string,
): Promise<void> {
  const sets: string[] = ["updated_by = $2", "updated_at = now()"];
  const params: unknown[] = [id, by];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (p.status !== undefined) set("status", p.status);
  if (p.outcome !== undefined) set("outcome", p.outcome);
  if (p.valueUsd !== undefined) set("value_usd", p.valueUsd);
  if (p.owner !== undefined) set("owner", p.owner);
  if (p.dueOn !== undefined) set("due_on", p.dueOn);
  if (p.outboxId !== undefined) set("outbox_id", p.outboxId);
  const { rows } = await db.query(`update initiatives set ${sets.join(", ")} where id = $1 returning id`, params);
  if (!rows[0]) throw new Error("No such initiative.");
  await audit(db, by, `portfolio.initiative.${p.status ?? "update"}`, id, {});
}

export async function initiatives(db: Db, companyId?: string): Promise<InitiativeRow[]> {
  const { rows } = await db.query<InitiativeRow>(
    `select i.*, e.name as company_name from initiatives i join entities e on e.id = i.company_id
      ${companyId ? "where i.company_id = $1" : ""} order by case i.status when 'in_progress' then 0 when 'proposed' then 1 when 'done' then 2 else 3 end, i.updated_at desc`,
    companyId ? [companyId] : [],
  );
  return rows.map(initiative);
}

// ---------------------------------------------------------------------------
// Decisions for the portfolio: health ratings, reserve plans, follow-ons
// ---------------------------------------------------------------------------

export interface DecisionRow {
  id: string;
  entity_id: string;
  kind: string;
  actor: string;
  value: Record<string, unknown>;
  rationale: string | null;
  created_at: string;
}

/** Decisions of some kinds, newest first, optionally for one company. */
export async function decisionsOf(db: Db, kinds: string[], companyId?: string): Promise<DecisionRow[]> {
  const { rows } = await db.query<DecisionRow>(
    `select id, entity_id, kind, actor, value, rationale, created_at from decisions
      where kind = any($1::text[]) ${companyId ? "and entity_id = $2" : ""} order by created_at desc`,
    companyId ? [kinds, companyId] : [kinds],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}
