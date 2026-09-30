import type { Db } from "../../lib/db.js";
import { callItems, calls, distributionItems, distributions, expenses, funds, partners, type FundRow, type PartnerRow } from "../../ledger/lp.js";
import { listInvestments, type InvestmentRow } from "../../ledger/execution.js";
import { realizations, valuations, type RealizationRow, type ValuationRow } from "../../ledger/portfolio.js";
import { equalizationFor } from "../../ledger/fundraising.js";
import { allocate, capitalAccounts, netReturns, type CapitalAccount, type FundBooks, type Movement } from "../../engines/fund-accounting.js";
import { portfolioMetrics, type Flow, type Position } from "../../engines/fund-metrics.js";
import { METHOD_LABELS } from "../../engines/valuation.js";
import { dayBefore, round2, sum, termsOf } from "./common.js";

/**
 * A fund's books, read from the ledger: contributions from approved capital
 * calls (on their due dates), distributions once paid, management fees as
 * called, fund expenses shared by commitment, and investment gains from
 * Portfolio's records (cost from Investment Execution, approved marks,
 * realizations). Everything is dated, so the same books give the account
 * at any date: that's how a statement shows the quarter, the year and
 * inception to date.
 */

export interface Holdings {
  companyId: string;
  name: string;
  investments: InvestmentRow[];
  realizations: RealizationRow[];
  marks: ValuationRow[];
}

export interface Ledger {
  fund: FundRow;
  partners: PartnerRow[];
  contributions: Movement[];
  fees: Movement[];
  expenses: Movement[];
  /** Expense rows as recorded, for the fees and expenses schedule. */
  expenseRows: Awaited<ReturnType<typeof expenses>>;
  distributions: Movement[];
  carryPaid: { date: string; amount: number; escrow: number }[];
  /** Subsequent-close interest: paid (positive) or received (negative). */
  adjustments: Movement[];
  holdings: Holdings[];
}

