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
     on conflict (firm_id, source, content_hash) do nothing
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
/**
 * The date a claim is true as of. Sources often give only a month ("as of
 * September 2026") or a year: those mean the end of that period. Anything
 * that isn't a real date is refused with a clear message.
 */
export function normalizeAsOf(v: string | undefined | null): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})$/))) return `${m[1]}-12-31`;
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12) throw new Error(`as_of ${s} isn't a real month`);
    return `${m[1]}-${m[2]}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(d.getTime())) return s.slice(0, 10);
  throw new Error(`as_of "${s}" isn't a date (use YYYY-MM-DD, YYYY-MM or YYYY)`);
}

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
  const asOf = normalizeAsOf(input.asOf);

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
      subject.id, input.predicate, JSON.stringify(value), input.unit ?? def.unit ?? null, asOf,
      evidence.id, input.spanStart ?? null, input.spanEnd ?? null, input.citedText ?? null, input.sourceType,
      input.confidence ?? 0.8, input.extractedBy, evidence.access_scope, input.supersedes ?? null,
    ],
  );
  const id = rows[0]!.id;
  await audit(db, input.extractedBy, "claim.insert", id, { predicate: input.predicate, subject: subject.id });
  return id;
}

export interface ClaimFilter {
  predicates?: string[];
  /** Only claims whose evidence carries one of these scopes. Filtered in SQL. */
  scopes?: AccessScope[];
}

/** The access scopes a shareable output (memo to co-investors, LP letter) may cite. */
export const SHAREABLE_SCOPES: AccessScope[] = ["public"];

/** Identifiers anyone can look up. The rest (Harmonic, PitchBook, Carta ids...) are vendor or internal data. */
const PUBLIC_IDENTIFIER_KINDS: IdentifierKind[] = ["domain", "linkedin", "cik", "twitter"];

/** An entity plus every entity merged into it. Claims and contradictions are read through merges. */
const MERGE_FAMILY = "select id from entities where id = $1 or merged_into = $1";

/**
 * Current (not superseded) claims about an entity. Pass a predicate name,
 * or a filter with predicates and/or access scopes.
 */
export async function currentClaims(db: Db, subjectId: string, filter: string | ClaimFilter = {}): Promise<ClaimRow[]> {
  const f: ClaimFilter = typeof filter === "string" ? { predicates: [filter] } : filter;
  const params: unknown[] = [subjectId];
  const where: string[] = [];
  if (f.predicates) {
    params.push(f.predicates);
    where.push(`and c.predicate = any($${params.length}::text[])`);
  }
  if (f.scopes) {
    params.push(f.scopes);
    where.push(`and c.access_scope = any($${params.length}::text[])`);
  }
  const { rows } = await db.query<Omit<ClaimRow, "as_of"> & { as_of: unknown }>(
    `select c.id, c.subject_id, c.predicate, c.value, c.as_of, c.source_type, c.evidence_id, c.cited_text
     from claims c
     where c.subject_id in (${MERGE_FAMILY}) ${where.join(" ")}
       and not exists (select 1 from claims s where s.supersedes = c.id)
     order by c.created_at`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    as_of: r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : (r.as_of as string | null),
  }));
}

