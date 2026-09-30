import { describe, it, expect } from "vitest";
import { expected, mfnElectable, offeringIssues, pipeline, type Subscriber } from "../engines/fundraising.js";

const inv = (o: Partial<Subscriber> & { id: string }): Subscriber => ({
  name: o.id, natural: false, commitment: 1_000_000, accredited: true, qualifiedPurchaser: false, knowledgeableEmployee: false, benefitPlanInvestor: false,
  pooledVehicle: false, verification: "self_certified", minimumInvestmentReps: false, gp: false, ...o,
});

describe("the pipeline", () => {
  it("weights each prospect by its firmest amount and its odds", () => {
    expect(expected({ stage: "meeting", askUsd: 5e6, softCircleUsd: null, committedUsd: null, probability: null })).toBe(1e6);
    expect(expected({ stage: "soft_circle", askUsd: 5e6, softCircleUsd: 4e6, committedUsd: null, probability: 0.5 })).toBe(2e6);
    const p = pipeline([
      { stage: "closed", askUsd: null, softCircleUsd: null, committedUsd: 10e6, probability: null },
      { stage: "soft_circle", askUsd: 5e6, softCircleUsd: 4e6, committedUsd: null, probability: null },
      { stage: "declined", askUsd: 5e6, softCircleUsd: null, committedUsd: null, probability: null },
    ], 40e6);
    expect(p).toMatchObject({ closed: 10e6, softCircled: 4e6, weighted: 3e6, remaining: 30e6 });
    expect(p.coverage).toBeCloseTo(13 / 40, 6);
  });
});

describe("the offering's limits", () => {
  const base = { exemption: "3c1" as const, offering: "506b" as const, hardCapUsd: 50e6, minCommitmentUsd: 250_000, vcoc: false };

  it("counts beneficial owners, knowledgeable employees aside, and caps a qualifying venture fund at $12M and 250", () => {
    const many = Array.from({ length: 101 }, (_, i) => inv({ id: `lp${i}`, commitment: 300_000 }));
    expect(offeringIssues(base, many).map((i) => i.key)).toContain("owners_100");
    expect(offeringIssues(base, [...many.slice(0, 100), inv({ id: "ke", knowledgeableEmployee: true, accredited: false, commitment: 300_000 })]).map((i) => i.key)).not.toContain("owners_100");
    const q = offeringIssues({ ...base, exemption: "3c1_qvcf", hardCapUsd: null }, Array.from({ length: 130 }, (_, i) => inv({ id: `q${i}`, commitment: 100_000 })));
    expect(q.map((i) => i.key)).toEqual(expect.arrayContaining(["qvcf_size", "below_min"]));
  });

  it("requires qualified purchasers in a 3(c)(7) fund and verification in a 506(c) offering", () => {
    const keys = (o: Parameters<typeof offeringIssues>[0], xs: Subscriber[]) => offeringIssues(o, xs).map((i) => `${i.key}:${i.investor ?? ""}`);
    expect(keys({ ...base, exemption: "3c7" }, [inv({ id: "a", qualifiedPurchaser: true }), inv({ id: "b" })])).toContain("not_qp:b");
    const c = { ...base, offering: "506c" as const };
    expect(keys(c, [inv({ id: "a" })])).toContain("not_verified:a");
    expect(keys(c, [inv({ id: "a", verification: "minimum_investment", natural: true, commitment: 150_000, minimumInvestmentReps: true })])).toContain("min_investment:a");
    expect(keys(c, [inv({ id: "a", verification: "minimum_investment", natural: true, commitment: 200_000 })])).toContain("min_investment_reps:a");
    expect(keys(c, [inv({ id: "a", verification: "minimum_investment", commitment: 1_000_000, minimumInvestmentReps: true })])).toEqual([]);
    expect(keys(c, [inv({ id: "a", verification: "third_party_letter", commitment: 300_000 })])).toEqual([]);
  });

  it("stops at 25% benefit plan money unless the fund is a VCOC, and at the hard cap", () => {
    const xs = [inv({ id: "pension", benefitPlanInvestor: true, commitment: 3e6 }), inv({ id: "fo", commitment: 7e6 })];
    expect(offeringIssues(base, xs).map((i) => i.key)).toContain("erisa_25");
    expect(offeringIssues({ ...base, vcoc: true }, xs).map((i) => i.key)).not.toContain("erisa_25");
    expect(offeringIssues({ ...base, hardCapUsd: 9e6 }, xs).map((i) => i.key)).toContain("hard_cap");
    expect(offeringIssues(base, [inv({ id: "fof", pooledVehicle: true, commitment: 3e6 }), inv({ id: "x", commitment: 7e6 })]).map((i) => i.key)).toContain("look_through");
  });
});

describe("MFN elections", () => {
  it("offers what equal or smaller investors got, electable terms only", () => {
    const terms = [
      { id: "t1", holderId: "small", holderCommitment: 5e6, category: "reporting", electable: true },
      { id: "t2", holderId: "big", holderCommitment: 20e6, category: "fee_discount", electable: true },
      { id: "t3", holderId: "small", holderCommitment: 5e6, category: "lpac_seat", electable: false },
    ];
    const m = mfnElectable(terms, [{ id: "mid", commitment: 10e6, hasMfn: true }, { id: "small", commitment: 5e6, hasMfn: true }, { id: "none", commitment: 50e6, hasMfn: false }]);
    expect(m.get("mid")!.map((t) => t.id)).toEqual(["t1"]);
    expect(m.get("small")).toEqual([]);
    expect(m.has("none")).toBe(false);
  });
});
