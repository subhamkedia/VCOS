import { xirr, type Flow } from "./fund-metrics.js";

/**
 * Fund accounting for LP reporting: allocating calls and distributions,
 * management fees, the carried interest waterfall, capital accounts and net
 * returns. Deterministic and unit-tested: a model may explain these numbers,
 * never compute them.
 *
 * Conventions (from the LPA; these are the market and ILPA defaults):
 * - Calls, fund expenses and investment gains are shared pro rata by
 *   commitment among all partners. Management fees and carried interest fall
 *   only on fee-paying LPs; the GP's own commitment pays neither.
 * - Management fee: an annual rate on committed capital during the
 *   investment period, then (usually) a lower rate on committed or invested
 *   capital, charged by day count, net of fee offsets.
 * - Waterfall, whole of fund ("European", ILPA's preferred model): LPs get
 *   their contributions back and a preferred return (the hurdle,
 *   compounding), then the GP catches up, then profits split. Deal by deal
 *   ("American") applies the same tiers to each realized investment, with a
 *   share of carry held in escrow (ILPA suggests 30% or more) against
 *   clawback.
 * - Accrued carry is the carry a hypothetical liquidation at NAV would
 *   produce; it reduces LPs' capital accounts before it is paid.
 */

const DAY = 86_400_000;
const years = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / DAY / 365);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Split an amount by weight, in cents, so the parts always add up to the
 * total exactly (largest remainder; ties go to the larger weight, then the
 * earlier row).
 */
export function allocate<T extends { id: string; weight: number }>(total: number, rows: T[]): { id: string; amount: number }[] {
  const w = sum(rows.map((r) => Math.max(0, r.weight)));
  if (!rows.length) return [];
  if (w <= 0) throw new Error("Nothing to allocate by: every weight is zero.");
  const cents = Math.round(total * 100);
  const raw = rows.map((r, i) => ({ id: r.id, i, weight: Math.max(0, r.weight), exact: (cents * Math.max(0, r.weight)) / w }));
  const base = raw.map((r) => ({ ...r, cents: Math.floor(r.exact) }));
  let left = cents - sum(base.map((b) => b.cents));
  const order = [...base].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || b.weight - a.weight || a.i - b.i);
  for (const r of order) {
    if (left <= 0) break;
    r.cents++;
    left--;
  }
  return base.map((b) => ({ id: b.id, amount: b.cents / 100 }));
}

// ---------------------------------------------------------------------------
// Terms and management fees
// ---------------------------------------------------------------------------

export interface FundTerms {
  /** Annual management fee during the investment period, percent. */
  managementFeePct: number;
  /** Annual rate after the investment period, percent; defaults to the full fee. */
  feeStepDownPct?: number;
  feeBasisAfterPeriod: "committed" | "invested";
  /** Last day of the investment period (YYYY-MM-DD). */
  investmentPeriodEnd: string;
  carryPct: number;
  /** Preferred return, percent a year, compounding annually. Zero for none (common in venture). */
  hurdlePct: number;
  /** Share of distributions the GP takes in the catch-up band, percent (100 = full catch-up, 0 = none). */
  catchUpPct: number;
  waterfall: "european" | "american";
  /** Share of each carry payment held back in escrow (deal-by-deal funds), percent. */
  escrowPct?: number;
}

export interface FeeInput {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  /** Fee-paying commitments (the GP's commitment excluded). */
  feePayingCommitments: number;
  /** Cost basis of investments still held, for an invested-capital basis. */
  investedCost: number;
  /** Fees the GP received from portfolio companies (board, transaction) that offset the fee. */
  offsets?: number;
}

export interface FeeResult {
  gross: number;
  offsets: number;
  net: number;
  lines: string[];
}

