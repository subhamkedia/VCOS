import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Db } from "../lib/db.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import type { Mailer } from "../lib/mailer.js";
import { testRoot } from "./helpers.js";
import { createApp } from "../server/app.js";
import { addMembership, readSession } from "../ledger/platform.js";
import { starterProfile } from "../modules/firm/profile.js";

beforeAll(async () => {
  setSecretKeyForTests(randomBytes(32));
  await testRoot();
});

let root: Db;
let app: ReturnType<typeof createApp>;
let outbox: { to: string; text: string }[];

beforeEach(async () => {
  root = await testRoot();
  outbox = [];
  const mailer: Mailer = { send: async (m) => void outbox.push(m) };
  app = createApp({ root, mailer, appUrl: "https://app.example" });
});

/** A browser: keeps the session cookie and sends the CSRF header on writes. */
function browser() {
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie };
    if (method !== "GET") headers["x-vcos"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
    put: (p: string, b: unknown) => call("PUT", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
    del: (p: string) => call("DELETE", p),
    get cookie() { return cookie; },
  };
}

async function signIn(email: string) {
  const b = browser();
  expect((await b.post("/api/auth/email", { email })).status).toBe(200);
  const link = outbox.pop()!.text.match(/https:\/\/\S+/)![0];
  const res = await b.get(new URL(link).pathname + new URL(link).search);
  expect(res.status).toBe(302);
  expect(b.cookie).toMatch(/^vcos_session=/);
  return b;
}

describe("the API", () => {
  it("walks a new firm from sign-in to its first sourcing feed", async () => {
    const pat = await signIn("pat@alpha.example");
    let me = await (await pat.get("/api/me")).json();
    expect(me).toMatchObject({ user: { email: "pat@alpha.example" }, firm: null });
    expect((await pat.get("/api/companies")).status).toBe(409); // no firm yet

    expect((await pat.post("/api/firms", { name: "Alpha Ventures" })).status).toBe(201);
    me = await (await pat.get("/api/me")).json();
    expect(me).toMatchObject({ firm: { name: "Alpha Ventures", role: "admin" }, onboarded: false, can: { manage_team: true } });

    const { current, options } = await (await pat.get("/api/profile")).json();
    expect(current.version).toBe(1);
    expect(options.structures.length).toBeGreaterThan(3);
    const bad = await pat.put("/api/profile", { ...current.profile, mandate: { ...current.profile.mandate, stages: [] } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).errors[0].path).toBe("mandate.stages");
    const edited = { ...current.profile, fund: { ...current.profile.fund, targetSizeUsd: 60_000_000 } };
    expect((await (await pat.put("/api/profile", edited)).json()).version).toBe(2);
    expect((await (await pat.get("/api/me")).json()).onboarded).toBe(true);

    const catalog = await (await pat.get("/api/connections")).json();
    expect(catalog.find((c: { id: string }) => c.id === "yc").status).toBe("available");
    const saved = await (await pat.post("/api/connections/harmonic/keys", { values: { harmonicApiKey: "hm-secret" } })).json();
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(await (await pat.get("/api/connections")).json())).not.toContain("hm-secret");

    const feed = await pat.post("/api/feeds", { connectorId: "yc", params: { batches: "W26" }, cadence: "weekly" });
    expect(feed.status).toBe(201);
    const feeds = await (await pat.get("/api/feeds")).json();
    expect(feeds[0]).toMatchObject({ connector_id: "yc", cadence: "weekly", params: { batches: ["W26"] } });
    expect((await pat.post("/api/feeds", { connectorId: "yc", params: {} })).status).toBe(400);
    expect((await (await pat.get("/api/modules")).json()).map((m: { name: string }) => m.name)).toEqual(
      ["Sourcing", "Diligence", "Investment Execution", "Portfolio & Value Creation", "LP Reporting"],
    );
  });

  it("requires sign-in, the CSRF header, and the right role", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const noHeader = await app.request("/api/firms", { method: "POST", headers: { cookie: pat.cookie, "content-type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(400);

    const ana = await signIn("ana@alpha.example");
    const s = await readSession(root, ana.cookie.split("=")[1]);
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    await addMembership(root, firmId, s!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    expect((await ana.get("/api/companies")).status).toBe(200);
    expect((await ana.post("/api/connections/harmonic/keys", { values: { harmonicApiKey: "x" } })).status).toBe(403);
    expect((await ana.put("/api/profile", await starterProfile("Alpha Ventures"))).status).toBe(403);
    expect((await ana.post("/api/team/invite", { email: "x@alpha.example", role: "analyst" })).status).toBe(403);
  });

  it("keeps firms apart over HTTP", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const form = new FormData();
    form.set("file", new File(["Girderline builds autonomous bridge inspection drones. We have 3 DOT contracts."], "girderline-notes.md"));
    form.set("company", "Girderline");
    form.set("domain", "girderline.example");
    const up = await app.request("/api/uploads", { method: "POST", headers: { cookie: pat.cookie, "x-vcos": "1" }, body: form });
    expect(up.status).toBe(201);
    const { entityId } = await up.json();
    expect((await pat.get(`/api/companies/${entityId}`)).status).toBe(200);

    const sam = await signIn("sam@beta.example");
    await sam.post("/api/firms", { name: "Beta Capital" });
    expect((await sam.get(`/api/companies/${entityId}`)).status).toBe(404);
    expect(await (await sam.get("/api/companies")).json()).toEqual([]);
    expect((await sam.post("/api/firms/switch", { firmId: (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id })).status).toBe(403);
  });

  it("invites teammates by email", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    expect((await pat.post("/api/team/invite", { email: "Kim@Alpha.example", role: "partner" })).status).toBe(201);
    expect(outbox.pop()!.to).toBe("kim@alpha.example");
    const kim = await signIn("kim@alpha.example");
    expect((await (await kim.get("/api/me")).json()).firm).toMatchObject({ name: "Alpha Ventures", role: "partner" });
    const t = await (await pat.get("/api/team")).json();
    expect(t.members.map((m: { email: string }) => m.email).sort()).toEqual(["kim@alpha.example", "pat@alpha.example"]);
  });
});

describe("company pages", () => {
  it("scores uploads live, and hides fit and non-public facts in the shareable view", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const form = new FormData();
    form.set("file", new File(["Girderline builds autonomous bridge inspection robots in Pittsburgh."], "notes.md"));
    form.set("company", "Girderline");
    const { entityId } = await (await app.request("/api/uploads", { method: "POST", headers: { cookie: pat.cookie, "x-vcos": "1" }, body: form })).json();
    const full = await (await pat.get(`/api/companies/${entityId}`)).json();
    expect(full.fit).toMatchObject({ thesis_version: 1, feed_name: null });
    const shared = await (await pat.get(`/api/companies/${entityId}?shareable=1`)).json();
    expect(shared.fit).toBeNull();
    expect(shared.shareable).toBe(true);
    expect(shared.sources).toEqual([]); // the upload is confidential
  });
});

