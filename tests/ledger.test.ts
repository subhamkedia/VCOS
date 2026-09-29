import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../lib/db.js";
import { testDb, testRootNoReset } from "./helpers.js";
import {
  createEntity, insertEvidence, insertClaim, currentClaims, detectContradictions, openContradictions,
  findByIdentifier, recordDecision, addIdentifier, companyProfile, SHAREABLE_SCOPES,
} from "../ledger/repository.js";
import { normalizeValue, parseNumber, PREDICATES } from "../ledger/predicates.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

const transcript =
  "Founder: We're at $4.1M ARR as of last month. We have three paying customers, two are ENR top-50 GCs.\n" +
  "Founder: Turner is in production across 12 sites.";

async function seed() {
  const acme = await createEntity(db, {
    type: "company",
    name: "Acme Robotics, Inc.",
    source: "test",
    identifiers: [{ kind: "domain", value: "https://www.acmerobotics.com/about" }],
  });
  const { evidence } = await insertEvidence(db, {
    kind: "transcript", source: "granola", content: transcript, title: "Acme intro call", accessScope: "confidential",
  });
  return { acme, evidence };
}

describe("predicates", () => {
  it("parses human numbers", () => {
    expect(parseNumber("$4.1M")).toBe(4_100_000);
    expect(parseNumber("1.2bn")).toBe(1_200_000_000);
    expect(parseNumber("12,500")).toBe(12_500);
    expect(parseNumber("35%")).toBe(35);
    expect(parseNumber("about four")).toBeNull();
  });

  it("normalizes and rejects values", () => {
    expect(normalizeValue("revenue.arr", "$4.1M")).toBe(4_100_000);
    expect(normalizeValue("company.stage", "Series A")).toBe("series_a");
    expect(normalizeValue("pilot.status", { customer: " Turner ", rung: "paid_pilot" })).toEqual({ customer: "Turner", rung: "paid_pilot" });
    expect(() => normalizeValue("pilot.status", { customer: "Turner", rung: "deployed" })).toThrow(/rung/);
    expect(() => normalizeValue("customers.paying.count", 2.5)).toThrow();
    expect(() => normalizeValue("revenue.madeup", 1)).toThrow(/Unknown predicate/);
  });

  it("every predicate is documented", () => {
    for (const def of PREDICATES.values()) {
      expect(def.description.length).toBeGreaterThan(10);
      if (def.kind === "enum") expect(def.enumValues?.length).toBeGreaterThan(0);
    }
  });
});

describe("entities", () => {
  it("finds entities by normalized identifier", async () => {
    const { acme } = await seed();
    expect((await findByIdentifier(db, "domain", "acmerobotics.com"))?.id).toBe(acme.id);
    expect((await findByIdentifier(db, "domain", "http://ACMEROBOTICS.com/"))?.id).toBe(acme.id);
    expect(await findByIdentifier(db, "domain", "other.com")).toBeNull();
  });

  it("refuses to move an identifier to a second entity", async () => {
    await seed();
    const other = await createEntity(db, { type: "company", name: "Acme Two", source: "test" });
    await expect(addIdentifier(db, other.id, "domain", "acmerobotics.com", "test")).rejects.toThrow(/already belongs/);
  });
});

