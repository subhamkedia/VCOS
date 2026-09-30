import { randomBytes } from "node:crypto";
import type { Db } from "../lib/db.js";
import { sha256 } from "../lib/text.js";
import { audit } from "./repository.js";

/**
 * Platform tables: firms, people, memberships, sessions and sign-in tokens.
 * These functions take the ROOT Db (not a firm-scoped one): they decide
 * which firm a request belongs to, so they sit outside any one firm.
 * Tokens are random, shown once, and stored only as SHA-256 hashes.
 */

export type Role = "admin" | "partner" | "analyst";
export const ROLES: Role[] = ["admin", "partner", "analyst"];

export interface Firm {
  id: string;
  name: string;
  slug: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export const newToken = () => randomBytes(32).toString("base64url");

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return s.length >= 2 ? s : `firm-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Firms
// ---------------------------------------------------------------------------

export async function createFirm(root: Db, input: { name: string; createdBy?: string }): Promise<Firm> {
  const name = input.name.trim();
  if (!name) throw new Error("A firm needs a name.");
  const base = slugify(name);
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { rows } = await root.query<Firm>(
      "insert into firms(name, slug) values ($1,$2) on conflict (slug) do nothing returning id, name, slug",
      [name, slug],
    );
    if (rows[0]) {
      await audit(root, input.createdBy ?? "platform", "firm.create", rows[0].id, { name });
      return rows[0];
    }
  }
  throw new Error(`Could not find a free slug for "${name}"`);
}

export async function getFirm(root: Db, id: string): Promise<Firm | null> {
  return (await root.query<Firm>("select id, name, slug from firms where id=$1", [id])).rows[0] ?? null;
}

export async function getFirmBySlug(root: Db, slug: string): Promise<Firm | null> {
  return (await root.query<Firm>("select id, name, slug from firms where slug=$1", [slug])).rows[0] ?? null;
}

export async function listFirms(root: Db): Promise<Firm[]> {
  return (await root.query<Firm>("select id, name, slug from firms order by created_at")).rows;
}

export async function renameFirm(root: Db, id: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error("A firm needs a name.");
  await root.query("update firms set name=$2 where id=$1", [id, name.trim()]);
}

// ---------------------------------------------------------------------------
// People and memberships
// ---------------------------------------------------------------------------

export async function upsertUser(root: Db, input: { email: string; name?: string | null }): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const { rows } = await root.query<User>(
    `insert into users(email, name) values ($1,$2)
     on conflict (email) do update set name = coalesce(users.name, excluded.name)
     returning id, email, name`,
    [email, input.name?.trim() || null],
  );
  return rows[0]!;
}

/** The user behind a provider account (Google `sub`, Microsoft object id), if seen before. */
export async function userByIdentity(root: Db, provider: string, subject: string): Promise<User | null> {
  const { rows } = await root.query<User>(
    `select u.id, u.email, u.name from user_identities i join users u on u.id = i.user_id
      where i.provider=$1 and i.subject=$2`,
    [provider, subject],
  );
  return rows[0] ?? null;
}

export async function linkIdentity(root: Db, provider: string, subject: string, userId: string): Promise<void> {
  await root.query(
    "insert into user_identities(provider, subject, user_id) values ($1,$2,$3) on conflict (provider, subject) do nothing",
    [provider, subject, userId],
  );
}

export async function getUser(root: Db, id: string): Promise<User | null> {
  return (await root.query<User>("select id, email, name from users where id=$1", [id])).rows[0] ?? null;
}

export async function addMembership(root: Db, firmId: string, userId: string, role: Role): Promise<void> {
  await root.query(
    `insert into memberships(firm_id, user_id, role) values ($1,$2,$3)
     on conflict (firm_id, user_id) do update set role = excluded.role`,
    [firmId, userId, role],
  );
}

export async function membership(root: Db, firmId: string, userId: string): Promise<Role | null> {
  const { rows } = await root.query<{ role: Role }>("select role from memberships where firm_id=$1 and user_id=$2", [firmId, userId]);
  return rows[0]?.role ?? null;
}

export async function firmsOf(root: Db, userId: string): Promise<(Firm & { role: Role })[]> {
  const { rows } = await root.query<Firm & { role: Role }>(
    `select f.id, f.name, f.slug, m.role from memberships m join firms f on f.id = m.firm_id
      where m.user_id=$1 order by m.created_at`,
    [userId],
  );
  return rows;
}

export async function team(root: Db, firmId: string) {
  const members = (
    await root.query<{ user_id: string; email: string; name: string | null; role: Role }>(
      `select u.id as user_id, u.email, u.name, m.role from memberships m join users u on u.id = m.user_id
        where m.firm_id=$1 order by m.created_at`,
      [firmId],
    )
  ).rows;
  const invited = (
    await root.query<{ id: string; email: string; role: Role }>(
      "select id, email, role from invitations where firm_id=$1 and accepted_at is null order by created_at",
      [firmId],
    )
  ).rows;
  return { members, invited };
}

export async function removeMember(root: Db, firmId: string, userId: string): Promise<void> {
  const admins = await root.query<{ n: number }>("select count(*)::int as n from memberships where firm_id=$1 and role='admin' and user_id<>$2", [firmId, userId]);
  const role = await membership(root, firmId, userId);
  if (role === "admin" && admins.rows[0]!.n === 0) throw new Error("A firm needs at least one admin.");
  await root.query("delete from memberships where firm_id=$1 and user_id=$2", [firmId, userId]);
}

/** Invite someone by email. They join when they first sign in with that address. */
export async function invite(root: Db, firmId: string, email: string, role: Role, invitedBy: string): Promise<string> {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`Not an email address: ${email}`);
  const { rows } = await root.query<{ id: string }>(
    `insert into invitations(firm_id, email, role, invited_by) values ($1,$2,$3,$4)
     on conflict (firm_id, email) do update set role = excluded.role, accepted_at = null returning id`,
    [firmId, e, role, invitedBy],
  );
  return rows[0]!.id;
}

/** On sign-in: turn any open invitations for this email into memberships. */
export async function acceptInvitations(root: Db, user: User): Promise<number> {
  const { rows } = await root.query<{ firm_id: string; role: Role }>(
    "update invitations set accepted_at = now() where email=$1 and accepted_at is null returning firm_id, role",
    [user.email],
  );
  for (const r of rows) {
    if (!(await membership(root, r.firm_id, user.id))) await addMembership(root, r.firm_id, user.id, r.role);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_DAYS = 30;

export async function createSession(root: Db, userId: string, firmId: string | null): Promise<string> {
  const token = newToken();
  await root.query(
    `insert into sessions(token_hash, user_id, firm_id, expires_at) values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [sha256(token), userId, firmId, String(SESSION_DAYS)],
  );
  await root.query("update users set last_login_at = now() where id=$1", [userId]);
  return token;
}

