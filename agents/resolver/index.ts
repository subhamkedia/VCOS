import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import {
  addAlias, addIdentifier, audit, createEntity, insertClaim, insertEvidence, type Entity, type IdentifierKind,
} from "../../ledger/repository.js";
import { resolve, type Candidate, type Resolution } from "./resolve.js";
import { llmSelect, LLM_SELECT_VERSION, type LlmSelection } from "./llm-select.js";

export { resolve, type Candidate, type Resolution } from "./resolve.js";

export const RESOLVER_VERSION = "resolver@0.1";

export interface ResolveOutcome {
  entity: Entity;
  resolution: Resolution;
  created: boolean;
  proposalId?: string;
  llm?: LlmSelection;
}

/**
 * Resolve a mention and make sure an entity exists for it.
 *
 * - match: attach any new identifiers and aliases to the existing entity.
 * - new:   create the entity.
 * - review: create a provisional entity and file a merge proposal pointing
 *           at the likely match. Claims attach to the provisional entity;
 *           accepting the proposal folds them into the target.
 */
export async function resolveOrCreate(
  db: Db,
  candidate: Candidate,
  opts: { llm?: Llm; seedClaims?: boolean } = {},
): Promise<ResolveOutcome> {
  const resolution = await resolve(db, candidate);
  const identifiers = collectIdentifiers(candidate);

  if (resolution.decision === "match" && resolution.entityId) {
    const entity = (await db.query<Entity>("select id, type, name, merged_into from entities where id=$1", [resolution.entityId])).rows[0]!;
    await addAlias(db, entity.id, entity.type, candidate.name, candidate.source);
    for (const id of identifiers) {
      try {
        await addIdentifier(db, entity.id, id.kind, id.value, candidate.source);
      } catch {
        // Identifier belongs to someone else: surface it rather than move it.
        await fileProposal(db, candidate, entity.id, resolution, `Identifier ${id.kind}:${id.value} is already held by another entity.`);
      }
    }
    await audit(db, RESOLVER_VERSION, "resolve.match", entity.id, { name: candidate.name, method: resolution.method, p: resolution.probability });
    return { entity, resolution, created: false };
  }

  const entity = await createEntity(db, {
    type: candidate.type,
    name: candidate.name,
    source: candidate.source,
    identifiers: identifiers.filter((i) => i.kind !== "domain" || !!i.value),
    actor: RESOLVER_VERSION,
  });
  // Callers that write their own claims (the ingest pipeline) turn this off.
  if (opts.seedClaims !== false) await seedFounderClaims(db, entity, candidate);

  if (resolution.decision === "new") return { entity, resolution, created: true };

  // Review band: optionally ask Claude to choose, then queue for a human.
  let llm: LlmSelection | undefined;
  let target = resolution.entityId ?? null;
  let note = resolution.explanation;
  if (opts.llm && resolution.candidates.length) {
    llm = await llmSelect(db, opts.llm, candidate, resolution.candidates);
    target = llm.choice ?? target;
    note = `${note} Claude (${LLM_SELECT_VERSION}) suggests ${llm.choice ? "a match" : "no match"} at ${llm.confidence.toFixed(2)}: ${llm.reason}`;
  }
  const proposalId = await fileProposal(db, candidate, target, resolution, note, entity.id, llm ? "llm-select" : "fellegi-sunter");
  return { entity, resolution, created: true, proposalId, llm };
}

function collectIdentifiers(c: Candidate): { kind: IdentifierKind; value: string }[] {
  const out: { kind: IdentifierKind; value: string }[] = [...(c.externalIds ?? [])];
  if (c.domain) out.push({ kind: "domain", value: c.domain });
  if (c.linkedin) out.push({ kind: "linkedin", value: c.linkedin });
  return out.filter((i) => i.value && i.value.trim());
}

/** Founders given by the source become claims, so the resolver can use them next time. */
async function seedFounderClaims(db: Db, entity: Entity, c: Candidate) {
  if (!c.founders?.length && !c.location) return;
  const { evidence } = await insertEvidence(
    db,
    {
      kind: "api_record",
      source: c.source,
      content: JSON.stringify({ name: c.name, domain: c.domain, founders: c.founders, location: c.location }),
      title: `Resolver record: ${c.name}`,
    },
    RESOLVER_VERSION,
  );
  for (const f of c.founders ?? []) {
    await insertClaim(db, {
      subjectId: entity.id, predicate: "team.founder", value: f, evidenceId: evidence.id,
      sourceType: "third_party", confidence: 0.7, extractedBy: RESOLVER_VERSION,
    });
  }
  if (c.location) {
    await insertClaim(db, {
      subjectId: entity.id, predicate: "company.hq_location", value: c.location, evidenceId: evidence.id,
      sourceType: "third_party", confidence: 0.7, extractedBy: RESOLVER_VERSION,
    });
  }
}

async function fileProposal(
  db: Db,
  candidate: Candidate,
  targetId: string | null,
  resolution: Resolution,
  explanation: string,
  provisionalId?: string,
  method: string = resolution.method,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into merge_proposals(candidate, proposed_entity_id, score, method, explanation)
     values ($1,$2,$3,$4,$5) returning id`,
    [JSON.stringify({ ...candidate, provisionalEntityId: provisionalId ?? null }), targetId, resolution.probability, method, explanation],
  );
  await audit(db, RESOLVER_VERSION, "resolve.review", rows[0]!.id, { name: candidate.name, target: targetId });
  return rows[0]!.id;
}

/** Pending proposals, strongest first. */
export async function pendingProposals(db: Db) {
  const { rows } = await db.query<{
    id: string; candidate: Candidate & { provisionalEntityId: string | null }; proposed_entity_id: string | null;
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
 * the merge.
 */
export async function decideProposal(db: Db, proposalId: string, accept: boolean, decidedBy: string) {
  await db.transaction(async (tx) => {
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
  });
}
