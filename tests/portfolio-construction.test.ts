import { describe, it, expect } from "vitest";
import { construct, reservesFromRatio } from "../engines/portfolio-construction.js";

describe("portfolio construction", () => {
  const base = {
    sizeUsd: 50_000_000, managementFeePct: 2, investmentPeriodYears: 5, termYears: 10, feeStepDownPct: 1.5,
    fundExpensesPct: 1, recyclingPct: 10, reservesPct: 50, avgInitialCheckUsd: 1_000_000,
  };

  it("turns commitments into first checks and reserves", () => {
    const c = construct(base);
    // Fees: 2% x 50M x 5y + 1.5% x 50M x 5y = 5M + 3.75M
    expect(c.managementFeesUsd).toBe(8_750_000);
    expect(c.feeLoadPct).toBeCloseTo(17.5);
    expect(c.expensesUsd).toBe(500_000);
    expect(c.recycledUsd).toBe(5_000_000);
    expect(c.investableUsd).toBe(45_750_000);
    expect(c.initialCapitalUsd).toBe(22_875_000);
    expect(c.reserveCapitalUsd).toBe(22_875_000);
    expect(c.reserveRatio).toBeCloseTo(1);
    expect(c.impliedInvestments).toBeCloseTo(22.875);
    expect(c.warnings).toEqual([]);
  });

  it("charges the step-down on invested capital when asked", () => {
    const c = construct({ ...base, feeBasisAfterPeriod: "invested" });
    // After the period: 1.5% x (50M - 5M - 0.5M) x 5y = 3.3375M
    expect(c.managementFeesUsd).toBe(8_337_500);
  });

  it("works with only a fund size", () => {
    const c = construct({ sizeUsd: 20_000_000 });
    expect(c).toMatchObject({ investableUsd: 20_000_000, initialCapitalUsd: 20_000_000, reserveCapitalUsd: 0, reserveRatio: 0, impliedInvestments: null });
  });

  it("flags plans that don't add up", () => {
    const c = construct({ ...base, targetInvestments: 40, checkRangeUsd: { min: 1_500_000, max: 3_000_000 }, maxConcentrationPct: 1 });
    expect(c.impliedAvgInitialCheckUsd).toBe(571_875);
    expect(c.avgReservePerCompanyUsd).toBe(571_875);
    expect(c.warnings.join(" ")).toMatch(/40 checks of \$1.0M need \$40.0M/);
    expect(c.warnings.join(" ")).toMatch(/outside your check range/);
    expect(c.warnings.join(" ")).toMatch(/above your 1% limit/);
    expect(construct({ ...base, termYears: 3 }).warnings.join(" ")).toMatch(/shorter than the investment period/);
    expect(construct({ ...base, managementFeePct: 3, feeStepDownPct: 3 }).warnings.join(" ")).toMatch(/Fees take 30%/);
  });

  it("converts a new-to-reserve ratio to a reserves share", () => {
    expect(reservesFromRatio(1)).toBe(50);
    expect(reservesFromRatio(1.5)).toBeCloseTo(60);
    expect(reservesFromRatio(0)).toBe(0);
  });
});