/** The management fee for a period, split at the end of the investment period. */
export function managementFee(t: FundTerms, f: FeeInput): FeeResult {
  const start = Date.parse(f.from);
  const end = Date.parse(f.to) + DAY; // inclusive
  if (!(end > start)) throw new Error("The fee period ends before it starts.");
  const ipEnd = Date.parse(t.investmentPeriodEnd) + DAY;
  const lines: string[] = [];
  let gross = 0;
  const part = (a: number, b: number, rate: number, basis: number, label: string) => {
    if (b <= a) return;
    const days = (b - a) / DAY;
    const amt = basis * (rate / 100) * (days / 365);
    gross += amt;
    lines.push(`${label}: ${rate}% a year on $${Math.round(basis).toLocaleString("en-US")} for ${Math.round(days)} days = $${round2(amt).toLocaleString("en-US")}`);
  };
  part(start, Math.min(end, ipEnd), t.managementFeePct, f.feePayingCommitments, "Investment period, on commitments");
  const after = t.feeStepDownPct ?? t.managementFeePct;
  const afterBasis = t.feeBasisAfterPeriod === "invested" ? f.investedCost : f.feePayingCommitments;
  part(Math.max(start, ipEnd), end, after, afterBasis, `After the investment period, on ${t.feeBasisAfterPeriod === "invested" ? "invested capital" : "commitments"}`);
  const offsets = Math.min(gross, Math.max(0, f.offsets ?? 0));
  if (offsets) lines.push(`Less fee offsets: $${round2(offsets).toLocaleString("en-US")}`);
  return { gross: round2(gross), offsets: round2(offsets), net: round2(gross - offsets), lines };
}

// ---------------------------------------------------------------------------
// Carried interest
// ---------------------------------------------------------------------------

/**
 * What LPs need to have received, in total, to reach the hurdle by `asOf`:
 * every contribution compounded at the hurdle, less every distribution
 * compounded the same way, plus what they've already received.
 */
export function hurdleTarget(contributions: Flow[], lpDistributions: Flow[], hurdlePct: number, asOf: string): number {
  const h = hurdlePct / 100;
  const grow = (x: Flow) => x.amount * Math.pow(1 + h, years(x.date, asOf));
  const contributed = sum(contributions.map((c) => c.amount));
  if (h === 0) return contributed;
  const balance = sum(contributions.map(grow)) - sum(lpDistributions.map(grow));
  return sum(lpDistributions.map((d) => d.amount)) + Math.max(0, balance);
}

/**
 * The GP's cumulative carry when `total` has been distributed in all (to LPs
 * and as carry), given what the LPs contributed and what they need for the
 * hurdle. The tiers: all to LPs up to the hurdle; then the catch-up band,
 * where the GP takes `catchUpPct` until it holds `carryPct` of all profit;
 * then `carryPct` of the rest.
 */
export function cumulativeCarry(total: number, contributed: number, hurdle: number, t: Pick<FundTerms, "carryPct" | "catchUpPct">): number {
  const carry = t.carryPct / 100;
  const c = t.catchUpPct / 100;
  if (carry <= 0 || total <= Math.max(contributed, hurdle)) return 0;
  const H = Math.max(contributed, hurdle);
  const above = total - H;
  if (c <= carry) return carry * above; // no catch-up: carry on what's above the hurdle only
  // Catch-up band: the GP takes c per dollar until GP = carry x (total - contributed).
  const band = (carry * (H - contributed)) / (c - carry);
  if (above <= band) return c * above;
  const gpAtBandEnd = c * band;
  return gpAtBandEnd + carry * (above - band);
}

export interface WaterfallState {
  /** Fee-paying LPs' contributions, dated. */
  contributions: Flow[];
  /** Earlier distributions to those LPs (after carry), dated. */
  lpDistributions: Flow[];
  /** Carry already paid to the GP (including amounts in escrow). */
  carryPaid: number;
}

export interface DistributionSplit {
  amount: number;
  toLps: number;
  carry: number;
  escrow: number;
  carryPaidNow: number;
  lines: string[];
}

/** Split one distribution (the fee-paying LPs' share of it) between LPs and carry, whole-of-fund. */
export function splitDistribution(amount: number, date: string, s: WaterfallState, t: FundTerms): DistributionSplit {
  const contributed = sum(s.contributions.map((c) => c.amount));
  const hurdle = hurdleTarget(s.contributions, s.lpDistributions, t.hurdlePct, date);
  const before = sum(s.lpDistributions.map((d) => d.amount)) + s.carryPaid;
  const due = cumulativeCarry(before + amount, contributed, hurdle, t);
  const carry = round2(Math.min(amount, Math.max(0, due - s.carryPaid)));
  const escrow = round2(carry * ((t.escrowPct ?? 0) / 100));
  const lines = [
    `LPs contributed $${round2(contributed).toLocaleString("en-US")}; with the ${t.hurdlePct}% hurdle they need $${round2(hurdle).toLocaleString("en-US")} before carry.`,
    `Distributed before: $${round2(before).toLocaleString("en-US")}; with this $${round2(amount).toLocaleString("en-US")}, carry due in total $${round2(due).toLocaleString("en-US")}; paid before $${round2(s.carryPaid).toLocaleString("en-US")}.`,
  ];
  if (escrow) lines.push(`${t.escrowPct}% of carry held in escrow: $${escrow.toLocaleString("en-US")}.`);
  return { amount: round2(amount), toLps: round2(amount - carry), carry, escrow, carryPaidNow: round2(carry - escrow), lines };
}

