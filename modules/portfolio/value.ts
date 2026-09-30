import type { Db } from "../../lib/db.js";
import type { InvestmentRow } from "../../ledger/execution.js";
import type { RealizationRow, ValuationRow } from "../../ledger/portfolio.js";
import { exits, prices, publicHoldings, receivables, type PublicHoldingRow, type ReceivableRow } from "../../ledger/exits.js";
import { receivableValue } from "../../engines/exits.js";

/**
 * What the firm holds in a company at a date, in three parts:
 * - private shares: the latest approved mark on or before the date (or
 *   cost), scaled down for shares sold since the mark, and nothing once the
 *   company is sold, listed or wound down;
 * - what a sale left to collect: escrows, holdbacks and earnouts at their
 *   expected amounts, less what had been settled by the date;
 * - listed shares: shares still held at the closing price on or before the
 *   date (the listing price until a price is on record).
 *
 * Portfolio (today) and LP Reporting (any statement date) both value
 * holdings here, so the two always agree. A company held by more than one
 * fund is split between them by shares (or cost, without share counts).
 */

export type ValueBasis = "mark" | "cost" | "exited" | "public";

export interface HoldingValue {
  value: number;
  basis: ValueBasis;
  privateUsd: number;
  pendingUsd: number;
  publicUsd: number;
  /** Private shares still held, when the investment records have share counts. */
  privateShares: number | null;
  /** Money back by the date. */
  realizedUsd: number;
  /** The approved mark used, if any. */
  markDate: string | null;
  markMethod: string | null;
  /** The date the company was sold, listed or wound down, if it was by then. */
  exitDate: string | null;
}

/** The investments a value is for: a company's, all or one fund's. */
export interface HoldingLike {
  companyId: string;
  investments: InvestmentRow[];
}

/** Everything a value needs, read once for the whole portfolio. */
export async function valueInputs(db: Db) {
  const ph = await publicHoldings(db);
  const px = new Map<string, { date: string; close: number }[]>();
  for (const h of ph) if (!px.has(h.ticker)) px.set(h.ticker, await prices(db, h.ticker, { limit: 2000 }));
  return { exits: await exits(db), receivables: await receivables(db), publicHoldings: ph, prices: px };
}
export type ValueInputs = Awaited<ReturnType<typeof valueInputs>>;

const SHARE_SALES = new Set(["secondary", "tender", "partial_sale"]);
const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/** Shares of a listed holding still held on a date: less what was sold or distributed in kind from it. */
export function publicSharesLeft(h: PublicHoldingRow, real: RealizationRow[], asOf = "9999-12-31"): number {
  return h.shares - real.filter((r) => (r.kind === "public_sale" || r.kind === "in_kind") && r.detail?.publicHoldingId === h.id && r.occurred_on <= asOf).reduce((a, r) => a + (r.shares ?? 0), 0);
}

/** The closing price on or before a date. */
export function priceOn(inputs: ValueInputs, ticker: string, asOf: string): { date: string; close: number } | undefined {
  return (inputs.prices.get(ticker) ?? []).filter((p) => p.date <= asOf).pop();
}

/**
 * A company's value to the firm at a date. `marks` are its approved marks
 * (any order); `real` its realizations.
 */
