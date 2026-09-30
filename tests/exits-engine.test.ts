import { describe, it, expect } from "vitest";
import { cvElections, fundLife, inKindPrice, liquidityForecast, qsbs, receivableValue, saleWindow, shareSplit, splitConsideration, tailOptions } from "../engines/exits.js";
import { mark } from "../engines/valuation.js";

describe("a sale's consideration", () => {
  it("splits cash at closing from escrows, the expense fund and earnouts, and expects earnouts at their odds", () => {
    const s = splitConsideration({
      closeDate: "2026-06-30", totalUsd: 10_000_000, escrowPct: 10, adjustmentEscrowPct: 1, expenseFundUsd: 25_000,
      earnouts: [{ description: "2027 revenue over $20M", maxUsd: 2_000_000, probabilityPct: 40, dueOn: "2028-03-31" }],
    });
    expect(s.atCloseCashUsd).toBe(8_875_000);
    expect(s.receivables.map((r) => [r.kind, r.amountUsd, r.dueOn])).toEqual([
      ["escrow", 1_000_000, "2027-06-30"], ["adjustment_escrow", 100_000, "2026-09-30"], ["expense_fund", 25_000, "2027-06-30"], ["earnout", 2_000_000, "2028-03-31"],
    ]);
    expect(s.expectedUsd).toBe(10_800_000); // 10M held and returned, plus 40% of 2M
    expect(s.maximumUsd).toBe(12_000_000);
    expect(s.warnings.some((w) => /probability/.test(w))).toBe(true);
  });

  it("keeps stock apart from cash and refuses to hold back more cash than there is", () => {
    const s = splitConsideration({ closeDate: "2026-06-30", totalUsd: 4_000_000, stockUsd: 3_000_000, escrowPct: 10 });
    expect([s.atCloseCashUsd, s.stockUsd]).toEqual([600_000, 3_000_000]);
    expect(() => splitConsideration({ closeDate: "2026-06-30", totalUsd: 1_000_000, stockUsd: 950_000, escrowPct: 10 })).toThrow(/more is held back/i);
    expect(splitConsideration({ closeDate: "2026-06-30", totalUsd: 1e6, escrowPct: 25 }).warnings[0]).toMatch(/high/);
  });

  it("values a receivable at what's left of its expected amount", () => {
    expect(receivableValue({ amountUsd: 1_000_000, expectedPct: 100, status: "pending" })).toBe(1_000_000);
    expect(receivableValue({ amountUsd: 1_000_000, expectedPct: 90, settledUsd: 400_000, status: "partial" })).toBe(540_000);
    expect(receivableValue({ amountUsd: 1_000_000, expectedPct: 100, settledUsd: 1_000_000, status: "released" })).toBe(0);
  });
});

describe("public shares", () => {
  it("dates the first sale from the lock-up and Rule 144, and limits an affiliate's volume", () => {
    const w = saleWindow({ acquiredOn: "2023-04-01", listedOn: "2026-05-15", affiliate: true, shares: 2_400_000, sharesOutstanding: 40_000_000, avgWeeklyVolume: 650_000, price: 18 });
    expect(w.lockupEnds).toBe("2026-11-11");
    expect(w.holdingPeriodMet).toBe("2026-08-13"); // the company has reported for 90 days
    expect(w.earliestSale).toBe("2026-11-11");
    expect(w.volumeLimit).toBe(650_000); // a week's volume beats 1% of 40M
    expect(w.form144).toBe(true);
    expect(w.reporting.join(" ")).toMatch(/13G/);
    expect(w.reporting.join(" ")).toMatch(/Section 16/);
  });

  it("lets a non-affiliate with a year's holding sell once the lock-up ends", () => {
    const w = saleWindow({ acquiredOn: "2024-01-10", listedOn: "2026-05-15", lockupDays: 90, affiliate: false, shares: 100_000 });
    expect(w.earliestSale).toBe("2026-08-13");
    expect(w.volumeLimit).toBeNull();
    const recent = saleWindow({ acquiredOn: "2026-04-01", listedOn: "2026-05-15", lockupDays: 0, affiliate: false, shares: 100_000 });
    expect(recent.earliestSale).toBe("2026-10-01"); // six months, the company having reported 90 days by then
  });

  it("marks listed shares at the quoted price with no discount for the lock-up", () => {
    const m = mark({ method: "public_price", shares: 2_400_000, price: 18.5, priceDate: "2026-09-30" }, "2026-09-30");
    expect(m.value).toBe(44_400_000);
    expect(m.steps.join(" ")).toMatch(/ASU 2022-03/);
  });
});

