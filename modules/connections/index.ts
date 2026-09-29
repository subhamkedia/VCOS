import { config, withCredentials, type ConfigKey } from "../../lib/config.js";
import { updateConnectionCredentials } from "../../ledger/workspace.js";
import { decryptJson, encryptJson } from "../../lib/secrets.js";
import type { Db } from "../../lib/db.js";
import { disconnect as markDisconnected, getConnection, listConnections, recordConnectionCheck, saveConnection } from "../../ledger/workspace.js";
import { CONNECTORS, getConnector, missingKeys, type Category, type ConnectorAuth, type ParamSpec, type Cadence } from "../../connectors/registry.js";
import { providerConfigured } from "../../connectors/oauth.js";

/**
 * A firm's connections to outside tools. Credentials are encrypted before
 * they're stored and never returned to a caller; connector code runs inside
 * `withFirmCredentials`, which gives it that firm's keys and nobody else's.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  category: Category;
  description: string;
  scope: string;
  docsUrl?: string;
  writes?: string;
  manual: boolean;
  auth:
    | { kind: "none" }
    | { kind: "platform"; note: string; ready: boolean }
    | { kind: "api_key"; fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string }[] }
    | { kind: "oauth"; provider: "google" | "microsoft" | "zoom" | "docusign"; available: boolean; product?: string };
  sourcing?: { mode: "discover" | "enrich"; summary: string; params: ParamSpec[]; defaultCadence: Cadence };
  /** Used in diligence to research a company. */
  research?: { summary: string; needsDomain: boolean };
  /** A meeting tool that syncs on its own. */
  meetings?: { summary: string; defaultCadence: Cadence };
  status: "available" | "connected" | "error" | "not_configured";
  accountLabel: string | null;
  connectedBy: string | null;
  connectedAt: unknown;
  lastCheckedAt: unknown;
  lastError: string | null;
}

function publicAuth(a: ConnectorAuth): CatalogEntry["auth"] {
  switch (a.kind) {
    case "none": return { kind: "none" };
    case "platform": return { kind: "platform", note: a.note, ready: a.keys.every((k) => Boolean(config[k])) };
    case "api_key": return { kind: "api_key", fields: a.fields.map(({ key, label, secret, placeholder, help }) => ({ key, label, secret, placeholder, help })) };
    case "oauth": return { kind: "oauth", provider: a.provider, available: providerConfigured(a.provider) };
  }
}

/** Every connector with this firm's status. Never includes credentials. */
export async function catalog(db: Db): Promise<CatalogEntry[]> {
  const rows = new Map((await listConnections(db)).map((r) => [r.connector_id, r]));
  return CONNECTORS.map((c) => {
    const r = rows.get(c.id);
    const needsNothing = c.auth.kind === "none" || c.auth.kind === "platform";
    const status: CatalogEntry["status"] =
      r && r.status !== "disconnected" ? r.status : needsNothing ? "available" : "not_configured";
    const auth = publicAuth(c.auth);
    if (auth.kind === "oauth" && c.product) auth.product = c.product;
    return {
      id: c.id, name: c.name, category: c.category, description: c.description, scope: c.scope, docsUrl: c.docsUrl,
      writes: c.writes, manual: Boolean(c.manual), auth,
      sourcing: c.sourcing ? { mode: c.sourcing.mode, summary: c.sourcing.summary, params: c.sourcing.params, defaultCadence: c.sourcing.defaultCadence } : undefined,
      research: c.research ? { summary: c.research.summary, needsDomain: Boolean(c.research.needsDomain) } : undefined,
      meetings: c.meetings ? { summary: c.meetings.summary, defaultCadence: c.meetings.defaultCadence } : undefined,
      status, accountLabel: r?.account_label ?? null, connectedBy: r?.connected_by ?? null, connectedAt: r?.connected_at ?? null,
      lastCheckedAt: r?.last_checked_at ?? null, lastError: r?.last_error ?? null,
    };
  });
}

type Creds = Partial<Record<ConfigKey, string>>;

async function credentialsFor(db: Db, connectorId: string): Promise<Creds> {
  const row = await getConnection(db, connectorId);
  return row?.credentials && row.status !== "disconnected" ? decryptJson<Creds>(row.credentials) : {};
}

/**
 * Run connector code as this firm. Loads and decrypts the firm's credentials
 * for the given connectors, and nothing else: no other firm's keys, and no
 * vendor keys from the server's environment. A credential the provider
 * rotates during the call (a refresh token) is saved back, encrypted, on
 * every connection that held it.
 */
export async function withFirmCredentials<T>(db: Db, connectorIds: string[], fn: () => Promise<T>): Promise<T> {
  const creds: Creds = {};
  const holders = new Map<ConfigKey, string[]>();
  for (const id of connectorIds) {
    const c = await credentialsFor(db, id);
    for (const k of Object.keys(c) as ConfigKey[]) holders.set(k, [...(holders.get(k) ?? []), id]);
    Object.assign(creds, c);
  }
  return withCredentials(creds, fn, async (key, value) => {
    for (const id of holders.get(key) ?? []) {
      const row = await getConnection(db, id);
      if (!row?.credentials) continue;
      await updateConnectionCredentials(db, id, encryptJson({ ...decryptJson<Creds>(row.credentials), [key]: value }));
    }
  });
}

