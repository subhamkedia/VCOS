import { describe, it, expect } from "vitest";
import { holdingValue, type ValueInputs } from "../modules/portfolio/value.js";
import type { InvestmentRow } from "../ledger/execution.js";
import type { RealizationRow, ValuationRow } from "../ledger/portfolio.js";

// The dated value Portfolio and LP Reporting share. Pure: no database.

const inputs: ValueInputs = { exits: [], receivables: [], publicHoldings: [], prices: new Map() };
const inv = (close_date: string, amount_usd: number, shares: number | null) => ({ close_date, amount_usd, shares, fund_name: "Fund I" }) as InvestmentRow;
const mark = (as_of: string, fair_value_usd: number) => ({ as_of, fair_value_usd, status: "approved", method: "milestone" }) as ValuationRow;
const sale = (occurred_on: string, shares: number, amount_usd: number) => ({ kind: "secondary", occurred_on, shares, amount_usd, detail: null, exit_id: null, receivable_id: null }) as unknown as RealizationRow;

describe("holding value", () => {
  it("holds a check written after the mark at cost, beside the marked shares", () => {
    const h = { companyId: "c", investments: [inv("2025-02-15", 3e6, null), inv("2026-07-20", 1e6, null)] };
    expect(holdingValue(h, mark("2026-06-30", 4.5e6), [], inputs, "2026-07-01").value).toBe(4.5e6);
    expect(holdingValue(h, mark("2026-06-30", 4.5e6), [], inputs, "2026-07-31")).toMatchObject({ value: 5.5e6, basis: "mark" });
    // Once a later mark covers both checks, it is the whole value.
    expect(holdingValue(h, [mark("2026-06-30", 4.5e6), mark("2026-09-30", 7e6)], [], inputs, "2026-10-01").value).toBe(7e6);
  });

  it("takes sales out of the marked shares first, then the newer ones", () => {
    const h = { companyId: "c", investments: [inv("2025-02-15", 3e6, 1_000_000), inv("2026-07-20", 1e6, 200_000)] };
    const m = mark("2026-06-30", 4.5e6);
    // 500k of the 1m marked shares sold: half the mark, plus the new check at cost.
    expect(holdingValue(h, m, [sale("2026-08-01", 500_000, 2.4e6)], inputs, "2026-08-31").privateUsd).toBe(3.25e6);
    // 1.1m sold: all the marked shares and half the newer ones.
    expect(holdingValue(h, m, [sale("2026-08-01", 1_100_000, 5e6)], inputs, "2026-08-31").privateUsd).toBe(0.5e6);
  });
});