describe("limits", () => {
  it("refuses oversized requests", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const big = await app.request("/api/profile/check", {
      method: "POST", headers: { cookie: pat.cookie, "x-vcos": "1", "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
      body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(big.status).toBe(413);
  });

  it("runs diligence over HTTP: analysts do the work, partners decide", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });

    const created = await ana.post("/api/deals", { company: { name: "Girderline", domain: "girderline.example" } });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const view = await (await ana.get(`/api/deals/${id}`)).json();
    expect(view).toMatchObject({ deal: { company_name: "Girderline", stage: "diligence" }, readiness: { ready: false } });
    expect(view.checklist.length).toBeGreaterThan(20);

    expect((await ana.put(`/api/deals/${id}/items/${encodeURIComponent("legal.corporate")}`, { status: "done" })).status).toBe(200);
    expect((await ana.post(`/api/deals/${id}/round`, { raiseUsd: 5e6, stage: "seed", source: "founder" })).status).toBe(201);
    expect((await ana.post(`/api/deals/${id}/notes`, { kind: "customer_call", title: "Call with PennDOT district 11", text: "They have two decks instrumented and plan to add six more next spring if the pilot holds." })).status).toBe(201);
    const bad = await ana.post(`/api/deals/${id}/notes`, { kind: "customer_call", title: "", text: "x" });
    expect(bad.status).toBe(400);
    expect((await ana.post(`/api/deals/${id}/memos`, {})).status).toBe(201);
    expect((await ana.get(`/api/deals/${id}/memos/1?format=md`)).headers.get("content-type")).toContain("text/markdown");
    const gathered = await (await ana.post(`/api/deals/${id}/gather?wait=1`, { only: ["harmonic"] })).json();
    expect(gathered.sources).toEqual([expect.objectContaining({ id: "harmonic", status: "skipped" })]);

    // Deciding is a partner's call.
    expect((await ana.post(`/api/deals/${id}/decision`, { kind: "pass", reasonCode: "team", rationale: "Not the right team for this market." })).status).toBe(403);
    const passed = await pat.post(`/api/deals/${id}/decision`, { kind: "pass", reasonCode: "team", rationale: "Not the right team for this market." });
    expect(passed.status).toBe(200);
    expect((await (await pat.get("/api/deals?stages=passed")).json()).map((d: { id: string }) => d.id)).toEqual([id]);
    expect((await pat.get("/api/deals/00000000-0000-0000-0000-000000000000")).status).toBe(404);

    // Meetings: empty but reachable, and triage is open to analysts.
    expect(await (await ana.get("/api/meetings/counts")).json()).toEqual({ matched: 0, needs_review: 0, internal: 0, ignored: 0 });
    expect((await ana.post("/api/meetings/00000000-0000-0000-0000-000000000000/mark", { status: "ignored" })).status).toBe(404);
  });
  it("runs execution over HTTP: members vote, partners approve wires and close, analysts can't", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    const { id } = await (await ana.post("/api/deals", { company: { name: "Girderline", domain: "girderline.example" } })).json();
    expect((await pat.post(`/api/deals/${id}/decision`, { kind: "advance", rationale: "Strong pilot data; take it to IC." })).status).toBe(200);

    const terms = { security: "preferred", seriesName: "Seed Preferred", preMoneyUsd: 12e6, raiseUsd: 3e6, ourAllocationUsd: 1.5e6, liquidation: { multiple: 1, participation: "none", seniority: "pari_passu" } };
    expect((await ana.post(`/api/deals/${id}/term-sheets`, { terms })).status).toBe(201);
    expect((await ana.post(`/api/deals/${id}/term-sheets`, { terms: { ...terms, preMoneyUsd: -1 } })).status).toBe(400);
    const form = new FormData();
    form.append("file", new File(["Holder,Class,Shares\nFounder A,Common,6000000\nFounder B,Common,3000000\nPool,Option pool,1000000\n"], "cap.csv", { type: "text/csv" }));
    const up = await app.request(`/api/deals/${id}/cap-table/uploads`, { method: "POST", headers: { cookie: ana.cookie, "x-vcos": "1" }, body: form });
    expect(up.status).toBe(201);
    const view = await (await ana.get(`/api/deals/${id}/execution`)).json();
    expect(view.termSheets[0].checks.length).toBeGreaterThan(5);
    expect(view.model.ours.postPct).toBeGreaterThan(9);

    // IC: scheduling is a partner's call; only members vote.
    expect((await ana.post(`/api/deals/${id}/ic`, { members: ["pat@alpha.example"] })).status).toBe(403);
    const ic = await (await pat.post(`/api/deals/${id}/ic`, { members: ["pat@alpha.example"] })).json();
    expect((await ana.post(`/api/ic/${ic.id}/vote`, { vote: "yes", conviction: 5 })).status).toBe(400);
    expect((await pat.post(`/api/ic/${ic.id}/vote`, { vote: "yes", conviction: 5 })).status).toBe(201);
    for (let i = 0; i < 2; i++) expect((await pat.post(`/api/ic/${ic.id}/advance`, {})).status).toBe(200);
    expect((await pat.post(`/api/ic/${ic.id}/vote`, { vote: "yes", conviction: 5 })).status).toBe(201);
    expect((await pat.post(`/api/ic/${ic.id}/advance`, {})).status).toBe(200);

    // Closing: analysts run the checklist and record instructions; partners approve the wire and close.
    expect((await ana.post(`/api/deals/${id}/closing`)).status).toBe(201);
    expect((await ana.patch(`/api/deals/${id}/closing/wire_callback`, { status: "done" })).status).toBe(400);
    const wire = await (await ana.post(`/api/deals/${id}/wires`, { amountUsd: 1.5e6, beneficiary: "Girderline, Inc.", bankName: "First Bank", accountLast4: "1234" })).json();
    expect((await ana.post(`/api/wires/${wire.id}/verify`, { numberSource: "CEO's mobile from our first meeting", confirmed: true })).status).toBe(200);
    expect((await ana.post(`/api/wires/${wire.id}/approve`)).status).toBe(403);
    expect((await pat.post(`/api/wires/${wire.id}/approve`)).status).toBe(200);
    expect((await ana.post(`/api/deals/${id}/close`, { closeDate: "2026-09-30" })).status).toBe(403);
    const early = await pat.post(`/api/deals/${id}/close`, { closeDate: "2026-09-30" });
    expect(early.status).toBe(400);
    expect((await early.json()).error).toMatch(/Still open/);
    expect((await pat.get("/api/wires/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await pat.post("/api/wires/00000000-0000-0000-0000-000000000000/approve")).status).toBe(404);
    expect((await (await pat.get("/api/execution")).json()).map((d: { id: string }) => d.id)).toEqual([id]);
  });
});
