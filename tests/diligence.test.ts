import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { scopedDb, type Db } from "../lib/db.js";
import { config } from "../lib/config.js";
import type { Llm } from "../lib/llm.js";
import { encryptJson } from "../lib/secrets.js";
import { testFirm, testRoot } from "./helpers.js";
import { createFirm } from "../ledger/platform.js";
import { saveConnection } from "../ledger/workspace.js";
import { currentClaims, detectContradictions, insertClaim, insertEvidence } from "../ledger/repository.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import {
  addItem, addNote, addQuestion, deals, dealView, decide, draftMemoFor, gather, memo, queueQuestionsEmail, recordRound,
  refreshQuestions, resolveContradiction, setItem, startDeal, updateDealInfo, updateQuestion,
} from "../modules/diligence/index.js";
import { checkMemo, numbersIn, type Citable } from "../modules/diligence/memo-check.js";
import { evaluateChecklist, suggestFlags } from "../modules/diligence/checklist.js";
import { pending } from "../modules/outbox/index.js";
import type { SourceRecord } from "../connectors/types.js";

// Fictional firm and companies throughout.

beforeAll(() => testRoot());
beforeEach(() => {
  config.patentsviewApiKey = "pv-key";
  Object.assign(config, { googleClientId: "gid", googleClientSecret: "gsecret" });
});

const BY = "human:pat@northbeam.vc";

async function firm() {
  const { root, db } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, {
    ...p,
    fund: { ...p.fund, committedUsd: 100e6, managementFeePct: 2, investmentPeriodYears: 5, termYears: 10, reservesPct: 50, targetInvestments: 25, maxConcentrationPct: 10 },
    mandate: { ...p.mandate, checkSizeUsd: { min: 1e6, max: 4e6 }, targetOwnershipPct: { min: 8, max: 15 } },
  }, BY);
  return { root, db };
}

const site = (content: string, claims: SourceRecord["claims"] = []): SourceRecord => ({
  evidence: { kind: "web_page", source: "company-site", uri: "https://kestrelrobotics.example/", title: "Kestrel Robotics", content, accessScope: "public" },
  subject: { type: "company", name: "Kestrel Robotics", domain: "kestrelrobotics.example", source: "company-site" },
  sourceType: "self_reported", claims,
});

async function dealWithResearch(db: Db) {
  const { id } = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, BY);
  const { done } = await gather(db, id, BY, {
    only: ["company-site", "uspto", "harmonic"],
    run: {
      "company-site": async () => [site("Site description: Autonomous rebar-tying robots for bridge decks. We are a team of 34 in Pittsburgh.", [
        { predicate: "company.description", value: "Autonomous rebar-tying robots for bridge decks.", citedText: "Autonomous rebar-tying robots for bridge decks." },
        { predicate: "team.headcount", value: 34, asOf: "2026-09-01", citedText: "We are a team of 34" },
      ])],
      uspto: async () => [{
        evidence: { kind: "api_record", source: "uspto", uri: "patentsview:assignee:Kestrel Robotics", title: "USPTO patents", content: "US 11999001: Rebar tying end effector (granted 2025-06-03)", accessScope: "public" },
        sourceType: "primary", claims: [{ predicate: "ip.patent", value: "US 11999001: Rebar tying end effector", asOf: "2025-06-03", citedText: "US 11999001: Rebar tying end effector" }],
      }],
    },
  });
  const results = await done;
  return { id, results };
}

describe("starting a deal and gathering everything", () => {
  it("starts one deal per company and reuses the open one", async () => {
    const { db } = await firm();
    const a = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "https://www.kestrelrobotics.example/about" } }, BY);
    expect(a.existing).toBe(false);
    const b = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, BY);
    expect(b).toEqual({ id: a.id, existing: true });
    await expect(startDeal(db, { company: { name: "X", domain: "not a domain" } }, BY)).rejects.toThrow(/look like/);
    expect((await deals(db)).map((d) => d.company_name)).toEqual(["Kestrel Robotics"]);
  });

  it("runs every usable source onto this company and says which were skipped and why", async () => {
    const { db } = await firm();
    const { id, results } = await dealWithResearch(db);
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by["company-site"]).toMatchObject({ status: "ok", records: 1, newEvidence: 1, claims: 2 });
    expect(by.uspto).toMatchObject({ status: "ok", claims: 1 });
    expect(by.harmonic).toMatchObject({ status: "skipped", detail: "Not connected" });
    const v = await dealView(db, id);
    expect(v.claims.map((c) => c.predicate).sort()).toEqual(["company.description", "ip.patent", "team.headcount"]);
    expect(v.runs[0]).toMatchObject({ kind: "diligence:gather", status: "done" });
    // Nothing was filed under a namesake: the research went onto the deal's company.
    expect(new Set(v.claims.map((c) => c.subject_id))).toEqual(new Set([v.company.id]));
  });
});

