import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import {
  claimsForEvidence, companyProfile, currentClaims, getEvidence, pendingProposals, decideProposal, SHAREABLE_SCOPES,
} from "../../ledger/repository.js";
import { latestHits, listCompanies, type HitRow } from "../../ledger/workspace.js";
import { getProfile } from "../firm/profile.js";
import { thesisFit } from "../sourcing/fit.js";
import { formatValue, predicateLabel, sourceTypeLabel } from "../../ledger/labels.js";
import { ingest } from "../../connectors/ingest.js";
import { documentFromBytes } from "../../connectors/documents.js";
import { transcriptRecord } from "../../connectors/transcripts.js";

/**
 * The Companies screen: the firm's ledger, one company at a time. Shared by
 * the web app and (via ledger read models) the CLI.
 */

export const list = (db: Db, search?: string) => listCompanies(db, { search });

/** Everything known about a company. `shareable` re-queries with public scope only (filtered in SQL). */
export async function profile(db: Db, id: string, opts: { shareable?: boolean } = {}) {
  const p = await companyProfile(db, id, opts.shareable ? { scopes: SHAREABLE_SCOPES } : {});
  // Fit is internal judgment and its reasons quote non-public facts: never part of the shareable view.
  const fit = opts.shareable
    ? null
    : ((await latestHits(db, { limit: 1000 })).find((h) => h.entity_id === p.entity.id) ?? (await liveFit(db, p.entity.id, p.entity.name)));
  const sources = new Map<string, { id: string; source: string; kind: string; title: string | null; uri: string | null; occurred_at: string | null; claims: number }>();
  for (const c of p.claims) {
    const s = sources.get(c.evidence_id) ?? { id: c.evidence_id, ...c.evidence, claims: 0 };
    s.claims++;
    sources.set(c.evidence_id, s);
  }
  const claims = p.claims.map((c) => ({ ...c, label: predicateLabel(c.predicate), display: formatValue(c.predicate, c.value) }));
  const byId = new Map(claims.map((c) => [c.id, c]));
  // Contradictions read from the claims they cite, so older stored wording doesn't leak through.
  const contradictions = p.contradictions.map((x) => {
    const [a, b] = x.claim_ids.map((cid) => byId.get(cid));
    if (!a || !b) return x;
    const side = (c: typeof a) => `${c.display} (${sourceTypeLabel(c.source_type).toLowerCase()}, ${c.evidence.title ?? c.evidence.source})`;
    return { ...x, detail: `${predicateLabel(x.predicate)}: ${side(a)} vs ${side(b)}` };
  });
  return { ...p, claims, contradictions, fit, sources: [...sources.values()], shareable: Boolean(opts.shareable) };
}

/** A company no feed has scored (an upload, a CRM import): score it now against the current thesis. */
async function liveFit(db: Db, entityId: string, name: string): Promise<HitRow | null> {
  const current = await getProfile(db);
  if (!current) return null;
  const fit = thesisFit(current.profile, await currentClaims(db, entityId));
  return {
    entity_id: entityId, name, is_new: false, fit_score: fit.score, fit_verdict: fit.verdict, thesis_version: current.version,
    fit, feed_name: null, connector_id: null, created_at: new Date().toISOString(),
  };
}

/** One source with the spans its claims cite, for highlighting. */
export async function evidence(db: Db, id: string) {
  const e = await getEvidence(db, id);
  if (!e) return null;
  return { ...e, spans: (await claimsForEvidence(db, id)).filter((c) => c.span_start !== null) };
}

/** Add a deck or transcript someone uploaded. Runs the extractor when Claude is configured. */
export async function upload(
  db: Db,
  file: { name: string; bytes: Uint8Array },
  opts: { company: string; companyDomain?: string; url?: string; date?: string; kind: "document" | "transcript" },
  llm?: Llm,
) {
  const rec =
    opts.kind === "transcript"
      ? transcriptRecord(file.name, new TextDecoder().decode(file.bytes), { company: opts.company, companyDomain: opts.companyDomain, date: opts.date })
      : await documentFromBytes(file.name, file.bytes, opts);
  const r = await ingest(db, rec, { llm });
  return {
    entityId: r.subject?.entity.id ?? null,
    duplicate: r.duplicate,
    claims: r.structuredClaims + (r.extraction?.claimIds.length ?? 0),
    extracted: Boolean(r.extraction),
    contradictions: r.contradictions,
  };
}

export const mergeProposals = pendingProposals;
export const decideMerge = decideProposal;