describe("in-kind distributions", () => {
  it("prices the shares by the LPA's method", () => {
    const px = [{ date: "2026-11-09", close: 20 }, { date: "2026-11-10", close: 21 }, { date: "2026-11-11", close: 22 }, { date: "2026-11-12", close: 25 }];
    expect(inKindPrice(px, { kind: "close", on: "2026-11-11" }).price).toBe(22);
    expect(inKindPrice(px, { kind: "average", days: 3, endingOn: "2026-11-11" }).price).toBe(21);
    expect(() => inKindPrice(px, { kind: "average", days: 5, endingOn: "2026-11-11" })).toThrow(/needs 5/);
  });

  it("hands out whole shares by largest remainder", () => {
    const s = shareSplit([{ id: "a", amountUsd: 500 }, { id: "b", amountUsd: 300 }, { id: "c", amountUsd: 200 }], 1001);
    expect(s).toEqual([{ id: "a", shares: 501 }, { id: "b", shares: 300 }, { id: "c", shares: 200 }]);
    expect(s.reduce((a, x) => a + x.shares, 0)).toBe(1001);
  });
});

describe("QSBS", () => {
  it("steps up at three, four and five years for stock issued after July 4, 2025", () => {
    const lot = { acquiredOn: "2025-09-01", basisUsd: 1_000_000 };
    expect(qsbs(lot, "2028-09-01")).toMatchObject({ regime: "post_2025", exclusionPct: 0, next: { on: "2028-09-02", pct: 50 }, capUsd: 15_000_000 });
    expect(qsbs(lot, "2029-09-02")).toMatchObject({ exclusionPct: 75, next: { on: "2030-09-02", pct: 100 } });
    expect(qsbs(lot, "2031-01-01").exclusionPct).toBe(100);
  });

  it("needs five years for earlier stock, capped at $10 million or ten times basis", () => {
    const r = qsbs({ acquiredOn: "2022-03-15", basisUsd: 2_000_000 }, "2026-09-30");
    expect(r).toMatchObject({ regime: "pre_2025", exclusionPct: 0, next: { on: "2027-03-16", pct: 100 }, capUsd: 10_000_000, tenTimesBasisUsd: 20_000_000 });
    expect(r.notes.join(" ")).toMatch(/1045/);
  });
});

describe("the fund's tail", () => {
  it("counts the term and extensions, and suggests options", () => {
    const l = fundLife({ inception: "2016-03-01", termYears: 10, extensions: [{ years: 1 }], maxExtensionYears: 2 }, "2026-09-30");
    expect(l).toMatchObject({ termEnds: "2026-02-28", endsOn: "2027-02-28", extensionYearsLeft: 1, stage: "extended", monthsLeft: 5 });
    const o = tailOptions({ monthsLeft: 5, residualNavUsd: 40e6, holdings: 4, extensionYearsLeft: 1, publicHoldings: 1 }).map((x) => x.key);
    expect(o).toEqual(["extension", "sell_or_distribute", "direct_secondary", "strip_sale", "continuation", "wind_up"]);
  });

  it("is in its investment period until the LPA says it ends, then harvesting, then in its final two years", () => {
    const f = { inception: "2024-01-15", termYears: 10, extensions: [], maxExtensionYears: 2, investmentPeriodEnd: "2029-01-14" };
    expect(fundLife(f, "2026-09-30").stage).toBe("investing");
    expect(fundLife(f, "2029-01-15").stage).toBe("harvesting");
    expect(fundLife(f, "2032-06-30").stage).toBe("final_years");
    expect(fundLife({ ...f, investmentPeriodEnd: undefined }, "2026-09-30").stage).toBe("harvesting");
  });

  it("tallies continuation vehicle elections, with silence as a sale", () => {
    const investors = [{ id: "a", navUsd: 6e6 }, { id: "b", navUsd: 3e6 }, { id: "c", navUsd: 1e6 }];
    const open = cvElections({ launchedOn: "2026-09-01", deadline: "2026-10-01", statusQuoOffered: true, pricePct: 92, investors, elections: [{ id: "a", choice: "roll" }] }, "2026-09-15");
    expect(open).toMatchObject({ issues: [], navRolled: 6e6, navPending: 4e6 });
    const done = cvElections({ launchedOn: "2026-09-01", deadline: "2026-09-20", statusQuoOffered: false, pricePct: 92, investors, elections: [{ id: "a", choice: "roll" }, { id: "b", choice: "status_quo" }] }, "2026-10-01");
    expect(done.investors.find((x) => x.id === "c")).toMatchObject({ choice: "sell", defaulted: true, cashUsd: 920_000 });
    expect(done.issues).toHaveLength(2);
  });

  it("forecasts cash back by year", () => {
    const f = liquidityForecast({
      receivables: [{ amountUsd: 1e6, dueOn: "2027-06-30" }, { amountUsd: 200_000, dueOn: "2025-12-31" }],
      publicHoldings: [{ valueUsd: 40e6, sellableFrom: "2026-11-11" }],
      plannedExits: [{ company: "Weldloop", year: 2028, valueUsd: 30e6, probabilityPct: 50 }],
    }, "2026-09-30");
    expect(f).toEqual([
      { year: 2026, receivables: 200_000, publicShares: 40e6, exits: 0, total: 40.2e6 },
      { year: 2027, receivables: 1e6, publicShares: 0, exits: 0, total: 1e6 },
      { year: 2028, receivables: 0, publicShares: 0, exits: 15e6, total: 15e6 },
    ]);
  });
});
