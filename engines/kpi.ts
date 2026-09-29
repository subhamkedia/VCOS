/**
 * Portfolio company KPIs: monthly series from claims, the derived numbers
 * investors watch (net burn, runway, growth, burn multiple, plan versus
 * actual) and early-warning signals. Deterministic and unit-tested: a model
 * may explain these numbers, never compute them.
 *
 * Definitions:
 * - Net burn for a month: the company's reported net burn if it gave one;
 *   else expenses minus revenue from its income statement; else the fall in
 *   cash from the month before. The basis is reported with the number.
 * - Runway: cash on hand / average net burn of the last three months with
 *   a figure. Zero or negative burn means the company isn't burning cash.
 * - Burn multiple (David Sacks, 2020): net burn / net new ARR over the same
 *   period, here the last three months. Under 1 is excellent, over 3 is bad.
 * - Growth: month over month, and year over year when there's a figure for
 *   the same month a year earlier.
 */

export type Metric =
  | "revenue" | "expenses" | "burn" | "cash" | "arr" | "headcount" | "customers" | "grossMargin" | "nrr"
  | "units" | "uptime" | "debt" | "backlog" | "planRevenue" | "planBurn";

export const METRIC_PREDICATE: Record<Metric, string> = {
  revenue: "revenue.monthly", expenses: "expenses.monthly", burn: "burn.monthly", cash: "cash.balance", arr: "revenue.arr",
  headcount: "team.headcount", customers: "customers.paying.count", grossMargin: "unit_economics.gross_margin", nrr: "customers.nrr",
  units: "fleet.units_deployed", uptime: "fleet.uptime", debt: "debt.balance", backlog: "revenue.contracted_backlog",
  planRevenue: "plan.revenue.monthly", planBurn: "plan.burn.monthly",
};

const PREDICATE_METRIC = new Map(Object.entries(METRIC_PREDICATE).map(([m, p]) => [p, m as Metric]));

/** When two sources give a figure for the same month, the better source wins. */
const SOURCE_RANK: Record<string, number> = { primary: 0, internal: 1, self_reported: 2, third_party: 3, inference: 4 };

export interface KpiClaim {
  id: string;
  predicate: string;
  value: unknown;
  as_of: string | null;
  source_type: string;
}

export interface Point {
  month: string; // YYYY-MM
  value: number;
  claimId: string;
  sourceType: string;
}

export type Series = Partial<Record<Metric, Point[]>>;

/** Claims to one point per metric per month, sorted by month. Claims without a date or a number are skipped. */
export function buildSeries(claims: KpiClaim[]): Series {
  const best = new Map<string, Point>();
  for (const c of claims) {
    const metric = PREDICATE_METRIC.get(c.predicate);
    if (!metric || !c.as_of || typeof c.value !== "number" || !Number.isFinite(c.value)) continue;
    const month = c.as_of.slice(0, 7);
    const key = `${metric}|${month}`;
    const prev = best.get(key);
    const rank = SOURCE_RANK[c.source_type] ?? 5;
    // Claims arrive oldest first: at equal rank, the later one replaces the earlier.
    if (!prev || rank <= (SOURCE_RANK[prev.sourceType] ?? 5)) best.set(key, { month, value: c.value, claimId: c.id, sourceType: c.source_type });
  }
  const out: Series = {};
  for (const [key, p] of best) {
    const metric = key.split("|")[0] as Metric;
    (out[metric] ??= []).push(p);
  }
  for (const m of Object.keys(out) as Metric[]) out[m]!.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}

export const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const monthsBetween = (a: string, b: string): number => {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
};
export const monthEnd = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

const at = (s: Point[] | undefined, month: string) => s?.find((p) => p.month === month);
const last = (s: Point[] | undefined) => (s && s.length ? s[s.length - 1] : undefined);

export interface BurnPoint {
  month: string;
  value: number;
  basis: "reported" | "income statement" | "change in cash";
  claimIds: string[];
}

