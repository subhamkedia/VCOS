import { scopedDb, type Db } from "../../lib/db.js";
import type { Mailer } from "../../lib/mailer.js";
import {
  acceptInvitations, addMembership, consumeLoginToken, createFirm, createLoginToken, createSession, firmsOf, invite as addInvitation,
  linkIdentity, membership, readSession, saveOAuthState, switchFirm, takeOAuthState, upsertUser, userByIdentity,
  type Firm, type Role, type SessionInfo, type User,
} from "../../ledger/platform.js";
import { audit } from "../../ledger/repository.js";
import { authorizeUrl, exchangeCode, identity, missingScopes, pkcePair, PROVIDER_NAMES, providerConfigured, SCOPES, type Provider } from "../../connectors/oauth.js";
import { getConnector, type ConnectorInfo } from "../../connectors/registry.js";
import type { FetchLike } from "../../connectors/types.js";
import { connectWithOAuth } from "../connections/index.js";

export type SignInProvider = "google" | "microsoft";
import { saveProfile, starterProfile } from "../firm/profile.js";

/**
 * Sign-in, workspaces and permissions. Google and Microsoft sign-in use the
 * authorization-code flow with PKCE; an emailed one-time link is the
 * fallback. Sessions are random tokens stored hashed.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type Action =
  | "read" | "queue" | "upload" | "work_deals" | "triage_meetings"
  | "edit_thesis" | "manage_feeds" | "manage_connections" | "approve_outbox" | "decide_merges" | "decide_deals"
  | "manage_team" | "manage_firm";

export const ACTIONS: Action[] = [
  "read", "queue", "upload", "work_deals", "triage_meetings", "edit_thesis", "manage_feeds", "manage_connections",
  "approve_outbox", "decide_merges", "decide_deals", "manage_team", "manage_firm",
];

const ANALYST: Action[] = ["read", "queue", "upload", "work_deals", "triage_meetings"];
const PARTNER: Action[] = [...ANALYST, "edit_thesis", "manage_feeds", "manage_connections", "approve_outbox", "decide_merges", "decide_deals"];

const GRANTS: Record<Role, Action[]> = {
  analyst: ANALYST,
  partner: PARTNER,
  admin: [...PARTNER, "manage_team", "manage_firm"],
};

export const can = (role: Role, action: Action) => GRANTS[role].includes(action);

export class Forbidden extends Error {}

export function requireAction(role: Role | undefined, action: Action) {
  if (!role || !can(role, action)) throw new Forbidden(`Your role can't ${action.replace(/_/g, " ")}.`);
}

/** The audit name for a person: human:<email>. Outbox approvals require this form. */
export const actor = (u: User) => `human:${u.email}`;

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export const providers = () => ({ google: providerConfigured("google"), microsoft: providerConfigured("microsoft") });

export async function beginSignIn(root: Db, provider: SignInProvider, redirectUri: string): Promise<string> {
  if (!providerConfigured(provider)) throw new Error(`${provider === "google" ? "Google" : "Microsoft"} sign-in isn't set up on this server.`);
  const { verifier, challenge } = pkcePair();
  const state = await saveOAuthState(root, { provider, purpose: "signin", codeVerifier: verifier });
  return authorizeUrl(provider, { scopes: SCOPES.signin[provider], state, challenge, redirectUri, offline: false });
}

async function signInAs(root: Db, email: string, name: string | undefined, via: string): Promise<{ token: string; user: User }> {
  const user = await upsertUser(root, { email, name });
  await acceptInvitations(root, user);
  const firms = await firmsOf(root, user.id);
  const token = await createSession(root, user.id, firms[0]?.id ?? null);
  await audit(root, actor(user), "auth.signin", user.id, { via });
  return { token, user };
}

/** Finish a Google or Microsoft sign-in. Returns a session token for the cookie. */
export async function completeOAuth(
  root: Db,
  q: { state: string; code: string; redirectUri: string },
  fetchImpl?: FetchLike,
): Promise<{ kind: "signin"; token: string; user: User } | { kind: "connect"; firmId: string; connectorId: string; account: string; ok: boolean; detail: string }> {
  const st = await takeOAuthState(root, q.state);
  if (!st) throw new Error("That sign-in link has expired. Start again.");
  if (st.purpose === "signin") {
    if (st.provider === "zoom" || st.provider === "docusign") throw new Error(`${PROVIDER_NAMES[st.provider]} can't be used to sign in.`);
    const scopes = SCOPES.signin[st.provider];
    const ex = await exchangeCode(st.provider, { code: q.code, verifier: st.codeVerifier, redirectUri: q.redirectUri, scopes }, fetchImpl);
    const who = await identity(st.provider, ex.accessToken, fetchImpl);
    const known = await userByIdentity(root, who.provider, who.subject);
    const { token, user } = await signInAs(root, known?.email ?? who.email, who.name, who.provider);
    await linkIdentity(root, who.provider, who.subject, user.id);
    return { kind: "signin", token, user };
  }

  // Connecting one or more of a firm's tools with one consent.
  if (!st.firmId || !st.userId || !st.connectorId) throw new Error("Incomplete connect request.");
  const role = await membership(root, st.firmId, st.userId);
  requireAction(role ?? undefined, "manage_connections");
  const targets = oauthTargets(st.connectorId.split(","), st.provider);
  const scopes = unionScopes(targets);
  const ex = await exchangeCode(st.provider, { code: q.code, verifier: st.codeVerifier, redirectUri: q.redirectUri, scopes }, fetchImpl);
  if (!ex.refreshToken) throw new Error(`${PROVIDER_NAMES[st.provider]} didn't grant offline access. Remove VC OS from your account's connected apps and try again.`);
  const who = await identity(st.provider, ex.accessToken, fetchImpl);
  const db = scopedDb(root, st.firmId);
  const results: { connectorId: string; ok: boolean; detail: string }[] = [];
  for (const c of targets) {
    const missing = c.auth.kind === "oauth" ? missingScopes(c.auth.scopes, ex.scope) : [];
    if (missing.length) {
      results.push({ connectorId: c.id, ok: false, detail: `${c.name}: permission not granted (${missing.join(", ")}). Connect again and leave its box ticked.` });
      continue;
    }
    results.push({ connectorId: c.id, ...(await connectWithOAuth(db, c.id, ex.refreshToken, who.email, `human:${who.email}`)) });
    // A meeting tool starts syncing as soon as it's connected.
    const { ensureSync } = await import("../meetings/index.js");
    await ensureSync(db, c.id, `human:${who.email}`);
  }
  const failed = results.filter((r) => !r.ok);
  return {
    kind: "connect", firmId: st.firmId, connectorId: results.map((r) => r.connectorId).join(","), account: who.email,
    ok: failed.length === 0, detail: failed.length ? failed.map((f) => f.detail).join(" ") : `Connected ${targets.map((t) => t.name).join(", ")}.`,
  };
}

