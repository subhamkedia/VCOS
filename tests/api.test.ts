import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Db } from "../lib/db.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import type { Mailer } from "../lib/mailer.js";
import { testRoot } from "./helpers.js";
import { createApp } from "../server/app.js";
import { addMembership, readSession } from "../ledger/platform.js";
import { scopedDb } from "../lib/db.js";
import { insertInvestment } from "../ledger/execution.js";
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
      ["Sourcing", "Diligence", "Investment Execution", "Portfolio & Value Creation", "LP Reporting", "Fundraising & IR"],
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
  it("runs portfolio over HTTP: analysts keep the numbers, partners decide, founders use the portal without an account", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    const { id: dealId } = await (await ana.post("/api/deals", { company: { name: "Girderline", domain: "girderline.example" } })).json();
    const db = scopedDb(root, firmId);
    const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [dealId])).rows[0]!.company_id;
    expect((await ana.get(`/api/portfolio/companies/${companyId}`)).status).toBe(404); // not held yet
    await insertInvestment(db, { dealId, companyId, fundName: "Fund I", security: "preferred", closeDate: "2026-01-15", amountUsd: 1e6, shares: 1e6, ownershipFdPct: 10, rights: {} }, "human:pat@alpha.example");

    expect((await (await ana.get("/api/portfolio")).json()).companies).toHaveLength(1);
    expect((await ana.post(`/api/portfolio/companies/${companyId}/kpis`, { period: "2026-05", values: { "cash.balance": 500000, "burn.monthly": 120000 } })).status).toBe(201);
    expect((await ana.post(`/api/portfolio/companies/${companyId}/kpis`, { period: "2026-05", values: { nonsense: 1 } })).status).toBe(400);
    const view = await (await ana.get(`/api/portfolio/companies/${companyId}`)).json();
    expect(view.signals[0]).toMatchObject({ key: "runway", severity: "high" });
    expect((await ana.post(`/api/portfolio/companies/${companyId}/reserve`, { amountUsd: 1e6, rationale: "Pro rata in the Series A." })).status).toBe(403);
    expect((await pat.post(`/api/portfolio/companies/${companyId}/reserve`, { amountUsd: 1e6, rationale: "Pro rata in the Series A." })).status).toBe(201);
    const mark = await (await ana.post(`/api/portfolio/companies/${companyId}/marks`, { method: "cost", asOf: "2026-06-30", rationale: "Recent round; nothing material has changed." })).json();
    expect((await ana.post(`/api/portfolio/marks/${mark.id}/review`, { approve: true })).status).toBe(403);
    expect((await pat.post(`/api/portfolio/marks/${mark.id}/review`, { approve: true })).status).toBe(200);

    // The founder portal: no session, the token is the key.
    const { url } = await (await ana.post(`/api/portfolio/companies/${companyId}/portal`)).json();
    const token = url.split("/portal/")[1];
    const founder = await app.request(`/api/portal/${token}`);
    expect(founder.status).toBe(200);
    expect(await founder.json()).toMatchObject({ company: "Girderline", firm: expect.any(String) });
    const noHeader = await app.request(`/api/portal/${token}/kpis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period: "2026-05", values: { "revenue.monthly": 50000 } }) });
    expect(noHeader.status).toBe(400); // CSRF header required
    const sent = await app.request(`/api/portal/${token}/kpis`, { method: "POST", headers: { "content-type": "application/json", "x-vcos": "1" }, body: JSON.stringify({ period: "2026-05", values: { "revenue.monthly": 50000 } }) });
    expect(sent.status).toBe(201);
    expect((await app.request("/api/portal/definitely-not-a-valid-token-000000000")).status).toBe(404);
    const connect = await app.request(`/api/portal/${token}/connect/quickbooks`);
    expect(connect.status).toBe(302);
    expect(connect.headers.get("location")).toMatch(/^\/portal\/connected\?error=/); // no QuickBooks app on this server
    expect((await app.request("/api/portal/callback?error=access_denied")).headers.get("location")).toMatch(/^\/portal\/connected\?error=access_denied/);
    expect((await pat.post(`/api/portfolio/companies/${companyId}/portal/revoke`)).status).toBe(200);
    expect((await app.request(`/api/portal/${token}`)).status).toBe(404);
  });
  it("runs LP reporting over HTTP: partners set up and approve, analysts prepare, investors read through their link", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    const p = await starterProfile("Alpha Ventures");
    expect((await pat.put("/api/profile", { ...p, fund: { ...p.fund, name: "Alpha Fund I", firstCloseDate: "2025-01-15", managementFeePct: 2, carryPct: 20 } })).status).toBe(200);
    expect((await ana.post("/api/lp/funds", {})).status).toBe(403);
    const fund = await (await pat.post("/api/lp/funds", {})).json();
    expect(fund.name).toBe("Alpha Fund I");
    for (const [name, commitmentUsd] of [["Harbor Pension Plan", 8e6], ["Aster Family Office", 2e6]] as const) {
      expect((await ana.post(`/api/lp/funds/${fund.id}/investors`, { name, kind: "pension", commitmentUsd, emails: "ir@lp.example" })).status).toBe(201);
    }
    const preview = await (await ana.post(`/api/lp/funds/${fund.id}/calls/preview`, { noticeDate: "2025-01-20", dueDate: "2025-02-10", investmentsUsd: 1e6 })).json();
    expect(preview.items.map((i: { amount: number }) => i.amount)).toEqual([800_000, 200_000]);
    const { call } = await (await ana.post(`/api/lp/funds/${fund.id}/calls`, { noticeDate: "2025-01-20", dueDate: "2025-02-10", investmentsUsd: 1e6, purpose: "First investments" })).json();
    expect((await ana.post(`/api/lp/calls/${call.id}/approve`)).status).toBe(403);
    expect((await pat.post(`/api/lp/calls/${call.id}/approve`)).status).toBe(200);
    const report = await (await ana.post(`/api/lp/funds/${fund.id}/reports`, { period: "2025-Q1" })).json();
    expect((await ana.post(`/api/lp/reports/${report.id}/approve`)).status).toBe(403);
    expect((await pat.post(`/api/lp/reports/${report.id}/approve`)).status).toBe(200);
    const csv = await pat.get(`/api/lp/reports/${report.id}/export/capital-accounts.csv`);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(await csv.text()).toMatch(/^Investor,Line,Quarter/);
    expect((await pat.get(`/api/lp/reports/${report.id}/export/everything.csv`)).status).toBe(404);
    const view = await (await ana.get(`/api/lp/funds/${fund.id}?asOf=2025-03-31`)).json();
    const harbor = view.investors.find((i: { name: string }) => i.name === "Harbor Pension Plan");
    const { url } = await (await ana.post(`/api/lp/investors/${harbor.id}/portal`)).json();
    const token = url.split("/investor/")[1];
    const lp = await app.request(`/api/investor/${token}`);
    expect(lp.status).toBe(200);
    const body = await lp.json();
    expect(body.investor.name).toBe("Harbor Pension Plan");
    expect(JSON.stringify(body)).not.toContain("Aster Family Office");
    expect((await app.request(`/api/investor/${token}/reports/${report.id}/statement.csv`)).status).toBe(200);
    expect((await app.request("/api/investor/definitely-not-a-valid-token-000000000")).status).toBe(404);
    expect((await ana.post(`/api/lp/investors/${harbor.id}/portal/revoke`)).status).toBe(200);
    expect((await app.request(`/api/investor/${token}`)).status).toBe(404);
  });
  it("runs fundraising over HTTP: partners set up and approve, analysts work the pipeline, prospects use the data room without an account", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    const p = await starterProfile("Alpha Ventures");
    await pat.put("/api/profile", { ...p, fund: { ...p.fund, name: "Alpha Fund II", targetSizeUsd: 30e6 } });
    expect((await ana.post("/api/fundraising/raises", {})).status).toBe(403);
    const raise = await (await pat.post("/api/fundraising/raises", {})).json();
    const prospect = await (await ana.post(`/api/fundraising/raises/${raise.id}/prospects`, { name: "Three Rivers Foundation", kind: "endowment_foundation" })).json();
    expect((await ana.patch(`/api/fundraising/prospects/${prospect.id}`, { stage: "declined" })).status).toBe(400);
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("%PDF-1.4 deck")], "deck.pdf", { type: "application/pdf" }));
    form.append("category", "deck");
    const up = await app.request(`/api/fundraising/raises/${raise.id}/docs/uploads`, { method: "POST", headers: { cookie: ana.cookie, "x-vcos": "1" }, body: form });
    expect(up.status).toBe(201);
    const doc = await up.json();
    expect((await ana.post(`/api/fundraising/docs/${doc.id}/approve`)).status).toBe(403);
    expect((await pat.post(`/api/fundraising/docs/${doc.id}/approve`)).status).toBe(200);
    const { url } = await (await ana.post(`/api/fundraising/prospects/${prospect.id}/data-room`, {})).json();
    const token = url.split("/data-room/")[1];
    const room = await app.request(`/api/data-room/${token}`);
    expect(await room.json()).toMatchObject({ investor: "Three Rivers Foundation", acknowledged: false, documents: [] });
    expect((await app.request(`/api/data-room/${token}/docs/${doc.id}`)).status).toBe(400);
    expect((await app.request(`/api/data-room/${token}/acknowledge`, { method: "POST", headers: { "x-vcos": "1" } })).status).toBe(200);
    const file = await app.request(`/api/data-room/${token}/docs/${doc.id}?download=1`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await app.request("/api/data-room/definitely-not-a-valid-token-000000000")).status).toBe(404);
    expect((await app.request("/api/subscribe/definitely-not-a-valid-token-000000000")).status).toBe(404);
    const view = await (await ana.get(`/api/fundraising/raises/${raise.id}`)).json();
    expect(view.prospects[0].engagement).toMatchObject({ downloads: 1 });
  });

  it("runs compliance over HTTP: everyone reports and asks, partners decide others' requests, personal reports stay private", async () => {
    const pat = await signIn("pat@alpha.example");
    await pat.post("/api/firms", { name: "Alpha Ventures" });
    const firmId = (await readSession(root, pat.cookie.split("=")[1]))!.firm!.id;
    const ana = await signIn("ana@alpha.example");
    await addMembership(root, firmId, (await readSession(root, ana.cookie.split("=")[1]))!.user.id, "analyst");
    await ana.post("/api/firms/switch", { firmId });
    expect((await ana.put("/api/compliance/profile", { adviserStatus: "registered" })).status).toBe(403);
    expect((await pat.put("/api/compliance/profile", { adviserStatus: "registered" })).status).toBe(200);
    expect((await ana.post("/api/compliance/reports", { kind: "no_activity", period: "2026-Q2" })).status).toBe(201);
    expect((await pat.post("/api/compliance/reports", { kind: "holding", period: "2026", items: [{ security: "Acme Corp", quantity: 10 }] })).status).toBe(201);
    const req = await (await ana.post("/api/compliance/preclearances", { kind: "ipo", security: "Northgate Grid" })).json();
    expect((await ana.post(`/api/compliance/preclearances/${req.id}/decide`, { approve: true })).status).toBe(403);
    expect((await pat.post(`/api/compliance/preclearances/${req.id}/decide`, { approve: false })).status).toBe(400); // a denial needs a note
    expect((await pat.post(`/api/compliance/preclearances/${req.id}/decide`, { approve: false, note: "IPO allocations aren't approved." })).status).toBe(200);
    const mine = await (await ana.get("/api/compliance")).json();
    expect(mine.reports.map((r: { person: string }) => r.person)).toEqual(["human:ana@alpha.example"]);
    expect(mine.reviewer).toBe(false);
    const all = await (await pat.get("/api/compliance")).json();
    expect(all.reports).toHaveLength(2);
    expect(all.calendar.some((o: { key: string }) => o.key.startsWith("audit_"))).toBe(true);
    expect((await ana.post("/api/compliance/restricted", { name: "Acme Corp", reason: "Board seat" })).status).toBe(403);
  });
});
