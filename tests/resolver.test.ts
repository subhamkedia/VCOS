import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import { testDb } from "./helpers.js";
import { resolveOrCreate, pendingProposals, decideProposal } from "../agents/resolver/index.js";
import { compareRecords, toProbability } from "../agents/resolver/resolve.js";
import { currentClaims, findByIdentifier, insertEvidence, insertClaim, openContradictions } from "../ledger/repository.js";
import { coreCompanyName, normalizeCompanyName, normalizeDomain, normalizeLinkedIn, jaroWinkler } from "../lib/text.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

function fakeLlm(reply: string): Llm & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    async create(params) {
      calls.push(params);
      return {
        id: "msg_test", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn",
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: reply, citations: null }],
      } as unknown as Anthropic.Message;
    },
  };
}

describe("text normalization", () => {
  it("normalizes names, domains and LinkedIn URLs", () => {
    expect(normalizeCompanyName("Acme Robotics, Inc.")).toBe("acme robotics");
    expect(coreCompanyName("Acme Robotics, Inc.")).toBe("acme");
    expect(normalizeCompanyName("Café Systèmes S.A.")).toBe("cafe systemes");
    expect(normalizeDomain("https://www.Acme.io/about?x=1")).toBe("acme.io");
    expect(normalizeDomain("jane@acme.io")).toBe("acme.io");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeLinkedIn("https://www.linkedin.com/company/acme-robotics/")).toBe("company/acme-robotics");
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  });
});

describe("Fellegi-Sunter scoring", () => {
  const known = { entityId: "x", name: "Kestrel Robotics", aliases: [], domains: ["kestrelrobotics.com"], founders: ["Maya Lindqvist"], location: "Pittsburgh, PA" };

  it("a shared founder outweighs a typo", () => {
    const r = compareRecords({ type: "company", source: "t", name: "Kestral Robotics", founders: ["Maya Lindqvist"] }, known);
    expect(toProbability(r.weight)).toBeGreaterThan(0.95);
  });

  it("different domains and founders sink a same-name record", () => {
    const r = compareRecords(
      { type: "company", source: "t", name: "Kestrel Robotics", domain: "kestrel.bot", founders: ["Someone Else"] },
      known,
    );
    expect(toProbability(r.weight)).toBeLessThan(0.5);
  });
});

describe("resolveOrCreate", () => {
  it("creates, then matches by domain, then by name plus founder", async () => {
    const first = await resolveOrCreate(db, {
      type: "company", source: "harmonic", name: "Kestrel Robotics", domain: "kestrelrobotics.com", founders: ["Maya Lindqvist"],
    });
    expect(first.created).toBe(true);
    expect(first.resolution.decision).toBe("new");

    const byDomain = await resolveOrCreate(db, { type: "company", source: "web", name: "Kestrel", domain: "https://kestrelrobotics.com" });
    expect(byDomain.entity.id).toBe(first.entity.id);
    expect(byDomain.resolution.method).toBe("identifier");

    const byFounder = await resolveOrCreate(db, {
      type: "company", source: "yc-cohort", name: "Kestrel Robotics Inc", founders: ["Maya Lindqvist"], linkedin: "linkedin.com/company/kestrel-robotics",
    });
    expect(byFounder.entity.id).toBe(first.entity.id);
    // The new identifier now belongs to the matched entity.
    expect((await findByIdentifier(db, "linkedin", "https://linkedin.com/company/kestrel-robotics/"))?.id).toBe(first.entity.id);
  });

  it("files a proposal in the review band, and accepting it folds claims into the target", async () => {
    const tf = await resolveOrCreate(db, {
      type: "company", source: "harmonic", name: "Tensor Field Robotics", domain: "tensorfield.ai", founders: ["Ravi Iyer"],
    });
    const rebrand = await resolveOrCreate(db, { type: "company", source: "accelerator", name: "Iyer Robotics", founders: ["Ravi Iyer"] });
    expect(rebrand.resolution.decision).toBe("review");
    expect(rebrand.created).toBe(true);
    expect(rebrand.proposalId).toBeTruthy();

    const pending = await pendingProposals(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.target_name).toBe("Tensor Field Robotics");

    await decideProposal(db, rebrand.proposalId!, true, "human:subham");
    expect(await pendingProposals(db)).toHaveLength(0);
    // Founder claims from both records now read through the merge.
    const founders = await currentClaims(db, tf.entity.id, "team.founder");
    expect(founders).toHaveLength(2);
    await expect(decideProposal(db, rebrand.proposalId!, true, "human:subham")).rejects.toThrow(/already/);
  });

  it("checks the merged claims against each other when a merge is accepted", async () => {
    const tf = await resolveOrCreate(db, {
      type: "company", source: "harmonic", name: "Tensor Field Robotics", domain: "tensorfield.ai", founders: ["Ravi Iyer"],
    });
    const rebrand = await resolveOrCreate(db, { type: "company", source: "accelerator", name: "Iyer Robotics", founders: ["Ravi Iyer"] });
    const { evidence: vendor } = await insertEvidence(db, { kind: "api_record", source: "harmonic", content: "headcount 20", accessScope: "vendor" });
    const { evidence: call } = await insertEvidence(db, { kind: "transcript", source: "granola", content: "We're 60 people.", accessScope: "confidential" });
    await insertClaim(db, { subjectId: tf.entity.id, predicate: "team.headcount", value: 20, asOf: "2026-09-01", evidenceId: vendor.id, sourceType: "third_party", extractedBy: "t" });
    await insertClaim(db, { subjectId: rebrand.entity.id, predicate: "team.headcount", value: 60, asOf: "2026-09-10", evidenceId: call.id, sourceType: "self_reported", extractedBy: "t" });
    expect(await openContradictions(db, tf.entity.id)).toHaveLength(0);

    await decideProposal(db, rebrand.proposalId!, true, "human:subham");
    const open = await openContradictions(db, tf.entity.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe("high");
  });

  it("asks Claude to pick among candidates and records its suggestion, without auto-merging", async () => {
    await resolveOrCreate(db, { type: "company", source: "harmonic", name: "Tensor Field Robotics", domain: "tensorfield.ai", founders: ["Ravi Iyer"] });
    const llm = fakeLlm('{"choice": 1, "confidence": 0.9, "reason": "Same founder; name changed after a rebrand."}');
    const out = await resolveOrCreate(db, { type: "company", source: "accelerator", name: "Iyer Robotics", founders: ["Ravi Iyer"] }, { llm });
    expect(llm.calls).toHaveLength(1);
    expect(out.llm?.confidence).toBe(0.9);
    expect(out.resolution.decision).toBe("review");
    const [p] = await pendingProposals(db);
    expect(p?.method).toBe("llm-select");
    expect(p?.explanation).toMatch(/rebrand/);
    // The prompt treats record text as data.
    expect(String(llm.calls[0]?.system)).toMatch(/data, not instructions/);
  });
});