describe("checklist, questions and readiness", () => {
  it("evaluates items against the ledger: missing, self-reported, verified", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    let v = await dealView(db, id);
    const item = (k: string) => v.checklist.find((i) => i.key === k)!;
    expect(item("team.headcount").state).toBe("self_reported");
    expect(item("product.ip").state).toBe("evidenced");
    expect(item("traction.revenue").state).toBe("missing");
    expect(item("team.references")).toMatchObject({ state: "missing", detail: "0 of 3 notes logged." });
    expect(v.readiness.ready).toBe(false);
    expect(v.questions.map((q) => q.key)).toEqual(expect.arrayContaining(["gap:traction.revenue", "verify:team.headcount"]));

    // An independent source verifies headcount; the verify question closes itself.
    const { evidence } = await insertEvidence(db, { kind: "api_record", source: "harmonic", content: "headcount 33", accessScope: "vendor" });
    await insertClaim(db, { subjectId: v.company.id, predicate: "team.headcount", value: 33, asOf: "2026-09-05", evidenceId: evidence.id, sourceType: "third_party", extractedBy: "t" });
    const qs = await refreshQuestions(db, id);
    expect(qs.find((q) => q.key === "verify:team.headcount")).toMatchObject({ status: "answered" });
    v = await dealView(db, id);
    expect(v.checklist.find((i) => i.key === "team.headcount")!.state).toBe("verified");
  });

  it("lets people mark items, add their own, and requires a reason for red flags and not-applicable", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    await expect(setItem(db, id, "legal.litigation", { status: "red_flag" }, BY)).rejects.toThrow(/red flag is/);
    await setItem(db, id, "legal.litigation", { status: "red_flag", note: "Pending suit from a former co-founder." }, BY);
    await expect(setItem(db, id, "legal.corporate", { status: "na" }, BY)).rejects.toThrow(/doesn't apply/);
    await setItem(db, id, "legal.corporate", { status: "done", assignee: "human:lee@northbeam.vc" }, BY);
    const key = await addItem(db, id, { workstream: "product", title: "Visit the Pittsburgh test site" }, BY);
    const v = await dealView(db, id);
    expect(v.checklist.find((i) => i.key === "legal.litigation")).toMatchObject({ state: "red_flag", note: "Pending suit from a former co-founder." });
    expect(v.checklist.find((i) => i.key === "legal.corporate")).toMatchObject({ state: "done", assignee: "human:lee@northbeam.vc", complete: true });
    expect(v.checklist.find((i) => i.key === key)).toMatchObject({ custom: true, title: "Visit the Pittsburgh test site", state: "open" });
    expect(v.readiness.redFlags).toEqual([{ key: "legal.litigation", title: "Litigation and liabilities" }]);
  });

  it("adds hardware sections when the ledger says it's a physical product", () => {
    const flags = suggestFlags([{ id: "1", subject_id: "s", predicate: "company.description", value: "Autonomous rebar-tying robots for bridge decks.", as_of: null, source_type: "self_reported", evidence_id: "e", cited_text: null }]);
    expect(flags).toEqual({ hardware: true, regulated: true, sensitive_tech: true });
    const base = { claims: [], notes: [], items: [], fit: null, fundFit: null };
    const without = evaluateChecklist({ ...base, flags: {} }).map((i) => i.key);
    const withHw = evaluateChecklist({ ...base, flags: { hardware: true } }).map((i) => i.key);
    expect(without).not.toContain("product.manufacturing");
    expect(withHw).toEqual(expect.arrayContaining(["product.manufacturing", "product.trl", "traction.pilots", "economics.hardware_costs"]));
  });

  it("logs reference and customer calls as confidential notes that count toward the checklist", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    for (const who of ["former manager", "co-founder at prior company", "backchannel: ex-employee"]) {
      await addNote(db, id, { kind: "reference", title: `Reference: ${who}`, text: `Spoke with a ${who}. Strong on execution, hires well, sometimes over-commits on timelines.` }, BY);
    }
    await expect(addNote(db, id, { kind: "reference", title: "x", text: "short" }, BY)).rejects.toThrow(/sentence/);
    const v = await dealView(db, id);
    expect(v.checklist.find((i) => i.key === "team.references")).toMatchObject({ state: "evidenced", noteCount: 3 });
    expect(v.notes).toHaveLength(3);
    const { rows } = await db.query<{ access_scope: string }>("select distinct access_scope from evidence where source = 'diligence-note'");
    expect(rows).toEqual([{ access_scope: "confidential" }]);
  });

  it("queues founder questions as an email draft for approval, never sends", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    const qs = await refreshQuestions(db, id);
    const custom = await addQuestion(db, id, { workstream: "product", text: "Can we see the robot on a live pour?" }, BY);
    await expect(queueQuestionsEmail(db, id, { to: ["maya@kestrelrobotics.example"], questionIds: [custom] }, BY)).rejects.toThrow(/Connect Gmail or Outlook/);
    await saveConnection(db, { connectorId: "gmail", credentials: encryptJson({ googleRefreshToken: "r" }), connectedBy: BY });
    const out = await queueQuestionsEmail(db, id, { to: ["maya@kestrelrobotics.example"], questionIds: [custom, qs[0]!.id] }, BY);
    expect(out.channel).toBe("gmail_draft");
    const [item] = await pending(db);
    expect(item!.payload).toMatchObject({ to: ["maya@kestrelrobotics.example"], subject: "Kestrel Robotics: questions from our diligence" });
    expect(String(item!.payload.body)).toContain("Can we see the robot on a live pour?");
    const after = (await dealView(db, id)).questions;
    expect(after.find((q) => q.id === custom)!.status).toBe("asked");
    await updateQuestion(db, id, custom, { status: "answered", answer: "Demo booked for 2026-10-14." }, BY);
  });
});

