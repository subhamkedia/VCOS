import { sha256, normalizeCompanyName, coreCompanyName, jaroWinkler } from "../../lib/text.js";
import { batchCode, type LaunchPost, type YcCompany } from "../../connectors/yc.js";

/**
 * Build the resolver gate set from YC's directory. Pure: the CLI in
 * build-yc.ts does the fetching.
 *
 * - 200 companies across the 2026 batches, allocated in proportion to batch
 *   size and picked by a seeded hash, so the draw is reproducible.
 * - 80% become known entities (the fund's CRM). 20% are held out: their
 *   mentions must come back NEW.
 * - Each known company gets one mention in a format the fund actually
 *   receives, rotating through: company website, Form D legal name + city,
 *   founder intro, typo. Real Launch HN titles and real former names are
 *   added on top. YC companies from other years with look-alike names are
 *   added as NEW cases: those are where false merges hide.
 *
 * Labels come from YC's own identity for each company (its slug), not from
 * the resolver, so the set can't be tuned to the code.
 */

export interface GateEntity {
  key: string;
  name: string;
  domain?: string;
  founders?: string[];
  location?: string;
}

export type CaseKind = "website" | "legal_name" | "founder_intro" | "typo" | "launch_hn" | "former_name" | "new_company" | "lookalike";

export interface GateCase {
  kind: CaseKind;
  name: string;
  domain?: string;
  founders?: string[];
  location?: string;
  expected: string;
  acceptReview?: boolean;
  mustReview?: boolean;
  note: string;
}

export interface GateInput {
  companies: YcCompany[];
  launches?: LaunchPost[];
  /** Other YC companies (not 2026), searched for look-alike names. */
  pool?: YcCompany[];
  size?: number;
  knownShare?: number;
  seed?: string;
  maxLookalikes?: number;
}

const rank = (seed: string, slug: string) => sha256(`${seed}:${slug}`);

/** Split `size` across batches in proportion to their sizes (largest remainder). */
export function allocate(counts: Map<string, number>, size: number): Map<string, number> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const want = Math.min(size, total);
  const rows = [...counts].map(([batch, n]) => {
    const exact = (n / total) * want;
    return { batch, n, take: Math.min(n, Math.floor(exact)), rem: exact - Math.floor(exact) };
  });
  let left = want - rows.reduce((a, r) => a + r.take, 0);
  for (const r of [...rows].sort((a, b) => b.rem - a.rem || a.batch.localeCompare(b.batch))) {
    if (left <= 0) break;
    if (r.take < r.n) {
      r.take++;
      left--;
    }
  }
  return new Map(rows.map((r) => [r.batch, r.take]));
}

/** A realistic one-slip typo: swap two adjacent letters inside the longest word. */
export function typo(name: string): string | null {
  const words = name.split(/\s+/);
  let best = -1;
  for (const [i, w] of words.entries()) if (/^[A-Za-z]{5,}$/.test(w) && (best < 0 || w.length > words[best]!.length)) best = i;
  if (best < 0) return null;
  const w = words[best]!;
  const at = Math.floor(w.length / 2) - 1;
  if (w[at]!.toLowerCase() === w[at + 1]!.toLowerCase()) return null;
  words[best] = w.slice(0, at) + w[at + 1] + w[at] + w.slice(at + 2);
  return words.join(" ");
}

/** Form D style: "ACME ROBOTICS, INC." and "SAN FRANCISCO". */
function legalName(name: string): string {
  return /\b(inc|llc|corp|ltd)\.?$/i.test(name) ? name.toUpperCase() : `${name.toUpperCase()}, INC.`;
}

const city = (location?: string) => location?.split(",")[0]?.trim();

function launchFor(c: YcCompany, launches: LaunchPost[]): LaunchPost | undefined {
  const code = batchCode(c.batch);
  return (
    launches.find((l) => l.batch === code && c.domain && l.domain === c.domain) ??
    launches.find((l) => l.batch === code && normalizeCompanyName(l.mention) === normalizeCompanyName(c.name))
  );
}

function looksAlike(a: string, b: string): boolean {
  const ca = coreCompanyName(a);
  const cb = coreCompanyName(b);
  if (!ca || !cb || ca === cb) return ca === cb && ca.length > 0;
  const firstA = ca.split(" ")[0]!;
  const firstB = cb.split(" ")[0]!;
  return (firstA.length >= 4 && firstA === firstB) || jaroWinkler(ca, cb) >= 0.92;
}

