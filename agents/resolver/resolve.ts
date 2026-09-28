import type { Db } from "../../lib/db.js";
import {
  coreCompanyName, jaroWinkler, normalizeCompanyName, normalizeDomain, normalizeLinkedIn,
  normalizePersonName, tokenJaccard,
} from "../../lib/text.js";
import { findByIdentifier, type IdentifierKind } from "../../ledger/repository.js";
import type { EntityType } from "../../ledger/predicates.js";

/**
 * An unresolved mention of a company as a source gives it to us: an
 * accelerator cohort row, a Harmonic record, a name in a transcript.
 */
export interface Candidate {
  type: EntityType;
  name: string;
  domain?: string;
  linkedin?: string;
  externalIds?: { kind: IdentifierKind; value: string }[];
  founders?: string[];
  location?: string;
  source: string;
}

export interface ScoredMatch {
  entityId: string;
  name: string;
  probability: number;
  weight: number;
  reasons: string[];
  /** Name agreement level, and whether any field beyond the name was compared. */
  nameLevel: NameLevel;
  corroborated: boolean;
}

export type NameLevel = "exact" | "core_exact" | "very_close" | "close" | "different";

export interface Resolution {
  decision: "match" | "new" | "review";
  entityId?: string;
  probability: number;
  method: "identifier" | "fellegi-sunter" | "llm-select" | "none";
  candidates: ScoredMatch[];
  explanation: string;
}

/**
 * Fellegi-Sunter comparison levels. Each level has m = P(level | same
 * entity) and u = P(level | different entities); its weight is log2(m/u).
 *
 * These are hand-set starting values. Once the ledger holds a few thousand
 * labeled pairs, re-estimate them with EM (or move batch dedupe to Splink,
 * which implements the same model) and replace this table.
 */
export const LEVELS = {
  name: {
    exact: { m: 0.7, u: 0.0005 },
    core_exact: { m: 0.15, u: 0.004 },
    very_close: { m: 0.12, u: 0.005 }, // Jaro-Winkler >= 0.95 on normalized names (typos)
    close: { m: 0.04, u: 0.04 },      // JW >= 0.88 or token overlap >= 0.5
    different: { m: 0.03, u: 0.9455 },
  },
  domain: {
    same_label_other_tld: { m: 0.15, u: 0.003 }, // acme.ai vs acme.com
    different: { m: 0.05, u: 0.95 },             // both present, unrelated
    missing: { m: 1, u: 1 },                      // one side lacks a domain: no evidence either way
  },
  founders: {
    overlap: { m: 0.6, u: 0.0005 },
    disjoint: { m: 0.1, u: 0.9 },
    missing: { m: 1, u: 1 },
  },
  location: {
    same: { m: 0.8, u: 0.05 },
    different: { m: 0.2, u: 0.95 },
    missing: { m: 1, u: 1 },
  },
} as const;

/** Prior that a random blocked pair is a match. Blocking already filters, so this is not tiny. */
export const PRIOR = 0.05;
export const MATCH_THRESHOLD = 0.95;
export const REVIEW_THRESHOLD = 0.5;

const w = (l: { m: number; u: number }) => Math.log2(l.m / l.u);

/** "siteline" leads "siteline construction software": the short name could be the long one. */
function leadingTokens(short: string, long: string): boolean {
  const s = short.split(" ").filter(Boolean);
  const l = long.split(" ").filter(Boolean);
  if (!s.length || s.length >= l.length) return false;
  return s.every((t, i) => l[i] === t) && s.join("").length >= 4;
}

interface KnownRecord {
  entityId: string;
  name: string;
  aliases: string[];
  domains: string[];
  founders: string[];
  location: string | null;
}

