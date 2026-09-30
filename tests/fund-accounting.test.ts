import { describe, it, expect } from "vitest";
import {
  allocate, capitalAccounts, carryPosition, cumulativeCarry, hurdleTarget, managementFee, netReturns, reportingCalendar, splitDistribution, type FundTerms,
} from "../engines/fund-accounting.js";

const TERMS: FundTerms = {
  managementFeePct: 2, feeStepDownPct: 1.5, feeBasisAfterPeriod: "invested", investmentPeriodEnd: "2026-06-30",
  carryPct: 20, hurdlePct: 0, catchUpPct: 100, waterfall: "european",
};

describe("allocation", () => {
  it("splits to the cent and always adds up", () => {
    const a = allocate(100, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]);
    expect(a.map((x) => x.amount)).toEqual([33.34, 33.33, 33.33]);
    const b = allocate(1_000_000.01, [{ id: "x", weight: 60 }, { id: "y", weight: 30 }, { id: "z", weight: 10 }]);
    expect(b.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(1_000_000.01, 6);
    expect(b[0]!.amount).toBe(600_000.01);
    expect(() => allocate(10, [{ id: "a", weight: 0 }])).toThrow(/zero/);
  });
});

describe("management fee", () => {
  it("charges by day, splitting at the end of the investment period, net of offsets", () => {
    const year = managementFee(TERMS, { from: "2025-01-01", to: "2025-12-31", feePayingCommitments: 40e6, investedCost: 10e6 });
    expect(year.gross).toBe(800_000);
    // Apr 1 - Jun 30 (91 days) at 2% on commitments; Jul 1 - Sep 30 (92 days) at 1.5% on invested cost; $10K of offsets.
    const q = managementFee(TERMS, { from: "2026-04-01", to: "2026-09-30", feePayingCommitments: 40e6, investedCost: 20e6, offsets: 10_000 });
    expect(q.gross).toBeCloseTo((40e6 * 0.02 * 91) / 365 + (20e6 * 0.015 * 92) / 365, 1);
    expect(q.net).toBeCloseTo(q.gross - 10_000, 2);
    expect(q.lines).toHaveLength(3);
    expect(() => managementFee(TERMS, { from: "2026-02-01", to: "2026-01-01", feePayingCommitments: 1, investedCost: 0 })).toThrow();
  });
});

describe("carried interest", () => {
  it("follows the tiers: return of capital, hurdle, catch-up, split", () => {
    // $100 in, $200 distributed in all: 20% of the $100 profit either way with a full catch-up.
    expect(cumulativeCarry(200, 100, 100, TERMS)).toBe(20);
    expect(cumulativeCarry(200, 100, 108, TERMS)).toBeCloseTo(20, 9); // 8% hurdle, full catch-up
    expect(cumulativeCarry(200, 100, 108, { carryPct: 20, catchUpPct: 0 })).toBeCloseTo(18.4, 9); // no catch-up: 20% above the hurdle
    expect(cumulativeCarry(200, 100, 108, { carryPct: 20, catchUpPct: 80 })).toBeCloseTo(20, 9); // 80% catch-up completes too
    expect(cumulativeCarry(104, 100, 108, TERMS)).toBe(0); // below the hurdle
    expect(cumulativeCarry(109, 100, 108, TERMS)).toBeCloseTo(1, 9); // in the catch-up band: GP takes it all
  });

  it("compounds the hurdle on what's outstanding", () => {
    const h = hurdleTarget([{ date: "2020-01-01", amount: 100 }], [], 8, "2021-12-31");
    expect(h).toBeCloseTo(100 * Math.pow(1.08, 730 / 365), 6);
    expect(hurdleTarget([{ date: "2020-01-01", amount: 100 }], [{ date: "2020-01-01", amount: 100 }], 8, "2021-12-31")).toBeCloseTo(100, 6);
  });

  it("splits distributions whole-of-fund, holding carry in escrow when the LPA says so", () => {
    const contributions = [{ date: "2020-01-01", amount: 100 }];
    const first = splitDistribution(60, "2023-01-01", { contributions, lpDistributions: [], carryPaid: 0 }, TERMS);
    expect(first).toMatchObject({ toLps: 60, carry: 0 });
    const second = splitDistribution(90, "2024-01-01", { contributions, lpDistributions: [{ date: "2023-01-01", amount: 60 }], carryPaid: 0 }, { ...TERMS, escrowPct: 30 });
    expect(second).toMatchObject({ toLps: 80, carry: 10, escrow: 3, carryPaidNow: 7 });
  });

  it("measures accrued carry and clawback exposure at NAV", () => {
    const s = { contributions: [{ date: "2020-01-01", amount: 100 }], lpDistributions: [{ date: "2023-01-01", amount: 80 }], carryPaid: 20 };
    // $100 in; $80 out to LPs, $20 carry paid, $100 still held: $100 of profit, $20 of carry, all paid.
    expect(carryPosition(s, 100, "2025-01-01", TERMS)).toMatchObject({ entitled: 20, accrued: 0, clawbackExposure: 0 });
    // At NAV 200 more carry has accrued.
    expect(carryPosition(s, 200, "2025-01-01", TERMS)).toMatchObject({ entitled: 40, accrued: 20 });
    // The rest of the portfolio fell: at NAV 0, the GP's $20 exceeds the $0 now earned.
    expect(carryPosition(s, 0, "2025-01-01", TERMS)).toMatchObject({ entitled: 0, accrued: -20, clawbackExposure: 20 });
  });
});

