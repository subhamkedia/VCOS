import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../lib/db.js";
import { testDb } from "./helpers.js";
import { checkProfile, getProfile, profileHistory, saveProfile, starterProfile, ProfileInvalid, type FirmProfile } from "../modules/firm/profile.js";
import { geographyMatches, thesisFit } from "../modules/sourcing/fit.js";
import type { ClaimRow } from "../ledger/contradictions.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

const claim = (id: string, predicate: string, value: unknown, as_of: string | null = null): ClaimRow => ({
  id, subject_id: "e", predicate, value, as_of, source_type: "third_party", evidence_id: "ev", cited_text: null,
});

describe("firm profile", () => {
  it("starts from thesis.yaml with the firm's name", async () => {
    const p = await starterProfile("Alpha Ventures");
    expect(p.firm.name).toBe("Alpha Ventures");
    expect(p.fund.name).toBe("Alpha Ventures Fund I");
    expect(p.mandate.stages).toEqual(["pre_seed", "seed", "series_a"]);
    expect(p.mandate.sectors.map((s) => s.id)).toContain("construction-tech");
    expect(p.scoring.dimensions.reduce((a, d) => a + d.weight, 0)).toBeCloseTo(1);
  });

  it("explains what's wrong, field by field", async () => {
    const p = await starterProfile("Alpha");
    const bad = { ...p, mandate: { ...p.mandate, stages: [], checkSizeUsd: { min: 5_000_000, max: 1_000_000 } }, scoring: { dimensions: [{ ...p.scoring.dimensions[0]!, weight: 0.5 }] } };
    const r = checkProfile(bad);
    expect(r.ok).toBe(false);
    const paths = r.ok ? [] : r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["mandate.stages", "mandate.checkSizeUsd", "scoring.dimensions"]));
  });

  it("saves each change as a new version", async () => {
    expect(await getProfile(db)).toBeNull();
    const p = await starterProfile("Alpha");
    expect((await saveProfile(db, p, "human:pat")).version).toBe(1);
    const v2 = await saveProfile(db, { ...p, fund: { ...p.fund, targetSizeUsd: 75_000_000 } }, "human:pat");
    expect(v2.version).toBe(2);
    expect((await getProfile(db))?.profile.fund.targetSizeUsd).toBe(75_000_000);
    expect((await profileHistory(db)).map((h) => h.version)).toEqual([2, 1]);
    await expect(saveProfile(db, { ...p, mandate: { ...p.mandate, geographies: [] } }, "human:pat")).rejects.toThrow(ProfileInvalid);
    await expect(db.query("update thesis_versions set created_by='x'")).rejects.toThrow(/permission denied/);
  });
});

describe("thesis fit", () => {
  let profile: FirmProfile;
  beforeEach(async () => {
    profile = await starterProfile("Alpha");
  });

  it("places locations in target geographies", () => {
    expect(geographyMatches("Pittsburgh, PA", "US")).toBe(true);
    expect(geographyMatches("San Francisco, CA, USA", "US")).toBe(true);
    expect(geographyMatches("Berlin, Germany", "Europe")).toBe(true);
    expect(geographyMatches("Toronto, ON, Canada", "Canada")).toBe(true);
    expect(geographyMatches("Bengaluru, India", "US")).toBe(false);
    expect(geographyMatches("Paris, France", "US")).toBe(false);
  });

  it("scores a clear fit, citing the claims it used", () => {
    const fit = thesisFit(profile, [
      claim("d", "company.description", "Autonomous rebar-tying robots for bridge decks and parking structures."),
      claim("h", "company.hq_location", "Pittsburgh, PA"),
      claim("s", "funding.round.stage", "seed", "2026-06-01"),
    ]);
    expect(fit.verdict).toBe("strong");
    expect(fit.score).toBe(100);
    expect(fit.sectors).toContain("physical-ai");
    expect(fit.reasons.find((r) => r.criterion === "sector")?.claimIds).toEqual(["d"]);
  });

  it("counts missing facts as unknown, not as a pass", () => {
    const fit = thesisFit(profile, [claim("d", "company.description", "Robotics for construction jobsites")]);
    expect(fit.score).toBe(75); // sector 50 + half of geography + half of stage
    expect(fit.reasons.filter((r) => r.result === "unknown").map((r) => r.criterion)).toEqual(["geography", "stage"]);
  });

  it("marks off-thesis and excluded companies", () => {
    expect(thesisFit(profile, [claim("d", "company.description", "A dating app for pet owners"), claim("h", "company.hq_location", "Austin, TX")]).verdict).toBe("weak");
    const ex = { ...profile, mandate: { ...profile.mandate, exclusions: ["consumer"] } };
    const fit = thesisFit(ex, [claim("d", "company.description", "Consumer robotics for home cleaning")]);
    expect(fit.verdict).toBe("excluded");
    expect(fit.score).toBe(0);
  });

  it("takes the latest round for stage", () => {
    const fit = thesisFit(profile, [claim("a", "funding.round.stage", "seed", "2024-01-01"), claim("b", "funding.round.stage", "series_c", "2026-01-01")]);
    expect(fit.reasons.find((r) => r.criterion === "stage")).toMatchObject({ result: "fail", claimIds: ["b"] });
  });
});

describe("stemming", () => {
  it("lets word forms meet", async () => {
    const { stem } = await import("../modules/sourcing/fit.js");
    for (const [a, b] of [["robots", "robotics"], ["autonomous", "autonomy"], ["buildings", "building"], ["construction", "constructing"], ["manufacturers", "manufacturing"]])
      expect(stem(a!)).toBe(stem(b!));
    expect(stem("AI")).toBe("ai");
  });
});
