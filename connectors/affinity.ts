import { config, requireKey } from "../lib/config.js";
import { normalizeDomain } from "../lib/text.js";
import { asArray, asDate, asNumber, asString, requestJson } from "./http.js";
import type { FetchLike, SourceRecord } from "./types.js";

/**
 * Affinity CRM (REST API v1, https://api.affinity.co). Basic auth with an
 * empty user name and the API key as the password.
 *
 * Read: organizations, list entries (your pipeline) and notes. Organizations
 * become entities with an `affinity` identifier; notes become internal
 * evidence the extractor reads. Write: adding a note, and only from an
 * approved outbox item. Nothing here edits or deletes CRM records.
 *
 * Field names follow Affinity's v1 docs. Run `pnpm ingest affinity-list <id>
 * --dry-run` once against your account before trusting the mapping.
 */
export const AFFINITY = "https://api.affinity.co";

function headers() {
  return { Authorization: `Basic ${Buffer.from(`:${requireKey("affinityApiKey")}`).toString("base64")}` };
}

export interface AffinityOrg {
  id: number;
  name: string;
  domain?: string;
  domains: string[];
}

export interface AffinityNote {
  id: number;
  content: string;
  createdAt?: string;
  creatorId?: number;
  organizationIds: number[];
}

export function parseAffinityOrg(o: Record<string, unknown>): AffinityOrg | null {
  const id = asNumber(o.id);
  const name = asString(o.name);
  if (id === undefined || !name) return null;
  const domains = [asString(o.domain), ...(Array.isArray(o.domains) ? o.domains : [])]
    .map((d) => normalizeDomain(typeof d === "string" ? d : ""))
    .filter((d): d is string => Boolean(d));
  return { id, name, domain: domains[0], domains: [...new Set(domains)] };
}

export function parseAffinityNote(n: Record<string, unknown>): AffinityNote | null {
  const id = asNumber(n.id);
  const content = asString(n.content);
  if (id === undefined || !content) return null;
  return {
    id, content, createdAt: asString(n.created_at), creatorId: asNumber(n.creator_id),
    organizationIds: (Array.isArray(n.organization_ids) ? n.organization_ids : []).map(Number).filter(Number.isFinite),
  };
}

export async function affinitySearchOrgs(term: string, fetchImpl?: FetchLike): Promise<AffinityOrg[]> {
  const res = await requestJson<{ organizations?: Record<string, unknown>[] }>(
    "affinity", `${AFFINITY}/organizations?term=${encodeURIComponent(term)}`, { headers: headers(), fetchImpl },
  );
  return (res.organizations ?? []).flatMap((o) => parseAffinityOrg(o) ?? []);
}

export async function affinityOrg(id: number, fetchImpl?: FetchLike): Promise<AffinityOrg> {
  const o = parseAffinityOrg(await requestJson<Record<string, unknown>>("affinity", `${AFFINITY}/organizations/${id}`, { headers: headers(), fetchImpl }));
  if (!o) throw new Error(`Affinity organization ${id} has no name`);
  return o;
}

/** Organizations on a list (for example your deal pipeline). Follows pagination. */
export async function affinityListOrgs(listId: number, fetchImpl?: FetchLike): Promise<AffinityOrg[]> {
  const out: AffinityOrg[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (token) params.set("page_token", token);
    const res = await requestJson<unknown>("affinity", `${AFFINITY}/lists/${listId}/list-entries?${params}`, { headers: headers(), fetchImpl });
    const body = Array.isArray(res) ? { list_entries: res } : (res as { list_entries?: unknown[]; next_page_token?: string | null });
    for (const e of asArray(body.list_entries)) {
      if (e.entity_type !== 1 && e.entity_type !== undefined) continue; // 1 = organization
      const o = parseAffinityOrg((e.entity ?? {}) as Record<string, unknown>);
      if (o) out.push(o);
    }
    token = Array.isArray(res) ? undefined : ((res as { next_page_token?: string | null }).next_page_token ?? undefined);
  } while (token);
  return out;
}

export async function affinityNotes(orgId: number, fetchImpl?: FetchLike): Promise<AffinityNote[]> {
  const res = await requestJson<unknown>("affinity", `${AFFINITY}/notes?organization_id=${orgId}`, { headers: headers(), fetchImpl });
  const rows = Array.isArray(res) ? res : ((res as { notes?: unknown[] }).notes ?? []);
  return asArray(rows).flatMap((n) => parseAffinityNote(n) ?? []);
}

/** The organization record: resolves the company and records its Affinity id. */
export function affinityOrgRecord(o: AffinityOrg, fetchedAt = new Date().toISOString()): SourceRecord {
  return {
    evidence: {
      kind: "api_record", source: "affinity", uri: `affinity:organization:${o.id}`, title: `Affinity: ${o.name}`,
      content: JSON.stringify(o, null, 2), mimeType: "application/json", accessScope: "internal", occurredAt: fetchedAt,
    },
    subject: {
      type: "company", name: o.name, domain: o.domain, source: "affinity",
      externalIds: [{ kind: "affinity", value: String(o.id) }],
    },
    claims: o.domain ? [{ predicate: "company.website", value: o.domain, asOf: fetchedAt.slice(0, 10), confidence: 0.7 }] : [],
    sourceType: "internal",
  };
}

/** A note your team wrote: internal evidence, read by the extractor. */
export function affinityNoteRecord(n: AffinityNote, o: AffinityOrg): SourceRecord {
  return {
    evidence: {
      kind: "note", source: "affinity", uri: `affinity:note:${n.id}`, title: `Affinity note on ${o.name}`,
      content: n.content, occurredAt: asDate(n.createdAt), accessScope: "internal", metadata: { creatorId: n.creatorId },
    },
    subject: { type: "company", name: o.name, domain: o.domain, source: "affinity", externalIds: [{ kind: "affinity", value: String(o.id) }] },
    extract: true,
  };
}

/** Add a note to an organization. Called only when an outbox item is approved. */
export async function affinityCreateNote(orgId: number, content: string, fetchImpl?: FetchLike): Promise<{ id: string }> {
  const res = await requestJson<{ id?: number }>("affinity", `${AFFINITY}/notes`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ organization_ids: [orgId], content }),
    fetchImpl,
  });
  return { id: String(res.id ?? "") };
}

export async function affinityCheck(fetchImpl?: FetchLike): Promise<string> {
  const me = await requestJson<{ user?: { email?: string } }>("affinity", `${AFFINITY}/auth/whoami`, { headers: headers(), fetchImpl });
  return `signed in as ${me.user?.email ?? "unknown"}`;
}

export const affinityConfigured = () => Boolean(config.affinityApiKey);
