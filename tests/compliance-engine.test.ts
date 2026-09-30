import { describe, it, expect } from "vitest";
import { cfius, marketingComplete, MARKETING_CHECKLIST, obligations, outbound, payToPlay, type Facts } from "../engines/compliance.js";

const base: Facts = { status: "era", fiscalYearEnd: "12-31", privateFundAumUsd: 0, firstSales: [], stateSales: [], outboundNotifiable: [], publicHoldings: [] };
const keys = (f: Facts, y: number) => obligations(f, y).map((o) => `${o.key}:${o.due}`);

describe("the obligations calendar", () => {
  it("dates what an exempt reporting adviser owes: Form ADV, and each fund's Form D and state notices", () => {
    const f = { ...base, firstSales: [{ fund: "Fund III", date: "2026-09-30", stillOffering: true }], stateSales: [{ fund: "Fund III", state: "PA", date: "2026-09-30" }] };
    expect(keys(f, 2026)).toEqual(["formd_Fund III:2026-10-15", "bluesky_Fund III_PA:2026-10-15", "adv_2026:2027-03-31"]);
    expect(keys(f, 2027)).toContain("formd_amend_Fund III_1:2027-09-30");
    expect(keys({ ...f, firstSales: [{ ...f.firstSales[0]!, stillOffering: false }] }, 2027)).not.toContain("formd_amend_Fund III_1:2027-09-30");
  });

  it("adds a registered adviser's audit, annual review, code of ethics reports and, over $150M, Form PF", () => {
    const small = keys({ ...base, status: "registered", privateFundAumUsd: 100e6 }, 2026);
    expect(small).toEqual(expect.arrayContaining(["audit_2026:2027-04-30", "review_2026:2026-12-31", "txn_q1_2026:2026-04-30", "txn_q4_2026:2027-01-30"]));
    expect(small.some((k) => k.startsWith("pf_"))).toBe(false);
    expect(keys({ ...base, status: "registered", privateFundAumUsd: 200e6 }, 2026)).toContain("pf_2026:2027-04-30");
    expect(keys({ ...base, status: "none" }, 2026)).toEqual([]);
  });

  it("dates outbound notices 30 days after closing, and 13G and Form 3 after an IPO", () => {
    const f = { ...base, status: "none" as const, outboundNotifiable: [{ company: "Kestrel", closed: "2026-03-01" }], publicHoldings: [{ company: "Weldloop", crossed: "2026-05-20", pct: 12.5, insider: true }] };
    expect(keys(f, 2026)).toEqual(["form3_Weldloop:2026-05-30", "outbound_Kestrel_2026-03-01:2026-03-31", "13g_Weldloop:2026-08-14"].sort((a, b) => a.split(":")[1]!.localeCompare(b.split(":")[1]!)));
  });
});

describe("pay to play", () => {
  it("allows $350 per election where the person votes and $150 where they don't, and times out above it", () => {
    expect(payToPlay({ amountUsd: 300, priorSameElectionUsd: 0, canVote: true, influencesGovernmentInvestor: true })).toMatchObject({ withinDeMinimis: true, timeOut: false });
    expect(payToPlay({ amountUsd: 200, priorSameElectionUsd: 0, canVote: false, influencesGovernmentInvestor: true })).toMatchObject({ limit: 150, withinDeMinimis: false, timeOut: true });
    expect(payToPlay({ amountUsd: 100, priorSameElectionUsd: 300, canVote: true, influencesGovernmentInvestor: false })).toMatchObject({ total: 400, withinDeMinimis: false, timeOut: false });
  });
});

describe("outbound investment, CFIUS and marketing", () => {
  it("classifies outbound deals by country, sector and threshold", () => {
    expect(outbound({ countryOfConcern: false, sector: "ai", aiNotifiable: true }).result).toBe("not_covered");
    expect(outbound({ countryOfConcern: true, sector: "ai", aiNotifiable: true }).result).toBe("notifiable"); // e.g. AI controlling robots
    expect(outbound({ countryOfConcern: true, sector: "ai", aiProhibited: true }).result).toBe("prohibited");
    expect(outbound({ countryOfConcern: true, sector: "quantum" }).result).toBe("prohibited");
    expect(outbound({ countryOfConcern: true, sector: "semiconductors" }).result).toBe("notifiable");
    expect(outbound({ countryOfConcern: true, sector: "semiconductors", semisAdvanced: true, excepted: true }).result).toBe("not_covered");
  });

  it("flags CFIUS only for TID businesses where a foreign investor gets rights", () => {
    expect(cfius({ criticalTechnology: true, infrastructureOrData: false, foreignRights: false }).result).toBe("none");
    expect(cfius({ criticalTechnology: true, infrastructureOrData: false, foreignRights: true }).result).toBe("review");
    expect(cfius({ criticalTechnology: true, infrastructureOrData: false, foreignRights: true, restrictedCountry: true }).result).toBe("declaration_likely");
  });

  it("needs every Marketing Rule check confirmed", () => {
    expect(marketingComplete({}).missing).toHaveLength(MARKETING_CHECKLIST.length);
    expect(marketingComplete(Object.fromEntries(MARKETING_CHECKLIST.map((c) => [c.key, true])))).toEqual({ complete: true, missing: [] });
  });
});
