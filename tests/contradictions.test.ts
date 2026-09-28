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