export interface SessionInfo {
  user: User;
  firm: (Firm & { role: Role }) | null;
}

/** The signed-in person and their current firm, or null if the token is unknown or expired. */
export async function readSession(root: Db, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const { rows } = await root.query<{ user_id: string; firm_id: string | null }>(
    "select user_id, firm_id from sessions where token_hash=$1 and expires_at > now()",
    [sha256(token)],
  );
  const s = rows[0];
  if (!s) return null;
  const user = await getUser(root, s.user_id);
  if (!user) return null;
  const firms = await firmsOf(root, user.id);
  const firm = firms.find((f) => f.id === s.firm_id) ?? firms[0] ?? null;
  return { user, firm };
}

export async function switchFirm(root: Db, token: string, firmId: string): Promise<void> {
  const s = await readSession(root, token);
  if (!s) throw new Error("Not signed in.");
  if (!(await membership(root, firmId, s.user.id))) throw new Error("You are not a member of that firm.");
  await root.query("update sessions set firm_id=$2 where token_hash=$1", [sha256(token), firmId]);
}

export async function endSession(root: Db, token: string | undefined): Promise<void> {
  if (token) await root.query("delete from sessions where token_hash=$1", [sha256(token)]);
}

// ---------------------------------------------------------------------------
// Email sign-in links and OAuth state
// ---------------------------------------------------------------------------

export async function createLoginToken(root: Db, email: string, minutes = 15): Promise<string> {
  const token = newToken();
  await root.query(
    `insert into login_tokens(token_hash, email, expires_at) values ($1,$2, now() + ($3 || ' minutes')::interval)`,
    [sha256(token), email.trim().toLowerCase(), String(minutes)],
  );
  return token;
}

/** Single use: returns the email once, then never again. */
export async function consumeLoginToken(root: Db, token: string): Promise<string | null> {
  const { rows } = await root.query<{ email: string }>(
    `update login_tokens set used_at = now()
      where token_hash=$1 and used_at is null and expires_at > now() returning email`,
    [sha256(token)],
  );
  return rows[0]?.email ?? null;
}

export interface OAuthState {
  provider: "google" | "microsoft" | "zoom" | "docusign";
  purpose: "signin" | "connect";
  codeVerifier: string;
  userId?: string;
  firmId?: string;
  /** One connector id, or several joined by commas when one consent covers several products. */
  connectorId?: string;
}

export async function saveOAuthState(root: Db, s: OAuthState): Promise<string> {
  const state = newToken();
  await root.query(
    `insert into oauth_states(state, provider, purpose, code_verifier, user_id, firm_id, connector_id, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + interval '10 minutes')`,
    [state, s.provider, s.purpose, s.codeVerifier, s.userId ?? null, s.firmId ?? null, s.connectorId ?? null],
  );
  return state;
}