describe("the round and the fund", () => {
  it("records terms as claims and checks the check against the mandate", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    await recordRound(db, id, { raiseUsd: 12e6, preMoneyUsd: 48e6, stage: "series_a", leadInvestor: "Summit Partners", source: "term_sheet", date: "2026-09-20" }, BY);
    await updateDealInfo(db, id, { ourCheckUsd: 3e6 }, BY);
    const v = await dealView(db, id);
    expect(v.round.raise.map((r) => r.display)).toEqual(["$12M", "Series A", "$48M", "Summit Partners"]);
    expect(v.round.raise.every((r) => r.source_type === "primary")).toBe(true);
    expect(v.round.math.postMoneyUsd).toBe(60e6);
    expect(v.round.math.ownershipPct).toBeCloseTo(5);
    expect(v.round.math.checks.ownership?.ok).toBe(false);
    expect(v.checklist.find((i) => i.key === "financing.fund_fit")).toMatchObject({ state: "flagged" });
    await expect(updateDealInfo(db, id, { ourCheckUsd: -1 }, BY)).rejects.toThrow();
    await expect(recordRound(db, id, { source: "founder" }, BY)).rejects.toThrow(/at least one term/);
  });
});

describe("the contradiction board", () => {
  it("explains or settles a disagreement; settling supersedes, never edits", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    const v0 = await dealView(db, id);
    const { evidence } = await insertEvidence(db, { kind: "api_record", source: "harmonic", content: "headcount 21", accessScope: "vendor" });
    await insertClaim(db, { subjectId: v0.company.id, predicate: "team.headcount", value: 21, asOf: "2026-09-03", evidenceId: evidence.id, sourceType: "third_party", extractedBy: "t" });
    const [x] = await detectContradictions(db, v0.company.id);
    expect(x).toBeDefined();
    const v1 = await dealView(db, id);
    expect(v1.contradictions).toHaveLength(1);
    expect(v1.questions.some((q) => q.origin === "contradiction")).toBe(true);
    await expect(resolveContradiction(db, id, x!.id, { status: "resolved" }, BY)).rejects.toThrow(/Write a note/);
    const vendor = v1.claims.find((c) => c.predicate === "team.headcount" && c.value === 21)!;
    await resolveContradiction(db, id, x!.id, { status: "resolved", keepClaimId: vendor.id, note: "Payroll export shows 21 full-time; 34 counts contractors." }, BY);
    const v2 = await dealView(db, id);
    expect(v2.contradictions).toHaveLength(0);
    expect(v2.settled[0]).toMatchObject({ status: "resolved", resolved_by: BY });
    const headcount = (await currentClaims(db, v0.company.id, "team.headcount")).map((c) => [c.value, c.source_type]);
    expect(headcount).toEqual([[21, "third_party"], [21, "internal"]]);
    // The original 34 still exists: it's superseded, not deleted.
    expect((await db.query<{ n: number }>("select count(*)::int as n from claims where predicate = 'team.headcount'")).rows[0]!.n).toBe(3);
    expect(v2.questions.find((q) => q.origin === "contradiction")!.status).toBe("answered");
  });
});

