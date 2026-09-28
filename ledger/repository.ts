import type { Db } from "../lib/db.js";
import { sha256, normalizeCompanyName, normalizeDomain, normalizeLinkedIn, normalizePersonName } from "../lib/text.js";
import { getPredicate, normalizeValue, type EntityType } from "./predicates.js";
import { findConflicts, type ClaimRow, type SourceType } from "./contradictions.js";

export type AccessScope = "public" | "internal" | "confidential" | "nda" | "vendor";
export type EvidenceKind =
  | "transcript" | "deck" | "filing" | "web_page" | "api_record" | "email" | "message" | "document" | "note";
export type IdentifierKind =
  | "domain" | "linkedin" | "pitchbook" | "harmonic" | "crunchbase" | "dealroom" | "carta" | "affinity" | "cik" | "email" | "twitter";

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  merged_into: string | null;
}

export interface EvidenceInput {
  kind: EvidenceKind;
  source: string;
  content: string;
  uri?: string;
  title?: string;
  mimeType?: string;
  occurredAt?: string;
  accessScope?: AccessScope;
  metadata?: Record<string, unknown>;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: string;
  uri: string | null;
  title: string | null;
  content: string;
  content_hash: string;
  access_scope: AccessScope;
  occurred_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ClaimInput {
  subjectId: string;
  predicate: string;
  value: unknown;
  unit?: string;
  asOf?: string;
  evidenceId: string;
  spanStart?: number;
  spanEnd?: number;
  citedText?: string;
  sourceType: SourceType;
  confidence?: number;
  extractedBy: string;
  supersedes?: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function audit(db: Db, actor: string, action: string, target?: string, detail: Record<string, unknown> = {}) {
  await db.query("insert into audit_log(actor, action, target, detail) values ($1,$2,$3,$4)", [
    actor, action, target ?? null, JSON.stringify(detail),
  ]);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function normalizeIdentifier(kind: IdentifierKind, value: string): string {
  if (kind === "domain") {
    const d = normalizeDomain(value);
    if (!d) throw new Error(`Not a domain: ${value}`);
    return d;
  }
  if (kind === "linkedin") {
    const l = normalizeLinkedIn(value);
    if (!l) throw new Error(`Not a LinkedIn URL: ${value}`);
    return l;
  }
  if (kind === "email") return value.trim().toLowerCase();
  return value.trim();
}

export function normalizeAlias(type: EntityType, name: string): string {
  return type === "person" ? normalizePersonName(name) : normalizeCompanyName(name);
}

export async function createEntity(
  db: Db,
  input: {
    type: EntityType;
    name: string;
    source: string;
    identifiers?: { kind: IdentifierKind; value: string }[];
    aliases?: string[];
    actor?: string;
  },
): Promise<Entity> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Entity>(
      "insert into entities(type, name) values ($1,$2) returning id, type, name, merged_into",
      [input.type, input.name.trim()],
    );
    const entity = rows[0]!;
    await addAlias(tx, entity.id, input.type, input.name, input.source);
    for (const a of input.aliases ?? []) await addAlias(tx, entity.id, input.type, a, input.source);
    for (const id of input.identifiers ?? []) await addIdentifier(tx, entity.id, id.kind, id.value, input.source);
    await audit(tx, input.actor ?? input.source, "entity.create", entity.id, { name: entity.name, type: entity.type });
    return entity;
  });
}

export async function addAlias(db: Db, entityId: string, type: EntityType, alias: string, source: string) {
  const normalized = normalizeAlias(type, alias);
  if (!normalized) return;
  await db.query(
    `insert into entity_aliases(entity_id, alias, normalized, source) values ($1,$2,$3,$4)
     on conflict (entity_id, normalized) do nothing`,
    [entityId, alias.trim(), normalized, source],
  );
}

/**
 * Attach a hard identifier. If the identifier already belongs to another
 * entity, that's a resolution conflict: throw so the caller files a merge
 * proposal instead of silently moving it.
 */
