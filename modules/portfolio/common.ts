import type { Db } from "../../lib/db.js";
import { currentClaims, getEntity } from "../../ledger/repository.js";
import type { ClaimRow } from "../../ledger/contradictions.js";
import { listInvestments, type InvestmentRow } from "../../ledger/execution.js";
import { METRIC_PREDICATE } from "../../engines/kpi.js";

export class PortfolioInvalid extends Error {}

export const KPI_PREDICATES = [...Object.values(METRIC_PREDICATE), "runway.months"];

export interface Holding {
  companyId: string;
  name: string;
  dealId: string;
  investments: InvestmentRow[];
}

/** Companies the firm holds, from its investment records. */
export async function holdings(db: Db): Promise<Holding[]> {
  const by = new Map<string, Holding>();
  for (const i of (await listInvestments(db)).reverse()) {
    const h = by.get(i.company_id) ?? { companyId: i.company_id, name: i.company_name ?? "Company", dealId: i.deal_id, investments: [] };
    h.investments.push(i);
    by.set(i.company_id, h);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A portfolio company, or an error if the firm doesn't hold it. */
export async function holding(db: Db, companyId: string): Promise<Holding> {
  const inv = (await listInvestments(db, { companyId })).reverse();
  if (!inv.length) {
    if (!(await getEntity(db, companyId))) throw new PortfolioInvalid("No such company.");
    throw new PortfolioInvalid("No such portfolio company: record the investment in Investment Execution first.");
  }
  return { companyId, name: inv[0]!.company_name ?? "Company", dealId: inv[0]!.deal_id, investments: inv };
}

export async function kpiClaims(db: Db, companyId: string): Promise<ClaimRow[]> {
  return currentClaims(db, companyId, { predicates: KPI_PREDICATES });
}

export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const today = () => new Date().toISOString().slice(0, 10);
