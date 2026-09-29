import { describe, it, expect } from "vitest";
import { buildSeries, netBurn, summarize, signals, suggestedHealth, addMonths, monthEnd, type KpiClaim } from "../engines/kpi.js";
import { npv, portfolioMetrics, reserves, xirr } from "../engines/fund-metrics.js";
import { mark } from "../engines/valuation.js";

let n = 0;
const c = (predicate: string, as_of: string, value: number, source_type = "self_reported"): KpiClaim => ({ id: `c${++n}`, predicate, as_of, value, source_type });

describe("KPI series", () => {
  it("keeps one figure per metric per month, preferring the better source", () => {
    const s = buildSeries([
      c("revenue.monthly", "2026-05-31", 100_000, "self_reported"),
      c("revenue.monthly", "2026-05-31", 98_000, "primary"), // the books win
      c("revenue.monthly", "2026-05-31", 120_000, "inference"),
      c("cash.balance", "2026-05-31", 1_000_000),
      c("company.description", "2026-05-31", 1), // not a KPI
    ]);
    expect(s.revenue).toEqual([{ month: "2026-05", value: 98_000, claimId: expect.any(String), sourceType: "primary" }]);
    expect(Object.keys(s).sort()).toEqual(["cash", "revenue"]);
  });

  it("works out net burn from what's there: reported, then the income statement, then cash", () => {
    const s = buildSeries([
      c("cash.balance", "2026-01-31", 2_000_000), c("cash.balance", "2026-02-28", 1_850_000),
      c("expenses.monthly", "2026-03-31", 260_000), c("revenue.monthly", "2026-03-31", 90_000),
      c("burn.monthly", "2026-04-30", 175_000),
    ]);
    expect(netBurn(s).map((b) => [b.month, b.value, b.basis])).toEqual([
      ["2026-02", 150_000, "change in cash"],
      ["2026-03", 170_000, "income statement"],
      ["2026-04", 175_000, "reported"],
    ]);
  });

  it("computes runway, growth, the burn multiple and plan variance", () => {
    const claims: KpiClaim[] = [];
    // Six months: revenue up 10% a month, expenses flat at 300k, ARR = 12x monthly revenue.
    let rev = 100_000;
    for (let i = 0; i < 6; i++) {
      const m = addMonths("2026-01", i);
      claims.push(c("revenue.monthly", monthEnd(m), Math.round(rev)), c("expenses.monthly", monthEnd(m), 300_000), c("revenue.arr", monthEnd(m), Math.round(rev * 12)));
      rev *= 1.1;
    }
    claims.push(c("cash.balance", "2026-06-30", 1_800_000), c("plan.revenue.monthly", "2026-06-30", 210_000));
    const s = summarize(buildSeries(claims), "2026-07-15");
    expect(s.latestMonth).toBe("2026-06");
    expect(s.monthsSinceUpdate).toBe(1);
    // Burn Apr-Jun: 300k - revenue (133,100 / 146,410 / 161,051) → avg 153,146.
    expect(s.avgBurn).toBeCloseTo((300_000 * 3 - (133_100 + 146_410 + 161_051)) / 3, 0);
    expect(s.runwayMonths).toBeCloseTo(1_800_000 / s.avgBurn!, 6);
    expect(s.zeroCashMonth).toBe(addMonths("2026-06", Math.floor(s.runwayMonths!)));
    expect(s.revenueMoM).toBeCloseTo(10, 1);
    // Net new ARR over three months (Mar -> Jun), and the burn over Apr-Jun.
    expect(s.netNewArr3m).toBe((161_051 - 121_000) * 12);
    expect(s.burnMultiple).toBeCloseTo((300_000 * 3 - (133_100 + 146_410 + 161_051)) / ((161_051 - 121_000) * 12), 4);
    expect(s.planRevenueVarPct).toBeCloseTo(((161_051 - 210_000) / 210_000) * 100, 4);
    const sig = signals(s);
    expect(sig.map((x) => x.key)).toEqual(["runway", "plan_revenue"]);
    expect(sig[0]).toMatchObject({ severity: "medium" }); // ~11.8 months: raising time
    expect(sig[0]!.claimIds.length).toBeGreaterThan(1); // cites cash and the burn figures
    expect(suggestedHealth(sig)).toBe("watch");
  });

  it("flags short runway, stale data and shrinking teams; a company that isn't burning has no runway warning", () => {
    const risky = summarize(buildSeries([
      c("cash.balance", "2026-03-31", 500_000), c("burn.monthly", "2026-03-31", 120_000),
      c("team.headcount", "2025-12-31", 40), c("team.headcount", "2026-03-31", 30),
    ]), "2026-07-01");
    const keys = signals(risky).map((x) => [x.key, x.severity]);
    expect(keys).toEqual([["runway", "high"], ["stale", "medium"], ["headcount", "medium"]]);
    expect(suggestedHealth(signals(risky))).toBe("at_risk");
    const profitable = summarize(buildSeries([
      c("cash.balance", "2026-06-30", 500_000), c("revenue.monthly", "2026-06-30", 400_000), c("expenses.monthly", "2026-06-30", 350_000),
    ]), "2026-07-01");
    expect(profitable.runwayMonths).toBe(Infinity);
    expect(signals(profitable)).toEqual([]);
    expect(signals(summarize({}, "2026-07-01")).map((x) => x.key)).toEqual(["stale"]);
  });
});