export function holdingValue(h: HoldingLike, marks: ValuationRow[] | ValuationRow | undefined, real: RealizationRow[], inputs: ValueInputs, asOf = today()): HoldingValue {
  const inv = h.investments.filter((i) => i.close_date <= asOf);
  const rs = real.filter((r) => r.occurred_on <= asOf);
  const markList = marks === undefined ? [] : Array.isArray(marks) ? marks : [marks];
  const mark = markList.filter((m) => m.as_of <= asOf && m.status === "approved").sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
  const closedExits = inputs.exits.filter((x) => x.company_id === h.companyId && x.stage === "closed" && x.closed_on && x.closed_on <= asOf);
  const closed = closedExits.filter((x) => ["acquisition", "ipo", "wind_down"].includes(x.kind)).map((x) => x.closed_on!).sort();
  const legacyExit = rs.filter((r) => (r.kind === "sale" && !r.exit_id) || r.kind === "write_off").map((r) => r.occurred_on).sort().pop();
  const exitDate = [closed[0], legacyExit].filter(Boolean).sort()[0] as string | undefined;
  const invested = inv.reduce((a, i) => a + i.amount_usd, 0);
  const shares = inv.length && inv.every((i) => i.shares !== null) ? inv.reduce((a, i) => a + (i.shares ?? 0), 0) : null;
  const sold = rs.filter((r) => SHARE_SALES.has(r.kind) && r.shares);
  const soldBy = (d: string) => sold.filter((r) => r.occurred_on <= d).reduce((a, r) => a + (r.shares ?? 0), 0);
  const left = shares === null ? null : Math.max(0, shares - soldBy(asOf));
  const closedIds = new Set(closedExits.map((x) => x.id));
  const recs = inputs.receivables.filter((r) => r.company_id === h.companyId && closedIds.has(r.exit_id));
  const listed = inputs.publicHoldings.filter((x) => x.company_id === h.companyId && x.listed_on <= asOf && (!x.exit_id || closedIds.has(x.exit_id)));
  let privateUsd = 0;
  let basis: ValueBasis = "cost";
  if (!inv.length) basis = "cost";
  else if (!exitDate) {
    if (mark) {
      const atMark = shares === null ? null : shares - soldBy(mark.as_of);
      privateUsd = atMark && left !== null ? mark.fair_value_usd * (left / atMark) : mark.fair_value_usd;
      basis = "mark";
    } else {
      privateUsd = shares && left !== null ? invested * (left / shares) : invested;
    }
  } else if (mark && mark.as_of > exitDate && !recs.length && !listed.length) {
    // An exit recorded without its receivables: a later mark carries what's still due.
    privateUsd = mark.fair_value_usd;
    basis = "mark";
  } else basis = "exited";
  // Receivables at the date: what had been settled by then comes from the dated realizations.
  const pendingUsd = recs.reduce((a, r) => {
    const settledBy = rs.filter((x) => x.receivable_id === r.id).reduce((s, x) => s + x.amount_usd, 0);
    const finalBy = r.status !== "pending" && r.status !== "partial" && r.settled_on !== null && r.settled_on <= asOf;
    return a + receivableValue({ amountUsd: r.amount_usd, expectedPct: r.expected_pct, settledUsd: settledBy, status: finalBy ? r.status : "pending" });
  }, 0);
  let publicUsd = 0;
  for (const p of listed) {
    // Before any closing price is on record, the listing price.
    const px = priceOn(inputs, p.ticker, asOf)?.close ?? inputs.exits.find((x) => x.id === p.exit_id)?.price_per_share ?? undefined;
    if (px) publicUsd += publicSharesLeft(p, rs, asOf) * px;
  }
  // Listed after an IPO (or shares recorded by hand); a sale paid partly in the buyer's shares stays "exited".
  const ipo = closedExits.some((x) => x.kind === "ipo") || listed.some((p) => !p.exit_id);
  if (publicUsd > 0 && (ipo || !exitDate)) basis = "public";
  return {
    value: round(privateUsd + pendingUsd + publicUsd), basis, privateUsd: round(privateUsd), pendingUsd: round(pendingUsd), publicUsd: round(publicUsd),
    privateShares: basis === "mark" || basis === "cost" ? left : 0,
    realizedUsd: round(rs.filter((r) => r.amount_usd > 0).reduce((a, r) => a + r.amount_usd, 0)),
    markDate: basis === "mark" && mark ? mark.as_of : null, markMethod: basis === "mark" && mark ? mark.method : null, exitDate: exitDate ?? null,
  };
}

/**
 * One fund's part of a company the firm holds from several funds: by
 * shares where every investment has them, else by cost. Money back and
 * value are the company's times this share.
 */
export function fundShare(all: InvestmentRow[], fundName: string, asOf = "9999-12-31"): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const inv = all.filter((i) => i.close_date <= asOf);
  const mine = inv.filter((i) => norm(i.fund_name) === norm(fundName));
  if (!mine.length) return 0;
  if (mine.length === inv.length) return 1;
  const byShares = inv.every((i) => i.shares !== null);
  const w = (xs: InvestmentRow[]) => xs.reduce((a, i) => a + (byShares ? i.shares! : i.amount_usd), 0);
  return w(inv) > 0 ? w(mine) / w(inv) : 0;
}

export type { ReceivableRow };