describe("capital accounts", () => {
  it("allocate gains and expenses by commitment, fees to fee payers, accrued carry to the GP; they add up to NAV", () => {
    const r = capitalAccounts({
      partners: [{ id: "A", commitment: 60, feePaying: true }, { id: "B", commitment: 30, feePaying: true }, { id: "GP", commitment: 10, feePaying: false }],
      contributions: [{ partnerId: "A", date: "2024-01-01", amount: 30 }, { partnerId: "B", date: "2024-01-01", amount: 15 }, { partnerId: "GP", date: "2024-01-01", amount: 5 }],
      distributions: [],
      fees: [{ partnerId: "A", date: "2024-01-01", amount: 1.2 }, { partnerId: "B", date: "2024-01-01", amount: 0.6 }],
      expenses: [{ partnerId: "A", date: "2024-06-30", amount: 0.6 }, { partnerId: "B", date: "2024-06-30", amount: 0.3 }, { partnerId: "GP", date: "2024-06-30", amount: 0.1 }],
      carryPaid: [], realizedGain: 0, unrealizedGain: 40,
    }, "2025-12-31", TERMS);
    const acc = Object.fromEntries(r.accounts.map((a) => [a.partnerId, a]));
    // LPs: 78.3 before carry on 45 contributed -> 33.3 profit -> 6.66 carry, split 2:1.
    expect(r.gpCarry.accrued).toBeCloseTo(6.66, 6);
    expect(acc.A).toMatchObject({ contributed: 30, unfunded: 30, fees: 1.2, carryAccrued: 4.44, balance: 47.76 });
    expect(acc.B).toMatchObject({ carryAccrued: 2.22, balance: 23.88 });
    expect(acc.GP).toMatchObject({ carryAccrued: 0, balance: 8.9 });
    // NAV = contributions - fees - expenses + gains.
    expect(r.nav).toBeCloseTo(50 - 1.8 - 1 + 40, 6);
  });

  it("takes carry already paid out of the LPs' accounts, not the GP's", () => {
    const r = capitalAccounts({
      partners: [{ id: "A", commitment: 90, feePaying: true }, { id: "GP", commitment: 10, feePaying: false }],
      contributions: [{ partnerId: "A", date: "2022-01-01", amount: 90 }, { partnerId: "GP", date: "2022-01-01", amount: 10 }],
      // $200 of proceeds: the GP's own 10% ($20) carries no carry; A's $180 pays 20% of its $90 profit ($18).
      distributions: [{ partnerId: "A", date: "2024-01-01", amount: 162 }, { partnerId: "GP", date: "2024-01-01", amount: 20 }],
      fees: [], expenses: [], carryPaid: [{ date: "2024-01-01", amount: 18 }], realizedGain: 100, unrealizedGain: 0,
    }, "2024-12-31", TERMS);
    expect(r.nav).toBeCloseTo(0, 6);
    expect(r.gpCarry).toMatchObject({ entitled: 18, accrued: 0, clawbackExposure: 0 });
    expect(r.accounts.map((a) => a.balance)).toEqual([0, 0]);
  });
});

describe("net returns and the calendar", () => {
  it("computes DPI, RVPI, TVPI and IRR from an investor's own flows", () => {
    const n = netReturns([{ date: "2024-01-01", amount: 100 }], [{ date: "2025-01-01", amount: 50 }], 100, "2026-01-01");
    expect(n).toMatchObject({ paidIn: 100, distributed: 50, nav: 100, dpi: 0.5, rvpi: 1, tvpi: 1.5 });
    expect(n.irr).toBeGreaterThan(0.2);
    expect(netReturns([], [], 0, "2026-01-01").tvpi).toBeNull();
  });

  it("lists the year's deadlines", () => {
    const c = Object.fromEntries(reportingCalendar(2026).map((d) => [d.key, d.due]));
    expect(c).toMatchObject({ q1_2026: "2026-05-15", q3_2026: "2026-11-14", q4_2026: "2027-03-31", adv_2026: "2027-03-31", k1_2026: "2027-03-15", audit_2026: "2027-04-30" });
  });
});
