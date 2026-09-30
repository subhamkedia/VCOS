/**
 * Exits and liquidity as deterministic, tested code: how a sale's
 * consideration splits into cash at closing, escrows, holdbacks and
 * earnouts; when public shares can be sold (lock-up, Rule 144) and how many;
 * what an in-kind distribution is worth and who gets which shares; QSBS
 * holding periods and caps; a fund's remaining life and its options for the
 * tail; continuation vehicle elections; and a liquidity forecast. Rule and
 * data citations are in each result so a person can check them. Counsel and
 * tax advisers decide; this flags, dates and adds up.
 */

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
};
const addYears = (d: string, n: number) => addMonths(d, n * 12);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const max = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// A sale's consideration
// ---------------------------------------------------------------------------

export type ReceivableKind = "escrow" | "adjustment_escrow" | "holdback" | "expense_fund" | "earnout" | "deferred";

export interface Consideration {
  closeDate: string;
  /** Everything the fund is due at the headline price, cash and stock, before anything is held back. */
  totalUsd: number;
  /** The part paid in the buyer's shares, at their value at closing. */
  stockUsd?: number;
  /** Indemnity escrow, percent of the fund's consideration, and when it's released. */
  escrowPct?: number;
  escrowMonths?: number;
  /** Purchase price adjustment escrow (working capital, net debt), percent, released after the true-up. */
  adjustmentEscrowPct?: number;
  adjustmentMonths?: number;
  /** A holdback the buyer keeps (not an escrow agent), percent. */
  holdbackPct?: number;
  holdbackMonths?: number;
  /** The fund's share of the sellers' representative expense fund. */
  expenseFundUsd?: number;
  /** Contingent payments, each with the most it can pay, the odds, and when it's decided. */
  earnouts?: { description: string; maxUsd: number; probabilityPct: number; dueOn: string }[];
  /** Fixed payments after closing. */
  deferred?: { description: string; amountUsd: number; dueOn: string }[];
}

export interface Receivable { kind: ReceivableKind; description: string; amountUsd: number; expectedPct: number; dueOn: string }

export interface ConsiderationSplit {
  atCloseCashUsd: number;
  stockUsd: number;
  receivables: Receivable[];
  /** Cash at close, stock, and each receivable at its expected amount. */
  expectedUsd: number;
  /** Everything, if every escrow is released and every earnout pays in full. */
  maximumUsd: number;
  steps: string[];
  warnings: string[];
}

/**
 * Splits the fund's consideration into what arrives at closing and what
 * waits. Escrows and holdbacks are expected in full unless a claim is made
 * (the person can lower that); earnouts are expected at their probability,
 * never at their maximum.
 */