/** Net burn by month, with the basis for each figure. Positive = cash out. */
export function netBurn(s: Series): BurnPoint[] {
  const months = new Set<string>();
  for (const k of ["burn", "revenue", "expenses", "cash"] as Metric[]) for (const p of s[k] ?? []) months.add(p.month);
  const out: BurnPoint[] = [];
  for (const month of [...months].sort()) {
    const b = at(s.burn, month);
    if (b) { out.push({ month, value: b.value, basis: "reported", claimIds: [b.claimId] }); continue; }
    const r = at(s.revenue, month);
    const e = at(s.expenses, month);
    if (e) { out.push({ month, value: e.value - (r?.value ?? 0), basis: "income statement", claimIds: [e.claimId, ...(r ? [r.claimId] : [])] }); continue; }
    const c = at(s.cash, month);
    const prev = at(s.cash, addMonths(month, -1));
    if (c && prev) out.push({ month, value: prev.value - c.value, basis: "change in cash", claimIds: [prev.claimId, c.claimId] });
  }
  return out;
}

const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / Math.abs(b)) * 100);

export interface Summary {
  latestMonth: string | null;
  monthsSinceUpdate: number | null;
  cash: Point | null;
  avgBurn: number | null;
  burnBasis: BurnPoint["basis"] | null;
  burnClaimIds: string[];
  runwayMonths: number | null; // Infinity when not burning
  zeroCashMonth: string | null;
  revenue: Point | null;
  revenueMoM: number | null;
  revenueYoY: number | null;
  arr: Point | null;
  netNewArr3m: number | null;
  burnMultiple: number | null;
  planRevenueVarPct: number | null;
  planBurnVarPct: number | null;
  headcount: Point | null;
  headcountChangePct: number | null;
  grossMargin: Point | null;
  grossMarginChangePts: number | null;
  nrr: Point | null;
  units: Point | null;
  uptime: Point | null;
}

/** The numbers the portfolio screen shows. `today` is YYYY-MM-DD. */
export function summarize(s: Series, today: string): Summary {
  // Plans are forecasts, not reports: they don't make the data current.
  const all = (Object.entries(s) as [Metric, Point[]][]).filter(([m]) => m !== "planRevenue" && m !== "planBurn").flatMap(([, v]) => v);
  const latestMonth = all.length ? all.map((p) => p.month).sort().pop()! : null;
  const burns = netBurn(s);
  const recent = latestMonth ? burns.filter((b) => monthsBetween(b.month, latestMonth) < 6).slice(-3) : [];
  const avgBurn = recent.length ? recent.reduce((a, b) => a + b.value, 0) / recent.length : null;
  const cash = last(s.cash) ?? null;
  let runwayMonths: number | null = null;
  let zeroCashMonth: string | null = null;
  if (cash && avgBurn !== null) {
    runwayMonths = avgBurn <= 0 ? Infinity : cash.value / avgBurn;
    if (Number.isFinite(runwayMonths)) zeroCashMonth = addMonths(cash.month, Math.floor(runwayMonths));
  }
  const rev = last(s.revenue) ?? null;
  const revPrev = rev ? at(s.revenue, addMonths(rev.month, -1)) : undefined;
  const revYear = rev ? at(s.revenue, addMonths(rev.month, -12)) : undefined;
  const arr = last(s.arr) ?? null;
  const arrBefore = arr ? (s.arr ?? []).filter((p) => monthsBetween(p.month, arr.month) >= 3).pop() : undefined;
  const netNewArr3m = arr && arrBefore && monthsBetween(arrBefore.month, arr.month) <= 4 ? arr.value - arrBefore.value : null;
  const burn3 = arr ? burns.filter((b) => monthsBetween(b.month, arr.month) >= 0 && monthsBetween(b.month, arr.month) < 3) : [];
  const burnMultiple = netNewArr3m !== null && netNewArr3m > 0 && burn3.length
    ? (burn3.reduce((a, b) => a + b.value, 0) * (3 / burn3.length)) / netNewArr3m
    : null;
  const planRev = rev ? at(s.planRevenue, rev.month) : undefined;
  const lastBurn = burns[burns.length - 1];
  const planBurn = lastBurn ? at(s.planBurn, lastBurn.month) : undefined;
  const hc = last(s.headcount) ?? null;
  const hcBefore = hc ? (s.headcount ?? []).filter((p) => monthsBetween(p.month, hc.month) >= 3 && monthsBetween(p.month, hc.month) <= 6).pop() : undefined;
  const gm = last(s.grossMargin) ?? null;
  const gmBefore = gm ? (s.grossMargin ?? []).filter((p) => monthsBetween(p.month, gm.month) >= 5 && monthsBetween(p.month, gm.month) <= 12).pop() : undefined;
  return {
    latestMonth,
    monthsSinceUpdate: latestMonth ? monthsBetween(latestMonth, today.slice(0, 7)) : null,
    cash,
    avgBurn,
    burnBasis: recent.length ? recent[recent.length - 1]!.basis : null,
    burnClaimIds: recent.flatMap((b) => b.claimIds),
    runwayMonths,
    zeroCashMonth,
    revenue: rev,
    revenueMoM: rev && revPrev ? pct(rev.value, revPrev.value) : null,
    revenueYoY: rev && revYear ? pct(rev.value, revYear.value) : null,
    arr,
    netNewArr3m,
    burnMultiple,
    planRevenueVarPct: rev && planRev ? pct(rev.value, planRev.value) : null,
    planBurnVarPct: lastBurn && planBurn ? pct(lastBurn.value, planBurn.value) : null,
    headcount: hc,
    headcountChangePct: hc && hcBefore ? pct(hc.value, hcBefore.value) : null,
    grossMargin: gm,
    grossMarginChangePts: gm && gmBefore ? gm.value - gmBefore.value : null,
    nrr: last(s.nrr) ?? null,
    units: last(s.units) ?? null,
    uptime: last(s.uptime) ?? null,
  };
}