/** Can this firm use the connector right now? */
export async function isReady(db: Db, connectorId: string): Promise<boolean> {
  const c = getConnector(connectorId);
  return withFirmCredentials(db, [connectorId], async () => missingKeys(c).length === 0);
}

export async function testConnection(db: Db, connectorId: string): Promise<{ ok: boolean; detail: string }> {
  const c = getConnector(connectorId);
  const outcome = await withFirmCredentials(db, [connectorId], async () => {
    const missing = missingKeys(c);
    if (missing.length) return { ok: false, detail: `Missing ${missing.join(", ")}` };
    if (!c.check) return { ok: true, detail: "Saved. This source has no test call; run it once to confirm." };
    try {
      return { ok: true, detail: await c.check() };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  });
  if (await getConnection(db, connectorId)) await recordConnectionCheck(db, connectorId, outcome);
  return outcome;
}

/** Save API-key credentials, then test them. Only the fields the connector declares are kept. */
export async function connectWithKeys(db: Db, connectorId: string, values: Record<string, string>, by: string) {
  const c = getConnector(connectorId);
  if (c.auth.kind !== "api_key") throw new Error(`${c.name} doesn't connect with an API key.`);
  const creds: Creds = {};
  for (const f of c.auth.fields) {
    const v = values[f.key]?.trim();
    if (!v) throw new Error(`${f.label} is required.`);
    creds[f.key] = v;
  }
  await saveConnection(db, { connectorId, credentials: encryptJson(creds), connectedBy: by, accountLabel: null });
  return testConnection(db, connectorId);
}

/**
 * Save the refresh token from a completed OAuth consent. With incremental
 * consent the new token covers everything granted before too, so every
 * other connection on the same account provider gets it as well.
 */
export async function connectWithOAuth(db: Db, connectorId: string, refreshToken: string, accountLabel: string, by: string) {
  const c = getConnector(connectorId);
  if (c.auth.kind !== "oauth") throw new Error(`${c.name} doesn't connect with OAuth.`);
  const provider = c.auth.provider;
  const refreshKey = c.auth.refreshKey;
  await saveConnection(db, { connectorId, credentials: encryptJson({ [refreshKey]: refreshToken }), connectedBy: by, accountLabel });
  for (const row of await listConnections(db)) {
    if (row.connector_id === connectorId || row.status === "disconnected" || !row.credentials) continue;
    const other = CONNECTORS.find((x) => x.id === row.connector_id);
    if (other?.auth.kind !== "oauth" || other.auth.provider !== provider) continue;
    await updateConnectionCredentials(db, other.id, encryptJson({ [refreshKey]: refreshToken }));
  }
  return testConnection(db, connectorId);
}

/** Record that a no-key source (YC, SEC, uploads) is in use, so it shows as connected. */
export async function enable(db: Db, connectorId: string, by: string) {
  const c = getConnector(connectorId);
  if (c.auth.kind !== "none" && c.auth.kind !== "platform") throw new Error(`${c.name} needs credentials.`);
  await saveConnection(db, { connectorId, credentials: null, connectedBy: by, accountLabel: null });
  return testConnection(db, connectorId);
}

export async function disconnect(db: Db, connectorId: string, by: string) {
  getConnector(connectorId);
  await markDisconnected(db, connectorId, by);
}

/**
 * Connectors diligence can research with, and whether this firm can use
 * each now. Public sources that need no key are on unless the firm turned
 * them off; everything else is on once connected. Nothing needs connecting
 * a second time: what a firm connected for sourcing is used here too.
 */
export async function researchSources(db: Db): Promise<{ id: string; name: string; category: Category; summary: string; needsDomain: boolean; ready: boolean; reason?: string }[]> {
  const rows = new Map((await listConnections(db)).map((r) => [r.connector_id, r]));
  const out = [];
  for (const c of CONNECTORS) {
    if (!c.research) continue;
    const row = rows.get(c.id);
    const open = c.auth.kind === "none" || c.auth.kind === "platform";
    let ready: boolean;
    let reason: string | undefined;
    if (row?.status === "disconnected") {
      ready = false;
      reason = "Turned off in Connections";
    } else if (open) {
      ready = c.auth.kind === "none" || (c.auth.kind === "platform" && c.auth.keys.every((k) => Boolean(config[k])));
      if (!ready) reason = "Not set up on this server";
    } else {
      ready = Boolean(row) && (await isReady(db, c.id));
      if (!ready) reason = row?.status === "error" ? `Connection error: ${row.last_error ?? "check it in Connections"}` : "Not connected";
    }
    out.push({ id: c.id, name: c.name, category: c.category, summary: c.research.summary, needsDomain: Boolean(c.research.needsDomain), ready, reason });
  }
  return out;
}