/** The fund's investments: those recorded against its name, or all of them when the firm has one fund. */
async function fundHoldings(db: Db, fund: FundRow): Promise<Holdings[]> {
  const single = (await funds(db)).length === 1;
  const norm = (s: string) => s.trim().toLowerCase();
  const inv = (await listInvestments(db)).filter((i) => single || norm(i.fund_name) === norm(fund.name));
  const real = await realizations(db);
  const marks = await valuations(db, { status: "approved" });
  const by = new Map<string, Holdings>();
  for (const i of [...inv].sort((a, b) => a.close_date.localeCompare(b.close_date))) {
    const h = by.get(i.company_id) ?? {
      companyId: i.company_id, name: i.company_name ?? "Company", investments: [],
      realizations: real.filter((r) => r.company_id === i.company_id),
      marks: marks.filter((m) => m.company_id === i.company_id),
    };
    h.investments.push(i);
    by.set(i.company_id, h);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readLedger(db: Db, fund: FundRow): Promise<Ledger> {
  const ps = await partners(db, fund.id);
  const approved = new Map((await calls(db, fund.id)).filter((c) => c.status === "approved").map((c) => [c.id, c]));
  const items = (await callItems(db, { fundId: fund.id })).filter((i) => approved.has(i.call_id));
  const contributions = items.map((i) => ({ partnerId: i.partner_id, date: approved.get(i.call_id)!.due_date, amount: i.amount_usd }));
  const fees = items.filter((i) => i.fee_usd).map((i) => ({ partnerId: i.partner_id, date: approved.get(i.call_id)!.due_date, amount: i.fee_usd }));
  const paid = new Map((await distributions(db, fund.id)).filter((d) => d.status === "paid").map((d) => [d.id, d]));
  const dItems = (await distributionItems(db, { fundId: fund.id })).filter((i) => paid.has(i.distribution_id));
  const dists = dItems.map((i) => ({ partnerId: i.partner_id, date: paid.get(i.distribution_id)!.paid_on, amount: i.net_usd }));
  const carryPaid = [...paid.values()].filter((d) => d.carry_usd > 0).map((d) => ({ date: d.paid_on, amount: d.carry_usd, escrow: d.escrow_usd }));
  // Subsequent closings: catch-up capital (refunds are negative), the newcomers' fee from the first closing, and interest between partners.
  const adjustments: Movement[] = [];
  for (const e of await equalizationFor(db, fund.id)) {
    const cash = e.capital_usd + e.fee_usd + e.interest_usd;
    if (cash) contributions.push({ partnerId: e.partner_id, date: e.closing_date, amount: cash });
    if (e.fee_usd) fees.push({ partnerId: e.partner_id, date: e.closing_date, amount: e.fee_usd });
    if (e.interest_usd) adjustments.push({ partnerId: e.partner_id, date: e.closing_date, amount: e.interest_usd });
  }
  const expenseRows = await expenses(db, fund.id);
  const expenseMoves: Movement[] = [];
  if (ps.length) {
    for (const e of expenseRows.filter((x) => !x.fee_offset)) {
      const sign = e.amount_usd < 0 ? -1 : 1;
      for (const a of allocate(Math.abs(e.amount_usd), ps.map((p) => ({ id: p.id, weight: p.commitment_usd })))) {
        expenseMoves.push({ partnerId: a.id, date: e.incurred_on, amount: sign * a.amount });
      }
    }
  }
  return { fund, partners: ps, contributions, fees, expenses: expenseMoves, expenseRows, distributions: dists, carryPaid, adjustments, holdings: await fundHoldings(db, fund) };
}

// ---------------------------------------------------------------------------
// Investments at a date
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  companyId: string;
  company: string;
  firstInvested: string;
  cost: number;
  realized: number;
  fairValue: number;
  totalValue: number;
  moic: number | null;
  status: "held" | "exited";
  basis: string;
  markDate: string | null;
}

/** Each investment at a date: cost, proceeds, and fair value (the latest approved mark on or before it, else cost; nothing after an exit). */
export function scheduleAt(holdings: Holdings[], asOf: string): ScheduleRow[] {
  return holdings.flatMap((h) => {
    const inv = h.investments.filter((i) => i.close_date <= asOf);
    if (!inv.length) return [];
    const real = h.realizations.filter((r) => r.occurred_on <= asOf);
    const cost = sum(inv.map((i) => i.amount_usd));
    const realized = sum(real.filter((r) => r.amount_usd > 0).map((r) => r.amount_usd));
    const exit = real.filter((r) => r.kind === "sale" || r.kind === "write_off").map((r) => r.occurred_on).sort().pop();
    const mark = h.marks.filter((m) => m.as_of <= asOf).sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
    let fairValue = cost;
    let basis = "Cost (no approved mark yet)";
    let markDate: string | null = null;
    if (mark && (!exit || mark.as_of > exit)) {
      fairValue = mark.fair_value_usd;
      basis = METHOD_LABELS[mark.method as keyof typeof METHOD_LABELS] ?? mark.method;
      markDate = mark.as_of;
    } else if (exit) {
      fairValue = 0;
      basis = "Exited";
    }
    const totalValue = realized + fairValue;
    return [{
      companyId: h.companyId, company: h.name, firstInvested: inv[0]!.close_date, cost: round2(cost), realized: round2(realized), fairValue: round2(fairValue),
      totalValue: round2(totalValue), moic: cost > 0 ? totalValue / cost : null, status: exit && fairValue === 0 ? "exited" : "held", basis, markDate,
    }];
  });
}

/** Realized gain (exits: proceeds less cost; held: proceeds so far) and unrealized gain (fair value less cost of what's held). */
export function gainsAt(holdings: Holdings[], asOf: string): { realized: number; unrealized: number; investedCostHeld: number } {
  let realized = 0;
  let unrealized = 0;
  let investedCostHeld = 0;
  for (const r of scheduleAt(holdings, asOf)) {
    if (r.status === "exited") realized += r.realized - r.cost;
    else {
      realized += r.realized;
      unrealized += r.fairValue - r.cost;
      investedCostHeld += r.cost;
    }
  }
  return { realized: round2(realized), unrealized: round2(unrealized), investedCostHeld: round2(investedCostHeld) };
}

export function booksAt(l: Ledger, asOf: string): FundBooks {
  const g = gainsAt(l.holdings, asOf);
  return {
    partners: l.partners.map((p) => ({ id: p.id, commitment: p.commitment_usd, feePaying: p.fee_paying })),
    contributions: l.contributions, distributions: l.distributions, fees: l.fees, expenses: l.expenses,
    carryPaid: l.carryPaid.map((c) => ({ date: c.date, amount: c.amount })),
    realizedGain: g.realized, unrealizedGain: g.unrealized, adjustments: l.adjustments,
  };
}

export function accountsAt(l: Ledger, asOf: string) {
  return capitalAccounts(booksAt(l, asOf), asOf, termsOf(l.fund));
}

// ---------------------------------------------------------------------------
// Statements: the quarter, the year and inception to date
// ---------------------------------------------------------------------------

export interface StatementColumn {
  beginning: number;
  contributions: number;
  distributions: number;
  managementFees: number;
  expenses: number;
  /** Subsequent-close interest paid (positive) or received (negative). */
  closeInterest: number;
  realizedGain: number;
  unrealizedGain: number;
  carriedInterest: number;
  ending: number;
}

export interface Statement {
  partnerId: string;
  name: string;
  kind: string;
  feePaying: boolean;
  commitment: number;
  contributedToDate: number;
  unfunded: number;
  distributedToDate: number;
  carryAccrued: number;
  quarter: StatementColumn;
  year: StatementColumn;
  inception: StatementColumn;
}

const ZERO: CapitalAccount = {
  partnerId: "", commitment: 0, contributed: 0, unfunded: 0, distributed: 0, fees: 0, expenses: 0, realizedGain: 0, unrealizedGain: 0, carryAccrued: 0, carryPaid: 0, closeInterest: 0, balance: 0,
};

function column(start: CapitalAccount, end: CapitalAccount): StatementColumn {
  const d = (k: keyof CapitalAccount) => round2((end[k] as number) - (start[k] as number));
  return {
    beginning: start.balance, contributions: d("contributed"), distributions: d("distributed"), managementFees: d("fees"), expenses: d("expenses"), closeInterest: d("closeInterest"),
    realizedGain: d("realizedGain"), unrealizedGain: d("unrealizedGain"),
    carriedInterest: round2(end.carryPaid + end.carryAccrued - start.carryPaid - start.carryAccrued), ending: end.balance,
  };
}

/** Every partner's capital account statement for the quarter ending `asOf`, in the ILPA template's order. */
export function statements(l: Ledger, asOf: string, periodStart: string, yearStart: string): { statements: Statement[]; total: Omit<Statement, "partnerId" | "name" | "kind" | "feePaying">; gpCarry: ReturnType<typeof accountsAt>["gpCarry"]; nav: number } {
  const end = accountsAt(l, asOf);
  const q = accountsAt(l, dayBefore(periodStart));
  const y = accountsAt(l, dayBefore(yearStart));
  const find = (xs: CapitalAccount[], id: string) => xs.find((a) => a.partnerId === id) ?? { ...ZERO, partnerId: id };
  const rows: Statement[] = l.partners.map((p) => {
    const e = find(end.accounts, p.id);
    return {
      partnerId: p.id, name: p.name, kind: p.kind, feePaying: p.fee_paying, commitment: p.commitment_usd,
      contributedToDate: e.contributed, unfunded: e.unfunded, distributedToDate: e.distributed, carryAccrued: e.carryAccrued,
      quarter: column(find(q.accounts, p.id), e), year: column(find(y.accounts, p.id), e), inception: column({ ...ZERO, partnerId: p.id }, e),
    };
  });
  const add = (k: "quarter" | "year" | "inception"): StatementColumn => {
    const keys = Object.keys(rows[0]?.[k] ?? column(ZERO, ZERO)) as (keyof StatementColumn)[];
    return Object.fromEntries(keys.map((x) => [x, round2(sum(rows.map((r) => r[k][x])))])) as unknown as StatementColumn;
  };
  return {
    statements: rows,
    total: {
      commitment: round2(sum(rows.map((r) => r.commitment))), contributedToDate: round2(sum(rows.map((r) => r.contributedToDate))),
      unfunded: round2(sum(rows.map((r) => r.unfunded))), distributedToDate: round2(sum(rows.map((r) => r.distributedToDate))),
      carryAccrued: round2(sum(rows.map((r) => r.carryAccrued))), quarter: add("quarter"), year: add("year"), inception: add("inception"),
    },
    gpCarry: end.gpCarry,
    nav: end.nav,
  };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

const flows = (xs: Movement[], ids: Set<string>, asOf: string): Flow[] =>
  xs.filter((x) => ids.has(x.partnerId) && x.date <= asOf).map((x) => ({ date: x.date, amount: x.amount }));

/**
 * Net returns to the fee-paying LPs (after fees, expenses and carry, from
 * their own cash flows and ending balances) beside gross returns on the
 * portfolio. The SEC's Marketing Rule wants net shown with equal prominence
 * wherever gross is shown; the ILPA Performance Template asks for both.
 */
export function performance(l: Ledger, asOf: string) {
  const acc = accountsAt(l, asOf);
  const payers = new Set(l.partners.filter((p) => p.fee_paying).map((p) => p.id));
  const navLp = sum(acc.accounts.filter((a) => payers.has(a.partnerId)).map((a) => a.balance));
  const net = netReturns(flows(l.contributions, payers, asOf), flows(l.distributions, payers, asOf), navLp, asOf);
  const schedule = scheduleAt(l.holdings, asOf);
  const positions: Position[] = l.holdings.map((h) => {
    const row = schedule.find((s) => s.companyId === h.companyId);
    return {
      company: h.name,
      invested: h.investments.filter((i) => i.close_date <= asOf).map((i) => ({ date: i.close_date, amount: i.amount_usd })),
      realized: h.realizations.filter((r) => r.occurred_on <= asOf && r.amount_usd > 0).map((r) => ({ date: r.occurred_on, amount: r.amount_usd })),
      fairValue: row?.fairValue ?? 0,
    };
  }).filter((p) => p.invested.length);
  const gross = portfolioMetrics(positions, asOf);
  const byPartner = l.partners.map((p) => {
    const one = new Set([p.id]);
    const a = acc.accounts.find((x) => x.partnerId === p.id);
    return { partnerId: p.id, ...netReturns(flows(l.contributions, one, asOf), flows(l.distributions, one, asOf), a?.balance ?? 0, asOf) };
  });
  // The ILPA performance template's cash flow table: every LP contribution and distribution, dated, and NAV at the end.
  const cashFlows = [
    ...aggregate(flows(l.contributions, payers, asOf)).map((f) => ({ date: f.date, type: "contribution" as const, amount: -f.amount })),
    ...aggregate(flows(l.distributions, payers, asOf)).map((f) => ({ date: f.date, type: "distribution" as const, amount: f.amount })),
    ...(navLp > 0 ? [{ date: asOf, type: "nav" as const, amount: round2(navLp) }] : []),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  return {
    asOf,
    net: { ...net, basis: "Net to fee-paying limited partners: after management fees, fund expenses and carried interest (paid and accrued), from their contributions, distributions and ending capital account balances." },
    gross: {
      invested: gross.invested, realized: gross.realized, unrealized: gross.unrealized, moic: gross.moic, irr: gross.irr, tvpi: gross.tvpi, dpi: gross.dpi,
      basis: gross.basis,
    },
    marketingNote: "Gross returns are before management fees, fund expenses and carried interest, which reduce returns to investors. Net returns are shown alongside them with equal prominence.",
    byPartner,
    cashFlows,
    gpCarry: acc.gpCarry,
    nav: acc.nav,
  };
}

function aggregate(xs: Flow[]): Flow[] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x.date, (m.get(x.date) ?? 0) + x.amount);
  return [...m.entries()].map(([date, amount]) => ({ date, amount: round2(amount) }));
}
