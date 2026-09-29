import { describe, it, expect } from "vitest";
import { roundMath } from "../engines/round-math.js";

describe("round math", () => {
  it("computes post-money, entry ownership and exposure", () => {
    const r = roundMath(
      { raiseUsd: 12e6, preMoneyUsd: 48e6, ourCheckUsd: 3e6 },
      { checkMinUsd: 1e6, checkMaxUsd: 4e6, ownershipMinPct: 8, ownershipMaxPct: 15, fundSizeUsd: 100e6, maxConcentrationPct: 10, reservePerCompanyUsd: 3e6 },
    );
    expect(r.postMoneyUsd).toBe(60e6);
    expect(r.ownershipPct).toBeCloseTo(5, 10);
    expect(r.shareOfRoundPct).toBeCloseTo(25, 10);
    expect(r.totalExposureUsd).toBe(6e6);
    expect(r.exposurePctOfFund).toBeCloseTo(6, 10);
    expect(r.checks.checkSize).toEqual({ ok: true, detail: "$3.0M is within your first-check range ($1.0M to $4.0M)." });
    expect(r.checks.ownership).toEqual({ ok: false, detail: "5.0% at entry; your target is 8.0% to 15.0%." });
    expect(r.checks.concentration?.ok).toBe(true);
    expect(r.checks.roundFit?.ok).toBe(true);
  });

  it("flags a check over the mandate, over the round, or over the concentration limit", () => {
    const r = roundMath({ raiseUsd: 2e6, preMoneyUsd: 8e6, ourCheckUsd: 5e6 }, { checkMaxUsd: 4e6, fundSizeUsd: 40e6, maxConcentrationPct: 10, reservePerCompanyUsd: 1e6 });
    expect(r.checks.checkSize?.ok).toBe(false);
    expect(r.checks.roundFit).toEqual({ ok: false, detail: "Our check ($5.0M) is bigger than the round ($2.0M)." });
    expect(r.checks.concentration?.ok).toBe(false);
  });

  it("says nothing it can't compute", () => {
    expect(roundMath({ ourCheckUsd: 1e6 })).toEqual({ totalExposureUsd: 1e6, checks: {} });
    expect(roundMath({ raiseUsd: 0, preMoneyUsd: 10e6, ourCheckUsd: 1e6 }).postMoneyUsd).toBeUndefined();
  });
});
