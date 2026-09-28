import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../lib/db.js";
import { testDb } from "./helpers.js";
import { approve, queue, reject, pending, type Executor, EXECUTORS } from "../modules/outbox/index.js";
import { getOutboxItem, type OutboxChannel } from "../ledger/repository.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

function recorder() {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  const make = (channel: OutboxChannel): Executor => async (payload) => (calls.push({ channel, payload }), { id: `${channel}-1` });
  const executors = { affinity_note: make("affinity_note"), gmail_draft: make("gmail_draft"), outlook_draft: make("outlook_draft") };
  return { calls, executors };
}

const draft = { to: ["ines@girderline.example"], subject: "Follow-up", body: "Thanks for the call." };

describe("outbox", () => {
  it("queues without acting, and runs once after a person approves", async () => {
    const r = recorder();
    const id = await queue(db, "gmail_draft", draft, { summary: "Follow-up to Girderline", proposedBy: "agent:diligence@0.1" });
    expect(r.calls).toHaveLength(0);
    expect((await pending(db)).map((i) => i.id)).toEqual([id]);

    const out = await approve(db, id, "human:subham", r.executors);
    expect(out.outcome.ok).toBe(true);
    expect(r.calls).toEqual([{ channel: "gmail_draft", payload: draft }]);
    expect((await getOutboxItem(db, id))?.status).toBe("done");
    await expect(approve(db, id, "human:subham", r.executors)).rejects.toThrow(/already done/);
    expect(r.calls).toHaveLength(1);
  });

  it("refuses approval by anything but a person, in code and in the database", async () => {
    const id = await queue(db, "affinity_note", { organizationId: 7001, content: "IC passed." }, { summary: "Note", proposedBy: "agent:x" });
    await expect(approve(db, id, "agent:x", recorder().executors)).rejects.toThrow(/Only a person/);
    await expect(db.query("update outbox set status='approved', decided_by='agent:x' where id=$1", [id])).rejects.toThrow();
    expect((await getOutboxItem(db, id))?.status).toBe("pending");
  });

  it("never runs a rejected item, and records failures", async () => {
    const r = recorder();
    const a = await queue(db, "outlook_draft", draft, { summary: "a", proposedBy: "agent:x" });
    await reject(db, a, "human:subham");
    await expect(approve(db, a, "human:subham", r.executors)).rejects.toThrow(/already rejected/);
    const b = await queue(db, "outlook_draft", draft, { summary: "b", proposedBy: "agent:x" });
    const failing = { ...r.executors, outlook_draft: async () => { throw new Error("outlook 401: token expired"); } };
    const out = await approve(db, b, "human:subham", failing);
    expect(out.outcome).toEqual({ ok: false, detail: "outlook 401: token expired" });
    expect((await getOutboxItem(db, b))?.error).toMatch(/401/);
    expect(r.calls).toHaveLength(0);
  });

  it("validates payloads when queued", async () => {
    await expect(queue(db, "gmail_draft", { ...draft, to: ["not-an-email"] }, { summary: "x", proposedBy: "agent:x" })).rejects.toThrow();
    await expect(queue(db, "affinity_note", { organizationId: -1, content: "" }, { summary: "x", proposedBy: "agent:x" })).rejects.toThrow();
  });

  it("has no channel that sends a message", () => {
    expect(Object.keys(EXECUTORS).sort()).toEqual(["affinity_note", "gmail_draft", "outlook_draft"]);
  });
});