/** Every claim cited from one piece of evidence, with its span. */
export async function claimsForEvidence(db: Db, evidenceId: string) {
  const { rows } = await db.query<{ id: string; predicate: string; value: unknown; span_start: number | null; span_end: number | null; cited_text: string | null }>(
    "select id, predicate, value, span_start, span_end, cited_text from claims where evidence_id=$1 order by created_at",
    [evidenceId],
  );
  return rows;
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

/**
 * Open contradictions about an entity (and anything merged into it). With
 * `scopes`, a contradiction is returned only if every claim it cites is in
 * scope, so its detail text can't leak a hidden value.
 */
export async function openContradictions(db: Db, subjectId: string, opts: { scopes?: AccessScope[] } = {}) {
  const params: unknown[] = [subjectId];
  let scopeFilter = "";
  if (opts.scopes) {
    params.push(opts.scopes);
    scopeFilter = `and not exists (select 1 from claims c where c.id = any(x.claim_ids) and c.access_scope <> all($2::text[]))`;
  }
  const { rows } = await db.query<{ id: string; predicate: string; severity: string; detail: string; claim_ids: string[] }>(
    `select x.id, x.predicate, x.severity, x.detail, x.claim_ids from contradictions x
     where x.subject_id in (${MERGE_FAMILY}) and x.status='open' ${scopeFilter}
     order by case x.severity when 'high' then 0 when 'medium' then 1 else 2 end, x.detected_at`,
    params,
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

// ---------------------------------------------------------------------------
// Entity lookups (read through merges)
// ---------------------------------------------------------------------------

/** An active entity whose normalized alias matches `name` exactly. */
export async function findEntityByAlias(db: Db, type: EntityType, name: string): Promise<Entity | null> {
  const normalized = normalizeAlias(type, name);
  if (!normalized) return null;
  const { rows } = await db.query<{ entity_id: string }>(
    `select a.entity_id from entity_aliases a join entities e on e.id = a.entity_id
      where e.type = $1 and a.normalized = $2 limit 1`,
    [type, normalized],
  );
  return rows[0] ? getEntity(db, rows[0].entity_id) : null;
}

export async function entityIdentifiers(db: Db, entityId: string, kind?: IdentifierKind) {
  const { rows } = await db.query<{ kind: IdentifierKind; value: string; source: string }>(
    `select kind, value, source from entity_identifiers
      where entity_id in (${MERGE_FAMILY}) ${kind ? "and kind = $2" : ""} order by created_at`,
    kind ? [entityId, kind] : [entityId],
  );
  return rows;
}

export async function entityAliases(db: Db, entityId: string): Promise<{ alias: string; source: string }[]> {
  const { rows } = await db.query<{ alias: string; source: string }>(
    `select alias, source from entity_aliases where entity_id in (${MERGE_FAMILY}) order by created_at`,
    [entityId],
  );
  return rows;
}

/**
 * Resolver blocking: active entities whose aliases look like the name, or
 * that share a founder (catches rebrands). Returns entity ids.
 */
export async function blockingCandidates(
  db: Db,
  q: { type: EntityType; normalized: string; core: string; founders?: string[]; limit?: number },
): Promise<string[]> {
  const limit = q.limit ?? 25;
  const byName = await db.query<{ entity_id: string }>(
    `select distinct a.entity_id
       from entity_aliases a join entities e on e.id = a.entity_id
      where e.type = $1 and e.merged_into is null
        and (a.normalized = $2 or a.normalized % $2 or a.normalized like $3 || '%' or similarity(a.normalized, $3) > 0.5)
      limit $4`,
    [q.type, q.normalized, q.core, limit],
  );
  const byFounder = q.founders?.length
    ? (
        await db.query<{ entity_id: string }>(
          `select distinct coalesce(e.merged_into, e.id) as entity_id from claims c join entities e on e.id = c.subject_id
            where c.predicate = 'team.founder' and e.type = $1
              and lower(c.value #>> '{}') = any($2::text[]) limit $3`,
          [q.type, q.founders.map((f) => f.toLowerCase().trim()), limit],
        )
      ).rows
    : [];
  return [...new Set([...byName.rows, ...byFounder].map((r) => r.entity_id))];
}

// ---------------------------------------------------------------------------
// Merge proposals
// ---------------------------------------------------------------------------

/** The unresolved record as the source gave it, plus the provisional entity created for it. */
export interface ProposalCandidate {
  name: string;
  source: string;
  domain?: string;
  founders?: string[];
  provisionalEntityId: string | null;
  [key: string]: unknown;
}

export async function insertMergeProposal(
  db: Db,
  p: { candidate: ProposalCandidate; targetId: string | null; score: number; method: string; explanation: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into merge_proposals(candidate, proposed_entity_id, score, method, explanation)
     values ($1,$2,$3,$4,$5) returning id`,
    [JSON.stringify(p.candidate), p.targetId, p.score, p.method, p.explanation],
  );
  return rows[0]!.id;
}

/** Pending proposals, strongest first. */
export async function pendingProposals(db: Db) {
  const { rows } = await db.query<{
    id: string; candidate: ProposalCandidate; proposed_entity_id: string | null;
    target_name: string | null; score: number; method: string; explanation: string;
  }>(
    `select p.id, p.candidate, p.proposed_entity_id, e.name as target_name, p.score, p.method, p.explanation
       from merge_proposals p left join entities e on e.id = p.proposed_entity_id
      where p.status = 'pending' order by p.score desc, p.created_at`,
  );
  return rows;
}

/**
 * A human decides a proposal. Accepting folds the provisional entity into
 * the target (merged_into); claims stay where they are and are read through
 * the merge. The merged claims are then checked against each other.
 */
export async function decideProposal(db: Db, proposalId: string, accept: boolean, decidedBy: string) {
  const target = await db.transaction(async (tx) => {
    const p = (
      await tx.query<{ candidate: { provisionalEntityId: string | null }; proposed_entity_id: string | null; status: string }>(
        "select candidate, proposed_entity_id, status from merge_proposals where id=$1",
        [proposalId],
      )
    ).rows[0];
    if (!p) throw new Error(`No proposal ${proposalId}`);
    if (p.status !== "pending") throw new Error(`Proposal ${proposalId} is already ${p.status}`);
    if (accept) {
      const from = p.candidate.provisionalEntityId;
      if (!from || !p.proposed_entity_id) throw new Error("Proposal has nothing to merge");
      if (from === p.proposed_entity_id) throw new Error("Cannot merge an entity into itself");
      await tx.query("update entities set merged_into=$1 where id=$2", [p.proposed_entity_id, from]);
      await tx.query("update entities set merged_into=$1 where merged_into=$2", [p.proposed_entity_id, from]);
    }
    await tx.query("update merge_proposals set status=$1, decided_by=$2, decided_at=now() where id=$3", [
      accept ? "accepted" : "rejected", decidedBy, proposalId,
    ]);
    await audit(tx, decidedBy, accept ? "merge.accept" : "merge.reject", proposalId);
    return accept ? p.proposed_entity_id : null;
  });
  if (target) await detectContradictions(db, target);
}

// ---------------------------------------------------------------------------
// Read models (shared by the CLI and the web app)
// ---------------------------------------------------------------------------

export interface ProfileClaim extends ClaimRow {
  unit: string | null;
  confidence: number;
  extracted_by: string;
  access_scope: AccessScope;
  span_start: number | null;
  span_end: number | null;
  evidence: { source: string; kind: EvidenceKind; title: string | null; uri: string | null; occurred_at: string | null };
}

/**
 * Everything the ledger knows about one entity, ready to display. With
 * `scopes`, claims and contradictions outside those scopes are left out in
 * SQL, so a shareable view can't see them; vendor identifiers and aliases
 * are left out too.
 */
export async function companyProfile(db: Db, entityId: string, opts: { scopes?: AccessScope[] } = {}) {
  const entity = await getEntity(db, entityId);
  if (!entity) throw new Error(`No entity ${entityId}`);
  const base = await currentClaims(db, entity.id, { scopes: opts.scopes });
  const detail = base.length
    ? (
        await db.query<Omit<ProfileClaim, keyof ClaimRow | "evidence"> & { id: string; source: string; kind: EvidenceKind; title: string | null; uri: string | null; occurred_at: unknown }>(
          `select c.id, c.unit, c.confidence, c.extracted_by, c.access_scope, c.span_start, c.span_end,
                  e.source, e.kind, e.title, e.uri, e.occurred_at
             from claims c join evidence e on e.id = c.evidence_id where c.id = any($1::uuid[])`,
          [base.map((c) => c.id)],
        )
      ).rows
    : [];
  const byId = new Map(detail.map((d) => [d.id, d]));
  const claims: ProfileClaim[] = base.map((c) => {
    const d = byId.get(c.id)!;
    const occurred = d.occurred_at instanceof Date ? d.occurred_at.toISOString() : (d.occurred_at as string | null);
    return {
      ...c, unit: d.unit, confidence: d.confidence, extracted_by: d.extracted_by, access_scope: d.access_scope,
      span_start: d.span_start, span_end: d.span_end,
      evidence: { source: d.source, kind: d.kind, title: d.title, uri: d.uri, occurred_at: occurred },
    };
  });
  const decisions = (
    await db.query<{ id: string; kind: string; actor: string; value: unknown; reason_code: string | null; rationale: string | null; created_at: unknown }>(
      `select id, kind, actor, value, reason_code, rationale, created_at from decisions
        where entity_id in (${MERGE_FAMILY}) order by created_at`,
      [entity.id],
    )
  ).rows;
  // Identifiers and aliases carry no scope of their own: a scoped view keeps
  // only public identifier kinds and drops aliases (one may come from a confidential call).
  const identifiers = await entityIdentifiers(db, entity.id);
  return {
    entity,
    identifiers: opts.scopes ? identifiers.filter((i) => PUBLIC_IDENTIFIER_KINDS.includes(i.kind)) : identifiers,
    aliases: opts.scopes ? [] : await entityAliases(db, entity.id),
    claims,
    contradictions: await openContradictions(db, entity.id, { scopes: opts.scopes }),
    decisions,
  };
}

export type CompanyProfile = Awaited<ReturnType<typeof companyProfile>>;

// ---------------------------------------------------------------------------
// Outbox: outbound actions waiting for a human
// ---------------------------------------------------------------------------

export type OutboxChannel = "affinity_note" | "gmail_draft" | "outlook_draft" | "docusign_draft";
export type OutboxStatus = "pending" | "approved" | "rejected" | "done" | "failed";

export interface OutboxItem {
  id: string;
  channel: OutboxChannel;
  entity_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  proposed_by: string;
  decided_by: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: unknown;
}

export async function insertOutboxItem(
  db: Db,
  item: { channel: OutboxChannel; entityId?: string; summary: string; payload: Record<string, unknown>; proposedBy: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into outbox(channel, entity_id, summary, payload, proposed_by) values ($1,$2,$3,$4,$5) returning id`,
    [item.channel, item.entityId ?? null, item.summary, JSON.stringify(item.payload), item.proposedBy],
  );
  await audit(db, item.proposedBy, "outbox.queue", rows[0]!.id, { channel: item.channel, summary: item.summary });
  return rows[0]!.id;
}

export async function listOutbox(db: Db, status?: OutboxStatus): Promise<OutboxItem[]> {
  const { rows } = await db.query<OutboxItem>(
    `select * from outbox ${status ? "where status = $1" : ""} order by created_at`,
    status ? [status] : [],
  );
  return rows;
}

export async function getOutboxItem(db: Db, id: string): Promise<OutboxItem | null> {
  const { rows } = await db.query<OutboxItem>("select * from outbox where id=$1", [id]);
  return rows[0] ?? null;
}

/**
 * Record a person's decision on a pending item. Atomic: an item can be
 * decided once. Returns the item, or throws if it wasn't pending.
 */
export async function decideOutboxItem(db: Db, id: string, approve: boolean, decidedBy: string): Promise<OutboxItem> {
  if (!decidedBy.startsWith("human:")) throw new Error("Only a person (decidedBy 'human:<name>') can decide outbox items.");
  const { rows } = await db.query<OutboxItem>(
    `update outbox set status=$2, decided_by=$3, decided_at=now() where id=$1 and status='pending' returning *`,
    [id, approve ? "approved" : "rejected", decidedBy],
  );
  if (!rows[0]) {
    const existing = await getOutboxItem(db, id);
    throw new Error(existing ? `Outbox item ${id} is already ${existing.status}` : `No outbox item ${id}`);
  }
  await audit(db, decidedBy, approve ? "outbox.approve" : "outbox.reject", id);
  return rows[0];
}

/** Record what happened when an approved item was carried out. */
export async function completeOutboxItem(db: Db, id: string, outcome: { ok: true; result: Record<string, unknown> } | { ok: false; error: string }) {
  const { rows } = await db.query<{ id: string }>(
    `update outbox set status=$2, result=$3, error=$4 where id=$1 and status='approved' returning id`,
    [id, outcome.ok ? "done" : "failed", outcome.ok ? JSON.stringify(outcome.result) : null, outcome.ok ? null : outcome.error],
  );
  if (!rows[0]) throw new Error(`Outbox item ${id} is not approved`);
  await audit(db, "outbox", outcome.ok ? "outbox.done" : "outbox.failed", id, outcome.ok ? outcome.result : { error: outcome.error });
}