export function buildGateSet(input: GateInput): { entities: GateEntity[]; cases: GateCase[]; selected: YcCompany[] } {
  const seed = input.seed ?? "yc2026";
  const size = input.size ?? 200;
  const launches = input.launches ?? [];

  // Companies without a name or sharing a domain with another are ambiguous at the source; leave them out.
  const domainCount = new Map<string, number>();
  for (const c of input.companies) if (c.domain) domainCount.set(c.domain, (domainCount.get(c.domain) ?? 0) + 1);
  const eligible = input.companies.filter((c) => !c.domain || domainCount.get(c.domain) === 1);

  const byBatch = new Map<string, YcCompany[]>();
  for (const c of eligible) byBatch.set(c.batch, [...(byBatch.get(c.batch) ?? []), c]);
  const quota = allocate(new Map([...byBatch].map(([b, list]) => [b, list.length])), size);
  const selected = [...byBatch]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([b, list]) => [...list].sort((x, y) => rank(seed, x.slug).localeCompare(rank(seed, y.slug))).slice(0, quota.get(b) ?? 0));

  const ordered = [...selected].sort((x, y) => rank(`${seed}:split`, x.slug).localeCompare(rank(`${seed}:split`, y.slug)));
  const knownCount = Math.round(ordered.length * (input.knownShare ?? 0.8));
  const known = ordered.slice(0, knownCount).sort((a, b) => a.name.localeCompare(b.name));
  const heldOut = ordered.slice(knownCount).sort((a, b) => a.name.localeCompare(b.name));

  const entities: GateEntity[] = known.map((c) => ({
    key: c.slug, name: c.name, domain: c.domain, founders: c.founders?.length ? c.founders : undefined, location: c.location,
  }));

  const cases: GateCase[] = [];
  const rotation: CaseKind[] = ["website", "legal_name", "founder_intro", "typo"];
  for (const [i, c] of known.entries()) {
    const code = batchCode(c.batch);
    let kind = rotation[i % rotation.length]!;
    const t = typo(c.name);
    if (kind === "typo" && !t) kind = "founder_intro";
    if (kind === "founder_intro" && !c.founders?.length) kind = c.domain ? "website" : "legal_name";
    if (kind === "website" && !c.website) kind = "legal_name";

    if (kind === "website") {
      cases.push({ kind, name: c.name, domain: c.website, expected: c.slug, note: `${code}: record with the company website, as from a data vendor` });
    } else if (kind === "legal_name") {
      // Name and city only, as on a Form D: a human check is an acceptable answer.
      cases.push({
        kind, name: legalName(c.name), location: city(c.location)?.toUpperCase(), expected: c.slug, acceptReview: true,
        note: `${code}: Form D style legal name`,
      });
    } else if (kind === "founder_intro") {
      cases.push({ kind, name: c.name, founders: [c.founders![0]!], expected: c.slug, note: `${code}: intro email naming one founder` });
    } else {
      cases.push({ kind, name: t!, founders: c.founders, expected: c.slug, acceptReview: true, note: `${code}: one-letter slip of "${c.name}"` });
    }

    const launch = launchFor(c, launches);
    if (launch && launch.mention !== c.name) {
      cases.push({
        kind: "launch_hn", name: launch.mention, expected: c.slug, acceptReview: true,
        note: `${code}: HN ${launch.hnId} "${launch.title}"`,
      });
    }
    for (const former of c.formerNames) {
      cases.push({
        kind: "former_name", name: former, founders: c.founders, expected: c.slug, acceptReview: true,
        note: `${code}: former name of ${c.name} per YC directory`,
      });
    }
  }

  for (const c of heldOut) {
    const code = batchCode(c.batch);
    cases.push({
      kind: "new_company", name: c.name, domain: c.website, founders: c.founders, location: c.location, expected: "NEW",
      note: `${code}: not in the CRM`,
    });
  }

  // Real YC companies from other batches whose names look like a known one.
  const selectedSlugs = new Set(selected.map((c) => c.slug));
  const knownDomains = new Set(known.map((c) => c.domain).filter(Boolean));
  const used = new Set<string>();
  const lookalikes: GateCase[] = [];
  for (const k of known) {
    for (const p of input.pool ?? []) {
      if (selectedSlugs.has(p.slug) || used.has(p.slug) || !p.domain || knownDomains.has(p.domain)) continue;
      if (!looksAlike(k.name, p.name)) continue;
      used.add(p.slug);
      lookalikes.push({
        kind: "lookalike", name: p.name, domain: p.website, location: p.location, expected: "NEW",
        note: `${batchCode(p.batch)} company whose name resembles ${k.name} (${batchCode(k.batch)})`,
      });
    }
  }
  lookalikes.sort((a, b) => rank(seed, a.name).localeCompare(rank(seed, b.name)));
  cases.push(...lookalikes.slice(0, input.maxLookalikes ?? 40));

  return { entities, cases, selected };
}