/** Deal by deal: carry on one realized investment's proceeds, against its own cost and hurdle. */
export function splitDealDistribution(proceeds: number, date: string, deal: { cost: Flow[]; priorProceeds: Flow[]; carryPaid: number }, t: FundTerms): DistributionSplit {
  return splitDistribution(proceeds, date, { contributions: deal.cost, lpDistributions: deal.priorProceeds, carryPaid: deal.carryPaid }, t);
}

export interface CarryPosition {
  /** Carry a liquidation at today's NAV would pay in total. */
  entitled: number;
  paid: number;
  /** Entitled but not yet paid (accrued): negative when the GP has been overpaid. */
  accrued: number;
  /** Carry the GP would have to give back if the fund liquidated at NAV (never negative). */
  clawbackExposure: number;
}

/** Whole-fund carry position at NAV: what's earned, paid, accrued, and any clawback exposure. */
export function carryPosition(s: WaterfallState, lpNavBeforeCarry: number, asOf: string, t: FundTerms): CarryPosition {
  const contributed = sum(s.contributions.map((c) => c.amount));
  const hurdle = hurdleTarget(s.contributions, s.lpDistributions, t.hurdlePct, asOf);
  const total = sum(s.lpDistributions.map((d) => d.amount)) + s.carryPaid + Math.max(0, lpNavBeforeCarry);
  const entitled = round2(cumulativeCarry(total, contributed, hurdle, t));
  const accrued = round2(entitled - s.carryPaid);
  return { entitled, paid: round2(s.carryPaid), accrued, clawbackExposure: round2(Math.max(0, -accrued)) };
}

// ---------------------------------------------------------------------------
// Capital accounts
// ---------------------------------------------------------------------------

export interface Partner {
  id: string;
  commitment: number;
  /** The GP's own commitment pays no fees or carry. */
  feePaying: boolean;
}

export interface Movement {
  partnerId: string;
  date: string;
  amount: number;
}

export interface FundBooks {
  partners: Partner[];
  contributions: Movement[];
  /** Cash distributed to partners (after carry). */
  distributions: Movement[];
  /** Management fees charged, net of offsets, by partner. */
  fees: Movement[];
  /** Fund expenses, allocated by partner. */
  expenses: Movement[];
  /** Carry paid to the GP, by date (reduces nothing further: it came out of distributions). */
  carryPaid: { date: string; amount: number }[];
  /** Investment gains to the date: realized (proceeds less cost of exits) and unrealized (fair value less cost of holdings). */
  realizedGain: number;
  unrealizedGain: number;
  /**
   * Subsequent-close interest: paid by investors admitted at a later closing
   * (positive) and received by earlier investors (negative). It passes
   * between partners, so it never changes NAV.
   */
  adjustments?: Movement[];
}

export interface CapitalAccount {
  partnerId: string;
  commitment: number;
  contributed: number;
  unfunded: number;
  distributed: number;
  fees: number;
  expenses: number;
  realizedGain: number;
  unrealizedGain: number;
  /** Accrued (unpaid) carry allocated against this LP. */
  carryAccrued: number;
  /** Carry already taken out of this LP's distributions. */
  carryPaid: number;
  /** Subsequent-close interest paid (positive) or received (negative). */
  closeInterest: number;
  /** Ending balance: this partner's share of NAV. */
  balance: number;
}

/**
 * Every partner's capital account at a date, from inception. Gains and
 * expenses go pro rata by commitment; fees are what each partner was
 * charged; accrued carry is taken from fee-paying LPs pro rata by commitment
 * and credited to the GP's carry account.
 */