export type Severity = "high" | "medium" | "low";

export interface Signal {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  claimIds: string[];
}

export interface SignalRules {
  /** Months of runway below which the company should be raising now. */
  runwayWatchMonths: number;
  /** Months of runway below which the company is at risk. */
  runwayRiskMonths: number;
  /** Months without any reported figure before the data is stale. */
  staleMonths: number;
  /** Revenue below plan, or burn above plan, by more than this percent. */
  planMissPct: number;
  burnMultipleBad: number;
  headcountDropPct: number;
  nrrFloorPct: number;
  uptimeFloorPct: number;
}

/**
 * Defaults. Runway: Carta's data puts the median gap between a seed and a
 * Series A at about 20 months in 2025, and a raise takes months, so under
 * 12 months a company should be raising and under 6 it's at risk.
 */
export const DEFAULT_RULES: SignalRules = {
  runwayWatchMonths: 12, runwayRiskMonths: 6, staleMonths: 2, planMissPct: 20, burnMultipleBad: 3, headcountDropPct: 15, nrrFloorPct: 90, uptimeFloorPct: 90,
};

const f1 = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toString() : n.toFixed(1));

/** Early warnings, each citing the claims it rests on. */
export function signals(sum: Summary, rules: SignalRules = DEFAULT_RULES): Signal[] {
  const out: Signal[] = [];
  if (sum.runwayMonths !== null && Number.isFinite(sum.runwayMonths) && sum.cash) {
    const ids = [sum.cash.claimId, ...sum.burnClaimIds];
    if (sum.runwayMonths < rules.runwayRiskMonths) {
      out.push({ key: "runway", severity: "high", title: `Runway under ${rules.runwayRiskMonths} months`, detail: `About ${f1(sum.runwayMonths)} months of cash at the recent burn; cash runs out around ${sum.zeroCashMonth}.`, claimIds: ids });
    } else if (sum.runwayMonths < rules.runwayWatchMonths) {
      out.push({ key: "runway", severity: "medium", title: `Runway under ${rules.runwayWatchMonths} months`, detail: `About ${f1(sum.runwayMonths)} months of cash; the next raise should be under way.`, claimIds: ids });
    }
  }
  if (sum.monthsSinceUpdate !== null && sum.monthsSinceUpdate > rules.staleMonths) {
    out.push({ key: "stale", severity: "medium", title: "No recent numbers", detail: `The latest figures are for ${sum.latestMonth}, ${sum.monthsSinceUpdate} months ago.`, claimIds: [] });
  } else if (sum.monthsSinceUpdate === null) {
    out.push({ key: "stale", severity: "low", title: "No numbers yet", detail: "Request the company's KPIs, or ask the founder to connect their accounting system.", claimIds: [] });
  }
  if (sum.planRevenueVarPct !== null && sum.planRevenueVarPct < -rules.planMissPct && sum.revenue) {
    out.push({ key: "plan_revenue", severity: "medium", title: "Revenue behind plan", detail: `${sum.revenue.month} revenue is ${f1(-sum.planRevenueVarPct)}% below plan.`, claimIds: [sum.revenue.claimId] });
  }
  if (sum.planBurnVarPct !== null && sum.planBurnVarPct > rules.planMissPct) {
    out.push({ key: "plan_burn", severity: "medium", title: "Burn above plan", detail: `Net burn is ${f1(sum.planBurnVarPct)}% above plan.`, claimIds: sum.burnClaimIds });
  }
  if (sum.revenueMoM !== null && sum.revenueMoM < -15 && sum.revenue) {
    out.push({ key: "revenue_drop", severity: "medium", title: "Revenue fell", detail: `Revenue fell ${f1(-sum.revenueMoM)}% in ${sum.revenue.month}.`, claimIds: [sum.revenue.claimId] });
  }
  if (sum.burnMultiple !== null && sum.burnMultiple > rules.burnMultipleBad && sum.arr) {
    out.push({ key: "burn_multiple", severity: "medium", title: "Growth is expensive", detail: `Burn multiple ${f1(sum.burnMultiple)}: about $${f1(sum.burnMultiple)} burned per $1 of new ARR over three months.`, claimIds: [sum.arr.claimId, ...sum.burnClaimIds] });
  }
  if (sum.headcountChangePct !== null && sum.headcountChangePct < -rules.headcountDropPct && sum.headcount) {
    out.push({ key: "headcount", severity: "medium", title: "Headcount down", detail: `Headcount fell ${f1(-sum.headcountChangePct)}% in the last few months.`, claimIds: [sum.headcount.claimId] });
  }
  if (sum.nrr && sum.nrr.value < rules.nrrFloorPct) {
    out.push({ key: "nrr", severity: "medium", title: "Customers shrinking", detail: `Net revenue retention is ${f1(sum.nrr.value)}%.`, claimIds: [sum.nrr.claimId] });
  }
  if (sum.grossMarginChangePts !== null && sum.grossMarginChangePts < -10 && sum.grossMargin) {
    out.push({ key: "gross_margin", severity: "low", title: "Gross margin falling", detail: `Down ${f1(-sum.grossMarginChangePts)} points to ${f1(sum.grossMargin.value)}%.`, claimIds: [sum.grossMargin.claimId] });
  }
  if (sum.uptime && sum.uptime.value < rules.uptimeFloorPct) {
    out.push({ key: "uptime", severity: "low", title: "Fleet uptime low", detail: `Deployed units were available ${f1(sum.uptime.value)}% of scheduled hours.`, claimIds: [sum.uptime.claimId] });
  }
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export type Health = "on_track" | "watch" | "at_risk";

/** A suggestion from the signals; a person sets the company's rating. */
export function suggestedHealth(sig: Signal[]): Health {
  if (sig.some((x) => x.severity === "high")) return "at_risk";
  if (sig.some((x) => x.severity === "medium")) return "watch";
  return "on_track";
}
