import { describe, it, expect } from "vitest";
import { holdingsAfter, noteInterest, proForma, type Holding } from "../engines/cap-table.js";
import { exitScenarios, waterfall, type PreferredSeries } from "../engines/waterfall.js";
import { adjustConversion } from "../engines/anti-dilution.js";

const common = (holder: string, shares: number): Holding => ({ holder, className: "Common", shares, kind: "common" });
const pool = (shares: number): Holding => ({ holder: "Option pool", className: "Unissued pool", shares, kind: "pool" });
const round = (over: Partial<Parameters<typeof proForma>[3]> = {}) => ({ seriesName: "Series A Preferred", preMoney: 8e6, investments: [{ holder: "Lead", amount: 2e6 }], closeDate: "2026-10-01", ...over });

describe("pro-forma cap table", () => {
  it("prices the option pool shuffle: $8M pre, $2M in, pool 20% of post", () => {
    // Venture Hacks' worked example: 6M founder shares; the pool comes out of the pre-money, so the price is $1.00, not $1.33.
    const p = proForma([common("Founders", 6e6)], [], [], round({ poolTargetPostPct: 20 }));
    expect(p.pricePerShare).toBe(1);
    expect(p.pool.increase).toBe(2e6);
    expect(p.newShares).toEqual([{ holder: "Lead", amount: 2e6, shares: 2e6 }]);
    expect(p.postMoneyFullyDiluted).toBe(10e6);
    expect(p.pool.afterPct).toBeCloseTo(20, 6);
    expect(p.rows.find((r) => r.holder === "Founders")!.postPct).toBeCloseTo(60, 6);
    expect(p.headlinePostMoney).toBe(10e6);
    expect(p.postMoneyImplied).toBe(10e6);
  });

  it("converts a post-money SAFE to exactly its cap ownership before the new money", () => {
    // $1M on a $10M post-money cap: 10% of the company capitalization, then the priced round.
    const p = proForma([common("Founders", 9e6), pool(1e6)], [{ holder: "Angel", amount: 1e6, kind: "post", cap: 10e6 }], [], round({ preMoney: 20e6, investments: [{ holder: "Lead", amount: 5e6 }] }));
    expect(p.pricePerShare).toBe(1.8);
    const safe = p.conversions[0]!;
    expect(safe).toMatchObject({ basis: "cap", shares: 1_111_111 });
    expect(safe.price).toBeCloseTo(0.9, 6);
    expect(p.newShares[0]!.shares).toBe(2_777_777);
    expect(p.postMoneyFullyDiluted).toBe(10e6 + 1_111_111 + 2_777_777);
    // 1,111,111 of (10M + 1,111,111) is 10.0% before the round.
    expect(safe.shares / (10e6 + safe.shares)).toBeCloseTo(0.1, 6);
  });

  it("converts a note with interest at the better of cap and discount", () => {
    const note = { holder: "Note holder", principal: 500_000, ratePct: 6, issueDate: "2025-10-01", cap: 8e6, discountPct: 20 };
    expect(noteInterest(note, "2026-10-01")).toBeCloseTo(30_000, 6);
    const p = proForma([common("Founders", 8e6)], [], [note], round({ preMoney: 16e6, investments: [{ holder: "Lead", amount: 4e6 }] }));
    const c = p.conversions[0]!;
    expect(c).toMatchObject({ basis: "cap", shares: 530_000, instrument: "Convertible note" });
    expect(c.converting).toBeCloseTo(530_000, 4);
    expect(p.pricePerShare).toBe(1.8757); // 16M / 8.53M, to 4 decimals
    // A high cap: the discount wins instead.
    const d = proForma([common("Founders", 8e6)], [], [{ ...note, cap: 30e6 }], round({ preMoney: 16e6, investments: [{ holder: "Lead", amount: 4e6 }] }));
    expect(d.conversions[0]!.basis).toBe("discount");
    expect(d.conversions[0]!.price).toBeCloseTo(d.pricePerShare * 0.8, 6);
  });

  it("converts an MFN SAFE at the round price, and refuses nonsense", () => {
    const p = proForma([common("Founders", 8e6)], [{ holder: "YC", amount: 375_000, kind: "mfn" }], [], round());
    expect(p.conversions[0]).toMatchObject({ basis: "round" });
    expect(() => proForma([common("Founders", 8e6)], [{ holder: "X", amount: 1, kind: "post" }], [], round())).toThrow(/cap, a discount/);
    expect(() => proForma([common("Founders", 8e6)], [], [], round({ preMoney: 0 }))).toThrow(/positive/);
    expect(() => proForma([], [], [], round())).toThrow(/no shares/);
  });

  it("carries holdings forward to the next round", () => {
    const existing = [common("Founders", 6e6)];
    const p = proForma(existing, [], [], round({ poolTargetPostPct: 20 }));
    const after = holdingsAfter(p, existing, "Series A Preferred");
    expect(after.reduce((a, h) => a + h.shares, 0)).toBe(p.postMoneyFullyDiluted);
  });
});

