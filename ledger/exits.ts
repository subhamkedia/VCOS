import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Exits and liquidity: exit plans, exit processes and bids, receivables
 * (escrows, holdbacks, earnouts), listed shares and their prices, QSBS
 * reviews, each fund's life, extensions and wind-down, and continuation
 * vehicle elections. Firm-scoped Db only. Money back is in `realizations`
 * (ledger/portfolio.ts); the fund's consent to an exit is a decision.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Exit plans
// ---------------------------------------------------------------------------

export interface ExitPlanRow {
  id: string; company_id: string; company_name?: string; path: "acquisition" | "ipo" | "secondary" | "hold" | "wind_down"; target_year: number | null;
  low_usd: number | null; base_usd: number | null; high_usd: number | null; probability_pct: number | null; buyers: string[];
  readiness: Record<string, boolean>; note: string | null; updated_by: string; updated_at: string;
}

const planOut = (r: ExitPlanRow): ExitPlanRow => ({ ...r, low_usd: num(r.low_usd), base_usd: num(r.base_usd), high_usd: num(r.high_usd), probability_pct: num(r.probability_pct), updated_at: iso(r.updated_at)! });

export async function saveExitPlan(db: Db, p: Omit<ExitPlanRow, "id" | "updated_by" | "updated_at" | "company_name">, by: string): Promise<void> {
  await db.query(
    `insert into exit_plans(company_id, path, target_year, low_usd, base_usd, high_usd, probability_pct, buyers, readiness, note, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (firm_id, company_id) do update set path = excluded.path, target_year = excluded.target_year, low_usd = excluded.low_usd, base_usd = excluded.base_usd,
       high_usd = excluded.high_usd, probability_pct = excluded.probability_pct, buyers = excluded.buyers, readiness = excluded.readiness, note = excluded.note,
       updated_by = excluded.updated_by, updated_at = now()`,
    [p.company_id, p.path, p.target_year, p.low_usd, p.base_usd, p.high_usd, p.probability_pct, p.buyers, JSON.stringify(p.readiness), p.note, by],
  );
  await audit(db, by, "exit.plan", p.company_id, { path: p.path, year: p.target_year });
}

export async function exitPlans(db: Db, companyId?: string): Promise<ExitPlanRow[]> {
  const { rows } = await db.query<ExitPlanRow>(
    `select p.*, e.name as company_name from exit_plans p join entities e on e.id = p.company_id ${companyId ? "where p.company_id = $1" : ""} order by e.name`,
    companyId ? [companyId] : [],
  );
  return rows.map(planOut);
}

// ---------------------------------------------------------------------------
// Exit processes and bids
// ---------------------------------------------------------------------------

export type ExitKind = "acquisition" | "ipo" | "secondary" | "tender" | "buyback" | "wind_down";
export type ExitStage = "exploring" | "preparing" | "marketing" | "offers" | "signed" | "closed" | "abandoned";

export interface ExitRow {
  id: string; company_id: string; company_name?: string; kind: ExitKind; stage: ExitStage; counterparty: string | null; expected_close: string | null;
  equity_value_usd: number | null; our_expected_usd: number | null; shares: number | null; price_per_share: number | null; terms: Record<string, unknown>;
  note: string | null; consent_decision_id: string | null; closed_on: string | null; closing: Record<string, unknown> | null; abandoned_reason: string | null;
  created_by: string; created_at: string; updated_by: string | null; updated_at: string;
}

const exitOut = (r: ExitRow): ExitRow => ({
  ...r, expected_close: day(r.expected_close), equity_value_usd: num(r.equity_value_usd), our_expected_usd: num(r.our_expected_usd), shares: num(r.shares),
  price_per_share: num(r.price_per_share), closed_on: day(r.closed_on), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
});

