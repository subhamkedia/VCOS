import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { config } from "../lib/config.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import type { Mailer } from "../lib/mailer.js";
import { testRoot } from "./helpers.js";
import { addMembership, readSession, upsertUser, invite, firmsOf } from "../ledger/platform.js";
import {
  beginConnect, beginSignIn, can, completeEmailLink, completeOAuth, createWorkspace, inviteTeammate, requestEmailLink, Forbidden,
} from "../modules/auth/index.js";
import { getProfile } from "../modules/firm/profile.js";
import { catalog } from "../modules/connections/index.js";

beforeAll(() => setSecretKeyForTests(randomBytes(32)));

let root: Db;
beforeEach(async () => {
  root = await testRoot();
  Object.assign(config, { googleClientId: "gid", googleClientSecret: "gsec", msClientId: "mid", msClientSecret: "msec" });
});

function mailbox(): Mailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return { sent, send: async (m) => void sent.push(m) };
}

/** Fake Google/Microsoft token and profile endpoints. */
function provider(profile: Record<string, unknown>, tokens: Record<string, unknown> = { access_token: "at", refresh_token: "rt-1" }) {
  return async (url: string) => {
    if (url.includes("/token")) return new Response(JSON.stringify(tokens));
    if (url.includes("userinfo") || url.includes("graph.microsoft.com")) return new Response(JSON.stringify(profile));
    return new Response("?", { status: 404 });
  };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const cb = "https://app.example/api/auth/callback";

describe("sign-in", () => {
  it("signs in with Google, creates the user once, and links the account", async () => {
    const url = await beginSignIn(root, "google", cb);
    expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
    const fetchImpl = provider({ sub: "g-123", email: "Pat@Alpha.example", email_verified: true, name: "Pat" });
    const r = await completeOAuth(root, { state: stateOf(url), code: "c", redirectUri: cb }, fetchImpl);
    expect(r.kind).toBe("signin");
    if (r.kind !== "signin") return;
    expect(r.user.email).toBe("pat@alpha.example");
    expect((await readSession(root, r.token))?.user.id).toBe(r.user.id);
    // Same Google account again: same user. A replayed state is refused.
    const again = await completeOAuth(root, { state: stateOf(await beginSignIn(root, "google", cb)), code: "c", redirectUri: cb }, fetchImpl);
    expect(again.kind === "signin" && again.user.id).toBe(r.user.id);
    await expect(completeOAuth(root, { state: stateOf(url), code: "c", redirectUri: cb }, fetchImpl)).rejects.toThrow(/expired/);
  });

  it("refuses unverified Google emails and Microsoft guest accounts", async () => {
    const g = await beginSignIn(root, "google", cb);
    await expect(completeOAuth(root, { state: stateOf(g), code: "c", redirectUri: cb }, provider({ sub: "x", email: "x@y.example", email_verified: false }))).rejects.toThrow(/verified/);
    const m = await beginSignIn(root, "microsoft", cb);
    await expect(completeOAuth(root, { state: stateOf(m), code: "c", redirectUri: cb }, provider({ id: "o1", userPrincipalName: "x_gmail.com#EXT#@tenant.onmicrosoft.com" }))).rejects.toThrow(/work account/);
  });

  it("signs in by emailed link, once", async () => {
    const mail = mailbox();
    await requestEmailLink(root, "Sam@Beta.example", "https://app.example", mail);
    expect(mail.sent[0]!.to).toBe("sam@beta.example");
    const token = new URL(mail.sent[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    const r = await completeEmailLink(root, token);
    expect(r.user.email).toBe("sam@beta.example");
    await expect(completeEmailLink(root, token)).rejects.toThrow(/expired or was already used/);
    await expect(requestEmailLink(root, "nope", "https://app.example", mail)).rejects.toThrow(/valid email/);
  });

  it("joins invited firms on first sign-in", async () => {
    const admin = await upsertUser(root, { email: "admin@alpha.example" });
    const mail = mailbox();
    const url = await beginSignIn(root, "google", cb);
    const first = await completeOAuth(root, { state: stateOf(url), code: "c", redirectUri: cb }, provider({ sub: "a", email: "admin@alpha.example", email_verified: true }));
    const firm = await createWorkspace(root, (first as { token: string }).token, "Alpha Ventures");
    await invite(root, firm.id, "analyst@alpha.example", "analyst", admin.id);
    const r = await completeEmailLink(root, await (async () => {
      await requestEmailLink(root, "analyst@alpha.example", "https://app.example", mail);
      return new URL(mail.sent[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    })());
    expect((await readSession(root, r.token))?.firm).toMatchObject({ name: "Alpha Ventures", role: "analyst" });
  });
});

describe("workspaces and roles", () => {
  it("creates a firm with the creator as admin and a starter thesis", async () => {
    const u = await upsertUser(root, { email: "gp@gamma.example" });
    const { createSession } = await import("../ledger/platform.js");
    const token = await createSession(root, u.id, null);
    const firm = await createWorkspace(root, token, "Gamma Partners");
    expect((await firmsOf(root, u.id))[0]).toMatchObject({ id: firm.id, role: "admin" });
    const p = await getProfile(scopedDb(root, firm.id));
    expect(p?.profile.firm.name).toBe("Gamma Partners");
    expect(p?.version).toBe(1);
  });

  it("grants actions by role", () => {
    expect(can("analyst", "read")).toBe(true);
    expect(can("analyst", "approve_outbox")).toBe(false);
    expect(can("partner", "approve_outbox")).toBe(true);
    expect(can("partner", "manage_team")).toBe(false);
    expect(can("admin", "manage_team")).toBe(true);
  });

  it("lets partners connect a mailbox for the firm, and not analysts", async () => {
    const u = await upsertUser(root, { email: "pat@alpha.example" });
    const { createSession } = await import("../ledger/platform.js");
    const token = await createSession(root, u.id, null);
    const firm = await createWorkspace(root, token, "Alpha Ventures");
    const s = (await readSession(root, token))!;
    const url = await beginConnect(root, s, "gmail", cb);
    expect(new URL(url).searchParams.get("access_type")).toBe("offline");
    expect(new URL(url).searchParams.get("scope")).toContain("gmail.readonly");
    const r = await completeOAuth(root, { state: stateOf(url), code: "c", redirectUri: cb }, provider({ sub: "g-1", email: "pat@alpha.example", email_verified: true }));
    expect(r).toMatchObject({ kind: "connect", connectorId: "gmail", account: "pat@alpha.example" });
    const gmail = (await catalog(scopedDb(root, firm.id))).find((c) => c.id === "gmail")!;
    expect(gmail.accountLabel).toBe("pat@alpha.example");
    expect(gmail.status).not.toBe("not_configured");

    const analyst = await upsertUser(root, { email: "an@alpha.example" });
    await addMembership(root, firm.id, analyst.id, "analyst");
    const at = await createSession(root, analyst.id, firm.id);
    await expect(beginConnect(root, (await readSession(root, at))!, "gmail", cb)).rejects.toThrow(Forbidden);
    await expect(inviteTeammate(root, (await readSession(root, at))!, "x@alpha.example", "analyst", "https://app.example", mailbox())).rejects.toThrow(Forbidden);
  });

  it("connects several Google products with one consent, and reports permissions the person unticked", async () => {
    const u = await upsertUser(root, { email: "pat@alpha.example" });
    const { createSession } = await import("../ledger/platform.js");
    const token = await createSession(root, u.id, null);
    const firm = await createWorkspace(root, token, "Alpha Ventures");
    const s = (await readSession(root, token))!;
    const url = new URL(await beginConnect(root, s, ["gmail", "google-calendar", "google-meet"], cb));
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("gmail.readonly");
    expect(scope).toContain("calendar.events.readonly");
    expect(scope).toContain("meetings.space.readonly");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    await expect(beginConnect(root, s, ["gmail", "outlook"], cb)).rejects.toThrow(/different account provider/);
    // The person unticked Meet on Google's consent screen.
    const granted = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events.readonly";
    const r = await completeOAuth(root, { state: stateOf(url.toString()), code: "c", redirectUri: cb },
      provider({ sub: "g-1", email: "pat@alpha.example", email_verified: true }, { access_token: "at", refresh_token: "rt-1", scope: granted }));
    expect(r).toMatchObject({ kind: "connect", ok: false });
    expect((r as { detail: string }).detail).toMatch(/Google Meet: permission not granted/);
    const cat = await catalog(scopedDb(root, firm.id));
    const status = (id: string) => cat.find((c) => c.id === id)!.status;
    expect(status("gmail")).not.toBe("not_configured");
    expect(status("google-calendar")).not.toBe("not_configured");
    expect(status("google-meet")).toBe("not_configured");
  });

  it("gives every Google product the newest token after an incremental consent", async () => {
    const u = await upsertUser(root, { email: "pat@alpha.example" });
    const { createSession } = await import("../ledger/platform.js");
    const token = await createSession(root, u.id, null);
    const firm = await createWorkspace(root, token, "Alpha Ventures");
    const s = (await readSession(root, token))!;
    const db = scopedDb(root, firm.id);
    const first = await beginConnect(root, s, "gmail", cb);
    await completeOAuth(root, { state: stateOf(first), code: "c", redirectUri: cb }, provider({ sub: "g-1", email: "pat@alpha.example", email_verified: true }, { access_token: "a", refresh_token: "rt-1" }));
    const second = await beginConnect(root, s, "google-calendar", cb);
    await completeOAuth(root, { state: stateOf(second), code: "c", redirectUri: cb }, provider({ sub: "g-1", email: "pat@alpha.example", email_verified: true }, { access_token: "b", refresh_token: "rt-2" }));
    const { withFirmCredentials } = await import("../modules/connections/index.js");
    const { setting } = await import("../lib/config.js");
    expect(await withFirmCredentials(db, ["gmail"], async () => setting("googleRefreshToken"))).toBe("rt-2");
  });
});