describe("the IC memo", () => {
  it("drafts a memo where every fact cites a claim, saves versions, and exports Markdown", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    await recordRound(db, id, { raiseUsd: 12e6, preMoneyUsd: 48e6, stage: "series_a", source: "founder" }, BY);
    await updateDealInfo(db, id, { ourCheckUsd: 3e6 }, BY);
    const v1 = await draftMemoFor(db, id, {}, BY);
    expect(v1.version).toBe(1);
    const check = v1.check_result as { ok: boolean; rejected: unknown[]; facts: number; cited: number };
    expect(check.ok).toBe(true);
    const m = (await memo(db, id))!;
    const facts = (m.body as { sections: { sentences: { kind: string; cites: string[]; text: string }[] }[] }).sections.flatMap((s) => s.sentences).filter((s) => s.kind === "fact");
    expect(facts.length).toBeGreaterThan(3);
    expect(facts.every((f) => f.cites.length > 0)).toBe(true);
    expect(facts.map((f) => f.text)).toEqual(expect.arrayContaining([
      "Kestrel Robotics: Autonomous rebar-tying robots for bridge decks.",
      "Raising $12M in a Series A round at a proposed $48M pre-money valuation.",
      "At our $3M check, entry ownership would be 5.0% at a $60M post-money valuation.",
    ]));
    expect(m.markdown).toMatch(/\[\^1\]: /);
    expect(Object.values(m.refs).some((r) => r.label === "Patent")).toBe(true);
    const v2 = await draftMemoFor(db, id, {}, BY);
    expect(v2.version).toBe(2);
    await expect(db.query("update memos set shareable = true where version = 1")).rejects.toThrow(/append-only|permission denied/);
  });

  it("a shareable memo uses public claims only and leaves out the fund's own numbers", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    await recordRound(db, id, { raiseUsd: 12e6, source: "founder" }, BY); // confidential note
    await updateDealInfo(db, id, { ourCheckUsd: 3e6 }, BY);
    await draftMemoFor(db, id, { shareable: true }, BY);
    const m = (await memo(db, id))!;
    const text = JSON.stringify(m.body);
    expect(text).toContain("Autonomous rebar-tying robots");
    expect(text).not.toContain("$12M");
    expect(text).not.toContain("calc:");
    expect(text).not.toContain("Recommendation");
    expect(m.shareable).toBe(true);
  });

  it("drops what Claude writes without support, and keeps what's cited", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    const v = await dealView(db, id);
    const headcount = v.claims.find((c) => c.predicate === "team.headcount")!;
    let prompt = "";
    const llm: Llm = {
      async create(params) {
        prompt = String(params.messages[0]!.content);
        const short = prompt.match(/\[(C\d+)\] Team headcount = 34/)![1];
        const reply = JSON.stringify({ sections: [
          { id: "team", sentences: [
            { text: "The company says it has 34 people.", cites: [short], kind: "fact" },
            { text: "The team has grown 50% this year.", cites: [short], kind: "fact" },
            { text: "Hiring looks strong.", cites: [], kind: "fact" },
          ] },
          { id: "risks", sentences: [{ text: "Founder-market fit needs a second reference.", cites: [], kind: "view" }] },
        ] });
        return { id: "m", type: "message", role: "assistant", model: "claude-test", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: reply, citations: null }] } as unknown as Anthropic.Message;
      },
    };
    const saved = await draftMemoFor(db, id, { writer: "claude" }, BY, llm);
    expect(saved.drafted_by).toBe("agent:memo-writer@0.1/claude-test");
    const check = saved.check_result as { rejected: { text: string; reason: string }[] };
    expect(check.rejected.map((r) => r.text)).toEqual(["The team has grown 50% this year.", "Hiring looks strong."]);
    const body = saved.body as { sections: { sentences: { text: string; cites: string[] }[] }[] };
    expect(body.sections.flatMap((s) => s.sentences.map((x) => x.text))).toEqual(["The company says it has 34 people.", "Founder-market fit needs a second reference."]);
    expect(body.sections[0]!.sentences[0]!.cites).toEqual([headcount.id]);
    expect(prompt).toContain("Team headcount = 34");
    expect(prompt).not.toContain("We are a team of 34"); // claims, never raw evidence
    await expect(draftMemoFor(db, id, { writer: "claude" }, BY)).rejects.toThrow(/Claude isn't configured/);
  });
});

