import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { score, valuesMatch, type Fixture } from "../evals/extraction/run.js";
import { normalizeValue } from "../ledger/predicates.js";

describe("extraction eval scoring", () => {
  it("matches values sensibly", () => {
    expect(valuesMatch(2_400_000, 2_400_000)).toBe(true);
    expect(valuesMatch(2_400_000, 2_390_000)).toBe(true);
    expect(valuesMatch(2_400_000, 2_000_000)).toBe(false);
    expect(valuesMatch("Pittsburgh", "Pittsburgh, PA")).toBe(true);
    expect(valuesMatch({ customer: "Kiewit", rung: "production_contract" }, { customer: "Kiewit Corp", rung: "production_contract" })).toBe(true);
    expect(valuesMatch({ customer: "Kiewit", rung: "production_contract" }, { customer: "Kiewit", rung: "paid_pilot" })).toBe(false);
  });

  it("scores misses, extras and forbidden claims", async () => {
    const fx = JSON.parse(await readFile("evals/extraction/fixtures/press-release-01.json", "utf8")) as Fixture;
    const got = [
      { predicate: "funding.round.amount", value: 9_000_000 },
      { predicate: "funding.round.stage", value: "series_a" },
      { predicate: "revenue.annual", value: 50_000_000 },
    ];
    const s = score(fx, got);
    expect(s.forbiddenHits).toHaveLength(1);
    expect(s.missed.map((m) => m.predicate)).toContain("funding.total_raised");
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.perfect).toBe(false);
  });

  it("every fixture's expected values are valid for their predicates", async () => {
    for (const f of ["founder-call-01.json", "press-release-01.json"]) {
      const fx = JSON.parse(await readFile(`evals/extraction/fixtures/${f}`, "utf8")) as Fixture;
      for (const e of fx.expected) expect(() => normalizeValue(e.predicate, e.value)).not.toThrow();
    }
  });
});