export function compareRecords(
  c: Candidate,
  k: KnownRecord,
): { weight: number; reasons: string[]; nameLevel: NameLevel; corroborated: boolean } {
  const reasons: string[] = [];
  let weight = 0;

  // Name: best level across the entity's aliases.
  const cn = normalizeCompanyName(c.name);
  const cc = coreCompanyName(c.name);
  const names = [k.name, ...k.aliases];
  let nameLevel: NameLevel = "different";
  const rank = ["different", "close", "very_close", "core_exact", "exact"] as const;
  for (const n of names) {
    const kn = normalizeCompanyName(n);
    const kc = coreCompanyName(n);
    let lvl: NameLevel = "different";
    if (kn === cn) lvl = "exact";
    else if (kc === cc && cc.length >= 3) lvl = "core_exact";
    else if (jaroWinkler(kn, cn) >= 0.95) lvl = "very_close";
    else if (jaroWinkler(kn, cn) >= 0.88 || tokenJaccard(kn, cn) >= 0.5 || leadingTokens(cc, kn) || leadingTokens(kc, cn)) lvl = "close";
    if (rank.indexOf(lvl) > rank.indexOf(nameLevel)) nameLevel = lvl;
  }
  weight += w(LEVELS.name[nameLevel]);
  reasons.push(`name ${nameLevel.replace("_", " ")}`);

  // Domain (exact equality never reaches here: it's an identifier match).
  const cd = normalizeDomain(c.domain);
  if (cd && k.domains.length) {
    const label = (d: string) => d.split(".").slice(0, -1).join(".");
    const sameLabel = k.domains.some((d) => label(d) === label(cd));
    const lvl = sameLabel ? "same_label_other_tld" : "different";
    weight += w(LEVELS.domain[lvl]);
    reasons.push(sameLabel ? "same domain name, different TLD" : `different domains (${cd} vs ${k.domains.join(", ")})`);
  }

  // Founders.
  if (c.founders?.length && k.founders.length) {
    const kf = new Set(k.founders.map(normalizePersonName));
    const overlap = c.founders.map(normalizePersonName).filter((f) => kf.has(f));
    const lvl = overlap.length ? "overlap" : "disjoint";
    weight += w(LEVELS.founders[lvl]);
    reasons.push(overlap.length ? `shared founder: ${overlap.join(", ")}` : "no founders in common");
  }

  // Location (city level).
  if (c.location && k.location) {
    const city = (s: string) => s.toLowerCase().split(",")[0]!.trim();
    const lvl = city(c.location) === city(k.location) ? "same" : "different";
    weight += w(LEVELS.location[lvl]);
    reasons.push(`location ${lvl}`);
  }

  return { weight, reasons, nameLevel, corroborated: reasons.length > 1 };
}

export function toProbability(weight: number, prior = PRIOR): number {
  const priorWeight = Math.log2(prior / (1 - prior));
  const odds = Math.pow(2, priorWeight + weight);
  return odds / (1 + odds);
}

/** Candidate entities that share enough of the name to be worth scoring. */
async function block(db: Db, c: Candidate): Promise<KnownRecord[]> {
  const cn = normalizeCompanyName(c.name);
  const cc = coreCompanyName(c.name);
  const { rows } = await db.query<{ entity_id: string }>(
    `select distinct a.entity_id
       from entity_aliases a join entities e on e.id = a.entity_id
      where e.type = $1 and e.merged_into is null
        and (a.normalized = $2 or a.normalized % $2 or a.normalized like $3 || '%' or similarity(a.normalized, $3) > 0.5)
      limit 25`,
    [c.type, cn, cc],
  );
  // Founder-based blocking catches rebrands where the name changed.
  const founderRows = c.founders?.length
    ? (
        await db.query<{ entity_id: string }>(
          `select distinct c.subject_id as entity_id from claims c join entities e on e.id = c.subject_id
            where c.predicate = 'team.founder' and e.type = $1 and e.merged_into is null
              and lower(c.value #>> '{}') = any($2::text[]) limit 25`,
          [c.type, c.founders.map((f) => f.toLowerCase().trim())],
        )
      ).rows
    : [];
  const ids = [...new Set([...rows, ...founderRows].map((r) => r.entity_id))];
  const out: KnownRecord[] = [];
  for (const id of ids) out.push(await loadKnown(db, id));
  return out;
}