export function splitConsideration(c: Consideration): ConsiderationSplit {
  if (!(c.totalUsd >= 0)) throw new Error("Enter the fund's consideration.");
  const stock = c.stockUsd ?? 0;
  if (stock < 0 || stock > c.totalUsd) throw new Error("The stock part can't be more than the total.");
  const steps: string[] = [`Consideration to the fund at the headline price: ${usd(c.totalUsd)}${stock ? `, of which ${usd(stock)} in the buyer's shares` : ""}.`];
  const warnings: string[] = [];
  const receivables: Receivable[] = [];
  const pct = (p: number | undefined, label: string) => {
    const v = p ?? 0;
    if (v < 0 || v > 100) throw new Error(`The ${label} should be between 0 and 100%.`);
    return v;
  };
  const hold = (kind: ReceivableKind, p: number | undefined, months: number | undefined, fallbackMonths: number, label: string) => {
    const v = pct(p, label);
    if (!v) return 0;
    const amount = round2(c.totalUsd * (v / 100));
    const dueOn = addMonths(c.closeDate, months ?? fallbackMonths);
    receivables.push({ kind, description: `${label[0]!.toUpperCase()}${label.slice(1)} (${v}%)`, amountUsd: amount, expectedPct: 100, dueOn });
    steps.push(`Less the ${label}, ${v}%: ${usd(amount)}, due back ${dueOn}.`);
    return amount;
  };
  let held = 0;
  held += hold("escrow", c.escrowPct, c.escrowMonths, 12, "indemnity escrow");
  held += hold("adjustment_escrow", c.adjustmentEscrowPct, c.adjustmentMonths, 3, "purchase price adjustment escrow");
  held += hold("holdback", c.holdbackPct, c.holdbackMonths, 12, "holdback");
  if (c.expenseFundUsd) {
    if (c.expenseFundUsd < 0) throw new Error("The expense fund can't be negative.");
    receivables.push({ kind: "expense_fund", description: "Sellers' representative expense fund", amountUsd: round2(c.expenseFundUsd), expectedPct: 100, dueOn: addMonths(c.closeDate, c.escrowMonths ?? 12) });
    steps.push(`Less the expense fund: ${usd(c.expenseFundUsd)}, returned with what's unspent.`);
    held += c.expenseFundUsd;
  }
  const cashPart = c.totalUsd - stock;
  if (held > cashPart + 0.005) throw new Error("More is held back than the cash part of the price.");
  const atClose = round2(cashPart - held);
  steps.push(`Cash at closing: ${usd(atClose)}.`);
  for (const e of c.earnouts ?? []) {
    if (!(e.maxUsd > 0)) throw new Error(`Enter the most "${e.description}" can pay.`);
    const p = pct(e.probabilityPct, "earnout probability");
    receivables.push({ kind: "earnout", description: e.description, amountUsd: round2(e.maxUsd), expectedPct: p, dueOn: e.dueOn });
    steps.push(`Earnout "${e.description}": up to ${usd(e.maxUsd)}, ${p}% likely, decided by ${e.dueOn}: expected ${usd(e.maxUsd * (p / 100))}.`);
  }
  for (const d of c.deferred ?? []) {
    if (!(d.amountUsd > 0)) throw new Error(`Enter the amount of "${d.description}".`);
    receivables.push({ kind: "deferred", description: d.description, amountUsd: round2(d.amountUsd), expectedPct: 100, dueOn: d.dueOn });
    steps.push(`Deferred payment "${d.description}": ${usd(d.amountUsd)} on ${d.dueOn}.`);
  }
  const expected = round2(atClose + stock + receivables.reduce((a, r) => a + r.amountUsd * (r.expectedPct / 100), 0));
  const maximum = round2(atClose + stock + receivables.reduce((a, r) => a + r.amountUsd, 0));
  steps.push(`Expected in total: ${usd(expected)}; at most ${usd(maximum)}.`);
  const escrowPct = (c.escrowPct ?? 0) + (c.holdbackPct ?? 0);
  if (escrowPct > 20) warnings.push(`${escrowPct}% held back for indemnity is high: most private deals hold about 10% or less, and far less with representation and warranty insurance (SRS Acquiom Deal Terms Study).`);
  if ((c.earnouts ?? []).length) warnings.push("Earnouts are carried at their probability, not their maximum; revisit the odds each quarter. About a quarter of private deals in 2025 had one, and many pay less than the maximum (SRS Acquiom).");
  if (stock > 0) warnings.push("Shares of the buyer are a new holding: record its ticker, the lock-up and our share count, and check the resale rules before selling.");
  return { atCloseCashUsd: atClose, stockUsd: stock, receivables, expectedUsd: expected, maximumUsd: maximum, steps, warnings };
}

/** What a receivable is worth today: its expected share, or what's left of it after a partial release. */
export function receivableValue(r: { amountUsd: number; expectedPct: number; settledUsd?: number; status: "pending" | "released" | "partial" | "claimed" | "forfeited" | "earned" }): number {
  if (r.status !== "pending" && r.status !== "partial") return 0;
  const remaining = Math.max(0, r.amountUsd - (r.settledUsd ?? 0));
  return round2(remaining * (r.expectedPct / 100));
}

// ---------------------------------------------------------------------------
// Public shares: lock-up and Rule 144
// ---------------------------------------------------------------------------

export interface PublicPosition {
  /** When the fund acquired the shares (the investment's closing; holding periods tack through conversion). */
  acquiredOn: string;
  /** When the company became a reporting company (the IPO's effective date). */
  listedOn: string;
  lockupDays?: number;
  /** An affiliate: a director of ours on the board, or enough ownership to share control. */
  affiliate: boolean;
  shares: number;
  sharesOutstanding?: number;
  /** Average weekly trading volume over the last four weeks. */
  avgWeeklyVolume?: number;
  price?: number;
}

export interface SaleWindow {
  lockupEnds: string;
  holdingPeriodMet: string;
  /** The first day the fund can sell, from all the restrictions together. */
  earliestSale: string;
  /** Affiliates: the most that can be sold in any three months. Null when there's no limit. */
  volumeLimit: number | null;
  /** Affiliates file Form 144 when a sale in three months exceeds 5,000 shares or $50,000. */
  form144: boolean;
  /** Five percent or more: Schedule 13G (or 13D); ten percent or a director: a Section 16 insider. */
  reporting: string[];
  steps: string[];
}

/**
 * When restricted shares in a listed company can be sold, under the
 * underwriters' lock-up (180 days is the norm) and Rule 144: a six-month
 * holding period once the issuer has reported for 90 days, a year before
 * then; affiliates also sell within the volume limit (the greater of 1% of
 * the shares outstanding and the average weekly volume) and file Form 144.
 */
export function saleWindow(p: PublicPosition): SaleWindow {
  const steps: string[] = [];
  const lockupEnds = addDays(p.listedOn, p.lockupDays ?? 180);
  steps.push(`Lock-up: ${p.lockupDays ?? 180} days from the listing, to ${lockupEnds}.`);
  const reporting90 = addDays(p.listedOn, 90);
  const sixMonths = addMonths(p.acquiredOn, 6);
  const oneYear = addYears(p.acquiredOn, 1);
  // Rule 144(d): six months if the issuer has reported for 90 days, one year otherwise.
  const holding = p.affiliate ? max(max(sixMonths, reporting90), p.listedOn) : oneYear <= reporting90 ? max(oneYear, p.listedOn) : max(sixMonths, reporting90);
  steps.push(p.affiliate
    ? `Rule 144 for an affiliate: shares held six months (${sixMonths}) and the company reporting for 90 days (${reporting90}).`
    : `Rule 144 for a non-affiliate: shares held a year (${oneYear}), or six months once the company has reported for 90 days (${reporting90}).`);
  const earliest = max(lockupEnds, holding);
  steps.push(`Earliest sale: ${earliest}.`);
  let volumeLimit: number | null = null;
  let form144 = false;
  if (p.affiliate) {
    const pct = p.sharesOutstanding ? Math.floor(p.sharesOutstanding * 0.01) : 0;
    volumeLimit = Math.max(pct, Math.floor(p.avgWeeklyVolume ?? 0)) || null;
    if (volumeLimit) steps.push(`Volume limit: the greater of 1% of shares outstanding (${pct.toLocaleString("en-US")}) and the average weekly volume (${Math.floor(p.avgWeeklyVolume ?? 0).toLocaleString("en-US")}): ${volumeLimit.toLocaleString("en-US")} shares in any three months.`);
    else steps.push("Enter the shares outstanding and the weekly volume to see the volume limit.");
    form144 = p.shares > 5000 || (p.price !== undefined && p.shares * p.price > 50_000);
  }
  const reporting: string[] = [];
  const own = p.sharesOutstanding ? (p.shares / p.sharesOutstanding) * 100 : null;
  if (own !== null && own >= 5) reporting.push(`We own ${own.toFixed(1)}%: Schedule 13G within 45 days after the quarter it's crossed (a passive or exempt holder), or 13D within 5 business days if we might influence control.`);
  if ((own !== null && own > 10) || p.affiliate) reporting.push("A Section 16 insider (a director, or over 10%): Form 3 at the listing, Form 4 within two business days of each trade, and short-swing profits within six months are recoverable.");
  return { lockupEnds, holdingPeriodMet: holding, earliestSale: earliest, volumeLimit, form144, reporting, steps };
}

// ---------------------------------------------------------------------------
// In-kind distributions
// ---------------------------------------------------------------------------

export type PriceMethod = { kind: "close"; on: string } | { kind: "average"; days: number; endingOn: string };

/**
 * The value per share of an in-kind distribution, the way the LPA says:
 * the closing price on the date, or the average closing price over the
 * trading days ending then.
 */
export function inKindPrice(prices: { date: string; close: number }[], m: PriceMethod): { price: number; steps: string[] } {
  const sorted = [...prices].filter((p) => p.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (m.kind === "close") {
    const p = sorted.filter((x) => x.date <= m.on).pop();
    if (!p) throw new Error(`No closing price on or before ${m.on}.`);
    return { price: p.close, steps: [`Closing price on ${p.date}: $${p.close.toFixed(4)}.`] };
  }
  if (!(m.days >= 1)) throw new Error("Average over at least one trading day.");
  const window = sorted.filter((x) => x.date <= m.endingOn).slice(-m.days);
  if (window.length < m.days) throw new Error(`Only ${window.length} trading days of prices on record up to ${m.endingOn}; the method needs ${m.days}.`);
  const avg = window.reduce((a, x) => a + x.close, 0) / window.length;
  return { price: Math.round(avg * 10_000) / 10_000, steps: [`Average close over ${m.days} trading days, ${window[0]!.date} to ${window[window.length - 1]!.date}: $${avg.toFixed(4)}.`] };
}

/**
 * Whole shares for each recipient, in proportion to its dollar amount, by
 * largest remainder; the fraction left over stays with the fund (cash in
 * lieu is paid when it's sold).
 */
export function shareSplit(recipients: { id: string; amountUsd: number }[], totalShares: number): { id: string; shares: number }[] {
  const total = recipients.reduce((a, r) => a + r.amountUsd, 0);
  if (!(total > 0) || !(totalShares > 0)) return recipients.map((r) => ({ id: r.id, shares: 0 }));
  const whole = Math.floor(totalShares);
  const raw = recipients.map((r) => ({ id: r.id, exact: (r.amountUsd / total) * whole }));
  const out = raw.map((r) => ({ id: r.id, shares: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let left = whole - out.reduce((a, r) => a + r.shares, 0);
  for (const r of [...out].sort((a, b) => b.rem - a.rem || a.id.localeCompare(b.id))) {
    if (left <= 0) break;
    r.shares++;
    left--;
  }
  return out.map(({ id, shares }) => ({ id, shares }));
}

// ---------------------------------------------------------------------------
// QSBS (Section 1202)
// ---------------------------------------------------------------------------

/** The One Big Beautiful Bill Act's changes apply to stock issued after July 4, 2025. */
export const OBBBA_DATE = "2025-07-05";

export interface QsbsResult {
  regime: "post_2025" | "pre_2025";
  heldDays: number;
  /** Percent of the gain excluded if sold on the date. */
  exclusionPct: number;
  /** The next step up, if one is ahead. */
  next: { on: string; pct: number } | null;
  /** Per taxpayer and issuer: the greater of this and ten times basis. */
  capUsd: number;
  tenTimesBasisUsd: number;
  notes: string[];
}

/**
 * The gain excluded under Section 1202 if a lot is sold on a date. Stock
 * issued after July 4, 2025: 50% after three years, 75% after four, 100%
 * after five, capped at $15 million (indexed from 2027) or ten times basis.
 * Earlier stock: 100% after five years (stock acquired after September 27,
 * 2010), capped at $10 million or ten times basis. Held "more than" the
 * period, so the day after the anniversary.
 */
export function qsbs(lot: { acquiredOn: string; basisUsd: number }, saleOn: string): QsbsResult {
  const post = lot.acquiredOn >= OBBBA_DATE;
  const held = days(lot.acquiredOn, saleOn);
  const after = (y: number) => addDays(addYears(lot.acquiredOn, y), 1);
  const tiers = post ? [{ y: 3, pct: 50 }, { y: 4, pct: 75 }, { y: 5, pct: 100 }] : [{ y: 5, pct: lot.acquiredOn > "2010-09-27" ? 100 : lot.acquiredOn >= "2009-02-18" ? 75 : 50 }];
  let pct = 0;
  let next: QsbsResult["next"] = null;
  for (const t of tiers) {
    if (saleOn >= after(t.y)) pct = t.pct;
    else if (!next) next = { on: after(t.y), pct: t.pct };
  }
  const cap = post ? 15_000_000 : 10_000_000;
  const notes: string[] = [];
  if (post && pct > 0 && pct < 100) notes.push("The gain not excluded is taxed at the 28% collectibles rate.");
  if (pct === 0) notes.push(`Sold before ${post ? "three" : "five"} years, no gain is excluded; a Section 1045 rollover into other QSBS within 60 days can defer it if the stock was held more than six months.`);
  notes.push("QSBS passes through the fund to partners who were partners when the fund bought the stock, in proportion to their interest then; each partner's cap is its own.");
  return { regime: post ? "post_2025" : "pre_2025", heldDays: held, exclusionPct: pct, next, capUsd: cap, tenTimesBasisUsd: round2(lot.basisUsd * 10), notes };
}

/** What the company and our records must show for stock to be QSBS. */
export const QSBS_CHECKS = [
  { key: "c_corp", label: "A domestic C corporation when the stock was issued and throughout our holding" },
  { key: "original_issue", label: "Bought from the company at original issue for cash, property or services (not from another holder)" },
  { key: "gross_assets", label: "The company's gross assets were at most $50 million ($75 million for stock issued after July 4, 2025) before and right after the issue" },
  { key: "active_business", label: "At least 80% of assets used in a qualified trade (not professional services, finance, hospitality, farming or extraction)" },
  { key: "no_redemptions", label: "No significant redemptions around the issue date" },
  { key: "company_rep", label: "The company has given a QSBS representation or statement" },
] as const;

// ---------------------------------------------------------------------------
// The fund's life and its tail
// ---------------------------------------------------------------------------

export interface FundLife {
  inception: string;
  termYears: number;
  extensions: { years: number }[];
  maxExtensionYears: number;
}

export function fundLife(f: FundLife, asOf: string) {
  const termEnds = addDays(addYears(f.inception, f.termYears), -1);
  const used = f.extensions.reduce((a, e) => a + e.years, 0);
  const endsOn = addDays(addYears(f.inception, f.termYears + used), -1);
  const monthsLeft = Math.round((Date.parse(endsOn) - Date.parse(asOf)) / (DAY * 30.4375));
  return {
    termEnds, endsOn, extensionYearsUsed: used, extensionYearsLeft: Math.max(0, f.maxExtensionYears - used), monthsLeft,
    stage: asOf > endsOn ? "past_term" as const : used > 0 ? "extended" as const : monthsLeft <= 24 ? "final_years" as const : "harvesting" as const,
  };
}

/**
 * What a fund can do with holdings its term won't outlast. Ordered roughly
 * by how often venture funds use them.
 */
export function tailOptions(t: { monthsLeft: number; residualNavUsd: number; holdings: number; extensionYearsLeft: number; publicHoldings: number }) {
  const out: { key: string; title: string; detail: string }[] = [];
  if (t.extensionYearsLeft > 0) out.push({ key: "extension", title: "Extend the term", detail: `Up to ${t.extensionYearsLeft} more year${t.extensionYearsLeft === 1 ? "" : "s"} under the LPA, usually with LPAC or investor consent. Many LPs expect the management fee to fall or stop in an extension.` });
  if (t.publicHoldings > 0) out.push({ key: "sell_or_distribute", title: "Sell or distribute the public shares", detail: "After the lock-up, sell within the volume limits or distribute the shares in kind to investors." });
  out.push({ key: "direct_secondary", title: "Sell positions to secondary buyers", detail: "Individual stakes, subject to each company's transfer restrictions and right of first refusal; expect a discount to the last round." });
  if (t.holdings >= 3) out.push({ key: "strip_sale", title: "Sell a strip or the whole tail", detail: "A secondary fund buys several positions at once, often at a deeper discount but with one process." });
  if (t.residualNavUsd >= 25_000_000) out.push({ key: "continuation", title: "A continuation vehicle", detail: "A GP-led transfer to a new vehicle backed by a lead secondary buyer. ILPA's 2023 guidance: a status quo option with unchanged terms, at least 30 calendar days (20 business days) to elect, silence treated as a sale, a fairness opinion, and LPAC review of the conflict." });
  out.push({ key: "wind_up", title: "Wind up", detail: "Distribute what's left in cash or in kind, then the final audit, final K-1s and the certificate of cancellation." });
  return out;
}

/** Steps to close a fund, in order. */
export const WIND_DOWN_STEPS = [
  { key: "final_valuation", label: "Final valuation of remaining holdings, approved by a second person" },
  { key: "dispose_holdings", label: "Every holding sold, distributed in kind or written off" },
  { key: "receivables", label: "Escrows, holdbacks and earnouts settled, or assigned to a liquidating trust" },
  { key: "clawback", label: "The GP clawback calculated and settled" },
  { key: "final_distribution", label: "The final distribution, approved and paid" },
  { key: "final_audit", label: "The final audit" },
  { key: "final_k1", label: "Final K-1s marked final, and the fund's last tax return" },
  { key: "regulatory", label: "Form ADV updated to remove the fund; Form D and state notices closed out" },
  { key: "cancellation", label: "Certificate of cancellation filed, bank accounts closed, records retained" },
] as const;

// ---------------------------------------------------------------------------
// Continuation vehicle elections
// ---------------------------------------------------------------------------

const businessDays = (from: string, to: string) => {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
};

export type Election = "roll" | "sell" | "status_quo";

/**
 * Tallies investors' elections in a GP-led continuation vehicle. Silence is
 * a sale (ILPA, 2023). The election window must be at least 30 calendar and
 * 20 business days.
 */
export function cvElections(p: { launchedOn: string; deadline: string; statusQuoOffered: boolean; pricePct: number; investors: { id: string; navUsd: number }[]; elections: { id: string; choice: Election }[] }, asOf: string) {
  const cal = days(p.launchedOn, p.deadline);
  const bus = businessDays(p.launchedOn, p.deadline);
  const issues: string[] = [];
  if (cal < 30 || bus < 20) issues.push(`The election window is ${cal} calendar days (${bus} business days): ILPA asks for at least 30 calendar days and 20 business days.`);
  if (!p.statusQuoOffered) issues.push("No status quo option: ILPA asks that investors can roll on unchanged terms (no higher fee or carry, and carry doesn't crystallize for them).");
  const closed = asOf > p.deadline;
  const by = p.investors.map((i) => {
    const e = p.elections.find((x) => x.id === i.id)?.choice;
    const choice: Election | "pending" = e ?? (closed ? "sell" : "pending");
    return { id: i.id, navUsd: i.navUsd, choice, defaulted: !e && closed, cashUsd: choice === "sell" ? round2(i.navUsd * (p.pricePct / 100)) : 0 };
  });
  const sumBy = (c: Election | "pending") => round2(by.filter((x) => x.choice === c).reduce((a, x) => a + x.navUsd, 0));
  if (p.pricePct < 80) issues.push(`The price is ${p.pricePct}% of NAV: a deep discount for investors who sell; the fairness opinion should explain it.`);
  return { calendarDays: cal, businessDays: bus, issues, closed, investors: by, navRolled: sumBy("roll"), navStatusQuo: sumBy("status_quo"), navSold: sumBy("sell"), navPending: sumBy("pending"), cashToSellers: round2(by.reduce((a, x) => a + x.cashUsd, 0)) };
}

// ---------------------------------------------------------------------------
// The liquidity forecast
// ---------------------------------------------------------------------------

/**
 * Expected cash back by year: receivables at their expected amounts, public
 * shares once they can be sold, and planned exits at their probability.
 */
export function liquidityForecast(
  i: { receivables: { amountUsd: number; dueOn: string }[]; publicHoldings: { valueUsd: number; sellableFrom: string }[]; plannedExits: { company: string; year: number; valueUsd: number; probabilityPct: number }[] },
  asOf: string,
) {
  const years = new Map<number, { receivables: number; publicShares: number; exits: number }>();
  const at = (y: number) => {
    const k = Math.max(y, Number(asOf.slice(0, 4)));
    const v = years.get(k) ?? { receivables: 0, publicShares: 0, exits: 0 };
    years.set(k, v);
    return v;
  };
  for (const r of i.receivables) at(Number(r.dueOn.slice(0, 4))).receivables += r.amountUsd;
  for (const p of i.publicHoldings) at(Number(max(p.sellableFrom, asOf).slice(0, 4))).publicShares += p.valueUsd;
  for (const e of i.plannedExits) at(e.year).exits += e.valueUsd * (e.probabilityPct / 100);
  return [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({
    year, receivables: round2(v.receivables), publicShares: round2(v.publicShares), exits: round2(v.exits), total: round2(v.receivables + v.publicShares + v.exits),
  }));
}

/** What makes a company ready to sell or list, for the exit plan. */
export const READINESS = [
  { key: "cap_table", label: "Cap table reconciled to the ledger (Carta or equivalent), with every grant documented" },
  { key: "ip", label: "IP assignments signed by every founder, employee and contractor" },
  { key: "financials", label: "Audited financials (two to three years, PCAOB standards for an IPO)" },
  { key: "contracts", label: "Key contracts reviewed for change-of-control and assignment clauses" },
  { key: "data_room", label: "A sell-side data room assembled" },
  { key: "valuation_409a", label: "A current 409A valuation" },
  { key: "tax", label: "Tax position reviewed (sales tax nexus, R&D credits, QSBS statements)" },
  { key: "management", label: "Management retention and any carve-out plan agreed" },
  { key: "board_aligned", label: "The board aligned on the process, with preferred and common interests considered" },
  { key: "advisers", label: "Bankers, counsel and, for a sale, representation and warranty insurance lined up" },
] as const;
