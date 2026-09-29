import type { Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import { insertEvidence, insertClaim, detectContradictions, getEntity, addIdentifier, entityIdentifiers, type Evidence } from "../ledger/repository.js";
import { resolveOrCreate, type ResolveOutcome } from "../agents/resolver/index.js";
import { extractClaims, type ExtractionResult } from "../agents/extractor/index.js";
import type { SourceRecord } from "./types.js";

export interface IngestResult {
  evidence: Evidence;
  duplicate: boolean;
  subject?: ResolveOutcome;
  structuredClaims: number;
  structuredRejected: { predicate: string; reason: string }[];
  extraction?: ExtractionResult;
  contradictions: { id: string; severity: string; detail: string }[];
}

/**
 * The one path from any source into the ledger:
 * resolve subject -> store evidence -> structured claims -> extractor -> contradictions.
 * Re-ingesting identical content is a no-op.
 */
export async function ingest(db: Db, rec: SourceRecord, opts: { llm?: Llm; subjectId?: string } = {}): Promise<IngestResult> {
  const subject = opts.subjectId ? await known(db, opts.subjectId, rec) : rec.subject ? await resolveOrCreate(db, rec.subject, { llm: opts.llm, seedClaims: false }) : undefined;
  const { evidence, created } = await insertEvidence(db, rec.evidence);

  const result: IngestResult = {
    evidence, duplicate: !created, subject, structuredClaims: 0, structuredRejected: [], contradictions: [],
  };
  if (!created || !subject) return result;

  for (const c of rec.claims ?? []) {
    let span: { spanStart: number; spanEnd: number; citedText: string } | undefined;
    if (c.citedText) {
      const at = evidence.content.indexOf(c.citedText);
      if (at >= 0) span = { spanStart: at, spanEnd: at + c.citedText.length, citedText: c.citedText };
    }
    try {
      await insertClaim(db, {
        subjectId: subject.entity.id,
        predicate: c.predicate,
        value: c.value,
        asOf: c.asOf,
        evidenceId: evidence.id,
        sourceType: rec.sourceType ?? "third_party",
        confidence: c.confidence ?? 0.8,
        extractedBy: `connector:${rec.evidence.source}`,
        ...span,
      });
      result.structuredClaims++;
    } catch (err) {
      result.structuredRejected.push({ predicate: c.predicate, reason: (err as Error).message });
    }
  }

  if (rec.extract && opts.llm) {
    result.extraction = await extractClaims(db, opts.llm, evidence.id, subject.entity.id);
    result.contradictions.push(...result.extraction.contradictions);
  } else {
    result.contradictions.push(...(await detectContradictions(db, subject.entity.id)));
  }
  return result;
}

/**
 * Diligence already knows which company it's researching: use it rather
 * than resolving the record's name again (a namesake could win). The
 * record's vendor ids are still attached when nothing else holds them.
 */
async function known(db: Db, subjectId: string, rec: SourceRecord): Promise<ResolveOutcome> {
  const entity = await getEntity(db, subjectId);
  if (!entity) throw new Error(`No entity ${subjectId}`);
  const have = new Set((await entityIdentifiers(db, entity.id)).map((i) => `${i.kind}:${i.value}`));
  for (const x of rec.subject?.externalIds ?? []) {
    if (have.has(`${x.kind}:${x.value}`)) continue;
    await addIdentifier(db, entity.id, x.kind, x.value, rec.subject!.source).catch(() => undefined);
  }
  return { entity, created: false, resolution: { decision: "match", method: "identifier", entityId: entity.id, probability: 1, candidates: [], explanation: "The company being researched." } };
}