describe("the citation check", () => {
  const allowed = new Map<string, Citable>([
    ["c1", { id: "c1", label: "ARR", values: [4_120_000], dates: ["2026-09-01"] }],
    ["c2", { id: "c2", label: "Headcount", values: [34], dates: [] }],
  ]);
  const doc = (text: string, cites: string[], kind: "fact" | "view" = "fact") => ({ title: "t", sections: [{ id: "s", heading: "S", sentences: [{ text, cites, kind }] }] });
  const ok = (text: string, cites: string[], kind: "fact" | "view" = "fact") => checkMemo(doc(text, cites, kind), allowed).result.ok;

  it("accepts numbers written to the precision of what's cited", () => {
    expect(ok("ARR is $4.1M.", ["c1"])).toBe(true);
    expect(ok("ARR is $4M as of 2026-09-01.", ["c1"])).toBe(true);
    expect(ok("ARR is $4,120,000 with 34 people.", ["c1", "c2"])).toBe(true);
    expect(ok("A strong team.", [], "view")).toBe(true);
  });

  it("rejects uncited facts, made-up numbers, unknown citations and wrong dates", () => {
    expect(ok("ARR is growing.", [])).toBe(false);
    expect(ok("ARR is $4.3M.", ["c1"])).toBe(false);
    expect(ok("ARR is $4.12M.", ["c2"])).toBe(false);
    expect(ok("ARR is $4.1M.", ["c9"])).toBe(false);
    expect(ok("ARR is $4.1M as of 2026-08-01.", ["c1"])).toBe(false);
    expect(ok("We think 3x is possible.", [], "view")).toBe(false);
    expect(numbersIn("$4.1M, 34%, 1,250 and 2bn").map((n) => n.value)).toEqual([4_100_000, 34, 1250, 2e9]);
  });
});

describe("decisions", () => {
  it("records a pass with its reason, and needs a reason to go to IC early", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    await expect(decide(db, id, { kind: "advance" }, BY)).rejects.toThrow(/Write why it should go to IC anyway/);
    await expect(decide(db, id, { kind: "pass", reasonCode: "valuation" }, BY)).rejects.toThrow();
    const d = await decide(db, id, { kind: "pass", reasonCode: "valuation", rationale: "Pre-money is 2x where comparable Series A rounds priced." }, BY);
    expect(d!.stage).toBe("passed");
    const v = await dealView(db, id);
    expect(v.decisions[0]).toMatchObject({ kind: "pass", reason_code: "valuation", actor: BY });
    expect((v.decisions[0]!.value as { readiness: { ready: boolean } }).readiness.ready).toBe(false);
    await expect(decide(db, id, { kind: "advance", rationale: "changed our minds entirely" }, BY)).rejects.toThrow(/already passed/);
    // A new deal on the same company can start after a pass.
    expect((await startDeal(db, { companyId: v.company.id }, BY)).existing).toBe(false);
  });

  it("sends to IC early only with a written reason", async () => {
    const { db } = await firm();
    const { id } = await dealWithResearch(db);
    const d = await decide(db, id, { kind: "advance", rationale: "Competitive round closing Friday; IC to review open items live." }, BY);
    expect(d!.stage).toBe("ic");
  });
});

describe("firm isolation", () => {
  it("keeps deals, checklists, questions and memos to their firm", async () => {
    const { root, db } = await firm();
    const { id } = await dealWithResearch(db);
    await setItem(db, id, "legal.corporate", { status: "done" }, BY);
    await draftMemoFor(db, id, {}, BY);
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    expect(await deals(other)).toEqual([]);
    await expect(dealView(other, id)).rejects.toThrow(/No such deal/);
    for (const t of ["deals", "deal_items", "deal_questions", "memos"]) {
      expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    }
  });
});

describe("memo citation-check eval", () => {
  it("gets every labeled case right", async () => {
    const { runMemoEval } = await import("../evals/memo-writer/run.js");
    const r = runMemoEval();
    expect(r.cases).toBeGreaterThanOrEqual(20);
    expect(r.wrong).toEqual([]);
  });
});