export async function insertExit(db: Db, x: { companyId: string; kind: ExitKind; counterparty: string | null; expectedClose: string | null; equityValueUsd: number | null; ourExpectedUsd: number | null; shares: number | null; pricePerShare: number | null; terms: Record<string, unknown>; note: string | null }, by: string): Promise<ExitRow> {
  const { rows } = await db.query<ExitRow>(
    `insert into exits(company_id, kind, counterparty, expected_close, equity_value_usd, our_expected_usd, shares, price_per_share, terms, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [x.companyId, x.kind, x.counterparty, x.expectedClose, x.equityValueUsd, x.ourExpectedUsd, x.shares, x.pricePerShare, JSON.stringify(x.terms), x.note, by],
  );
  await audit(db, by, "exit.start", rows[0]!.id, { company: x.companyId, kind: x.kind });
  return exitOut(rows[0]!);
}

const EXIT_FIELDS = ["stage", "counterparty", "expected_close", "equity_value_usd", "our_expected_usd", "shares", "price_per_share", "terms", "note", "consent_decision_id", "closed_on", "closing", "abandoned_reason"] as const;
export type ExitPatch = Partial<Pick<ExitRow, (typeof EXIT_FIELDS)[number]>>;

export async function updateExit(db: Db, id: string, p: ExitPatch, by: string): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const k of EXIT_FIELDS) {
    if (p[k] === undefined) continue;
    vals.push(k === "terms" || k === "closing" ? JSON.stringify(p[k]) : p[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(by);
  const { rows } = await db.query(`update exits set ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() where id = $1 returning id`, vals);
  if (!rows[0]) throw new Error("No such exit.");
  await audit(db, by, "exit.update", id, { fields: Object.keys(p) });
}

export async function getExit(db: Db, id: string): Promise<ExitRow | null> {
  const { rows } = await db.query<ExitRow>("select x.*, e.name as company_name from exits x join entities e on e.id = x.company_id where x.id = $1", [id]);
  return rows[0] ? exitOut(rows[0]) : null;
}

export async function exits(db: Db, opts: { companyId?: string } = {}): Promise<ExitRow[]> {
  const { rows } = await db.query<ExitRow>(
    `select x.*, e.name as company_name from exits x join entities e on e.id = x.company_id ${opts.companyId ? "where x.company_id = $1" : ""}
     order by (x.stage in ('closed', 'abandoned')), x.expected_close nulls last, x.created_at desc`,
    opts.companyId ? [opts.companyId] : [],
  );
  return rows.map(exitOut);
}

export interface BidRow { id: string; exit_id: string; bidder: string; kind: "ioi" | "loi" | "final"; value_usd: number; consideration: string | null; received_on: string; note: string | null; created_by: string; created_at: string }

export async function insertBid(db: Db, b: { exitId: string; bidder: string; kind: BidRow["kind"]; valueUsd: number; consideration: string | null; receivedOn: string; note: string | null }, by: string): Promise<void> {
  await db.query("insert into exit_bids(exit_id, bidder, kind, value_usd, consideration, received_on, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [b.exitId, b.bidder, b.kind, b.valueUsd, b.consideration, b.receivedOn, b.note, by]);
  await audit(db, by, "exit.bid", b.exitId, { bidder: b.bidder, kind: b.kind });
}

export async function bids(db: Db, exitId: string): Promise<BidRow[]> {
  const { rows } = await db.query<BidRow>("select * from exit_bids where exit_id = $1 order by received_on desc, created_at desc", [exitId]);
  return rows.map((r) => ({ ...r, value_usd: Number(r.value_usd), received_on: day(r.received_on)!, created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

export type ReceivableStatus = "pending" | "partial" | "released" | "earned" | "claimed" | "forfeited";

export interface ReceivableRow {
  id: string; exit_id: string; company_id: string; company_name?: string; kind: "escrow" | "adjustment_escrow" | "holdback" | "expense_fund" | "earnout" | "deferred";
  description: string; amount_usd: number; expected_pct: number; due_on: string; status: ReceivableStatus; settled_usd: number; settled_on: string | null;
  note: string | null; created_by: string; created_at: string; updated_by: string | null;
}

const recOut = (r: ReceivableRow): ReceivableRow => ({ ...r, amount_usd: Number(r.amount_usd), expected_pct: Number(r.expected_pct), settled_usd: Number(r.settled_usd), due_on: day(r.due_on)!, settled_on: day(r.settled_on), created_at: iso(r.created_at)! });

export async function insertReceivable(db: Db, r: { exitId: string; companyId: string; kind: ReceivableRow["kind"]; description: string; amountUsd: number; expectedPct: number; dueOn: string }, by: string): Promise<void> {
  await db.query("insert into exit_receivables(exit_id, company_id, kind, description, amount_usd, expected_pct, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [r.exitId, r.companyId, r.kind, r.description, r.amountUsd, r.expectedPct, r.dueOn, by]);
}

export async function updateReceivable(db: Db, id: string, p: { status?: ReceivableStatus; settledUsd?: number; settledOn?: string; expectedPct?: number; dueOn?: string; note?: string | null }, by: string): Promise<void> {
  const { rows } = await db.query(
    `update exit_receivables set status = coalesce($2, status), settled_usd = coalesce($3, settled_usd), settled_on = coalesce($4, settled_on),
       expected_pct = coalesce($5, expected_pct), due_on = coalesce($6, due_on), note = coalesce($7, note), updated_by = $8, updated_at = now() where id = $1 returning id`,
    [id, p.status ?? null, p.settledUsd ?? null, p.settledOn ?? null, p.expectedPct ?? null, p.dueOn ?? null, p.note ?? null, by],
  );
  if (!rows[0]) throw new Error("No such receivable.");
  await audit(db, by, "exit.receivable", id, { status: p.status, settled: p.settledUsd });
}

export async function receivables(db: Db, opts: { exitId?: string; companyId?: string } = {}): Promise<ReceivableRow[]> {
  const where = opts.exitId ? "where r.exit_id = $1" : opts.companyId ? "where r.company_id = $1" : "";
  const { rows } = await db.query<ReceivableRow>(`select r.*, e.name as company_name from exit_receivables r join entities e on e.id = r.company_id ${where} order by r.due_on`, opts.exitId ? [opts.exitId] : opts.companyId ? [opts.companyId] : []);
  return rows.map(recOut);
}

export async function getReceivable(db: Db, id: string): Promise<ReceivableRow | null> {
  const { rows } = await db.query<ReceivableRow>("select r.*, e.name as company_name from exit_receivables r join entities e on e.id = r.company_id where r.id = $1", [id]);
  return rows[0] ? recOut(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Listed shares and prices
// ---------------------------------------------------------------------------

export interface PublicHoldingRow {
  id: string; company_id: string; company_name?: string; exit_id: string | null; ticker: string; exchange: string | null; listed_on: string; acquired_on: string;
  shares: number; shares_outstanding: number | null; lockup_days: number; affiliate: boolean; created_by: string; created_at: string;
}

const phOut = (r: PublicHoldingRow): PublicHoldingRow => ({ ...r, listed_on: day(r.listed_on)!, acquired_on: day(r.acquired_on)!, shares: Number(r.shares), shares_outstanding: num(r.shares_outstanding), created_at: iso(r.created_at)! });

export async function insertPublicHolding(db: Db, h: { companyId: string; exitId: string | null; ticker: string; exchange: string | null; listedOn: string; acquiredOn: string; shares: number; sharesOutstanding: number | null; lockupDays: number; affiliate: boolean }, by: string): Promise<PublicHoldingRow> {
  const { rows } = await db.query<PublicHoldingRow>(
    `insert into public_holdings(company_id, exit_id, ticker, exchange, listed_on, acquired_on, shares, shares_outstanding, lockup_days, affiliate, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [h.companyId, h.exitId, h.ticker, h.exchange, h.listedOn, h.acquiredOn, h.shares, h.sharesOutstanding, h.lockupDays, h.affiliate, by],
  );
  await audit(db, by, "exit.public_holding", h.companyId, { ticker: h.ticker, shares: h.shares });
  return phOut(rows[0]!);
}

export async function updatePublicHolding(db: Db, id: string, p: { sharesOutstanding?: number | null; lockupDays?: number; affiliate?: boolean }, by: string): Promise<void> {
  const { rows } = await db.query(
    `update public_holdings set shares_outstanding = coalesce($2, shares_outstanding), lockup_days = coalesce($3, lockup_days), affiliate = coalesce($4, affiliate),
       updated_by = $5, updated_at = now() where id = $1 returning id`,
    [id, p.sharesOutstanding ?? null, p.lockupDays ?? null, p.affiliate ?? null, by],
  );
  if (!rows[0]) throw new Error("No such holding.");
  await audit(db, by, "exit.public_holding.update", id, {});
}

export async function publicHoldings(db: Db, companyId?: string): Promise<PublicHoldingRow[]> {
  const { rows } = await db.query<PublicHoldingRow>(
    `select h.*, e.name as company_name from public_holdings h join entities e on e.id = h.company_id ${companyId ? "where h.company_id = $1" : ""} order by e.name`,
    companyId ? [companyId] : [],
  );
  return rows.map(phOut);
}

export async function getPublicHolding(db: Db, id: string): Promise<PublicHoldingRow | null> {
  const { rows } = await db.query<PublicHoldingRow>("select h.*, e.name as company_name from public_holdings h join entities e on e.id = h.company_id where h.id = $1", [id]);
  return rows[0] ? phOut(rows[0]) : null;
}

export async function upsertPrices(db: Db, ticker: string, prices: { date: string; close: number; volume?: number | null }[], source: string, by: string): Promise<number> {
  for (const p of prices) {
    await db.query(
      `insert into share_prices(ticker, on_date, close_usd, volume, source, created_by) values ($1,$2,$3,$4,$5,$6)
       on conflict (firm_id, ticker, on_date) do update set close_usd = excluded.close_usd, volume = excluded.volume, source = excluded.source`,
      [ticker, p.date, p.close, p.volume ?? null, source, by],
    );
  }
  if (prices.length) await audit(db, by, "exit.prices", undefined, { ticker, count: prices.length });
  return prices.length;
}

export async function prices(db: Db, ticker: string, opts: { limit?: number } = {}): Promise<{ date: string; close: number; volume: number | null }[]> {
  const { rows } = await db.query<{ on_date: string; close_usd: string; volume: string | null }>(
    "select on_date, close_usd, volume from share_prices where ticker = $1 order by on_date desc limit $2", [ticker, opts.limit ?? 400]);
  return rows.map((r) => ({ date: day(r.on_date)!, close: Number(r.close_usd), volume: num(r.volume) })).reverse();
}

export interface InKindPlanRow { distribution_id: string; public_holding_id: string; shares: number; price_usd: number; method: Record<string, unknown>; allocation: { id: string; name: string; shares: number }[]; created_by: string; created_at: string }

export async function insertInKindPlan(db: Db, p: { distributionId: string; publicHoldingId: string; shares: number; priceUsd: number; method: Record<string, unknown>; allocation: InKindPlanRow["allocation"] }, by: string): Promise<void> {
  await db.query("insert into in_kind_plans(distribution_id, public_holding_id, shares, price_usd, method, allocation, created_by) values ($1,$2,$3,$4,$5,$6,$7)",
    [p.distributionId, p.publicHoldingId, p.shares, p.priceUsd, JSON.stringify(p.method), JSON.stringify(p.allocation), by]);
}

export async function inKindPlans(db: Db, opts: { distributionId?: string } = {}): Promise<InKindPlanRow[]> {
  const { rows } = await db.query<InKindPlanRow>(`select * from in_kind_plans ${opts.distributionId ? "where distribution_id = $1" : ""} order by created_at`, opts.distributionId ? [opts.distributionId] : []);
  return rows.map((r) => ({ ...r, shares: Number(r.shares), price_usd: Number(r.price_usd), created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// QSBS reviews
// ---------------------------------------------------------------------------

export interface QsbsReviewRow { id: string; investment_id: string; checks: Record<string, boolean>; status: "eligible" | "not_eligible" | "unclear"; note: string | null; reviewed_by: string; created_at: string }

export async function insertQsbsReview(db: Db, r: { investmentId: string; checks: Record<string, boolean>; status: QsbsReviewRow["status"]; note: string | null }, by: string): Promise<void> {
  await db.query("insert into qsbs_reviews(investment_id, checks, status, note, reviewed_by) values ($1,$2,$3,$4,$5)", [r.investmentId, JSON.stringify(r.checks), r.status, r.note, by]);
  await audit(db, by, "exit.qsbs", r.investmentId, { status: r.status });
}

/** The latest review of each investment. */
export async function latestQsbs(db: Db): Promise<Map<string, QsbsReviewRow>> {
  const { rows } = await db.query<QsbsReviewRow>("select distinct on (investment_id) * from qsbs_reviews order by investment_id, created_at desc");
  return new Map(rows.map((r) => [r.investment_id, { ...r, created_at: iso(r.created_at)! }]));
}

// ---------------------------------------------------------------------------
// Fund life, extensions and wind-down
// ---------------------------------------------------------------------------

export async function getFundLife(db: Db, fundId: string): Promise<{ term_years: number; max_extension_years: number } | null> {
  const r = (await db.query<{ term_years: string; max_extension_years: string }>("select term_years, max_extension_years from fund_life where fund_id = $1", [fundId])).rows[0];
  return r ? { term_years: Number(r.term_years), max_extension_years: Number(r.max_extension_years) } : null;
}

export async function saveFundLife(db: Db, fundId: string, termYears: number, maxExtensionYears: number, by: string): Promise<void> {
  await db.query(
    `insert into fund_life(fund_id, term_years, max_extension_years, updated_by) values ($1,$2,$3,$4)
     on conflict (fund_id) do update set term_years = excluded.term_years, max_extension_years = excluded.max_extension_years, updated_by = excluded.updated_by, updated_at = now()`,
    [fundId, termYears, maxExtensionYears, by],
  );
  await audit(db, by, "fund.life", fundId, { termYears, maxExtensionYears });
}

export interface ExtensionRow { id: string; fund_id: string; years: number; approved_via: "gp" | "lpac" | "investors"; lpac_consent_id: string | null; fee_change: string | null; note: string | null; created_by: string; created_at: string }

export async function insertExtension(db: Db, e: { fundId: string; years: number; approvedVia: ExtensionRow["approved_via"]; lpacConsentId: string | null; feeChange: string | null; note: string | null }, by: string): Promise<void> {
  await db.query("insert into fund_extensions(fund_id, years, approved_via, lpac_consent_id, fee_change, note, created_by) values ($1,$2,$3,$4,$5,$6,$7)",
    [e.fundId, e.years, e.approvedVia, e.lpacConsentId, e.feeChange, e.note, by]);
  await audit(db, by, "fund.extension", e.fundId, { years: e.years, via: e.approvedVia });
}

export async function extensions(db: Db, fundId: string): Promise<ExtensionRow[]> {
  const { rows } = await db.query<ExtensionRow>("select * from fund_extensions where fund_id = $1 order by created_at", [fundId]);
  return rows.map((r) => ({ ...r, years: Number(r.years), created_at: iso(r.created_at)! }));
}

export async function setWindDownItem(db: Db, fundId: string, key: string, status: "open" | "done" | "na", note: string | null, by: string): Promise<void> {
  await db.query(
    `insert into wind_down_items(fund_id, key, status, note, updated_by) values ($1,$2,$3,$4,$5)
     on conflict (fund_id, key) do update set status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
    [fundId, key, status, note, by],
  );
  await audit(db, by, "fund.wind_down", fundId, { key, status });
}

export async function windDownItems(db: Db, fundId: string): Promise<{ key: string; status: "open" | "done" | "na"; note: string | null; updated_by: string; updated_at: string }[]> {
  const { rows } = await db.query<{ key: string; status: "open" | "done" | "na"; note: string | null; updated_by: string; updated_at: string }>("select key, status, note, updated_by, updated_at from wind_down_items where fund_id = $1", [fundId]);
  return rows.map((r) => ({ ...r, updated_at: iso(r.updated_at)! }));
}

// ---------------------------------------------------------------------------
// Continuation vehicles
// ---------------------------------------------------------------------------

export interface CvRow {
  id: string; fund_id: string; name: string; lead_buyer: string; company_ids: string[]; price_pct_of_nav: number; reference_nav_usd: number; launched_on: string; deadline: string;
  status_quo_offered: boolean; fairness_opinion: string | null; lpac_consent_id: string | null; status: "open" | "closed" | "abandoned"; created_by: string; created_at: string;
}

const cvOut = (r: CvRow): CvRow => ({ ...r, price_pct_of_nav: Number(r.price_pct_of_nav), reference_nav_usd: Number(r.reference_nav_usd), launched_on: day(r.launched_on)!, deadline: day(r.deadline)!, created_at: iso(r.created_at)! });

export async function insertCv(db: Db, c: Omit<CvRow, "id" | "status" | "created_by" | "created_at">, by: string): Promise<CvRow> {
  const { rows } = await db.query<CvRow>(
    `insert into cv_processes(fund_id, name, lead_buyer, company_ids, price_pct_of_nav, reference_nav_usd, launched_on, deadline, status_quo_offered, fairness_opinion, lpac_consent_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [c.fund_id, c.name, c.lead_buyer, c.company_ids, c.price_pct_of_nav, c.reference_nav_usd, c.launched_on, c.deadline, c.status_quo_offered, c.fairness_opinion, c.lpac_consent_id, by],
  );
  await audit(db, by, "fund.cv", c.fund_id, { name: c.name });
  return cvOut(rows[0]!);
}

export async function updateCv(db: Db, id: string, p: { status?: CvRow["status"]; fairnessOpinion?: string | null; lpacConsentId?: string | null }, by: string): Promise<void> {
  const { rows } = await db.query("update cv_processes set status = coalesce($2, status), fairness_opinion = coalesce($3, fairness_opinion), lpac_consent_id = coalesce($4, lpac_consent_id) where id = $1 returning id",
    [id, p.status ?? null, p.fairnessOpinion ?? null, p.lpacConsentId ?? null]);
  if (!rows[0]) throw new Error("No such process.");
  await audit(db, by, "fund.cv.update", id, { status: p.status });
}

export async function cvs(db: Db, fundId: string): Promise<CvRow[]> {
  const { rows } = await db.query<CvRow>("select * from cv_processes where fund_id = $1 order by created_at desc", [fundId]);
  return rows.map(cvOut);
}

export async function getCv(db: Db, id: string): Promise<CvRow | null> {
  const { rows } = await db.query<CvRow>("select * from cv_processes where id = $1", [id]);
  return rows[0] ? cvOut(rows[0]) : null;
}

export async function setElection(db: Db, processId: string, partnerId: string, choice: "roll" | "sell" | "status_quo", by: string): Promise<void> {
  await db.query(
    `insert into cv_elections(process_id, partner_id, choice, recorded_by) values ($1,$2,$3,$4)
     on conflict (process_id, partner_id) do update set choice = excluded.choice, recorded_by = excluded.recorded_by, recorded_at = now()`,
    [processId, partnerId, choice, by],
  );
  await audit(db, by, "fund.cv.election", processId, { partner: partnerId, choice });
}

export async function elections(db: Db, processId: string): Promise<{ partner_id: string; choice: "roll" | "sell" | "status_quo"; recorded_by: string; recorded_at: string }[]> {
  const { rows } = await db.query<{ partner_id: string; choice: "roll" | "sell" | "status_quo"; recorded_by: string; recorded_at: string }>("select partner_id, choice, recorded_by, recorded_at from cv_elections where process_id = $1", [processId]);
  return rows.map((r) => ({ ...r, recorded_at: iso(r.recorded_at)! }));
}