/** The connectors one consent covers: all must use the same provider. */
function oauthTargets(ids: string[], provider?: Provider): (ConnectorInfo & { auth: { kind: "oauth" } })[] {
  const out = [...new Set(ids.filter(Boolean))].map(getConnector);
  if (!out.length) throw new Error("Pick something to connect.");
  const p = provider ?? (out[0]!.auth.kind === "oauth" ? out[0]!.auth.provider : undefined);
  for (const c of out) {
    if (c.auth.kind !== "oauth") throw new Error(`${c.name} doesn't connect with OAuth.`);
    if (c.auth.provider !== p) throw new Error(`${c.name} uses a different account provider; connect it separately.`);
  }
  return out as (ConnectorInfo & { auth: { kind: "oauth" } })[];
}

function unionScopes(cs: { auth: { kind: "oauth"; scopes: readonly string[] } }[]): string[] {
  return [...new Set(cs.flatMap((c) => c.auth.scopes))];
}

/**
 * Start connecting one or more products from the same provider (Gmail,
 * Drive, Calendar and Meet are all Google) with a single consent screen.
 */
export async function beginConnect(root: Db, s: SessionInfo, connectorIds: string | string[], redirectUri: string): Promise<string> {
  if (!s.firm) throw new Error("Create or join a firm first.");
  requireAction(s.firm.role, "manage_connections");
  const targets = oauthTargets(Array.isArray(connectorIds) ? connectorIds : [connectorIds]);
  const provider = targets[0]!.auth.provider;
  if (!providerConfigured(provider)) throw new Error(`This server has no ${PROVIDER_NAMES[provider]} app configured.`);
  const { verifier, challenge } = pkcePair();
  const state = await saveOAuthState(root, { provider, purpose: "connect", codeVerifier: verifier, userId: s.user.id, firmId: s.firm.id, connectorId: targets.map((t) => t.id).join(",") });
  return authorizeUrl(provider, { scopes: unionScopes(targets), state, challenge, redirectUri, offline: true, loginHint: s.user.email });
}

/** Email a one-time sign-in link. Always looks the same to the caller, whether or not the address is known. */
export async function requestEmailLink(root: Db, email: string, appUrl: string, mailer: Mailer): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("Enter a valid email address.");
  const token = await createLoginToken(root, e);
  await mailer.send({
    to: e,
    subject: "Your VC OS sign-in link",
    text: `Sign in to VC OS:\n\n${appUrl.replace(/\/$/, "")}/api/auth/email/callback?token=${encodeURIComponent(token)}\n\nThe link works once, for 15 minutes. If you didn't ask for it, ignore this email.`,
  });
}

export async function completeEmailLink(root: Db, token: string): Promise<{ token: string; user: User }> {
  const email = await consumeLoginToken(root, token);
  if (!email) throw new Error("That sign-in link has expired or was already used.");
  return signInAs(root, email, undefined, "email");
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Create a firm with the signer as admin, seeded with the starter thesis, and make it their current firm. */
export async function createWorkspace(root: Db, sessionToken: string, name: string): Promise<Firm> {
  const s = await readSession(root, sessionToken);
  if (!s) throw new Error("Not signed in.");
  const firm = await createFirm(root, { name, createdBy: actor(s.user) });
  await addMembership(root, firm.id, s.user.id, "admin");
  await switchFirm(root, sessionToken, firm.id);
  await saveProfile(scopedDb(root, firm.id), await starterProfile(firm.name), actor(s.user));
  return firm;
}

export async function inviteTeammate(root: Db, s: SessionInfo, email: string, role: Role, appUrl: string, mailer: Mailer): Promise<void> {
  if (!s.firm) throw new Error("No current firm.");
  requireAction(s.firm.role, "manage_team");
  await addInvitation(root, s.firm.id, email, role, s.user.id);
  await mailer.send({
    to: email.trim().toLowerCase(),
    subject: `${s.user.name ?? s.user.email} invited you to ${s.firm.name} on VC OS`,
    text: `You've been invited to join ${s.firm.name} as ${role}.\n\nSign in with this email address at ${appUrl} to accept.`,
  });
  await audit(scopedDb(root, s.firm.id), actor(s.user), "team.invite", email, { role });
}
