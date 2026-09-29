import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { scopedDb, type Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import type { Mailer } from "../lib/mailer.js";
import { endSession, readSession, removeMember, renameFirm, switchFirm, team, SESSION_DAYS, ROLES, type Role, type SessionInfo } from "../ledger/platform.js";
import * as auth from "../modules/auth/index.js";
import * as connections from "../modules/connections/index.js";
import * as sourcing from "../modules/sourcing/index.js";
import * as companies from "../modules/companies/index.js";
import * as outbox from "../modules/outbox/index.js";
import * as meetings from "../modules/meetings/index.js";
import * as diligence from "../modules/diligence/index.js";
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
    if (err instanceof sourcing.FeedInvalid || err instanceof diligence.DiligenceInvalid || err instanceof meetings.MeetingInvalid) {
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