describe("fund metrics", () => {
  it("XIRR matches the closed form for a single in and out", () => {
    // $100 in, $200 out exactly two years later (730 days / 365): IRR = sqrt(2) - 1.
    const r = xirr([{ date: "2024-01-01", amount: -100 }, { date: "2025-12-31", amount: 200 }])!;
    expect(r).toBeCloseTo(Math.SQRT2 - 1, 6);
    expect(npv(r, [{ date: "2024-01-01", amount: -100 }, { date: "2025-12-31", amount: 200 }])).toBeCloseTo(0, 5);
    expect(xirr([{ date: "2024-01-01", amount: -100 }])).toBeNull();
    // A total loss: -100%, just inside the bracket.
    expect(xirr([{ date: "2024-01-01", amount: -100 }, { date: "2025-01-01", amount: 0.0001 }])!).toBeLessThan(-0.99);
  });

  it("rolls positions up to MOIC, DPI, RVPI, TVPI, loss ratio and concentration", () => {
    const r = portfolioMetrics([
      { company: "A", invested: [{ date: "2023-01-01", amount: 1_000_000 }], realized: [{ date: "2025-06-30", amount: 3_000_000 }], fairValue: 0 },
      { company: "B", invested: [{ date: "2023-06-30", amount: 1_000_000 }, { date: "2024-06-30", amount: 500_000 }], realized: [], fairValue: 2_500_000 },
      { company: "C", invested: [{ date: "2024-01-01", amount: 1_500_000 }], realized: [], fairValue: 500_000 },
    ], "2026-06-30");
    expect(r.invested).toBe(4_000_000);
    expect(r.realized).toBe(3_000_000);
    expect(r.unrealized).toBe(3_000_000);
    expect(r.tvpi).toBe(1.5);
    expect(r.dpi).toBe(0.75);
    expect(r.rvpi).toBe(0.75);
    expect(r.dpi! + r.rvpi!).toBe(r.tvpi);
    expect(r.lossRatioPct).toBeCloseTo((1_500_000 / 4_000_000) * 100, 6); // C is below cost
    expect(r.positions[0]).toMatchObject({ company: "A", moic: 3 });
    expect(r.topPositionPct).toBe(50);
    expect(r.irr).toBeGreaterThan(0.1);
  });

  it("tracks the reserve pool: deployed, still planned, and unallocated", () => {
    const r = reserves({
      fundSizeUsd: 50e6, reservesPct: 40,
      followOns: [{ company: "A", amount: 2e6 }, { company: "B", amount: 1e6 }],
      planned: [{ company: "A", amount: 3e6 }, { company: "B", amount: 1e6 }, { company: "C", amount: 4e6 }],
    });
    expect(r.budget).toBe(20e6);
    expect(r.deployed).toBe(3e6);
    expect(r.committedRemaining).toBe(1e6 + 0 + 4e6);
    expect(r.unallocated).toBe(20e6 - 3e6 - 5e6);
    expect(r.overAllocated).toBe(false);
    expect(reserves({ fundSizeUsd: 10e6, reservesPct: 10, followOns: [], planned: [{ company: "X", amount: 2e6 }] }).overAllocated).toBe(true);
  });
});

describe("valuation marks", () => {
  it("calibrates to a recent round and warns when the round is old", () => {
    const m = mark({ method: "recent_round", ourShares: 1_000_000, roundPrice: 2.5, roundDate: "2026-01-15" }, "2026-06-30");
    expect(m.value).toBe(2_500_000);
    expect(m.warnings.some((w) => /months old/.test(w))).toBe(false);
    const old = mark({ method: "recent_round", ourShares: 1_000_000, roundPrice: 2.5, roundDate: "2024-06-30", adjustmentPct: -20 }, "2026-06-30");
    expect(old.value).toBe(2_000_000);
    expect(old.warnings.join(" ")).toMatch(/not a default/);
  });

  it("applies milestone adjustments and never goes below zero", () => {
    expect(mark({ method: "milestone", priorValue: 1_000_000, adjustmentPct: 25 }, "2026-06-30").value).toBe(1_250_000);
    expect(mark({ method: "milestone", priorValue: 1_000_000, adjustmentPct: -120 }, "2026-06-30").value).toBe(0);
  });

  it("values from a revenue multiple, pro rata or through the preferences", () => {
    const pro = mark({ method: "revenue_multiple", metricValue: 4e6, metricLabel: "ARR", multiple: 5, cash: 2e6, debt: 1e6, ownershipPct: 10 }, "2026-06-30");
    expect(pro.value).toBe((4e6 * 5 + 2e6 - 1e6) * 0.1); // 2.1M
    expect(pro.warnings.join(" ")).toMatch(/preferences aren't applied/);
    // Low value: our 1x non-participating preferred ($5M in) takes its preference ahead of common.
    const pref = mark({
      method: "revenue_multiple", metricValue: 1e6, metricLabel: "ARR", multiple: 4, cash: 0, debt: 0,
      classes: {
        prefs: [{ name: "Series A", shares: 5_000_000, issuePrice: 1, multiple: 1, participating: false, seniority: 1 }],
        commons: [{ name: "Common", shares: 15_000_000 }],
        ourSeries: "Series A", ourShares: 2_000_000,
      },
    }, "2026-06-30");
    // Equity $4M < the $5M preference: Series A takes all $4M; our 2M of 5M shares = $1.6M (pro rata would be 10% = $400K).
    expect(pref.value).toBeCloseTo(1_600_000, 0);
  });

  it("handles exits, write-offs and cost", () => {
    expect(mark({ method: "exit", proceeds: 7e6 }, "2026-06-30").value).toBe(7e6);
    expect(mark({ method: "write_off" }, "2026-06-30").value).toBe(0);
    const cost = mark({ method: "cost", invested: 1e6, investedDate: "2024-01-01" }, "2026-06-30");
    expect(cost.value).toBe(1e6);
    expect(cost.warnings.join(" ")).toMatch(/rarely fair value/);
  });
});
