/**
 * Portfolio monitoring tools, founders' spreadsheets and email updates name
 * the same metric many ways ("MRR", "Monthly revenue", "Revenue"). This maps
 * a metric's name to a predicate, so every source lands on the same claim.
 * Unknown names map to nothing and are kept only as evidence.
 */

const RULES: [RegExp, string][] = [
  [/^(plan(ned)? revenue|budget(ed)? revenue|revenue (plan|budget))$/, "plan.revenue.monthly"],
  [/^(plan(ned)? (net )?burn|budget(ed)? (net )?burn|burn (plan|budget))$/, "plan.burn.monthly"],
  [/^(annual recurring revenue|arr|annualized run[- ]?rate|run[- ]?rate revenue)$/, "revenue.arr"],
  [/^(mrr|monthly recurring revenue|monthly revenue|revenue|total revenue|net revenue|sales|income|total income)$/, "revenue.monthly"],
  [/^(total expenses|expenses|opex|operating expenses|total operating expenses|total costs?)$/, "expenses.monthly"],
  [/^(net burn|burn|burn rate|monthly burn|cash burn|net cash burn)$/, "burn.monthly"],
  [/^(cash|cash balance|cash on hand|cash in bank|bank balance|ending cash|total bank)$/, "cash.balance"],
  [/^(runway|runway months|months of runway|cash runway)$/, "runway.months"],
  [/^(headcount|employees|ftes?|full[- ]time employees|team size|total headcount)$/, "team.headcount"],
  [/^(customers|paying customers|customer count|# customers|number of customers|active customers)$/, "customers.paying.count"],
  [/^(gross margin|gross margin %|gm|gm %)$/, "unit_economics.gross_margin"],
  [/^(nrr|ndr|net revenue retention|net dollar retention)$/, "customers.nrr"],
  [/^(units deployed|robots deployed|deployed units|fleet size|installed base|units in field)$/, "fleet.units_deployed"],
  [/^(uptime|fleet uptime|availability)$/, "fleet.uptime"],
  [/^(debt|debt outstanding|venture debt|loans)$/, "debt.balance"],
  [/^(backlog|contracted backlog|signed backlog|rpo|remaining performance obligations)$/, "revenue.contracted_backlog"],
];

export function predicateForMetric(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\((usd|\$|%|#)\)$/, "");
  for (const [re, predicate] of RULES) if (re.test(n)) return predicate;
  return null;
}

/** The predicates a founder is asked for by default in a KPI request. */
export const DEFAULT_REQUEST_METRICS = [
  "revenue.monthly", "expenses.monthly", "cash.balance", "burn.monthly", "team.headcount", "customers.paying.count", "revenue.arr",
] as const;

/** Every predicate a founder can report in the portal. */
export const REPORTABLE_METRICS = [
  "revenue.monthly", "expenses.monthly", "burn.monthly", "cash.balance", "revenue.arr", "team.headcount", "customers.paying.count",
  "unit_economics.gross_margin", "customers.nrr", "fleet.units_deployed", "fleet.uptime", "revenue.contracted_backlog", "debt.balance",
  "plan.revenue.monthly", "plan.burn.monthly",
] as const;