async function loadKnown(db: Db, entityId: string): Promise<KnownRecord> {
  const e = (await db.query<{ name: string }>("select name from entities where id=$1", [entityId])).rows[0]!;
  const aliases = (await db.query<{ alias: string }>("select alias from entity_aliases where entity_id=$1", [entityId])).rows.map((r) => r.alias);
  const domains = (
    await db.query<{ value: string }>("select value from entity_identifiers where entity_id=$1 and kind='domain'", [entityId])
  ).rows.map((r) => r.value);
  const claims = await db.query<{ predicate: string; value: unknown }>(
    `select predicate, value from claims where subject_id=$1 and predicate in ('team.founder','company.hq_location')`,
    [entityId],
  );
  return {
    entityId,
    name: e.name,
    aliases,
    domains,
    founders: claims.rows.filter((r) => r.predicate === "team.founder").map((r) => String(r.value)),
    location: (claims.rows.find((r) => r.predicate === "company.hq_location")?.value as string | undefined) ?? null,
  };
}

/**
 * Resolve a mention to an entity. Pure read: never writes. Callers decide
 * what to do with a "review" (see resolveOrCreate).
 */
export async function resolve(db: Db, c: Candidate): Promise<Resolution> {
  // 1. Hard identifiers.
  const ids: { kind: IdentifierKind; value: string }[] = [...(c.externalIds ?? [])];
  if (c.domain && normalizeDomain(c.domain)) ids.unshift({ kind: "domain", value: c.domain });
  if (c.linkedin && normalizeLinkedIn(c.linkedin)) ids.unshift({ kind: "linkedin", value: c.linkedin });
  for (const id of ids) {
    const hit = await findByIdentifier(db, id.kind, id.value);
    if (hit && hit.type === c.type) {
      return {
        decision: "match", entityId: hit.id, probability: 1, method: "identifier", candidates: [],
        explanation: `Same ${id.kind} as ${hit.name}.`,
      };
    }
  }

  // 2. Block, then score.
  const known = await block(db, c);
  const scored: ScoredMatch[] = known
    .map((k) => {
      const r = compareRecords(c, k);
      return { entityId: k.entityId, name: k.name, probability: toProbability(r.weight), ...r };
    })
    .sort((a, b) => b.probability - a.probability);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.probability < REVIEW_THRESHOLD) {
    return {
      decision: "new", probability: best?.probability ?? 0, method: best ? "fellegi-sunter" : "none", candidates: scored,
      explanation: best ? `Closest is ${best.name} at ${(best.probability * 100).toFixed(0)}%: ${best.reasons.join("; ")}.` : "No similar entities.",
    };
  }
  // Two strong candidates means we can't tell them apart: a human decides.
  // So does a bare name when another known company shares most of it.
  const nameOnlyClash =
    !best.corroborated && scored.filter((s) => s.nameLevel !== "different").length > 1;
  const ambiguous = (runnerUp && runnerUp.probability >= REVIEW_THRESHOLD) || nameOnlyClash;
  if (best.probability >= MATCH_THRESHOLD && !ambiguous) {
    return {
      decision: "match", entityId: best.entityId, probability: best.probability, method: "fellegi-sunter", candidates: scored,
      explanation: `${best.name} at ${(best.probability * 100).toFixed(1)}%: ${best.reasons.join("; ")}.`,
    };
  }
  return {
    decision: "review", entityId: best.entityId, probability: best.probability, method: "fellegi-sunter", candidates: scored,
    explanation: ambiguous
      ? `Name alone can't separate ${best.name} from ${runnerUp?.name ?? "another entity"}.`
      : `${best.name} at ${(best.probability * 100).toFixed(0)}%: ${best.reasons.join("; ")}.`,
  };
}