export function capitalAccounts(b: FundBooks, asOf: string, t: FundTerms): { accounts: CapitalAccount[]; gpCarry: CarryPosition; nav: number } {
  const upto = <X extends { date: string }>(xs: X[]) => xs.filter((x) => x.date <= asOf);
  const total = sum(b.partners.map((p) => p.commitment));
  const feePayers = b.partners.filter((p) => p.feePaying);
  const feeTotal = sum(feePayers.map((p) => p.commitment));
  const by = (xs: Movement[], id: string) => sum(upto(xs).filter((x) => x.partnerId === id).map((x) => x.amount));
  const share = (p: Partner) => (total > 0 ? p.commitment / total : 0);
  const carryShare = (p: Partner) => (p.feePaying && feeTotal > 0 ? p.commitment / feeTotal : 0);
  const carryPaid = sum(upto(b.carryPaid).map((c) => c.amount));
  const pre = b.partners.map((p) => {
    const contributed = by(b.contributions, p.id);
    const distributed = by(b.distributions, p.id);
    const fees = by(b.fees, p.id);
    const expenses = by(b.expenses, p.id);
    const closeInterest = by(b.adjustments ?? [], p.id);
    const realizedGain = b.realizedGain * share(p);
    const unrealizedGain = b.unrealizedGain * share(p);
    // Carry already paid came out of these LPs' share of the proceeds.
    const paid = carryPaid * carryShare(p);
    return { p, contributed, distributed, fees, expenses, closeInterest, realizedGain, unrealizedGain, paid, before: contributed - distributed - fees - expenses - closeInterest + realizedGain + unrealizedGain - paid };
  });
  const lpRows = pre.filter((r) => r.p.feePaying);
  const gpCarry = carryPosition({
    contributions: upto(b.contributions).filter((c) => feePayers.some((p) => p.id === c.partnerId)).map((c) => ({ date: c.date, amount: c.amount })),
    lpDistributions: upto(b.distributions).filter((d) => feePayers.some((p) => p.id === d.partnerId)).map((d) => ({ date: d.date, amount: d.amount })),
    carryPaid,
  }, sum(lpRows.map((r) => r.before)), asOf, t);
  const accounts = pre.map((r) => {
    const carryAccrued = round2(gpCarry.accrued * carryShare(r.p));
    return {
      // Interest paid at a later closing is on top of the commitment; a refund of excess capital to an earlier investor is callable again.
      partnerId: r.p.id, commitment: r.p.commitment, contributed: round2(r.contributed), unfunded: round2(Math.max(0, r.p.commitment - (r.contributed - r.closeInterest))),
      distributed: round2(r.distributed), fees: round2(r.fees), expenses: round2(r.expenses), realizedGain: round2(r.realizedGain), unrealizedGain: round2(r.unrealizedGain),
      carryAccrued, carryPaid: round2(r.paid), closeInterest: round2(r.closeInterest), balance: round2(r.before - carryAccrued),
    };
  });
  const nav = round2(sum(accounts.map((a) => a.balance)) + gpCarry.accrued);
  return { accounts, gpCarry, nav };
}

// ---------------------------------------------------------------------------
// Subsequent closings
// ---------------------------------------------------------------------------

export interface PriorCall {
  date: string;
  /** Amounts each existing partner paid toward investments and expenses in this call. */
  capital: { partnerId: string; amount: number }[];
  /** The management fee in this call, on the fee-paying commitments at the time. */
  fees: number;
}

export interface EqualizationLine {
  partnerId: string;
  /** Catch-up capital paid (positive, new investors) or refunded (negative, earlier investors). */
  capital: number;
  /** Management fee a new investor owes from the first closing (positive only). */
  fee: number;
  /** Interest paid (positive) or received (negative), on the capital catch-up. */
  interest: number;
  lines: string[];
}

/**
 * Admit investors at a later closing as if they had been in from the start.
 * For each earlier call, the investment and expense capital is re-split by
 * commitment across everyone, so new investors pay in their share and
 * earlier investors get their excess back (callable again). New fee-paying
 * investors owe the management fee on their commitment from the first
 * closing; that goes to the manager, not to other investors. New investors
 * also pay interest on their capital catch-up, at the LPA's rate from each
 * call's date to the closing, to the earlier investors in proportion to
 * their refunds.
 */
