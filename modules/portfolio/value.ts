import type { Db } from "../../lib/db.js";
import type { RealizationRow, ValuationRow } from "../../ledger/portfolio.js";
import { exits, prices, publicHoldings, receivables, type PublicHoldingRow, type ReceivableRow } from "../../ledger/exits.js";
import { receivableValue } from "../../engines/exits.js";
import type { Holding } from "./common.js";

/**
 * What the fund holds in a company now, in three parts:
 * - private shares: the latest approved mark (or cost), scaled down for
 *   shares sold since the mark, and nothing once the company is sold,
 *   listed or wound down;
 * - what a sale left to collect: escrows, holdbacks and earnouts at their
 *   expected amounts;
 * - listed shares: shares still held at the latest closing price.
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
}

/** Everything the value needs, read once for the whole portfolio. */
export async function valueInputs(db: Db) {
  const ph = await publicHoldings(db);
  const last = new Map<string, { date: string; close: number } | undefined>();
  for (const h of ph) if (!last.has(h.ticker)) last.set(h.ticker, (await prices(db, h.ticker, { limit: 1 })).pop());
  return { exits: await exits(db), receivables: await receivables(db), publicHoldings: ph, lastPrice: last };
}
export type ValueInputs = Awaited<ReturnType<typeof valueInputs>>;

const SHARE_SALES = new Set(["secondary", "tender", "partial_sale"]);

/** Shares of a listed holding still held: less what was sold or distributed in kind from it. */
export function publicSharesLeft(h: PublicHoldingRow, real: RealizationRow[]): number {
  return h.shares - real.filter((r) => (r.kind === "public_sale" || r.kind === "in_kind") && r.detail?.publicHoldingId === h.id).reduce((a, r) => a + (r.shares ?? 0), 0);
}

export function holdingValue(h: Holding, mark: ValuationRow | undefined, real: RealizationRow[], inputs: ValueInputs): HoldingValue {
  const closed = inputs.exits.filter((x) => x.company_id === h.companyId && x.stage === "closed" && ["acquisition", "ipo", "wind_down"].includes(x.kind)).map((x) => x.closed_on!).sort();
  const legacyExit = real.filter((r) => (r.kind === "sale" && !r.exit_id) || r.kind === "write_off").map((r) => r.occurred_on).sort().pop();
  const exitDate = [closed[0], legacyExit].filter(Boolean).sort()[0] as string | undefined;
  const invested = h.investments.reduce((a, i) => a + i.amount_usd, 0);
  const shares = h.investments.every((i) => i.shares !== null) ? h.investments.reduce((a, i) => a + (i.shares ?? 0), 0) : null;
  const sold = real.filter((r) => SHARE_SALES.has(r.kind) && r.shares);
  const soldBy = (d: string) => sold.filter((r) => r.occurred_on <= d).reduce((a, r) => a + (r.shares ?? 0), 0);
  const left = shares === null ? null : Math.max(0, shares - soldBy("9999-12-31"));
  const recs = inputs.receivables.filter((r) => r.company_id === h.companyId);
  const listed = inputs.publicHoldings.filter((x) => x.company_id === h.companyId);
  let privateUsd = 0;
  let basis: ValueBasis = "cost";
  if (!exitDate) {
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
  const pendingUsd = recs.reduce((a, r) => a + receivableValue({ amountUsd: r.amount_usd, expectedPct: r.expected_pct, settledUsd: r.settled_usd, status: r.status }), 0);
  let publicUsd = 0;
  for (const p of listed) {
    // Before any closing price is on record, the listing price.
    const px = inputs.lastPrice.get(p.ticker)?.close ?? inputs.exits.find((x) => x.id === p.exit_id)?.price_per_share;
    if (px) publicUsd += publicSharesLeft(p, real) * px;
  }
  if (publicUsd > 0) basis = "public";
  const round = (n: number) => Math.round(n * 100) / 100;
  return { value: round(privateUsd + pendingUsd + publicUsd), basis, privateUsd: round(privateUsd), pendingUsd: round(pendingUsd), publicUsd: round(publicUsd), privateShares: left };
}

export type { ReceivableRow };
