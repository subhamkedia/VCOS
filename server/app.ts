import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { scopedDb, type Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import type { Mailer } from "../lib/mailer.js";
import { dataRoomByToken, endSession, lpPortalByToken, subscriptionByToken, portalLinkByToken, readSession, removeMember, renameFirm, switchFirm, takePortalOAuth, team, SESSION_DAYS, ROLES, type Role, type SessionInfo } from "../ledger/platform.js";
import * as auth from "../modules/auth/index.js";
import * as connections from "../modules/connections/index.js";
import * as sourcing from "../modules/sourcing/index.js";
import * as companies from "../modules/companies/index.js";
import * as outbox from "../modules/outbox/index.js";
import * as meetings from "../modules/meetings/index.js";
import * as diligence from "../modules/diligence/index.js";
import * as execution from "../modules/execution/index.js";
import * as portfolio from "../modules/portfolio/index.js";
import * as lp from "../modules/lp/index.js";
import * as fundraising from "../modules/fundraising/index.js";
import * as compliance from "../modules/compliance/index.js";
import type { MeetingStatus } from "../ledger/meetings.js";
import type { DealStage } from "../ledger/diligence.js";
import { checkProfile, construction, getProfile, profileHistory, profileOptions, saveProfile, ProfileInvalid } from "../modules/firm/profile.js";
import { MODULES } from "../modules/catalog.js";
import { vocabulary } from "../ledger/labels.js";
import { CONNECTORS } from "../connectors/registry.js";
import type { Cadence } from "../ledger/workspace.js";

/**
 * The HTTP API for the web app. Routes are thin: check the session and the
 * role, call a module function, return JSON. Every firm route gets a Db
 * scoped to the signed-in person's current firm; nothing here touches
 * another firm's rows.
 *
 * CSRF: the session cookie is SameSite=Lax, and every state-changing
 * request must carry the `X-VCOS: 1` header, which a cross-site form can't set.
 */

export interface AppDeps {
  root: Db;
  mailer: Mailer;
  appUrl: string;
  llm?: Llm;
}

type Env = { Variables: { session: SessionInfo; db: Db; role: Role; token: string } };

const COOKIE = "vcos_session";
const param = (c: Context<Env>, name: string) => c.req.param(name) ?? "";
const csvResponse = (c: Context, out: { filename: string; text: string }) =>
  c.body(out.text, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "Cache-Control": "no-store" });