export function equalization(
  calls: PriorCall[],
  partners: Partner[],
  newcomers: string[],
  closeDate: string,
  ratePct: number,
): EqualizationLine[] {
  const isNew = new Set(newcomers);
  const out = new Map<string, EqualizationLine>(partners.map((p) => [p.id, { partnerId: p.id, capital: 0, fee: 0, interest: 0, lines: [] }]));
  const oldPayers = partners.filter((p) => p.feePaying && !isNew.has(p.id));
  const oldPayerTotal = sum(oldPayers.map((p) => p.commitment));
  for (const c of calls) {
    const total = sum(c.capital.map((x) => x.amount));
    const target = total > 0 ? allocate(total, partners.map((p) => ({ id: p.id, weight: p.commitment }))) : [];
    const days = Math.max(0, (Date.parse(closeDate) - Date.parse(c.date)) / DAY);
    const refunds: { id: string; amount: number }[] = [];
    let interestIn = 0;
    for (const p of partners) {
      const paid = sum(c.capital.filter((x) => x.partnerId === p.id).map((x) => x.amount));
      const diff = round2((target.find((t) => t.id === p.id)?.amount ?? 0) - paid);
      const line = out.get(p.id)!;
      line.capital = round2(line.capital + diff);
      if (isNew.has(p.id)) {
        const interest = round2(Math.max(0, diff) * (ratePct / 100) * (days / 365));
        line.interest = round2(line.interest + interest);
        interestIn += interest;
        const fee = p.feePaying && oldPayerTotal > 0 ? round2(c.fees * (p.commitment / oldPayerTotal)) : 0;
        line.fee = round2(line.fee + fee);
        if (diff || fee) line.lines.push(`Call of ${c.date}: $${diff.toLocaleString("en-US")} capital${fee ? ` and $${fee.toLocaleString("en-US")} fee` : ""}${interest ? `, $${interest.toLocaleString("en-US")} interest at ${ratePct}% for ${Math.round(days)} days` : ""}`);
      } else if (diff < 0) {
        refunds.push({ id: p.id, amount: -diff });
        line.lines.push(`Call of ${c.date}: $${(-diff).toLocaleString("en-US")} returned`);
      }
    }
    if (interestIn > 0 && refunds.length) {
      for (const a of allocate(interestIn, refunds.map((r) => ({ id: r.id, weight: r.amount })))) {
        const line = out.get(a.id)!;
        line.interest = round2(line.interest - a.amount);
      }
    }
  }
  return [...out.values()].filter((l) => l.capital || l.fee || l.interest);
}

export interface NetReturns {
  paidIn: number;
  distributed: number;
  nav: number;
  dpi: number | null;
  rvpi: number | null;
  tvpi: number | null;
  irr: number | null;
}

/** Net returns from a partner's (or all fee-paying partners') own cash flows and ending balance. */
export function netReturns(contributions: Flow[], distributions: Flow[], nav: number, asOf: string): NetReturns {
  const paidIn = sum(contributions.map((c) => c.amount));
  const distributed = sum(distributions.map((d) => d.amount));
  const r = (x: number) => (paidIn > 0 ? x / paidIn : null);
  return {
    paidIn: round2(paidIn), distributed: round2(distributed), nav: round2(nav),
    dpi: r(distributed), rvpi: r(nav), tvpi: r(distributed + nav),
    irr: xirr([...contributions.map((c) => ({ date: c.date, amount: -c.amount })), ...distributions, ...(nav > 0 ? [{ date: asOf, amount: nav }] : [])]),
  };
}

// ---------------------------------------------------------------------------
// The reporting calendar
// ---------------------------------------------------------------------------

export interface Deadline {
  key: string;
  title: string;
  due: string;
  basis: string;
}

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

/**
 * What's due for a fund year with a December year end: quarterly reports
 * (ILPA: within 45 days of quarter end, the annual one within 90), audited
 * financial statements (the custody rule's audit provision: 120 days),
 * Schedules K-1 (March 15, or September 15 with an extension) and the
 * adviser's annual Form ADV amendment (90 days after fiscal year end).
 */
export function reportingCalendar(year: number): Deadline[] {
  const q = (n: number, end: string, days: number): Deadline => ({ key: `q${n}_${year}`, title: `Q${n} ${year} report to LPs`, due: addDays(end, days), basis: days === 45 ? "ILPA: within 45 days of quarter end" : "ILPA: annual report within 90 days of year end" });
  return [
    q(1, `${year}-03-31`, 45), q(2, `${year}-06-30`, 45), q(3, `${year}-09-30`, 45), q(4, `${year}-12-31`, 90),
    { key: `adv_${year}`, title: `Form ADV annual amendment for ${year}`, due: addDays(`${year}-12-31`, 90), basis: "SEC: within 90 days of fiscal year end (registered and exempt reporting advisers)" },
    { key: `k1_${year}`, title: `Schedules K-1 for ${year}`, due: `${year + 1}-03-15`, basis: "IRS: March 15; September 15 with a Form 7004 extension" },
    { key: `audit_${year}`, title: `Audited financial statements for ${year}`, due: addDays(`${year}-12-31`, 120), basis: "SEC custody rule audit provision: within 120 days of year end (registered advisers; LPAs often require it too)" },
  ];
}