const seriesA = (over: Partial<PreferredSeries> = {}): PreferredSeries => ({ name: "Series A", shares: 10e6, issuePrice: 1, multiple: 1, participating: false, seniority: 1, ...over });
const founders = [{ name: "Common", shares: 30e6 }];
const payout = (r: ReturnType<typeof waterfall>, name: string) => r.classes.find((c) => c.name === name)!.payout;

describe("exit waterfall", () => {
  it("non-participating preferred takes the greater of its preference or converting", () => {
    const low = waterfall(20e6, [seriesA()], founders);
    expect(payout(low, "Series A")).toBeCloseTo(10e6, 2);
    expect(payout(low, "Common")).toBeCloseTo(10e6, 2);
    const high = waterfall(100e6, [seriesA()], founders);
    expect(high.classes[0]!.converted).toBe(true);
    expect(payout(high, "Series A")).toBeCloseTo(25e6, 2);
    expect(payout(high, "Common")).toBeCloseTo(75e6, 2);
  });

  it("participating preferred double-dips, up to its cap, then converts", () => {
    const full = waterfall(20e6, [seriesA({ participating: true })], founders);
    expect(payout(full, "Series A")).toBeCloseTo(12.5e6, 2);
    expect(payout(full, "Common")).toBeCloseTo(7.5e6, 2);
    const cappedBelow = waterfall(60e6, [seriesA({ participating: true, capMultiple: 3 })], founders);
    expect(payout(cappedBelow, "Series A")).toBeCloseTo(22.5e6, 2);
    const aboveCap = waterfall(200e6, [seriesA({ participating: true, capMultiple: 3 })], founders);
    expect(aboveCap.classes[0]!.converted).toBe(true);
    expect(payout(aboveCap, "Series A")).toBeCloseTo(50e6, 2);
  });

  it("pays senior series first, and pari passu series pro rata", () => {
    const seed: PreferredSeries = { name: "Seed", shares: 5e6, issuePrice: 1, multiple: 1, participating: false, seniority: 2 };
    const a = seriesA({ issuePrice: 2, seniority: 1 });
    const stacked = waterfall(22e6, [a, seed], [{ name: "Common", shares: 20e6 }]);
    expect(payout(stacked, "Series A")).toBeCloseTo(20e6, 2);
    expect(payout(stacked, "Seed")).toBeCloseTo(2e6, 2);
    expect(payout(stacked, "Common")).toBeCloseTo(0, 2);
    const pari = waterfall(22e6, [a, { ...seed, seniority: 1 }], [{ name: "Common", shares: 20e6 }]);
    expect(payout(pari, "Series A")).toBeCloseTo(17.6e6, 2);
    expect(payout(pari, "Seed")).toBeCloseTo(4.4e6, 2);
  });

  it("exercises options only when they're in the money, and always adds up", () => {
    const commons = [{ name: "Common", shares: 9e6 }, { name: "Options", shares: 1e6, strike: 2 }];
    const low = waterfall(10e6, [], commons);
    expect(payout(low, "Options")).toBe(0);
    expect(payout(low, "Common")).toBeCloseTo(10e6, 2);
    const high = waterfall(100e6, [], commons);
    expect(payout(high, "Options")).toBeCloseTo(8.2e6, 2);
    expect(payout(high, "Common")).toBeCloseTo(91.8e6, 2);
    for (const exit of [0, 5e6, 40e6, 1e9]) {
      const r = waterfall(exit, [seriesA({ participating: true, capMultiple: 2 })], commons);
      expect(r.classes.reduce((a, c) => a + c.payout, 0)).toBeCloseTo(exit, 0);
    }
  });

  it("builds a returns table for our position", () => {
    const rows = exitScenarios([10e6, 40e6, 100e6], [seriesA()], founders, { series: "Series A", shares: 5e6, invested: 5e6 });
    expect(rows.map((r) => Math.round(r.multiple * 100) / 100)).toEqual([1, 1, 2.5]);
  });
});

describe("anti-dilution", () => {
  it("adjusts by broad-based weighted average or full ratchet", () => {
    const base = { conversionPrice: 1, originalIssuePrice: 1, seriesShares: 5e6, sharesOutstanding: 10e6, newMoney: 2e6, newPrice: 0.5 };
    const wa = adjustConversion({ ...base, kind: "broad_wa" });
    expect(wa.conversionPrice).toBeCloseTo(12 / 14, 10);
    expect(wa.extraCommonShares).toBe(833_333);
    const fr = adjustConversion({ ...base, kind: "full_ratchet" });
    expect(fr).toMatchObject({ conversionPrice: 0.5, extraCommonShares: 5e6 });
    expect(adjustConversion({ ...base, kind: "broad_wa", newPrice: 1.2 }).extraCommonShares).toBe(0);
  });
});
