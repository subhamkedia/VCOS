import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * LP Reporting's tables: funds, partners, capital calls and distributions
 * with their per-partner lines, fund expenses, bank transactions, tax
 * documents, quarterly reports and LP portal links. Firm-scoped Db only.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

export interface FundRow {
  id: string;
  name: string;
  vintage: number | null;
  currency: string;
  inception: string;
  terms: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const fund = (r: FundRow): FundRow => ({ ...r, inception: day(r.inception)!, created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! });

export async function insertFund(db: Db, f: { name: string; vintage?: number | null; currency: string; inception: string; terms: unknown }, by: string): Promise<FundRow> {
  const { rows } = await db.query<FundRow>(
    "insert into funds(name, vintage, currency, inception, terms, created_by) values ($1,$2,$3,$4,$5,$6) returning *",
    [f.name, f.vintage ?? null, f.currency, f.inception, JSON.stringify(f.terms), by],
  );
  await audit(db, by, "lp.fund.create", rows[0]!.id, { name: f.name });
  return fund(rows[0]!);
}

export async function updateFund(db: Db, id: string, p: { terms?: unknown; name?: string; vintage?: number | null; inception?: string }, by: string): Promise<void> {
  const { rows } = await db.query(
    `update funds set terms = coalesce($2, terms), name = coalesce($3, name), vintage = coalesce($4, vintage), inception = coalesce($5, inception),
            updated_by = $6, updated_at = now() where id = $1 returning id`,
    [id, p.terms === undefined ? null : JSON.stringify(p.terms), p.name ?? null, p.vintage ?? null, p.inception ?? null, by],
  );
  if (!rows[0]) throw new Error("No such fund.");
  await audit(db, by, "lp.fund.update", id, {});
}

export async function funds(db: Db): Promise<FundRow[]> {
  return (await db.query<FundRow>("select * from funds order by inception desc, name")).rows.map(fund);
}

export async function getFund(db: Db, id: string): Promise<FundRow | null> {
  const r = (await db.query<FundRow>("select * from funds where id = $1", [id])).rows[0];
  return r ? fund(r) : null;
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

export interface PartnerRow {
  id: string;
  fund_id: string;
  name: string;
  kind: string;
  commitment_usd: number;
  fee_paying: boolean;
  closing: number;
  admitted_on: string;
  emails: string[];
  tax_status: string | null;
  erisa: boolean;
  investor_status: string | null;
  kyc_verified_on: string | null;
  side_letter: string | null;
  created_by: string;
  created_at: string;
}

const partner = (r: PartnerRow): PartnerRow => ({ ...r, commitment_usd: num(r.commitment_usd), admitted_on: day(r.admitted_on)!, kyc_verified_on: day(r.kyc_verified_on), created_at: iso(r.created_at)! });

export async function insertPartner(
  db: Db,
  p: { fundId: string; name: string; kind: string; commitmentUsd: number; feePaying: boolean; closing: number; admittedOn: string; emails: string[]; taxStatus?: string | null; erisa?: boolean; investorStatus?: string | null; kycVerifiedOn?: string | null; sideLetter?: string | null },
  by: string,
): Promise<PartnerRow> {
  const { rows } = await db.query<PartnerRow>(
    `insert into fund_partners(fund_id, name, kind, commitment_usd, fee_paying, closing, admitted_on, emails, tax_status, erisa, investor_status, kyc_verified_on, side_letter, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [p.fundId, p.name, p.kind, p.commitmentUsd, p.feePaying, p.closing, p.admittedOn, p.emails, p.taxStatus ?? null, p.erisa ?? false, p.investorStatus ?? null, p.kycVerifiedOn ?? null, p.sideLetter ?? null, by],
  );
  await audit(db, by, "lp.partner.admit", p.fundId, { partner: rows[0]!.id, commitment: p.commitmentUsd });
  return partner(rows[0]!);
}

export async function updatePartner(db: Db, id: string, p: { emails?: string[]; taxStatus?: string | null; erisa?: boolean; investorStatus?: string | null; kycVerifiedOn?: string | null; sideLetter?: string | null }, by: string): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (p.emails !== undefined) set("emails", p.emails);
  if (p.taxStatus !== undefined) set("tax_status", p.taxStatus);
  if (p.erisa !== undefined) set("erisa", p.erisa);
  if (p.investorStatus !== undefined) set("investor_status", p.investorStatus);
  if (p.kycVerifiedOn !== undefined) set("kyc_verified_on", p.kycVerifiedOn);
  if (p.sideLetter !== undefined) set("side_letter", p.sideLetter);
  if (!sets.length) return;
  const { rows } = await db.query(`update fund_partners set ${sets.join(", ")} where id = $1 returning fund_id`, params);
  if (!rows[0]) throw new Error("No such partner.");
  await audit(db, by, "lp.partner.update", id, {});
}

export async function partners(db: Db, fundId: string): Promise<PartnerRow[]> {
  return (await db.query<PartnerRow>("select * from fund_partners where fund_id = $1 order by fee_paying desc, commitment_usd desc, name", [fundId])).rows.map(partner);
}

export async function getPartner(db: Db, id: string): Promise<PartnerRow | null> {
  const r = (await db.query<PartnerRow>("select * from fund_partners where id = $1", [id])).rows[0];
  return r ? partner(r) : null;
}

// ---------------------------------------------------------------------------
// Capital calls
// ---------------------------------------------------------------------------

export interface CallRow {
  id: string;
  fund_id: string;
  number: number;
  notice_date: string;
  due_date: string;
  investments_usd: number;
  fees_usd: number;
  expenses_usd: number;
  fee_detail: { from?: string; to?: string; lines?: string[]; offsets?: number };
  purpose: string | null;
  status: "draft" | "approved" | "cancelled";
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

export interface CallItemRow {
  id: string;
  call_id: string;
  partner_id: string;
  partner_name?: string;
  investment_usd: number;
  fee_usd: number;
  expense_usd: number;
  amount_usd: number;
  received_usd: number;
  received_on: string | null;
  bank_txn_id: string | null;
}

const call = (r: CallRow): CallRow => ({
  ...r, notice_date: day(r.notice_date)!, due_date: day(r.due_date)!, investments_usd: num(r.investments_usd), fees_usd: num(r.fees_usd), expenses_usd: num(r.expenses_usd),
  created_at: iso(r.created_at)!, approved_at: iso(r.approved_at),
});
const item = (r: CallItemRow): CallItemRow => ({
  ...r, investment_usd: num(r.investment_usd), fee_usd: num(r.fee_usd), expense_usd: num(r.expense_usd), amount_usd: num(r.amount_usd), received_usd: num(r.received_usd), received_on: day(r.received_on),
});

export async function insertCall(
  db: Db,
  c: { fundId: string; noticeDate: string; dueDate: string; investmentsUsd: number; feesUsd: number; expensesUsd: number; feeDetail: unknown; purpose: string | null },
  items: { partnerId: string; investmentUsd: number; feeUsd: number; expenseUsd: number }[],
  by: string,
): Promise<CallRow> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<CallRow>(
      `insert into capital_calls(fund_id, number, notice_date, due_date, investments_usd, fees_usd, expenses_usd, fee_detail, purpose, created_by)
       values ($1, (select coalesce(max(number), 0) + 1 from capital_calls where fund_id = $1), $2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [c.fundId, c.noticeDate, c.dueDate, c.investmentsUsd, c.feesUsd, c.expensesUsd, JSON.stringify(c.feeDetail), c.purpose, by],
    );
    for (const i of items) {
      await tx.query(
        "insert into call_items(call_id, partner_id, investment_usd, fee_usd, expense_usd, amount_usd) values ($1,$2,$3,$4,$5,$6)",
        [rows[0]!.id, i.partnerId, i.investmentUsd, i.feeUsd, i.expenseUsd, Math.round((i.investmentUsd + i.feeUsd + i.expenseUsd) * 100) / 100],
      );
    }
    await audit(tx, by, "lp.call.draft", rows[0]!.id, { number: rows[0]!.number });
    return call(rows[0]!);
  });
}

export async function calls(db: Db, fundId: string): Promise<CallRow[]> {
  return (await db.query<CallRow>("select * from capital_calls where fund_id = $1 order by number desc", [fundId])).rows.map(call);
}

export async function getCall(db: Db, id: string): Promise<CallRow | null> {
  const r = (await db.query<CallRow>("select * from capital_calls where id = $1", [id])).rows[0];
  return r ? call(r) : null;
}

export async function callItems(db: Db, opts: { callId?: string; fundId?: string }): Promise<CallItemRow[]> {
  const { rows } = await db.query<CallItemRow>(
    `select i.*, p.name as partner_name from call_items i join fund_partners p on p.id = i.partner_id join capital_calls c on c.id = i.call_id
      where ${opts.callId ? "i.call_id = $1" : "c.fund_id = $1"} order by c.number, p.name`,
    [opts.callId ?? opts.fundId],
  );
  return rows.map(item);
}

/** One call line with its call's fund and status. */
export async function getCallItem(db: Db, itemId: string): Promise<(CallItemRow & { fund_id: string; status: CallRow["status"] }) | null> {
  const r = (await db.query<CallItemRow & { fund_id: string; status: CallRow["status"] }>(
    "select i.*, c.fund_id, c.status from call_items i join capital_calls c on c.id = i.call_id where i.id = $1", [itemId],
  )).rows[0];
  return r ? { ...item(r), fund_id: r.fund_id, status: r.status } : null;
}

export async function setCallStatus(db: Db, id: string, status: "approved" | "cancelled", by: string): Promise<void> {
  const { rows } = await db.query(
    `update capital_calls set status = $2, approved_by = case when $2 = 'approved' then $3 else approved_by end,
            approved_at = case when $2 = 'approved' then now() else approved_at end where id = $1 and status = 'draft' returning id`,
    [id, status, by],
  );
  if (!rows[0]) throw new Error("This call isn't a draft any more.");
  await audit(db, by, `lp.call.${status}`, id, {});
}

export async function recordReceipt(db: Db, itemId: string, r: { amountUsd: number; receivedOn: string; bankTxnId?: string | null }, by: string): Promise<void> {
  const { rows } = await db.query(
    "update call_items set received_usd = $2, received_on = $3, bank_txn_id = coalesce($4, bank_txn_id) where id = $1 returning call_id",
    [itemId, r.amountUsd, r.receivedOn, r.bankTxnId ?? null],
  );
  if (!rows[0]) throw new Error("No such call line.");
  await audit(db, by, "lp.call.receipt", itemId, { amount: r.amountUsd });
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export interface DistributionRow {
  id: string;
  fund_id: string;
  number: number;
  paid_on: string;
  gross_usd: number;
  kind: "cash" | "in_kind";
  company_id: string | null;
  company_name?: string | null;
  purpose: string | null;
  carry_usd: number;
  escrow_usd: number;
  waterfall: string[];
  status: "draft" | "approved" | "paid" | "cancelled";
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_by: string | null;
}

export interface DistributionItemRow {
  id: string;
  distribution_id: string;
  partner_id: string;
  partner_name?: string;
  gross_usd: number;
  carry_usd: number;
  net_usd: number;
}

const dist = (r: DistributionRow): DistributionRow => ({
  ...r, paid_on: day(r.paid_on)!, gross_usd: num(r.gross_usd), carry_usd: num(r.carry_usd), escrow_usd: num(r.escrow_usd), created_at: iso(r.created_at)!, approved_at: iso(r.approved_at),
});
const ditem = (r: DistributionItemRow): DistributionItemRow => ({ ...r, gross_usd: num(r.gross_usd), carry_usd: num(r.carry_usd), net_usd: num(r.net_usd) });

export async function insertDistribution(
  db: Db,
  d: { fundId: string; paidOn: string; grossUsd: number; kind: "cash" | "in_kind"; companyId: string | null; purpose: string | null; carryUsd: number; escrowUsd: number; waterfall: string[] },
  items: { partnerId: string; grossUsd: number; carryUsd: number; netUsd: number }[],
  by: string,
): Promise<DistributionRow> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<DistributionRow>(
      `insert into distributions(fund_id, number, paid_on, gross_usd, kind, company_id, purpose, carry_usd, escrow_usd, waterfall, created_by)
       values ($1, (select coalesce(max(number), 0) + 1 from distributions where fund_id = $1), $2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [d.fundId, d.paidOn, d.grossUsd, d.kind, d.companyId, d.purpose, d.carryUsd, d.escrowUsd, JSON.stringify(d.waterfall), by],
    );
    for (const i of items) {
      await tx.query("insert into distribution_items(distribution_id, partner_id, gross_usd, carry_usd, net_usd) values ($1,$2,$3,$4,$5)", [rows[0]!.id, i.partnerId, i.grossUsd, i.carryUsd, i.netUsd]);
    }
    await audit(tx, by, "lp.distribution.draft", rows[0]!.id, { number: rows[0]!.number, gross: d.grossUsd });
    return dist(rows[0]!);
  });
}

export async function distributions(db: Db, fundId: string): Promise<DistributionRow[]> {
  const { rows } = await db.query<DistributionRow>(
    "select d.*, e.name as company_name from distributions d left join entities e on e.id = d.company_id where d.fund_id = $1 order by d.number desc",
    [fundId],
  );
  return rows.map(dist);
}

export async function getDistribution(db: Db, id: string): Promise<DistributionRow | null> {
  const r = (await db.query<DistributionRow>("select * from distributions where id = $1", [id])).rows[0];
  return r ? dist(r) : null;
}

export async function distributionItems(db: Db, opts: { distributionId?: string; fundId?: string }): Promise<DistributionItemRow[]> {
  const { rows } = await db.query<DistributionItemRow>(
    `select i.*, p.name as partner_name from distribution_items i join fund_partners p on p.id = i.partner_id join distributions d on d.id = i.distribution_id
      where ${opts.distributionId ? "i.distribution_id = $1" : "d.fund_id = $1"} order by d.number, p.name`,
    [opts.distributionId ?? opts.fundId],
  );
  return rows.map(ditem);
}

export async function setDistributionStatus(db: Db, id: string, status: "approved" | "paid" | "cancelled", by: string): Promise<void> {
  const from = status === "paid" ? "approved" : "draft";
  const { rows } = await db.query(
    `update distributions set status = $2,
            approved_by = case when $2 = 'approved' then $3 else approved_by end, approved_at = case when $2 = 'approved' then now() else approved_at end,
            paid_by = case when $2 = 'paid' then $3 else paid_by end
      where id = $1 and status = $4 returning id`,
    [id, status, by, from],
  );
  if (!rows[0]) throw new Error(status === "paid" ? "Approve the distribution before marking it paid." : "This distribution isn't a draft any more.");
  await audit(db, by, `lp.distribution.${status}`, id, {});
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export interface ExpenseRow {
  id: string;
  fund_id: string;
  incurred_on: string;
  amount_usd: number;
  category: string;
  description: string;
  related_party: boolean;
  fee_offset: boolean;
  created_by: string;
  created_at: string;
}

export async function insertExpense(db: Db, e: { fundId: string; incurredOn: string; amountUsd: number; category: string; description: string; relatedParty: boolean; feeOffset: boolean }, by: string): Promise<ExpenseRow> {
  const { rows } = await db.query<ExpenseRow>(
    "insert into fund_expenses(fund_id, incurred_on, amount_usd, category, description, related_party, fee_offset, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
    [e.fundId, e.incurredOn, e.amountUsd, e.category, e.description, e.relatedParty, e.feeOffset, by],
  );
  await audit(db, by, "lp.expense", e.fundId, { amount: e.amountUsd, category: e.category });
  return { ...rows[0]!, incurred_on: day(rows[0]!.incurred_on)!, amount_usd: num(rows[0]!.amount_usd), created_at: iso(rows[0]!.created_at)! };
}

export async function expenses(db: Db, fundId: string): Promise<ExpenseRow[]> {
  const { rows } = await db.query<ExpenseRow>("select * from fund_expenses where fund_id = $1 order by incurred_on, created_at", [fundId]);
  return rows.map((r) => ({ ...r, incurred_on: day(r.incurred_on)!, amount_usd: num(r.amount_usd), created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Bank transactions
// ---------------------------------------------------------------------------

export interface BankTxnRow {
  id: string;
  fund_id: string;
  provider: string;
  external_id: string;
  posted_on: string;
  amount_usd: number;
  counterparty: string | null;
  memo: string | null;
  matched_item_id: string | null;
}

export async function insertBankTxn(db: Db, t: { fundId: string; provider: string; externalId: string; postedOn: string; amountUsd: number; counterparty?: string | null; memo?: string | null }): Promise<boolean> {
  const { rows } = await db.query(
    `insert into bank_transactions(fund_id, provider, external_id, posted_on, amount_usd, counterparty, memo) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (firm_id, provider, external_id) do nothing returning id`,
    [t.fundId, t.provider, t.externalId, t.postedOn, t.amountUsd, t.counterparty ?? null, t.memo ?? null],
  );
  return rows.length > 0;
}

export async function bankTxns(db: Db, fundId: string): Promise<BankTxnRow[]> {
  const { rows } = await db.query<BankTxnRow>("select id, fund_id, provider, external_id, posted_on, amount_usd, counterparty, memo, matched_item_id from bank_transactions where fund_id = $1 order by posted_on desc", [fundId]);
  return rows.map((r) => ({ ...r, posted_on: day(r.posted_on)!, amount_usd: num(r.amount_usd) }));
}

export async function matchBankTxn(db: Db, txnId: string, itemId: string, by: string): Promise<void> {
  await db.query("update bank_transactions set matched_item_id = $2 where id = $1", [txnId, itemId]);
  await audit(db, by, "lp.bank.match", txnId, { item: itemId });
}

// ---------------------------------------------------------------------------
// Tax documents
// ---------------------------------------------------------------------------

export interface TaxDocRow {
  id: string;
  fund_id: string;
  partner_id: string;
  tax_year: number;
  kind: "k1" | "k3" | "estimate";
  status: "pending" | "delivered";
  delivered_on: string | null;
  note: string | null;
}

export async function upsertTaxDoc(db: Db, t: { fundId: string; partnerId: string; taxYear: number; kind: TaxDocRow["kind"]; status: TaxDocRow["status"]; deliveredOn?: string | null; note?: string | null }, by: string): Promise<void> {
  await db.query(
    `insert into tax_documents(fund_id, partner_id, tax_year, kind, status, delivered_on, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (partner_id, tax_year, kind) do update set status = excluded.status, delivered_on = excluded.delivered_on, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
    [t.fundId, t.partnerId, t.taxYear, t.kind, t.status, t.deliveredOn ?? null, t.note ?? null, by],
  );
  await audit(db, by, "lp.tax_document", t.partnerId, { year: t.taxYear, kind: t.kind, status: t.status });
}

export async function taxDocs(db: Db, fundId: string, year?: number): Promise<TaxDocRow[]> {
  const { rows } = await db.query<TaxDocRow>(
    `select id, fund_id, partner_id, tax_year, kind, status, delivered_on, note from tax_documents where fund_id = $1 ${year ? "and tax_year = $2" : ""} order by tax_year desc`,
    year ? [fundId, year] : [fundId],
  );
  return rows.map((r) => ({ ...r, delivered_on: day(r.delivered_on) }));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportRow {
  id: string;
  fund_id: string;
  period: string;
  version: number;
  as_of: string;
  snapshot: Record<string, unknown>;
  letter: { blocks: unknown[] };
  commentary: string | null;
  status: "draft" | "approved" | "withdrawn";
  prepared_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

const report = (r: ReportRow): ReportRow => ({ ...r, as_of: day(r.as_of)!, created_at: iso(r.created_at)!, approved_at: iso(r.approved_at) });

export async function insertReport(db: Db, r: { fundId: string; period: string; asOf: string; snapshot: unknown; letter: unknown; commentary: string | null }, by: string): Promise<ReportRow> {
  const { rows } = await db.query<ReportRow>(
    `insert into lp_reports(fund_id, period, version, as_of, snapshot, letter, commentary, prepared_by)
     values ($1,$2,(select coalesce(max(version), 0) + 1 from lp_reports where fund_id = $1 and period = $2),$3,$4,$5,$6,$7) returning *`,
    [r.fundId, r.period, r.asOf, JSON.stringify(r.snapshot), JSON.stringify(r.letter), r.commentary, by],
  );
  await audit(db, by, "lp.report.draft", rows[0]!.id, { period: r.period, version: rows[0]!.version });
  return report(rows[0]!);
}

export async function reports(db: Db, fundId: string, opts: { status?: ReportRow["status"] } = {}): Promise<ReportRow[]> {
  const { rows } = await db.query<ReportRow>(
    `select * from lp_reports where fund_id = $1 ${opts.status ? "and status = $2" : ""} order by period desc, version desc`,
    opts.status ? [fundId, opts.status] : [fundId],
  );
  return rows.map(report);
}

export async function getReport(db: Db, id: string): Promise<ReportRow | null> {
  const r = (await db.query<ReportRow>("select * from lp_reports where id = $1", [id])).rows[0];
  return r ? report(r) : null;
}

export async function setReportStatus(db: Db, id: string, status: "approved" | "withdrawn", by: string): Promise<void> {
  const { rows } = await db.query(
    `update lp_reports set status = $2, approved_by = case when $2 = 'approved' then $3 else approved_by end,
            approved_at = case when $2 = 'approved' then now() else approved_at end where id = $1 returning id`,
    [id, status, by],
  );
  if (!rows[0]) throw new Error("No such report.");
  await audit(db, by, `lp.report.${status}`, id, {});
}

// ---------------------------------------------------------------------------
// LP portal links
// ---------------------------------------------------------------------------

export async function insertLpPortalLink(db: Db, partnerId: string, tokenHash: string, days: number, by: string): Promise<{ id: string; expires_at: string }> {
  const { rows } = await db.query<{ id: string; expires_at: string }>(
    "insert into lp_portal_links(partner_id, token_hash, expires_at, created_by) values ($1,$2, now() + ($3 || ' days')::interval, $4) returning id, expires_at",
    [partnerId, tokenHash, String(days), by],
  );
  await audit(db, by, "lp.portal_link", partnerId, { link: rows[0]!.id });
  return { id: rows[0]!.id, expires_at: iso(rows[0]!.expires_at)! };
}

export async function lpPortalLinks(db: Db, fundId: string): Promise<{ id: string; partner_id: string; expires_at: string; revoked_at: string | null; last_used_at: string | null; created_at: string }[]> {
  const { rows } = await db.query<{ id: string; partner_id: string; expires_at: string; revoked_at: string | null; last_used_at: string | null; created_at: string }>(
    `select l.id, l.partner_id, l.expires_at, l.revoked_at, l.last_used_at, l.created_at from lp_portal_links l join fund_partners p on p.id = l.partner_id
      where p.fund_id = $1 order by l.created_at desc`,
    [fundId],
  );
  return rows.map((r) => ({ ...r, expires_at: iso(r.expires_at)!, revoked_at: iso(r.revoked_at), last_used_at: iso(r.last_used_at), created_at: iso(r.created_at)! }));
}

export async function revokeLpPortalLinks(db: Db, partnerId: string, by: string): Promise<number> {
  const { rows } = await db.query("update lp_portal_links set revoked_at = now() where partner_id = $1 and revoked_at is null returning id", [partnerId]);
  await audit(db, by, "lp.portal_link.revoke", partnerId, { links: rows.length });
  return rows.length;
}
