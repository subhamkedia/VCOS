/**
 * Portfolio performance, gross, on the capital invested in companies:
 * multiple on invested capital (MOIC), realized and unrealized value, DPI,
 * RVPI and TVPI on invested capital, and gross IRR from dated cash flows.
 * Net returns to LPs (after fees, expenses and carry, on paid-in capital)
 * belong to LP Reporting. Definitions follow ILPA and GIPS: TVPI = DPI +
 * RVPI, all at one measurement date.
 *
 * Deterministic and unit-tested. A model may explain these numbers, never
 * compute them.
 */

export interface Flow {
  date: string; // YYYY-MM-DD
  amount: number; // negative = invested, positive = returned
}

const DAY = 86_400_000;
const years = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY / 365;

/** Net present value of dated flows at an annual rate. */
export function npv(rate: number, flows: Flow[]): number {
  const t0 = flows[0]!.date;
  return flows.reduce((a, f) => a + f.amount / Math.pow(1 + rate, years(t0, f.date)), 0);
}

/**
 * Annualized internal rate of return of irregular dated flows (Excel's
 * XIRR convention: actual days / 365). Null when there's no sign change
 * or no root between -100% and 10,000%.
 */
export function xirr(flowsIn: Flow[]): number | null {
  const flows = [...flowsIn].filter((f) => f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (flows.length < 2 || !flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  let lo = -0.99999999;
  let hi = 100;
  let fLo = npv(lo, flows);
  const fHi = npv(hi, flows);
  if (fLo * fHi > 0) return null;
  // Bisection: slow but never diverges; 200 halvings is far below a basis point.
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, flows);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) hi = mid;
    else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

export interface Position {
  company: string;
  /** Each check, dated; positive amounts. */
  invested: { date: string; amount: number }[];
  /** Each distribution or sale proceeds, dated; positive amounts. */
  realized: { date: string; amount: number }[];
  /** Fair value of what's still held, at `asOf`. */
  fairValue: number;
}

export interface PositionResult {
  company: string;
  invested: number;
  realized: number;
  fairValue: number;
  totalValue: number;
  moic: number | null;
  irr: number | null;
  shareOfValuePct: number;
}

export interface PortfolioResult {
  asOf: string;
  invested: number;
  realized: number;
  unrealized: number;
  totalValue: number;
  /** Gross, on invested capital. */
  moic: number | null;
  dpi: number | null;
  rvpi: number | null;
  tvpi: number | null;
  irr: number | null;
  /** Share of invested capital in positions now worth less than cost. */
  lossRatioPct: number | null;
  /** The largest position's share of total value. */
  topPositionPct: number | null;
  positions: PositionResult[];
  basis: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function flowsOf(p: Position, asOf: string): Flow[] {
  return [
    ...p.invested.map((x) => ({ date: x.date, amount: -x.amount })),
    ...p.realized.map((x) => ({ date: x.date, amount: x.amount })),
    ...(p.fairValue > 0 ? [{ date: asOf, amount: p.fairValue }] : []),
  ];
}

export function portfolioMetrics(positions: Position[], asOf: string): PortfolioResult {
  const invested = sum(positions.flatMap((p) => p.invested.map((x) => x.amount)));
  const realized = sum(positions.flatMap((p) => p.realized.map((x) => x.amount)));
  const unrealized = sum(positions.map((p) => p.fairValue));
  const totalValue = realized + unrealized;
  const rows: PositionResult[] = positions.map((p) => {
    const inv = sum(p.invested.map((x) => x.amount));
    const rel = sum(p.realized.map((x) => x.amount));
    const tv = rel + p.fairValue;
    return {
      company: p.company, invested: inv, realized: rel, fairValue: p.fairValue, totalValue: tv,
      moic: ratio(tv, inv), irr: xirr(flowsOf(p, asOf)), shareOfValuePct: totalValue > 0 ? (tv / totalValue) * 100 : 0,
    };
  }).sort((a, b) => b.totalValue - a.totalValue);
  const losers = sum(rows.filter((r) => r.moic !== null && r.moic < 1).map((r) => r.invested));
  return {
    asOf, invested, realized, unrealized, totalValue,
    moic: ratio(totalValue, invested),
    dpi: ratio(realized, invested),
    rvpi: ratio(unrealized, invested),
    tvpi: ratio(totalValue, invested),
    irr: xirr(positions.flatMap((p) => flowsOf(p, asOf))),
    lossRatioPct: invested > 0 ? (losers / invested) * 100 : null,
    topPositionPct: rows.length && totalValue > 0 ? rows[0]!.shareOfValuePct : null,
    positions: rows,
    basis: "Gross, on capital invested in companies, before fees, expenses and carry. Unrealized value is the latest approved mark, or cost where there's none.",
  };
}

export interface ReserveInput {
  /** Fund size (committed capital). */
  fundSizeUsd: number;
  /** Share of the fund held for follow-ons, percent. */
  reservesPct: number;
  /** Follow-on checks already made, by company. */
  followOns: { company: string; amount: number }[];
  /** Planned follow-on reserves, by company (the latest plan for each). */
  planned: { company: string; amount: number }[];
}

export interface ReserveResult {
  budget: number;
  deployed: number;
  /** Planned but not yet deployed, by company (never negative). */
  byCompany: { company: string; planned: number; deployed: number; remaining: number }[];
  committedRemaining: number;
  unallocated: number;
  overAllocated: boolean;
}

/**
 * The reserve pool: budget = fund size x reserves %. What's deployed in
 * follow-ons and what's still planned for each company come out of it;
 * the rest is unallocated. Re-underwrite each follow-on: a planned
 * reserve is an option, not an obligation.
 */
export function reserves(r: ReserveInput): ReserveResult {
  const budget = r.fundSizeUsd * (r.reservesPct / 100);
  const companies = [...new Set([...r.followOns.map((x) => x.company), ...r.planned.map((x) => x.company)])];
  const byCompany = companies.map((company) => {
    const planned = sum(r.planned.filter((x) => x.company === company).map((x) => x.amount));
    const deployed = sum(r.followOns.filter((x) => x.company === company).map((x) => x.amount));
    return { company, planned, deployed, remaining: Math.max(0, planned - deployed) };
  }).sort((a, b) => b.remaining - a.remaining);
  const deployed = sum(byCompany.map((x) => x.deployed));
  const committedRemaining = sum(byCompany.map((x) => x.remaining));
  const unallocated = budget - deployed - committedRemaining;
  return { budget, deployed, byCompany, committedRemaining, unallocated, overAllocated: unallocated < 0 };
}