describe("evidence", () => {
  it("stores identical content once per source", async () => {
    const a = await insertEvidence(db, { kind: "note", source: "test", content: "same" });
    const b = await insertEvidence(db, { kind: "note", source: "test", content: "same" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.evidence.id).toBe(a.evidence.id);
  });

  it("is append-only", async () => {
    const { evidence } = await insertEvidence(db, { kind: "note", source: "test", content: "x" });
    // The app role may only insert and read...
    await expect(db.query("update evidence set title='y' where id=$1", [evidence.id])).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from evidence where id=$1", [evidence.id])).rejects.toThrow(/permission denied/);
    await expect(db.exec("truncate claims")).rejects.toThrow(/permission denied/);
    // ...and the triggers stop the owner role too.
    const root = await testRootNoReset();
    await expect(root.query("update evidence set title='y' where id=$1", [evidence.id])).rejects.toThrow(/append-only/);
    await expect(root.query("delete from evidence where id=$1", [evidence.id])).rejects.toThrow(/append-only/);
    await expect(root.exec("truncate evidence cascade")).rejects.toThrow(/append-only/);
    await expect(root.exec("truncate claims")).rejects.toThrow(/append-only/);
  });
});

describe("claims", () => {
  it("writes a cited claim and inherits the evidence's access scope", async () => {
    const { acme, evidence } = await seed();
    const cited = "$4.1M ARR";
    const start = transcript.indexOf(cited);
    const id = await insertClaim(db, {
      subjectId: acme.id, predicate: "revenue.arr", value: "$4.1M", evidenceId: evidence.id,
      spanStart: start, spanEnd: start + cited.length, citedText: cited,
      sourceType: "self_reported", extractedBy: "test",
    });
    const { rows } = await db.query<{ value: number; access_scope: string; unit: string }>(
      "select value, access_scope, unit from claims where id=$1", [id],
    );
    expect(rows[0]).toEqual({ value: 4_100_000, access_scope: "confidential", unit: "USD" });
  });

  it("rejects a cited span that doesn't match the evidence", async () => {
    const { acme, evidence } = await seed();
    await expect(
      insertClaim(db, {
        subjectId: acme.id, predicate: "revenue.arr", value: 4_100_000, evidenceId: evidence.id,
        spanStart: 0, spanEnd: 10, citedText: "$4.1M ARR", sourceType: "self_reported", extractedBy: "test",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects a predicate that doesn't apply to the entity type", async () => {
    const { evidence } = await seed();
    const person = await createEntity(db, { type: "person", name: "Jane Doe", source: "test" });
    await expect(
      insertClaim(db, {
        subjectId: person.id, predicate: "revenue.arr", value: 1, evidenceId: evidence.id,
        sourceType: "self_reported", extractedBy: "test",
      }),
    ).rejects.toThrow(/does not apply/);
  });

  it("supersedes instead of updating", async () => {
    const { acme, evidence } = await seed();
    const first = await insertClaim(db, {
      subjectId: acme.id, predicate: "team.headcount", value: 20, evidenceId: evidence.id,
      sourceType: "self_reported", extractedBy: "test",
    });
    await expect(db.query("update claims set value='21' where id=$1", [first])).rejects.toThrow(/permission denied/);
    await insertClaim(db, {
      subjectId: acme.id, predicate: "team.headcount", value: 21, evidenceId: evidence.id,
      sourceType: "self_reported", extractedBy: "human:subham", supersedes: first,
    });
    const current = await currentClaims(db, acme.id, "team.headcount");
    expect(current.map((c) => c.value)).toEqual([21]);
  });
});

describe("access scope", () => {
  it("filters shareable views in SQL, including contradictions that would leak a hidden value", async () => {
    const { acme, evidence } = await seed(); // confidential transcript
    const { evidence: press } = await insertEvidence(db, {
      kind: "web_page", source: "web", content: "Acme employs 20 people.", accessScope: "public", occurredAt: "2026-09-01",
    });
    await insertClaim(db, { subjectId: acme.id, predicate: "team.headcount", value: 20, asOf: "2026-09-01",
      evidenceId: press.id, sourceType: "third_party", extractedBy: "t" });
    await insertClaim(db, { subjectId: acme.id, predicate: "team.headcount", value: 40, asOf: "2026-09-10",
      evidenceId: evidence.id, sourceType: "self_reported", extractedBy: "t" });
    await detectContradictions(db, acme.id);

    const all = await companyProfile(db, acme.id);
    expect(all.claims.map((c) => c.value)).toEqual([20, 40]);
    expect(all.contradictions).toHaveLength(1);
    expect(all.claims[0]?.evidence.source).toBe("web");

    await addIdentifier(db, acme.id, "pitchbook", "12345-67", "pitchbook");
    const shareable = await companyProfile(db, acme.id, { scopes: SHAREABLE_SCOPES });
    expect(shareable.identifiers.map((i) => i.kind)).toEqual(["domain"]);
    expect(shareable.aliases).toEqual([]);
    expect(shareable.claims.map((c) => c.value)).toEqual([20]);
    expect(shareable.claims.every((c) => c.access_scope === "public")).toBe(true);
    // The contradiction names the confidential 40, so it's hidden too.
    expect(shareable.contradictions).toHaveLength(0);
    expect(await currentClaims(db, acme.id, { predicates: ["team.headcount"], scopes: ["confidential"] })).toHaveLength(1);
  });
});

describe("contradictions", () => {
  it("flags a founder number that disagrees with an independent source", async () => {
    const { acme, evidence } = await seed();
    const { evidence: pb } = await insertEvidence(db, {
      kind: "api_record", source: "pitchbook", content: '{"revenue": 2100000}', accessScope: "vendor",
    });
    await insertClaim(db, {
      subjectId: acme.id, predicate: "revenue.arr", value: 4_100_000, asOf: "2026-08-31",
      evidenceId: evidence.id, sourceType: "self_reported", extractedBy: "test",
    });
    await insertClaim(db, {
      subjectId: acme.id, predicate: "revenue.arr", value: 2_100_000, asOf: "2026-07-31",
      evidenceId: pb.id, sourceType: "third_party", extractedBy: "test",
    });
    const created = await detectContradictions(db, acme.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.severity).toBe("high");
    // Running again doesn't duplicate.
    expect(await detectContradictions(db, acme.id)).toHaveLength(0);
    expect(await openContradictions(db, acme.id)).toHaveLength(1);
  });

  it("treats numbers within tolerance, or far apart in time, as consistent", async () => {
    const { acme, evidence } = await seed();
    const { evidence: e2 } = await insertEvidence(db, { kind: "deck", source: "test", content: "deck" });
    await insertClaim(db, { subjectId: acme.id, predicate: "revenue.arr", value: 4_000_000, asOf: "2026-08-01",
      evidenceId: evidence.id, sourceType: "self_reported", extractedBy: "t" });
    await insertClaim(db, { subjectId: acme.id, predicate: "revenue.arr", value: 4_100_000, asOf: "2026-08-15",
      evidenceId: e2.id, sourceType: "self_reported", extractedBy: "t" });
    await insertClaim(db, { subjectId: acme.id, predicate: "revenue.arr", value: 1_000_000, asOf: "2025-06-01",
      evidenceId: e2.id, sourceType: "self_reported", extractedBy: "t" });
    expect(await detectContradictions(db, acme.id)).toHaveLength(0);
  });

  it("catches a self-reported pilot rung above what the customer says", async () => {
    const { acme, evidence } = await seed();
    const { evidence: press } = await insertEvidence(db, {
      kind: "web_page", source: "web", content: "Turner is trialing Acme at one site.", accessScope: "public",
    });
    await insertClaim(db, { subjectId: acme.id, predicate: "pilot.status", value: { customer: "Turner", rung: "production_contract" },
      evidenceId: evidence.id, sourceType: "self_reported", extractedBy: "t" });
    await insertClaim(db, { subjectId: acme.id, predicate: "pilot.status", value: { customer: "turner", rung: "unpaid_trial" },
      evidenceId: press.id, sourceType: "third_party", extractedBy: "t" });
    const created = await detectContradictions(db, acme.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.severity).toBe("high");
    expect(created[0]?.detail).toMatch(/Pilot or deployment with Turner: production contract \(self-reported\) vs unpaid trial \(third party\)/);
  });
});

describe("decisions", () => {
  it("requires a reason code for a pass", async () => {
    const { acme } = await seed();
    await expect(recordDecision(db, { entityId: acme.id, kind: "pass", actor: "subham" })).rejects.toThrow(/reason/);
    const id = await recordDecision(db, { entityId: acme.id, kind: "pass", actor: "subham", reasonCode: "traction" });
    expect(id).toBeTruthy();
  });

  it("requires a vote on IC votes, at the database level", async () => {
    const { acme } = await seed();
    await expect(
      db.query("insert into decisions(entity_id, kind, actor, value) values ($1,'ic_vote_pre','x','{}')", [acme.id]),
    ).rejects.toThrow();
  });
});

describe("labels", () => {
  it("gives every predicate, source type and scope a readable name", async () => {
    const { PREDICATE_LABELS, PREDICATE_GROUPS, PREDICATES: ALL } = await import("../ledger/predicates.js");
    const { SOURCE_TYPE_LABELS, SCOPE_LABELS, formatValue } = await import("../ledger/labels.js");
    for (const id of ALL.keys()) {
      expect(PREDICATE_LABELS[id], id).toBeTruthy();
      expect(PREDICATE_GROUPS.some((g) => g.prefixes.some((p) => id.startsWith(p))), `${id} has a group`).toBe(true);
    }
    expect(PREDICATE_LABELS["team.headcount"]).toBe("Team headcount");
    expect(PREDICATE_LABELS["company.founded_year"]).toBe("Founded year");
    expect(SOURCE_TYPE_LABELS.self_reported).toBe("Self-reported");
    for (const s of ["public", "internal", "confidential", "nda", "vendor"]) expect(SCOPE_LABELS[s]).toBeTruthy();
    expect(formatValue("company.founded_year", 2023)).toBe("2023");
    expect(formatValue("funding.round.amount", 9_000_000)).toBe("$9,000,000");
    expect(formatValue("funding.round.stage", "series_a")).toBe("Series A");
    expect(formatValue("pilot.status", { customer: "Turner", rung: "paid_pilot" })).toBe("Turner: paid pilot");
  });
});