/** Single use, and only within ten minutes. */
export async function takeOAuthState(root: Db, state: string): Promise<OAuthState | null> {
  const { rows } = await root.query<{ provider: OAuthState["provider"]; purpose: OAuthState["purpose"]; code_verifier: string; user_id: string | null; firm_id: string | null; connector_id: string | null }>(
    "delete from oauth_states where state=$1 and expires_at > now() returning provider, purpose, code_verifier, user_id, firm_id, connector_id",
    [state],
  );
  const r = rows[0];
  return r
    ? { provider: r.provider, purpose: r.purpose, codeVerifier: r.code_verifier, userId: r.user_id ?? undefined, firmId: r.firm_id ?? undefined, connectorId: r.connector_id ?? undefined }
    : null;
}

// ---------------------------------------------------------------------------
// Founder portal links. A founder has no session, so the firm comes from the
// link: these two lookups run as root, return only ids, and everything after
// runs on the firm's scoped Db.
// ---------------------------------------------------------------------------

export interface PortalRef {
  id: string;
  firmId: string;
  companyId: string;
}

/** A live portal link by its token (only the hash is stored). */
export async function portalLinkByToken(root: Db, token: string): Promise<PortalRef | null> {
  if (!token || token.length < 20) return null;
  const { rows } = await root.query<{ id: string; firm_id: string; company_id: string }>(
    `update portal_links set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning id, firm_id, company_id`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, firmId: r.firm_id, companyId: r.company_id } : null;
}

export interface LpPortalRef {
  id: string;
  firmId: string;
  partnerId: string;
}

/** An investor's live portal link by its token (only the hash is stored). */
export async function lpPortalByToken(root: Db, token: string): Promise<LpPortalRef | null> {
  if (!token || token.length < 20) return null;
  const { rows } = await root.query<{ id: string; firm_id: string; partner_id: string }>(
    `update lp_portal_links set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning id, firm_id, partner_id`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, firmId: r.firm_id, partnerId: r.partner_id } : null;
}

export interface DataRoomRef {
  id: string;
  firmId: string;
  prospectId: string;
}

/** A prospect's live data room link by its token (only the hash is stored). */
export async function dataRoomByToken(root: Db, token: string): Promise<DataRoomRef | null> {
  if (!token || token.length < 20) return null;
  const { rows } = await root.query<{ id: string; firm_id: string; prospect_id: string }>(
    `update dataroom_links set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning id, firm_id, prospect_id`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, firmId: r.firm_id, prospectId: r.prospect_id } : null;
}

export interface SubscriptionRef {
  firmId: string;
  subscriptionId: string;
}

/** An investor's live subscription link by its token. It stops working once the subscription is decided. */
export async function subscriptionByToken(root: Db, token: string): Promise<SubscriptionRef | null> {
  if (!token || token.length < 20) return null;
  const { rows } = await root.query<{ id: string; firm_id: string }>(
    `select id, firm_id from subscriptions
      where token_hash = $1 and token_revoked_at is null and token_expires_at > now() and status in ('invited', 'submitted')`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { firmId: r.firm_id, subscriptionId: r.id } : null;
}

/** The accounting OAuth flow a portal link started. Single use, within fifteen minutes. */
export async function takePortalOAuth(root: Db, state: string): Promise<(PortalRef & { provider: "quickbooks" | "xero"; verifier: string }) | null> {
  const { rows } = await root.query<{ id: string; firm_id: string; company_id: string; oauth_provider: "quickbooks" | "xero"; oauth_verifier: string }>(
    `with hit as (
       select id, firm_id, company_id, oauth_provider, oauth_verifier from portal_links
        where oauth_state = $1 and oauth_expires_at > now() and revoked_at is null and expires_at > now()
     )
     update portal_links p set oauth_state = null, oauth_verifier = null, oauth_expires_at = null
       from hit where p.id = hit.id
     returning hit.id, hit.firm_id, hit.company_id, hit.oauth_provider, hit.oauth_verifier`,
    [state],
  );
  const r = rows[0];
  return r ? { id: r.id, firmId: r.firm_id, companyId: r.company_id, provider: r.oauth_provider, verifier: r.oauth_verifier } : null;
}

/** A throwaway in-memory database with one firm, for the demo and evals. Closing the Db closes the database. */
export async function inMemoryFirm(name = "Demo Fund"): Promise<{ root: Db; db: Db; firm: Firm }> {
  const { createPgliteDb, migrate, scopedDb } = await import("../lib/db.js");
  const root = await createPgliteDb();
  await migrate(root);
  const firm = await createFirm(root, { name });
  return { root, db: scopedDb(root, firm.id, { closeRoot: true }), firm };
}
