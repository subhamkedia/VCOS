import type { Db } from "../../lib/db.js";
import { getFund, type FundRow } from "../../ledger/lp.js";
import { LP_LABELS } from "../../ledger/labels.js";
import type { FundTerms } from "../../engines/fund-accounting.js";

export class LpInvalid extends Error {}

export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const today = () => new Date().toISOString().slice(0, 10);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const usd = (n: number) => `$${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export const PARTNER_KINDS = Object.keys(LP_LABELS.partnerKinds);
export const EXPENSE_CATEGORIES = Object.keys(LP_LABELS.expenseCategories);

/** What a fund stores: the LPA's economics (FundTerms) plus the GP's commitment. */
export interface StoredTerms extends FundTerms {
  gpCommitmentPct?: number;
}

export function termsOf(f: FundRow): StoredTerms {
  const t = f.terms as Partial<StoredTerms>;
  return {
    managementFeePct: Number(t.managementFeePct ?? 2),
    feeStepDownPct: t.feeStepDownPct === undefined || t.feeStepDownPct === null ? undefined : Number(t.feeStepDownPct),
    feeBasisAfterPeriod: t.feeBasisAfterPeriod === "invested" ? "invested" : "committed",
    investmentPeriodEnd: String(t.investmentPeriodEnd ?? f.inception),
    carryPct: Number(t.carryPct ?? 20),
    hurdlePct: Number(t.hurdlePct ?? 0),
    catchUpPct: Number(t.catchUpPct ?? 100),
    waterfall: t.waterfall === "american" ? "american" : "european",
    escrowPct: t.escrowPct === undefined || t.escrowPct === null ? undefined : Number(t.escrowPct),
    gpCommitmentPct: t.gpCommitmentPct === undefined || t.gpCommitmentPct === null ? undefined : Number(t.gpCommitmentPct),
  };
}

export async function fundOr404(db: Db, id: string): Promise<FundRow> {
  const f = await getFund(db, id);
  if (!f) throw new LpInvalid("No such fund.");
  return f;
}

/** The calendar quarter a date falls in, and its first and last days. */
export function quarterOf(d: string): { period: string; start: string; end: string; yearStart: string } {
  const y = Number(d.slice(0, 4));
  const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
  const start = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
  const endMonth = q * 3;
  const end = new Date(Date.UTC(y, endMonth, 0)).toISOString().slice(0, 10);
  return { period: `${y}-Q${q}`, start, end, yearStart: `${y}-01-01` };
}

export function periodBounds(period: string): { start: string; end: string; yearStart: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) throw new LpInvalid("Pick a quarter, like 2026-Q3.");
  return quarterOf(`${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}-15`);
}

export const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** Business days between two dates (weekends excluded), for notice periods. */
export function businessDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let t = Date.parse(from) + 86_400_000; t <= Date.parse(to); t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
