import { describe, it, expect, beforeAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Llm } from "../lib/llm.js";
import { testFirm, testRoot } from "./helpers.js";
import { ycToRecord, type YcCompany } from "../connectors/yc.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { createFeed, discovered, runFeed } from "../modules/sourcing/index.js";
import { ensureSync, meetings, syncMeetings } from "../modules/meetings/index.js";
import { dealView, startDeal } from "../modules/diligence/index.js";

// Sourcing → Diligence ← Meetings: the company a feed finds is the one a
// call is filed under and the one diligence works on. Fictional throughout.

beforeAll(() => testRoot());

const NONE_LLM: Llm = {
  async create() {
    return { id: "m", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "NONE", citations: null }] } as unknown as Anthropic.Message;
  },
};

const kestrel: YcCompany = {
  slug: "kestrel-robotics", name: "Kestrel Robotics", oneLiner: "Autonomous rebar-tying robots for bridge decks", location: "Pittsburgh, PA, USA", formerNames: [],
  website: "https://kestrelrobotics.com", domain: "kestrelrobotics.com", batch: "Winter 2026", industries: [], founders: ["Maya Lindqvist"], url: "https://www.ycombinator.com/companies/kestrel-robotics",
};

describe("a company from sourcing to diligence", () => {
  it("keeps one company as a feed finds it, a call is filed under it and a deal starts on it", async () => {
    const { db } = await testFirm("Northbeam");
    const p = await starterProfile("Northbeam");
    await saveProfile(db, { ...p, firm: { ...p.firm, emailDomains: ["northbeam.vc"] } }, "human:pat@northbeam.vc");

    // Sourcing finds it and scores it against the thesis.
    const feed = await createFeed(db, { connectorId: "yc", params: { batches: "W26" }, cadence: "weekly" }, "human:pat@northbeam.vc");
    await runFeed(db, feed, "human:pat@northbeam.vc", { discover: async () => [ycToRecord(kestrel, "2026-09-29T00:00:00Z")] });
    const [hit] = await discovered(db);
    expect(hit).toMatchObject({ name: "Kestrel Robotics", fit_verdict: "strong", deal_id: null });

    // Meetings files the founder call under the same company, by her email domain.
    const cal = (await ensureSync(db, "google-calendar", "human:pat@northbeam.vc"))!;
    const s = await syncMeetings(db, cal, "t", {
      list: async () => [{ source: "google-calendar", externalId: "ev1", title: "Northbeam <> Kestrel", startedAt: "2026-09-30T16:00:00.000Z", attendees: [{ email: "pat@northbeam.vc", self: true }, { email: "maya@kestrelrobotics.com", name: "Maya Lindqvist" }], joinKey: "zoom:81234567890" }],
      llm: NONE_LLM,
    });
    expect(s.stats).toMatchObject({ matched: 1 });
    expect((await meetings(db, { companyId: hit!.entity_id })).map((m) => m.title)).toEqual(["Northbeam <> Kestrel"]);

    // Triage starts diligence on the hit; the deal sees the call, and Sourcing shows where it stands.
    const { id } = await startDeal(db, { companyId: hit!.entity_id }, "human:pat@northbeam.vc");
    const v = await dealView(db, id);
    expect(v.meetings.map((m) => m.title)).toEqual(["Northbeam <> Kestrel"]);
    expect((await discovered(db))[0]).toMatchObject({ deal_id: id, deal_stage: "diligence" });
  });
});