export async function addIdentifier(db: Db, entityId: string, kind: IdentifierKind, value: string, source: string) {
  const v = normalizeIdentifier(kind, value);
  const existing = await db.query<{ entity_id: string }>(
    "select entity_id from entity_identifiers where kind=$1 and value=$2",
    [kind, v],
  );
  const owner = existing.rows[0]?.entity_id;
  if (owner && owner !== entityId) {
    throw new Error(`Identifier ${kind}:${v} already belongs to entity ${owner}`);
  }
  if (!owner) {
    await db.query("insert into entity_identifiers(entity_id, kind, value, source) values ($1,$2,$3,$4)", [
      entityId, kind, v, source,
    ]);
  }
}

export async function findByIdentifier(db: Db, kind: IdentifierKind, value: string): Promise<Entity | null> {
  let v: string;
  try {
    v = normalizeIdentifier(kind, value);
  } catch {
    return null;
  }
  const { rows } = await db.query<Entity>(
    `select e.id, e.type, e.name, e.merged_into from entity_identifiers i
     join entities e on e.id = i.entity_id where i.kind=$1 and i.value=$2`,
    [kind, v],
  );
  const e = rows[0];
  if (!e) return null;
  return e.merged_into ? getEntity(db, e.merged_into) : e;
}

export async function getEntity(db: Db, id: string): Promise<Entity | null> {
  const { rows } = await db.query<Entity>("select id, type, name, merged_into from entities where id=$1", [id]);
  const e = rows[0];
  if (!e) return null;
  return e.merged_into ? getEntity(db, e.merged_into) : e;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Store a raw artifact. Identical content from the same source is stored once. */
export async function insertEvidence(db: Db, input: EvidenceInput, actor = input.source): Promise<{ evidence: Evidence; created: boolean }> {
  const hash = sha256(input.content);
  const inserted = await db.query<Evidence>(
    `insert into evidence(kind, source, uri, title, content, content_hash, mime_type, occurred_at, access_scope, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (source, content_hash) do nothing
     returning *`,
    [
      input.kind, input.source, input.uri ?? null, input.title ?? null, input.content, hash,
      input.mimeType ?? "text/plain", input.occurredAt ?? null, input.accessScope ?? "internal",
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (inserted.rows[0]) {
    await audit(db, actor, "evidence.insert", inserted.rows[0].id, { source: input.source, kind: input.kind, uri: input.uri });
    return { evidence: inserted.rows[0], created: true };
  }
  const { rows } = await db.query<Evidence>("select * from evidence where source=$1 and content_hash=$2", [input.source, hash]);
  return { evidence: rows[0]!, created: false };
}

export async function getEvidence(db: Db, id: string): Promise<Evidence | null> {
  const { rows } = await db.query<Evidence>("select * from evidence where id=$1", [id]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Write one claim. Validates the predicate, normalizes the value, checks
 * the evidence span, and inherits the evidence's access scope. Throws on
 * anything that doesn't fit.
 */
export async function insertClaim(db: Db, input: ClaimInput): Promise<string> {
  const def = getPredicate(input.predicate);
  const subject = await getEntity(db, input.subjectId);
  if (!subject) throw new Error(`No entity ${input.subjectId}`);
  if (!def.appliesTo.includes(subject.type)) {
    throw new Error(`${input.predicate} does not apply to a ${subject.type}`);
  }
  const evidence = await getEvidence(db, input.evidenceId);
  if (!evidence) throw new Error(`No evidence ${input.evidenceId}`);

  const value = normalizeValue(input.predicate, input.value);

  if (input.spanStart !== undefined || input.spanEnd !== undefined) {
    const s = input.spanStart ?? 0;
    const e = input.spanEnd ?? s;
    if (s < 0 || e > evidence.content.length || e < s) {
      throw new Error(`Span ${s}-${e} is outside evidence ${evidence.id} (length ${evidence.content.length})`);
    }
    if (input.citedText !== undefined && evidence.content.slice(s, e).trim() !== input.citedText.trim()) {
      throw new Error(`Cited text does not match evidence ${evidence.id} at ${s}-${e}`);
    }
  }

  const { rows } = await db.query<{ id: string }>(
    `insert into claims(subject_id, predicate, value, unit, as_of, evidence_id, span_start, span_end,
                        cited_text, source_type, confidence, extracted_by, access_scope, supersedes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      subject.id, input.predicate, JSON.stringify(value), input.unit ?? def.unit ?? null, input.asOf ?? null,
      evidence.id, input.spanStart ?? null, input.spanEnd ?? null, input.citedText ?? null, input.sourceType,
      input.confidence ?? 0.8, input.extractedBy, evidence.access_scope, input.supersedes ?? null,
    ],
  );
  const id = rows[0]!.id;
  await audit(db, input.extractedBy, "claim.insert", id, { predicate: input.predicate, subject: subject.id });
  return id;
}

/** Current (not superseded) claims about an entity, optionally for one predicate. */
export async function currentClaims(db: Db, subjectId: string, predicate?: string): Promise<ClaimRow[]> {
  const params: unknown[] = [subjectId];
  let filter = "";
  if (predicate) {
    params.push(predicate);
    filter = "and c.predicate = $2";
  }
  const { rows } = await db.query<Omit<ClaimRow, "as_of"> & { as_of: unknown }>(
    `select c.id, c.subject_id, c.predicate, c.value, c.as_of, c.source_type, c.evidence_id, c.cited_text
     from claims c
     where c.subject_id in (select id from entities where id = $1 or merged_into = $1) ${filter}
       and not exists (select 1 from claims s where s.supersedes = c.id)
     order by c.created_at`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    as_of: r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : (r.as_of as string | null),
  }));
}

/**
 * Compare current claims about an entity and file any new contradictions.
 * Returns the ones created by this call.
 */
export async function detectContradictions(db: Db, subjectId: string, actor = "contradiction-finder@0.1") {
  const conflicts = findConflicts(await currentClaims(db, subjectId));
  const created: { id: string; severity: string; detail: string }[] = [];
  for (const c of conflicts) {
    const fingerprint = [...c.claimIds].sort().join(":");
    const { rows } = await db.query<{ id: string }>(
      `insert into contradictions(subject_id, predicate, claim_ids, fingerprint, severity, detail)
       values ($1,$2,$3,$4,$5,$6) on conflict (fingerprint) do nothing returning id`,
      [subjectId, c.predicate, c.claimIds, fingerprint, c.severity, c.detail],
    );
    if (rows[0]) {
      created.push({ id: rows[0].id, severity: c.severity, detail: c.detail });
      await audit(db, actor, "contradiction.open", rows[0].id, { detail: c.detail, severity: c.severity });
    }
  }
  return created;
}

export async function openContradictions(db: Db, subjectId: string) {
  const { rows } = await db.query<{ id: string; predicate: string; severity: string; detail: string }>(
    `select id, predicate, severity, detail from contradictions
     where subject_id=$1 and status='open'
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, detected_at`,
    [subjectId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const PASS_REASONS = [
  "team", "market_size", "timing", "competition", "technology_risk", "traction", "valuation",
  "capital_intensity", "thesis_fit", "deal_dynamics", "other",
] as const;

export async function recordDecision(
  db: Db,
  input: {
    entityId: string;
    kind: "pass" | "advance" | "ic_vote_pre" | "ic_vote_post" | "invest" | "follow_on" | "score_override";
    actor: string;
    value?: Record<string, unknown>;
    reasonCode?: (typeof PASS_REASONS)[number];
    rationale?: string;
  },
): Promise<string> {
  if (input.kind === "pass" && !input.reasonCode) throw new Error("A pass needs a reason code.");
  const { rows } = await db.query<{ id: string }>(
    `insert into decisions(entity_id, kind, actor, value, reason_code, rationale)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.entityId, input.kind, input.actor, JSON.stringify(input.value ?? {}), input.reasonCode ?? null, input.rationale ?? null],
  );
  const id = rows[0]!.id;
  await audit(db, input.actor, `decision.${input.kind}`, id, { entity: input.entityId });
  return id;
}
