import { describe, it, expect } from "vitest";
import { runResolverEval, judge } from "../evals/resolver/run.js";

describe("resolver eval harness", () => {
  it("judges verdicts", () => {
    expect(judge({ name: "x", expected: "NEW" }, "match", "a")).toBe("false_merge");
    expect(judge({ name: "x", expected: "a" }, "match", "b")).toBe("false_merge");
    expect(judge({ name: "x", expected: "a", mustReview: true }, "match", "a")).toBe("unsafe_auto_merge");
    expect(judge({ name: "x", expected: "a", acceptReview: true }, "review", "a")).toBe("correct");
    expect(judge({ name: "x", expected: "a" }, "new", "NEW")).toBe("missed_match");
  });

  it("the synthetic set has no false merges", async () => {
    const { falseMerges, results } = await runResolverEval("evals/resolver/synthetic");
    expect(results.length).toBeGreaterThan(30);
    expect(falseMerges).toBe(0);
  }, 60_000);
});
