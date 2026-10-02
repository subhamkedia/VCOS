import { describe, it, expect } from "vitest";
import { findConflicts, stringsCompatible, type ClaimRow } from "../ledger/contradictions.js";
import { getPredicate } from "../ledger/predicates.js";

const claim = (id: string, predicate: string, value: unknown, source_type: ClaimRow["source_type"], as_of: string | null = null): ClaimRow => ({
  id, subject_id: "s", predicate, value, as_of, source_type, evidence_id: `e-${id}`, cited_text: null,
});

describe("contradiction rules", () => {
  it("treats a more specific location as the same place", () => {
    const def = getPredicate("company.hq_location");
    expect(stringsCompatible(def, "Pittsburgh, PA", "Pittsburgh, PA, United States")).toBe(true);
    expect(stringsCompatible(def, "Pittsburgh, PA", "Austin, TX")).toBe(false);
  });

  it("never flags differently worded descriptions", () => {
    expect(findConflicts([
      claim("a", "company.description", "Rebar-tying robots for bridges", "self_reported"),
      claim("b", "company.description", "Construction robotics startup", "third_party"),
    ])).toHaveLength(0);
  });

  it("reads a monthly series as change over time, not a contradiction", () => {
    const series = (id: string, v: number, asOf: string, evidence = "e-kpis"): ClaimRow => ({ ...claim(id, "fleet.units_deployed", v, "self_reported", asOf), evidence_id: evidence });
    // One KPI export, month after month.
    expect(findConflicts([series("a", 14, "2025-11-30"), series("b", 17, "2025-12-31"), series("c", 20, "2026-01-31")])).toHaveLength(0);
    // Separate monthly reports from the same kind of source.
    expect(findConflicts([series("a", 14, "2025-11-30", "e1"), series("b", 17, "2025-12-31", "e2")])).toHaveLength(0);
    // Two kinds of source disagreeing about the same month still is one.
    expect(findConflicts([series("a", 14, "2025-11-30", "e1"), { ...claim("b", "fleet.units_deployed", 30, "third_party", "2025-11-20"), evidence_id: "e2" }])).toHaveLength(1);
  });

  it("flags different enum values", () => {
    const out = findConflicts([
      claim("a", "funding.round.stage", "seed", "self_reported", "2026-06-01"),
      claim("b", "funding.round.stage", "series_a", "primary", "2026-06-10"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("high");
  });

  it("downgrades anything involving a model inference", () => {
    const out = findConflicts([
      claim("a", "revenue.arr", 5_000_000, "inference"),
      claim("b", "revenue.arr", 1_000_000, "primary"),
    ]);
    expect(out[0]?.severity).toBe("low");
  });

  it("ignores multi-valued predicates", () => {
    expect(findConflicts([
      claim("a", "funding.investor", "Ironbridge", "third_party"),
      claim("b", "funding.investor", "Keystone", "third_party"),
    ])).toHaveLength(0);
  });

  it("uses a short window for fast-moving metrics: growth is not a contradiction", () => {
    // 18 people in June, 34 in October: four months of hiring.
    expect(findConflicts([
      claim("a", "team.headcount", 18, "third_party", "2026-06-10"),
      claim("b", "team.headcount", 34, "self_reported", "2026-10-02"),
    ])).toHaveLength(0);
    // 21 people per a database two weeks ago, 34 per the founder today: ask about it.
    expect(findConflicts([
      claim("a", "team.headcount", 21, "third_party", "2026-09-20"),
      claim("b", "team.headcount", 34, "self_reported", "2026-10-02"),
    ])).toHaveLength(1);
  });
});