export function createApp(deps: AppDeps) {
  const { root, mailer, appUrl, llm } = deps;
  const app = new Hono<Env>();
  const secure = appUrl.startsWith("https://");
  const callback = `${appUrl.replace(/\/$/, "")}/api/auth/callback`;
  const setSession = (c: Context, token: string) =>
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: SESSION_DAYS * 86_400 });

  app.onError((err, c) => {
    if (err instanceof ProfileInvalid) return c.json({ error: err.message, errors: err.errors }, 422);
    if (err instanceof auth.Forbidden) return c.json({ error: err.message }, 403);
    if (err instanceof sourcing.FeedInvalid || err instanceof diligence.DiligenceInvalid || err instanceof meetings.MeetingInvalid || err instanceof execution.ExecutionInvalid || err instanceof portfolio.PortfolioInvalid || err instanceof lp.LpInvalid || err instanceof fundraising.FundraisingInvalid || err instanceof compliance.ComplianceInvalid || err instanceof compliance.ComplianceBlocked || err instanceof companies.CompanyInvalid) {
      return c.json({ error: err.message }, /^No such/.test(err.message) ? 404 : 400);
    }
    const msg = err.message || "Something went wrong.";
    const status = /not a member/i.test(msg) ? 403 : /^(Unknown connector|No such|No entity|No outbox item)/.test(msg) ? 404 : /required|invalid|Enter a valid|already|can't|doesn't|Connect .* first|Not an email/i.test(msg) ? 400 : 500;
    if (status === 500) console.error(err);
    return c.json({ error: msg }, status);
  });

  // JSON bodies are small; uploads have their own limit below.
  app.use("/api/*", async (c, next) => {
    if (!c.req.path.endsWith("/uploads")) return bodyLimit({ maxSize: 1024 * 1024, onError: (x) => x.json({ error: "Request too large." }, 413) })(c, next);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-vcos") !== "1") {
      return c.json({ error: "Missing X-VCOS header." }, 400);
    }
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Sign-in (no session needed)
  // -------------------------------------------------------------------------

  app.get("/api/auth/providers", (c) => c.json(auth.providers()));

  app.get("/api/auth/:provider/start", async (c) => {
    const p = param(c, "provider");
    if (p !== "google" && p !== "microsoft") return c.json({ error: "Unknown provider" }, 404);
    return c.redirect(await auth.beginSignIn(root, p, callback));
  });

  app.get("/api/auth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const denied = c.req.query("error");
    if (denied || !state || !code) return c.redirect(`/signin?error=${encodeURIComponent(c.req.query("error_description") ?? denied ?? "Sign-in was cancelled.")}`);
    try {
      const r = await auth.completeOAuth(root, { state, code, redirectUri: callback });
      if (r.kind === "signin") {
        setSession(c, r.token);
        return c.redirect("/");
      }
      return c.redirect(`/connections?${new URLSearchParams(r.ok ? { connected: r.connectorId } : { failed: r.connectorId, detail: r.detail })}`);
    } catch (err) {
      return c.redirect(`/signin?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.post("/api/auth/email", async (c) => {
    const { email } = await c.req.json<{ email?: string }>();
    await auth.requestEmailLink(root, email ?? "", appUrl, mailer);
    return c.json({ ok: true });
  });

  app.get("/api/auth/email/callback", async (c) => {
    try {
      const r = await auth.completeEmailLink(root, c.req.query("token") ?? "");
      setSession(c, r.token);
      return c.redirect("/");
    } catch (err) {
      return c.redirect(`/signin?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Founder portal (no session: the link's token finds the firm; everything
  // after runs on that firm's scoped Db). Shows the company only what it
  // needs to report, never the firm's marks, ratings or notes.
  // -------------------------------------------------------------------------

  const portalCallback = `${appUrl.replace(/\/$/, "")}/api/portal/callback`;
  const portalRef = async (c: Context) => {
    const ref = await portalLinkByToken(root, c.req.param("token") ?? "");
    if (!ref) throw new portfolio.PortfolioInvalid("No such link: it may have expired. Ask your investor for a new one.");
    return ref;
  };
  app.get("/api/portal/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const done = (q: Record<string, string>) => c.redirect(`/portal/connected?${new URLSearchParams(q)}`);
    if (c.req.query("error") || !c.req.query("code")) return done({ error: c.req.query("error_description") ?? c.req.query("error") ?? "The connection was cancelled." });
    const ref = await takePortalOAuth(root, state);
    if (!ref) return done({ error: "This connection link has expired. Open your portal link and try again." });
    try {
      const r = await portfolio.finishAccountingLink(scopedDb(root, ref.firmId), ref, { code: c.req.query("code")!, realmId: c.req.query("realmId"), redirectUri: portalCallback });
      return done({ provider: r.provider, company: r.company, ...(r.externalName ? { books: r.externalName } : {}) });
    } catch (err) {
      return done({ error: (err as Error).message });
    }
  });
  app.get("/api/portal/:token", async (c) => {
    const ref = await portalRef(c);
    return c.json(await portfolio.portalView(scopedDb(root, ref.firmId), ref));
  });
  app.post("/api/portal/:token/kpis", async (c) => {
    const ref = await portalRef(c);
    return c.json(await portfolio.portalSubmit(scopedDb(root, ref.firmId), ref, await c.req.json()), 201);
  });
  app.get("/api/portal/:token/connect/:provider", async (c) => {
    try {
      const ref = await portalRef(c);
      return c.redirect(await portfolio.startAccountingLink(scopedDb(root, ref.firmId), ref, c.req.param("provider"), portalCallback));
    } catch (err) {
      return c.redirect(`/portal/connected?${new URLSearchParams({ error: (err as Error).message })}`);
    }
  });

  // -------------------------------------------------------------------------
  // Investor portal (no session: the token finds the firm and the investor).
  // Shows one investor its own statements, notices, tax documents and the
  // fund's approved reports; never another investor's account.
  // -------------------------------------------------------------------------

  const investorRef = async (c: Context) => {
    const ref = await lpPortalByToken(root, c.req.param("token") ?? "");
    if (!ref) throw new lp.LpInvalid("No such link: it may have expired. Ask the fund for a new one.");
    return ref;
  };
  app.get("/api/investor/:token", async (c) => {
    const ref = await investorRef(c);
    return c.json(await lp.lpPortalView(scopedDb(root, ref.firmId), ref));
  });
  app.get("/api/investor/:token/reports/:id/statement.csv", async (c) => {
    const ref = await investorRef(c);
    const out = await lp.lpPortalStatementCsv(scopedDb(root, ref.firmId), ref, c.req.param("id"));
    return csvResponse(c, out);
  });

  // -------------------------------------------------------------------------
  // Data room and subscriptions for prospective investors (no session: the
  // token finds the firm and the prospect). A prospect sees only approved
  // documents, after acknowledging confidentiality; every open is recorded.
  // -------------------------------------------------------------------------

  const roomRef = async (c: Context) => {
    const ref = await dataRoomByToken(root, c.req.param("token") ?? "");
    if (!ref) throw new fundraising.FundraisingInvalid("No such link: it may have expired. Ask the fund for a new one.");
    return ref;
  };
  const fileResponse = (c: Context, f: { fileName: string; mimeType: string; content: Uint8Array }, download: boolean) =>
    c.body(f.content as unknown as ArrayBuffer, 200, {
      "Content-Type": f.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${f.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    });
  app.get("/api/data-room/:token", async (c) => {
    const ref = await roomRef(c);
    return c.json(await fundraising.dataRoomView(scopedDb(root, ref.firmId), ref));
  });
  app.post("/api/data-room/:token/acknowledge", async (c) => {
    const ref = await roomRef(c);
    await fundraising.acknowledgeDataRoom(scopedDb(root, ref.firmId), ref);
    return c.json({ ok: true });
  });
  app.get("/api/data-room/:token/docs/:id", async (c) => {
    const ref = await roomRef(c);
    const download = c.req.query("download") === "1";
    return fileResponse(c, await fundraising.openDoc(scopedDb(root, ref.firmId), ref, c.req.param("id"), download ? "download" : "view"), download);
  });
  const subRef = async (c: Context) => {
    const ref = await subscriptionByToken(root, c.req.param("token") ?? "");
    if (!ref) throw new fundraising.FundraisingInvalid("No such link: it may have expired or the subscription is complete. Ask the fund for a new one.");
    return ref;
  };
  app.get("/api/subscribe/:token", async (c) => {
    const ref = await subRef(c);
    return c.json(await fundraising.subscriptionView(scopedDb(root, ref.firmId), ref));
  });
  app.post("/api/subscribe/:token", async (c) => {
    const ref = await subRef(c);
    return c.json(await fundraising.subscriptionSubmit(scopedDb(root, ref.firmId), ref, await c.req.json()));
  });

  app.post("/api/auth/logout", async (c) => {
    await endSession(root, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Signed in
  // -------------------------------------------------------------------------

  const signedIn = async (c: Context<Env>, next: Next) => {
    const token = getCookie(c, COOKIE);
    const s = await readSession(root, token);
    if (!s) return c.json({ error: "Not signed in." }, 401);
    c.set("session", s);
    c.set("token", token!);
    await next();
  };

  const inFirm = async (c: Context<Env>, next: Next) => {
    const s = c.get("session");
    if (!s.firm) return c.json({ error: "Create or join a firm first." }, 409);
    c.set("db", scopedDb(root, s.firm.id));
    c.set("role", s.firm.role);
    await next();
  };

  const allow = (action: auth.Action) => async (c: Context<Env>, next: Next) => {
    auth.requireAction(c.get("role"), action);
    await next();
  };

  const who = (c: Context<Env>) => auth.actor(c.get("session").user);

  app.use("/api/me", signedIn);
  app.get("/api/me", async (c) => {
    const s = c.get("session");
    const { firmsOf } = await import("../ledger/platform.js");
    const firms = await firmsOf(root, s.user.id);
    const role = s.firm?.role;
    const actions = auth.ACTIONS;
    const profile = s.firm ? await getProfile(scopedDb(root, s.firm.id)) : null;
    return c.json({
      user: s.user, firm: s.firm, firms,
      can: role ? Object.fromEntries(actions.map((a) => [a, auth.can(role, a)])) : {},
      onboarded: Boolean(profile && profile.version > 1),
    });
  });

  app.use("/api/firms", signedIn);
  app.use("/api/firms/*", signedIn);
  app.post("/api/firms", async (c) => {
    const { name } = await c.req.json<{ name?: string }>();
    const firm = await auth.createWorkspace(root, c.get("token"), name ?? "");
    return c.json(firm, 201);
  });
  app.post("/api/firms/switch", async (c) => {
    const { firmId } = await c.req.json<{ firmId: string }>();
    await switchFirm(root, c.get("token"), firmId);
    return c.json({ ok: true });
  });

  // Everything below is inside one firm.
  const firm = new Hono<Env>();
  firm.use("*", signedIn, inFirm);

  firm.get("/modules", (c) => c.json(MODULES));
  // Labels for every id the ledger stores: predicates, source types, scopes, sources...
  const vocab = vocabulary(Object.fromEntries(CONNECTORS.map((x) => [x.id, x.name])));
  firm.get("/vocabulary", (c) => c.json(vocab));

  // Firm profile and thesis
  firm.get("/profile", async (c) => {
    const current = await getProfile(c.get("db"));
    return c.json({ current, options: profileOptions(), construction: current ? construction(current.profile) : null });
  });
  firm.post("/profile/check", async (c) => c.json(checkProfile(await c.req.json())));
  firm.put("/profile", allow("edit_thesis"), async (c) => {
    const body = await c.req.json();
    const saved = await saveProfile(c.get("db"), body, who(c));
    if (c.get("role") === "admin" && saved.profile.firm.name !== c.get("session").firm!.name) {
      await renameFirm(root, c.get("session").firm!.id, saved.profile.firm.name);
    }
    return c.json(saved);
  });
  firm.get("/profile/history", async (c) => c.json(await profileHistory(c.get("db"))));

  // Connections
  firm.get("/connections", async (c) => c.json(await connections.catalog(c.get("db"))));
  firm.post("/connections/:id/keys", allow("manage_connections"), async (c) => {
    const { values } = await c.req.json<{ values: Record<string, string> }>();
    const out = await connections.connectWithKeys(c.get("db"), param(c, "id"), values ?? {}, who(c));
    await meetings.ensureSync(c.get("db"), param(c, "id"), who(c));
    return c.json(out);
  });
  firm.post("/connections/:id/enable", allow("manage_connections"), async (c) =>
    c.json(await connections.enable(c.get("db"), param(c, "id"), who(c))));
  // One consent for several products from the same account provider: { with: ["google-calendar", "google-meet"] }.
  firm.post("/connections/:id/oauth", allow("manage_connections"), async (c) => {
    const body = await c.req.json<{ with?: string[] }>().catch(() => ({} as { with?: string[] }));
    return c.json({ url: await auth.beginConnect(root, c.get("session"), [param(c, "id"), ...(body.with ?? [])], callback) });
  });
  firm.get("/research-sources", async (c) => c.json(await connections.researchSources(c.get("db"))));
  firm.post("/connections/:id/test", allow("manage_connections"), async (c) =>
    c.json(await connections.testConnection(c.get("db"), param(c, "id"))));
  firm.delete("/connections/:id", allow("manage_connections"), async (c) => {
    await connections.disconnect(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });

  // Sourcing
  firm.get("/feeds", async (c) => c.json(await sourcing.feeds(c.get("db"))));
  firm.post("/feeds", allow("manage_feeds"), async (c) => {
    const body = await c.req.json<{ connectorId: string; name?: string; params?: Record<string, unknown>; cadence?: Cadence }>();
    return c.json({ id: await sourcing.createFeed(c.get("db"), body, who(c)) }, 201);
  });
  firm.patch("/feeds/:id", allow("manage_feeds"), async (c) => {
    await sourcing.updateFeed(c.get("db"), param(c, "id"), await c.req.json());
    return c.json({ ok: true });
  });
  firm.delete("/feeds/:id", allow("manage_feeds"), async (c) => {
    await sourcing.deleteFeed(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/feeds/:id/run", allow("manage_feeds"), async (c) => {
    const job = sourcing.runFeed(c.get("db"), param(c, "id"), who(c), { llm });
    if (c.req.query("wait") === "1") return c.json(await job);
    job.catch((err) => console.error("feed run failed", err));
    return c.json({ started: true }, 202);
  });
  firm.get("/runs", async (c) => c.json(await sourcing.runs(c.get("db"), c.req.query("feed") || undefined)));
  firm.post("/discovered/:id/pass", allow("decide_deals"), async (c) => c.json(await sourcing.passOnCompany(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.get("/discovered", async (c) => c.json(await sourcing.discovered(c.get("db"), { verdict: c.req.query("verdict") || undefined })));

  // Companies and the ledger
  firm.get("/companies", async (c) => c.json(await companies.list(c.get("db"), c.req.query("q") || undefined)));
  firm.get("/companies/:id", async (c) => c.json(await companies.profile(c.get("db"), param(c, "id"), { shareable: c.req.query("shareable") === "1" })));
  firm.get("/evidence/:id", async (c) => {
    const e = await companies.evidence(c.get("db"), param(c, "id"));
    return e ? c.json(e) : c.json({ error: "No such source." }, 404);
  });
  const uploadLimit = bodyLimit({ maxSize: 26 * 1024 * 1024, onError: (c) => c.json({ error: "Files up to 25 MB." }, 413) });
  firm.post("/uploads", uploadLimit, allow("upload"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach a file." }, 400);
    if (file.size > 25 * 1024 * 1024) return c.json({ error: "Files up to 25 MB." }, 400);
    const company = String(body.company ?? "").trim();
    if (!company) return c.json({ error: "Company is required." }, 400);
    const r = await companies.upload(c.get("db"), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, {
      company, companyDomain: String(body.domain ?? "").trim() || undefined, url: String(body.url ?? "").trim() || undefined,
      date: String(body.date ?? "").trim() || undefined, kind: body.kind === "transcript" ? "transcript" : "document",
    }, llm);
    return c.json({ ...r, extractionAvailable: Boolean(llm) }, 201);
  });
  firm.post("/web-pages", allow("upload"), async (c) => {
    const b = await c.req.json<{ url?: string; company?: string; domain?: string }>();
    const r = await companies.saveWebPage(c.get("db"), { url: String(b.url ?? ""), company: String(b.company ?? ""), companyDomain: String(b.domain ?? "").trim() || undefined }, llm);
    return c.json({ ...r, extractionAvailable: Boolean(llm) }, 201);
  });
  firm.get("/merges", async (c) => c.json(await companies.mergeProposals(c.get("db"))));
  firm.post("/merges/:id", allow("decide_merges"), async (c) => {
    const { accept } = await c.req.json<{ accept: boolean }>();
    await companies.decideMerge(c.get("db"), param(c, "id"), Boolean(accept), who(c));
    return c.json({ ok: true });
  });

  // Meetings
  firm.get("/meetings", async (c) => c.json(await meetings.meetings(c.get("db"), {
    status: (c.req.query("status") as MeetingStatus) || undefined, companyId: c.req.query("company") || undefined, search: c.req.query("q") || undefined,
  })));
  firm.get("/meetings/counts", async (c) => c.json(await meetings.counts(c.get("db"))));
  firm.get("/meetings/syncs", async (c) => c.json(await meetings.syncs(c.get("db"))));
  firm.post("/meetings/syncs/:id/run", allow("triage_meetings"), async (c) => c.json(await meetings.syncMeetings(c.get("db"), param(c, "id"), who(c), { llm })));
  firm.post("/meetings/:id/assign", allow("triage_meetings"), async (c) => {
    const body = await c.req.json<{ companyId?: string; newCompany?: { name: string; domain?: string } }>();
    return c.json(await meetings.assignMeeting(c.get("db"), param(c, "id"), body, who(c), llm));
  });
  firm.post("/meetings/:id/mark", allow("triage_meetings"), async (c) => {
    const { status } = await c.req.json<{ status: "internal" | "ignored" | "needs_review" }>();
    if (!["internal", "ignored", "needs_review"].includes(status)) return c.json({ error: "Unknown status." }, 400);
    return c.json(await meetings.markMeeting(c.get("db"), param(c, "id"), status, who(c)));
  });

  // Diligence
  firm.get("/deals", async (c) => {
    const stages = (c.req.query("stages") ?? "").split(",").filter(Boolean) as DealStage[];
    return c.json(await diligence.deals(c.get("db"), { stages: stages.length ? stages : undefined }));
  });
  firm.post("/deals", allow("work_deals"), async (c) => c.json(await diligence.startDeal(c.get("db"), await c.req.json(), who(c)), 201));
  firm.get("/deals/:id", async (c) => c.json(await diligence.dealView(c.get("db"), param(c, "id"))));
  firm.patch("/deals/:id", allow("work_deals"), async (c) => c.json(await diligence.updateDealInfo(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.post("/deals/:id/round", allow("work_deals"), async (c) => c.json(await diligence.recordRound(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/deals/:id/notes", allow("work_deals"), async (c) => c.json(await diligence.addNote(c.get("db"), param(c, "id"), await c.req.json(), who(c), llm), 201));
  firm.post("/deals/:id/items", allow("work_deals"), async (c) => c.json({ key: await diligence.addItem(c.get("db"), param(c, "id"), await c.req.json(), who(c)) }, 201));
  firm.put("/deals/:id/items/:key", allow("work_deals"), async (c) => {
    await diligence.setItem(c.get("db"), param(c, "id"), decodeURIComponent(param(c, "key")), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.delete("/deals/:id/items/:key", allow("work_deals"), async (c) => {
    await diligence.removeItem(c.get("db"), param(c, "id"), decodeURIComponent(param(c, "key")), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/questions", allow("work_deals"), async (c) => c.json({ id: await diligence.addQuestion(c.get("db"), param(c, "id"), await c.req.json(), who(c)) }, 201));
  firm.patch("/deals/:id/questions/:qid", allow("work_deals"), async (c) => {
    await diligence.updateQuestion(c.get("db"), param(c, "id"), param(c, "qid"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/questions/email", allow("queue"), async (c) => c.json(await diligence.queueQuestionsEmail(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/deals/:id/contradictions/:cid", allow("work_deals"), async (c) => {
    await diligence.resolveContradiction(c.get("db"), param(c, "id"), param(c, "cid"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/gather", allow("work_deals"), async (c) => {
    const body = await c.req.json<{ only?: string[] }>().catch(() => ({} as { only?: string[] }));
    const { runId, done } = await diligence.gather(c.get("db"), param(c, "id"), who(c), { llm, only: body.only });
    if (c.req.query("wait") === "1") return c.json({ runId, sources: await done });
    done.catch((err) => console.error("gather failed", err));
    return c.json({ runId }, 202);
  });
  firm.post("/deals/:id/memos", allow("work_deals"), async (c) => {
    const body = await c.req.json<{ shareable?: boolean; writer?: "deterministic" | "claude" }>();
    return c.json(await diligence.draftMemoFor(c.get("db"), param(c, "id"), body, who(c), llm), 201);
  });
  firm.get("/deals/:id/memos/latest", async (c) => {
    const m = await diligence.memo(c.get("db"), param(c, "id"));
    return m ? c.json(m) : c.json({ error: "No memo yet." }, 404);
  });
  firm.get("/deals/:id/memos/:version", async (c) => {
    const m = await diligence.memo(c.get("db"), param(c, "id"), Number(param(c, "version")));
    if (!m) return c.json({ error: "No such memo version." }, 404);
    if (c.req.query("format") === "md") {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="memo-v${m.version}.md"`);
      return c.body(m.markdown);
    }
    return c.json(m);
  });
  firm.post("/deals/:id/decision", allow("decide_deals"), async (c) => c.json(await diligence.decide(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.get("/diligence/options", (c) => c.json({ checklist: diligence.CHECKLIST.map((i) => ({ key: i.key, workstream: i.workstream, title: i.title })), workstreams: diligence.WORKSTREAMS, noteKinds: diligence.NOTE_KINDS, flags: diligence.FLAG_LABELS, llm: Boolean(llm) }));

  // Investment Execution. Analysts do the work; partners schedule IC, approve wires and close.
  // IC votes are limited to the meeting's members, and moving a meeting on to its chair, in the module.
  firm.get("/execution", async (c) => c.json(await execution.pipeline(c.get("db"))));
  firm.get("/execution/options", (c) => c.json({ rules: execution.RULE_LABELS, categories: execution.CATEGORY_LABELS, standings: execution.STANDING_LABELS }));
  firm.get("/investments", async (c) => c.json(await execution.investments(c.get("db"))));
  firm.get("/deals/:id/execution", async (c) => c.json(await execution.executionView(c.get("db"), param(c, "id"), who(c))));
  firm.post("/deals/:id/term-sheets", allow("work_deals"), async (c) => c.json(await execution.saveTermSheet(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/deals/:id/term-sheets/:version/status", allow("work_deals"), async (c) => {
    const { status } = await c.req.json<{ status: "draft" | "proposed" | "negotiating" | "signed" }>();
    if (!["draft", "proposed", "negotiating", "signed"].includes(status)) return c.json({ error: "Unknown status." }, 400);
    await execution.setTermStatus(c.get("db"), param(c, "id"), Number(param(c, "version")), status, who(c));
    return c.json({ ok: true });
  });
  firm.put("/deals/:id/cap-table", allow("work_deals"), async (c) => c.json(await execution.saveCapTable(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/deals/:id/cap-table/uploads", uploadLimit, allow("work_deals"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach a CSV file." }, 400);
    if (!/\.(csv|txt)$/i.test(file.name)) return c.json({ error: "Export the cap table as CSV first." }, 400);
    return c.json(await execution.importCapTableCsv(c.get("db"), param(c, "id"), { name: file.name, text: await file.text() }, who(c)), 201);
  });
  firm.post("/deals/:id/cap-table/carta", allow("work_deals"), async (c) => c.json(await execution.importCartaCapTable(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/deals/:id/ic", allow("decide_deals"), async (c) => c.json(await execution.scheduleIc(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/ic/:id/vote", async (c) => {
    await execution.castVote(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true }, 201);
  });
  firm.post("/ic/:id/recuse", async (c) => {
    const { reason } = await c.req.json<{ reason: string }>();
    await execution.recuse(c.get("db"), param(c, "id"), reason, who(c));
    return c.json({ ok: true }, 201);
  });
  firm.post("/ic/:id/advance", allow("decide_deals"), async (c) => c.json(await execution.advanceIc(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.post("/ic/:id/cancel", allow("decide_deals"), async (c) => {
    await execution.cancelIc(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/closing", allow("work_deals"), async (c) => {
    await execution.startClosing(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true }, 201);
  });
  firm.patch("/deals/:id/closing/:key", allow("work_deals"), async (c) => {
    await execution.updateItem(c.get("db"), param(c, "id"), decodeURIComponent(param(c, "key")), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/closing/items", allow("work_deals"), async (c) => c.json({ key: await execution.addClosingItem(c.get("db"), param(c, "id"), await c.req.json(), who(c)) }, 201));
  firm.post("/deals/:id/closing/sanctions", allow("work_deals"), async (c) => c.json(await execution.screenSanctions(c.get("db"), param(c, "id"), who(c))));
  firm.post("/deals/:id/closing/signatures/sync", allow("work_deals"), async (c) => c.json(await execution.syncSignatures(c.get("db"), param(c, "id"), who(c))));
  firm.post("/deals/:id/closing/signatures/uploads", uploadLimit, allow("queue"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach the document to sign." }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: "Documents up to 10 MB." }, 400);
    let signers: { name: string; email: string }[];
    try { signers = JSON.parse(String(body.signers ?? "[]")); } catch { return c.json({ error: "Signers are invalid." }, 400); }
    const file64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return c.json(await execution.queueSignatureDraft(c.get("db"), param(c, "id"), { itemKey: String(body.itemKey ?? ""), file: { name: file.name, base64: file64 }, signers }, who(c)), 201);
  });
  firm.post("/deals/:id/wires", allow("work_deals"), async (c) => c.json(await execution.recordWireInstructions(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/wires/:id/verify", allow("work_deals"), async (c) => {
    await execution.verifyWire(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/wires/:id/approve", allow("approve_outbox"), async (c) => c.json(await execution.approveWire(c.get("db"), param(c, "id"), who(c))));
  firm.post("/wires/:id/sent", allow("approve_outbox"), async (c) => {
    await execution.markWireSent(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/wires/:id/confirm", allow("work_deals"), async (c) => {
    await execution.confirmWire(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/deals/:id/close", allow("decide_deals"), async (c) => c.json(await execution.closeDeal(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));

  // Portfolio Management and Value Creation. Analysts keep the numbers, the
  // board record and the value-creation work; partners decide reserves,
  // follow-ons and realizations, and review marks (never their own).
  firm.get("/portfolio", async (c) => c.json(await portfolio.overview(c.get("db"), undefined, c.req.query("fund") || undefined)));
  firm.get("/portfolio/queues", async (c) => c.json(await portfolio.workQueues(c.get("db"))));
  firm.get("/portfolio/companies/:id", async (c) => c.json(await portfolio.companyView(c.get("db"), param(c, "id"), who(c))));
  firm.post("/portfolio/companies/:id/kpis", allow("work_deals"), async (c) => c.json(await portfolio.recordKpis(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/portfolio/companies/:id/kpis/uploads", uploadLimit, allow("work_deals"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach a CSV file." }, 400);
    if (!/\.(csv|txt)$/i.test(file.name)) return c.json({ error: "Export the sheet as CSV first." }, 400);
    return c.json(await portfolio.importKpiCsv(c.get("db"), param(c, "id"), { name: file.name, text: await file.text() }, who(c)), 201);
  });
  firm.post("/portfolio/companies/:id/sync", allow("work_deals"), async (c) => c.json(await portfolio.syncCompany(c.get("db"), param(c, "id"), who(c), { llm })));
  firm.post("/portfolio/companies/:id/requests", allow("queue"), async (c) => c.json(await portfolio.requestKpis(c.get("db"), param(c, "id"), await c.req.json(), who(c), appUrl), 201));
  firm.post("/portfolio/requests/:id/cancel", allow("work_deals"), async (c) => {
    await portfolio.cancelRequest(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/portfolio/companies/:id/portal", allow("work_deals"), async (c) => c.json(await portfolio.createPortalLink(c.get("db"), param(c, "id"), who(c), appUrl), 201));
  firm.post("/portfolio/companies/:id/portal/revoke", allow("work_deals"), async (c) => c.json(await portfolio.revokePortal(c.get("db"), param(c, "id"), who(c))));
  firm.post("/portfolio/companies/:id/contacts", allow("work_deals"), async (c) => c.json(await portfolio.addContact(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.delete("/portfolio/companies/:id/contacts/:cid", allow("work_deals"), async (c) => {
    await portfolio.deleteContact(c.get("db"), param(c, "id"), param(c, "cid"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/portfolio/companies/:id/health", allow("work_deals"), async (c) => c.json({ id: await portfolio.rateHealth(c.get("db"), param(c, "id"), await c.req.json(), who(c)) }, 201));
  firm.post("/portfolio/companies/:id/marks", allow("work_deals"), async (c) => c.json(await portfolio.proposeMark(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/portfolio/marks/:id/review", allow("decide_deals"), async (c) => {
    const b = await c.req.json<{ approve: boolean; note?: string }>();
    await portfolio.reviewMark(c.get("db"), param(c, "id"), { approve: Boolean(b.approve), note: b.note }, who(c));
    return c.json({ ok: true });
  });
  firm.post("/portfolio/companies/:id/reserve", allow("decide_deals"), async (c) => c.json({ id: await portfolio.planReserve(c.get("db"), param(c, "id"), await c.req.json(), who(c)) }, 201));
  firm.post("/portfolio/companies/:id/follow-on", allow("decide_deals"), async (c) => c.json(await portfolio.decideFollowOn(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/portfolio/companies/:id/realizations", allow("decide_deals"), async (c) => c.json(await portfolio.recordRealization(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  // Exits and liquidity, inside Portfolio. Analysts keep plans, processes,
  // bids, listed shares and prices, QSBS reviews, and prepare distributions
  // (a partner approves them in LP Reporting); partners give the fund's
  // consent, record closings, settle escrows and earnouts, sell listed
  // shares, and decide a fund's extension and continuation vehicle.
  const body = async (c: Context<Env>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  firm.get("/portfolio/liquidity", async (c) => c.json(await portfolio.liquidityOverview(c.get("db"))));
  firm.get("/portfolio/companies/:id/exits", async (c) => c.json(await portfolio.companyExits(c.get("db"), param(c, "id"))));
  firm.put("/portfolio/companies/:id/exit-plan", allow("work_deals"), async (c) => { await portfolio.saveExitPlanFor(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/companies/:id/exits", allow("work_deals"), async (c) => c.json(await portfolio.startExit(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.patch("/portfolio/exits/:id", allow("work_deals"), async (c) => { await portfolio.updateExitProcess(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/exits/:id/bids", allow("work_deals"), async (c) => { await portfolio.addBid(c.get("db"), param(c, "id"), await body(c), who(c)); return c.json({ ok: true }, 201); });
  firm.post("/portfolio/exits/:id/consent", allow("decide_deals"), async (c) => c.json(await portfolio.consentToExit(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.post("/portfolio/exits/:id/close/preview", allow("work_deals"), async (c) => c.json(await portfolio.previewClose(c.get("db"), param(c, "id"), await body(c))));
  firm.post("/portfolio/exits/:id/close", allow("decide_deals"), async (c) => c.json(await portfolio.closeExit(c.get("db"), param(c, "id"), await body(c), who(c))));
  firm.post("/portfolio/receivables/:id/settle", allow("decide_deals"), async (c) => c.json(await portfolio.settleReceivable(c.get("db"), param(c, "id"), await body(c), who(c))));
  firm.patch("/portfolio/receivables/:id", allow("work_deals"), async (c) => { await portfolio.reviseReceivable(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/companies/:id/listed", allow("work_deals"), async (c) => c.json(await portfolio.addPublicHolding(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.patch("/portfolio/listed/:id", allow("work_deals"), async (c) => { await portfolio.editPublicHolding(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/prices/:ticker", allow("work_deals"), async (c) => c.json(await portfolio.recordPrices(c.get("db"), param(c, "ticker"), await body(c), who(c)), 201));
  firm.post("/portfolio/listed/:id/sell", allow("decide_deals"), async (c) => c.json(await portfolio.sellPublic(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.post("/portfolio/listed/:id/in-kind/preview", allow("work_deals"), async (c) => c.json(await portfolio.previewInKind(c.get("db"), param(c, "id"), await body(c))));
  firm.post("/portfolio/listed/:id/in-kind", allow("work_deals"), async (c) => c.json(await portfolio.distributeInKind(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.post("/portfolio/companies/:id/distribute", allow("work_deals"), async (c) => c.json(await portfolio.distributeProceeds(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.post("/portfolio/companies/:id/investments/:inv/qsbs", allow("work_deals"), async (c) => c.json(await portfolio.reviewQsbs(c.get("db"), param(c, "id"), param(c, "inv"), await body(c), who(c)), 201));
  firm.get("/portfolio/funds/:id/life", async (c) => c.json(await portfolio.fundLifeView(c.get("db"), param(c, "id"))));
  firm.put("/portfolio/funds/:id/life", allow("decide_deals"), async (c) => { await portfolio.setFundLife(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/funds/:id/extensions", allow("decide_deals"), async (c) => { await portfolio.extendFund(c.get("db"), param(c, "id"), await body(c), who(c)); return c.json({ ok: true }, 201); });
  firm.put("/portfolio/funds/:id/wind-down/:key", allow("work_deals"), async (c) => { await portfolio.setWindDownStep(c.get("db"), param(c, "id"), param(c, "key"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/funds/:id/continuation", allow("decide_deals"), async (c) => c.json(await portfolio.startContinuation(c.get("db"), param(c, "id"), await body(c), who(c)), 201));
  firm.post("/portfolio/continuation/:id/elections", allow("work_deals"), async (c) => { await portfolio.recordElection(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/continuation/:id/finish", allow("decide_deals"), async (c) => { await portfolio.finishContinuation(c.get("db"), param(c, "id"), await body(c), who(c)); return ok(c); });
  firm.post("/portfolio/companies/:id/board", allow("work_deals"), async (c) => c.json(await portfolio.addBoardMeeting(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/portfolio/companies/:id/initiatives", allow("work_deals"), async (c) => c.json(await portfolio.addInitiative(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.patch("/portfolio/initiatives/:id", allow("work_deals"), async (c) => {
    await portfolio.setInitiative(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/portfolio/initiatives/:id/intro", allow("queue"), async (c) => c.json(await portfolio.queueIntro(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));

  // LP Reporting. Analysts keep the investor register, prepare calls,
  // distributions and reports, record expenses and reconcile the bank;
  // partners set up funds and their terms, and approve calls, distributions
  // and reports (never ones they prepared). Nothing here moves money or
  // sends: notices are drafts in the approval outbox.
  const csvUpload = async (c: Context<Env>) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new lp.LpInvalid("Attach a CSV file.");
    if (!/\.(csv|txt)$/i.test(file.name)) throw new lp.LpInvalid("Export it as CSV first.");
    return { name: file.name, text: await file.text() };
  };
  const day = (c: Context<Env>) => (/^\d{4}-\d{2}-\d{2}$/.test(c.req.query("asOf") ?? "") ? c.req.query("asOf")! : undefined);
  firm.get("/lp", async (c) => c.json(await lp.overview(c.get("db"), day(c))));
  firm.post("/lp/funds", allow("decide_deals"), async (c) => c.json(await lp.createFund(c.get("db"), await c.req.json(), who(c)), 201));
  firm.get("/lp/funds/:id", async (c) => c.json(await lp.fundView(c.get("db"), param(c, "id"), day(c))));
  firm.put("/lp/funds/:id/terms", allow("decide_deals"), async (c) => c.json(await lp.setTerms(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.post("/lp/funds/:id/investors", allow("work_deals"), async (c) => c.json(await lp.addPartner(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/lp/funds/:id/investors/uploads", uploadLimit, allow("work_deals"), async (c) => c.json(await lp.importPartnersCsv(c.get("db"), param(c, "id"), await csvUpload(c), who(c)), 201));
  firm.patch("/lp/investors/:id", allow("work_deals"), async (c) => {
    await lp.editPartner(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/investors/:id/portal", allow("work_deals"), async (c) => c.json(await lp.createLpPortalLink(c.get("db"), param(c, "id"), who(c), appUrl), 201));
  firm.post("/lp/investors/:id/portal/revoke", allow("work_deals"), async (c) => c.json(await lp.revokeLpPortal(c.get("db"), param(c, "id"), who(c))));
  firm.post("/lp/funds/:id/calls/preview", allow("work_deals"), async (c) => c.json(await lp.previewCall(c.get("db"), param(c, "id"), await c.req.json())));
  firm.post("/lp/funds/:id/calls", allow("work_deals"), async (c) => c.json(await lp.draftCall(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/lp/calls/:id/approve", allow("decide_deals"), async (c) => c.json(await lp.approveCall(c.get("db"), param(c, "id"), who(c))));
  firm.post("/lp/calls/:id/cancel", allow("decide_deals"), async (c) => {
    await lp.cancelCall(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/calls/:id/notices", allow("queue"), async (c) => c.json(await lp.queueCallNotices(c.get("db"), param(c, "id"), who(c)), 201));
  firm.post("/lp/call-items/:id/receipt", allow("work_deals"), async (c) => {
    await lp.receive(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/bank/:id/match", allow("work_deals"), async (c) => {
    const b = await c.req.json<{ itemId?: string }>();
    await lp.matchReceipt(c.get("db"), param(c, "id"), String(b.itemId ?? ""), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/funds/:id/bank/sync", allow("work_deals"), async (c) => c.json(await lp.syncBank(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.post("/lp/funds/:id/bank/uploads", uploadLimit, allow("work_deals"), async (c) => c.json(await lp.importBankCsv(c.get("db"), param(c, "id"), await csvUpload(c), who(c)), 201));
  firm.post("/lp/funds/:id/distributions/preview", allow("work_deals"), async (c) => c.json(await lp.previewDistribution(c.get("db"), param(c, "id"), await c.req.json())));
  firm.post("/lp/funds/:id/distributions", allow("work_deals"), async (c) => c.json(await lp.draftDistribution(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/lp/distributions/:id/approve", allow("decide_deals"), async (c) => c.json(await lp.approveDistribution(c.get("db"), param(c, "id"), who(c))));
  firm.post("/lp/distributions/:id/paid", allow("decide_deals"), async (c) => {
    await lp.markDistributionPaid(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/distributions/:id/cancel", allow("decide_deals"), async (c) => {
    await lp.cancelDistribution(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/funds/:id/expenses", allow("work_deals"), async (c) => c.json(await lp.addExpense(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/lp/funds/:id/tax-documents", allow("work_deals"), async (c) => {
    await lp.setTaxDoc(c.get("db"), param(c, "id"), await c.req.json(), who(c));
    return c.json({ ok: true }, 201);
  });
  firm.post("/lp/funds/:id/reports", allow("work_deals"), async (c) => c.json(await lp.prepareReport(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.get("/lp/reports/:id", async (c) => c.json(await lp.report(c.get("db"), param(c, "id"))));
  firm.get("/lp/reports/:id/export/:kind", async (c) => {
    const kind = param(c, "kind").replace(/\.csv$/, "") as lp.ExportKind;
    if (!["capital-accounts", "fees-expenses", "performance", "investments"].includes(kind)) return c.json({ error: "Unknown export." }, 404);
    return csvResponse(c, lp.exportCsv(await lp.report(c.get("db"), param(c, "id")), kind));
  });
  firm.post("/lp/reports/:id/approve", allow("decide_deals"), async (c) => {
    await lp.approveReport(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/reports/:id/withdraw", allow("decide_deals"), async (c) => {
    await lp.withdrawReport(c.get("db"), param(c, "id"), who(c));
    return c.json({ ok: true });
  });
  firm.post("/lp/reports/:id/notices", allow("queue"), async (c) => c.json(await lp.queueReportNotices(c.get("db"), param(c, "id"), who(c), appUrl), 201));

  // Fundraising & Investor Relations. Analysts keep the pipeline, the data
  // room, the DDQ and subscriptions; partners set up raises, approve
  // documents and DDQ answers (never their own), accept subscriptions,
  // approve closings, grant side letter terms and run the LPAC.
  const ok = (c: Context<Env>) => c.json({ ok: true });
  firm.get("/fundraising", async (c) => c.json(await fundraising.overview(c.get("db"))));
  firm.post("/fundraising/raises", allow("decide_deals"), async (c) => c.json(await fundraising.createRaise(c.get("db"), await c.req.json(), who(c)), 201));
  firm.get("/fundraising/raises/:id", async (c) => c.json(await fundraising.raiseView(c.get("db"), param(c, "id"))));
  firm.patch("/fundraising/raises/:id", allow("decide_deals"), async (c) => { await fundraising.editRaise(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/fundraising/raises/:id/prospects", allow("work_deals"), async (c) => c.json(await fundraising.addProspect(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/fundraising/raises/:id/prospects/uploads", uploadLimit, allow("work_deals"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach a CSV file." }, 400);
    return c.json(await fundraising.importProspectsCsv(c.get("db"), param(c, "id"), { name: file.name, text: await file.text() }, who(c)), 201);
  });
  firm.post("/fundraising/raises/:id/prospects/affinity", allow("work_deals"), async (c) => c.json(await fundraising.importAffinityList(c.get("db"), param(c, "id"), (await c.req.json<{ listId?: unknown }>()).listId, who(c)), 201));
  firm.patch("/fundraising/prospects/:id", allow("work_deals"), async (c) => { await fundraising.editProspect(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.get("/fundraising/prospects/:id/activity", async (c) => c.json(await fundraising.prospectActivity(c.get("db"), param(c, "id"))));
  firm.post("/fundraising/prospects/:id/activity", allow("work_deals"), async (c) => { await fundraising.logActivity(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return c.json({ ok: true }, 201); });
  firm.post("/fundraising/prospects/:id/data-room", allow("queue"), async (c) => c.json(await fundraising.shareDataRoom(c.get("db"), param(c, "id"), await c.req.json(), who(c), appUrl), 201));
  firm.post("/fundraising/prospects/:id/data-room/revoke", allow("work_deals"), async (c) => c.json(await fundraising.revokeDataRoom(c.get("db"), param(c, "id"), who(c))));
  firm.post("/fundraising/raises/:id/docs/uploads", uploadLimit, allow("upload"), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Attach a file." }, 400);
    return c.json(await fundraising.uploadDoc(c.get("db"), param(c, "id"), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, { title: body.title, category: body.category, marketing: body.marketing }, who(c)), 201);
  });
  firm.get("/fundraising/docs/:id/file", async (c) => fileResponse(c, await fundraising.downloadDocInternal(c.get("db"), param(c, "id")), true));
  firm.post("/fundraising/docs/:id/approve", allow("decide_deals"), async (c) => {
    const b = await c.req.json<{ checklist?: Record<string, unknown> }>().catch(() => ({} as { checklist?: Record<string, unknown> }));
    await fundraising.approveDoc(c.get("db"), param(c, "id"), who(c), b.checklist);
    return ok(c);
  });
  firm.post("/fundraising/docs/:id/archive", allow("work_deals"), async (c) => { await fundraising.archiveDoc(c.get("db"), param(c, "id"), who(c)); return ok(c); });
  firm.get("/fundraising/ddq", async (c) => c.json({ sections: await fundraising.ddqView(c.get("db")) }));
  firm.post("/fundraising/ddq/draft", allow("work_deals"), async (c) => c.json(await fundraising.draftFromRecords(c.get("db"), who(c))));
  firm.put("/fundraising/ddq/:key", allow("work_deals"), async (c) => { await fundraising.saveAnswer(c.get("db"), param(c, "key"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/fundraising/ddq/:key/approve", allow("decide_deals"), async (c) => { await fundraising.approveDdqAnswer(c.get("db"), param(c, "key"), who(c)); return ok(c); });
  firm.post("/fundraising/ddq/export", allow("queue"), async (c) => {
    const b = await c.req.json<{ prospectId?: string; format?: "markdown" | "csv" }>();
    return c.json(await fundraising.exportDdq(c.get("db"), { prospectId: b.prospectId || undefined, format: b.format }, who(c)));
  });
  firm.post("/fundraising/raises/:id/subscriptions", allow("queue"), async (c) => c.json(await fundraising.inviteSubscriber(c.get("db"), param(c, "id"), await c.req.json(), who(c), appUrl), 201));
  firm.post("/fundraising/subscriptions/:id/screen", allow("work_deals"), async (c) => c.json(await fundraising.screenSubscriber(c.get("db"), param(c, "id"), who(c))));
  firm.post("/fundraising/subscriptions/:id/parallel", allow("work_deals"), async (c) => c.json(await fundraising.checkWithParallel(c.get("db"), param(c, "id"), who(c))));
  firm.patch("/fundraising/subscriptions/:id", allow("work_deals"), async (c) => { await fundraising.reviewSubscription(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/fundraising/subscriptions/:id/decide", allow("decide_deals"), async (c) => c.json(await fundraising.decideSubscription(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.post("/fundraising/subscriptions/:id/withdraw", allow("decide_deals"), async (c) => { await fundraising.withdrawSubscription(c.get("db"), param(c, "id"), who(c)); return ok(c); });
  firm.post("/fundraising/subscriptions/:id/documents", allow("queue"), async (c) => c.json(await fundraising.sendSubscriptionDocs(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/fundraising/subscriptions/:id/terms", allow("decide_deals"), async (c) => c.json(await fundraising.addTerm(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/fundraising/raises/:id/closings", allow("work_deals"), async (c) => c.json(await fundraising.draftClosing(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.get("/fundraising/closings/:id", async (c) => c.json(await fundraising.closingView(c.get("db"), param(c, "id"))));
  firm.post("/fundraising/closings/:id/approve", allow("decide_deals"), async (c) => c.json(await fundraising.approveClosing(c.get("db"), param(c, "id"), who(c))));
  firm.post("/fundraising/closings/:id/cancel", allow("decide_deals"), async (c) => { await fundraising.cancelClosing(c.get("db"), param(c, "id"), who(c)); return ok(c); });
  firm.post("/fundraising/equalization/:id/settle", allow("work_deals"), async (c) => { await fundraising.settle(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.get("/fundraising/raises/:id/side-letters", async (c) => c.json(await fundraising.sideLetterView(c.get("db"), param(c, "id"))));
  firm.post("/fundraising/raises/:id/mfn", allow("queue"), async (c) => c.json(await fundraising.mfnPackage(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/fundraising/mfn/:id", allow("work_deals"), async (c) => c.json(await fundraising.decideMfn(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.get("/ir/funds/:id/lpac", async (c) => c.json(await fundraising.lpacView(c.get("db"), param(c, "id"))));
  firm.post("/ir/funds/:id/lpac/members", allow("decide_deals"), async (c) => { await fundraising.addLpacMember(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return c.json({ ok: true }, 201); });
  firm.post("/ir/lpac/members/:id/end", allow("decide_deals"), async (c) => { await fundraising.endLpacMember(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/ir/funds/:id/lpac/consents", allow("decide_deals"), async (c) => c.json(await fundraising.requestConsent(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/ir/lpac/consents/:id/votes", allow("work_deals"), async (c) => { await fundraising.castVote(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return c.json({ ok: true }, 201); });
  firm.post("/ir/lpac/consents/:id/decide", allow("decide_deals"), async (c) => c.json(await fundraising.decideLpacConsent(c.get("db"), param(c, "id"), await c.req.json(), who(c))));
  firm.get("/ir/requests", async (c) => c.json(await fundraising.requestQueue(c.get("db"))));
  firm.post("/ir/requests", allow("work_deals"), async (c) => c.json(await fundraising.logRequest(c.get("db"), await c.req.json(), who(c)), 201));
  firm.post("/ir/requests/:id/answer", allow("work_deals"), async (c) => { await fundraising.answerInvestorRequest(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });

  // Compliance, shared by every module. Everyone files their own reports,
  // requests and attestations; partners (the CCO) decide requests (never
  // their own), screen deals, keep the restricted list and record filings;
  // an admin sets the regulatory profile.
  firm.get("/compliance", async (c) => {
    const t = await team(root, c.get("session").firm!.id);
    return c.json(await compliance.overview(c.get("db"), { person: who(c), team: t.members.map((m) => `human:${m.email.toLowerCase()}`), reviewer: auth.can(c.get("role"), "decide_deals") }));
  });
  firm.put("/compliance/profile", allow("manage_firm"), async (c) => { await compliance.setProfile(c.get("db"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/compliance/filings", allow("decide_deals"), async (c) => c.json(await compliance.recordFiling(c.get("db"), await c.req.json(), who(c)), 201));
  firm.get("/compliance/form-d", async (c) => c.json(await compliance.findFormD(c.req.query("name") ?? "")));
  firm.post("/compliance/deals/:id/screening", allow("work_deals"), async (c) => c.json(await compliance.screenDeal(c.get("db"), param(c, "id"), await c.req.json(), who(c)), 201));
  firm.post("/compliance/restricted", allow("decide_deals"), async (c) => { await compliance.addRestricted(c.get("db"), await c.req.json(), who(c)); return c.json({ ok: true }, 201); });
  firm.post("/compliance/restricted/:id/remove", allow("decide_deals"), async (c) => { await compliance.dropRestricted(c.get("db"), param(c, "id"), who(c)); return ok(c); });
  firm.post("/compliance/reports", allow("read"), async (c) => c.json(await compliance.fileReport(c.get("db"), who(c), await c.req.json()), 201));
  firm.post("/compliance/preclearances", allow("read"), async (c) => c.json(await compliance.requestPreclearance(c.get("db"), who(c), await c.req.json()), 201));
  firm.post("/compliance/preclearances/:id/decide", allow("decide_deals"), async (c) => { await compliance.decidePreclearance(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/compliance/contributions", allow("read"), async (c) => c.json(await compliance.requestContribution(c.get("db"), who(c), await c.req.json()), 201));
  firm.post("/compliance/contributions/:id/decide", allow("decide_deals"), async (c) => { await compliance.decideContribution(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/compliance/gifts", allow("read"), async (c) => c.json(await compliance.logGift(c.get("db"), who(c), await c.req.json()), 201));
  firm.post("/compliance/gifts/:id/decide", allow("decide_deals"), async (c) => { await compliance.decideGift(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/compliance/conflicts/detect", allow("work_deals"), async (c) => c.json(await compliance.detectConflicts(c.get("db"), who(c))));
  firm.post("/compliance/conflicts", allow("work_deals"), async (c) => { await compliance.addConflict(c.get("db"), await c.req.json(), who(c)); return c.json({ ok: true }, 201); });
  firm.patch("/compliance/conflicts/:id", allow("decide_deals"), async (c) => { await compliance.resolveConflict(c.get("db"), param(c, "id"), await c.req.json(), who(c)); return ok(c); });
  firm.post("/compliance/attestations", allow("read"), async (c) => c.json(await compliance.attest(c.get("db"), who(c), await c.req.json()), 201));

  // Approvals
  firm.get("/outbox", async (c) => c.json(await outbox.pending(c.get("db"), (c.req.query("status") as never) || "pending")));
  firm.post("/outbox/:id/approve", allow("approve_outbox"), async (c) => c.json(await outbox.approve(c.get("db"), param(c, "id"), who(c))));
  firm.post("/outbox/:id/reject", allow("approve_outbox"), async (c) => c.json(await outbox.reject(c.get("db"), param(c, "id"), who(c))));

  // Team
  firm.get("/team", async (c) => c.json({ ...(await team(root, c.get("session").firm!.id)), roles: ROLES }));
  firm.post("/team/invite", allow("manage_team"), async (c) => {
    const { email, role } = await c.req.json<{ email: string; role: Role }>();
    if (!ROLES.includes(role)) return c.json({ error: "Unknown role." }, 400);
    await auth.inviteTeammate(root, c.get("session"), email, role, appUrl, mailer);
    return c.json({ ok: true }, 201);
  });
  firm.delete("/team/:userId", allow("manage_team"), async (c) => {
    await removeMember(root, c.get("session").firm!.id, param(c, "userId"));
    return c.json({ ok: true });
  });

  app.route("/api", firm);
  return app;
}
