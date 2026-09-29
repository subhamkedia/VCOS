import { normalizeCompanyName, normalizeDomain } from "../lib/text.js";

/**
 * Shared by the public-data connectors that look a company up by name
 * (patents, federal awards, SBIR, news). Names collide: there are many
 * "Kestrel"s. A record counts only when its organization name is the same
 * company name after normalization (legal suffixes and punctuation
 * removed), or when it carries the company's own website domain.
 */

export interface CompanyRef {
  name: string;
  domain?: string;
  /** Other names the ledger knows (former names, legal name). */
  aliases?: string[];
}

export function sameCompanyName(company: CompanyRef, candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const c = normalizeCompanyName(candidate);
  if (!c) return false;
  return [company.name, ...(company.aliases ?? [])].some((n) => normalizeCompanyName(n) === c);
}

export function sameDomain(company: CompanyRef, url: string | undefined | null): boolean {
  const d = normalizeDomain(url ?? undefined);
  return Boolean(d && company.domain && d === normalizeDomain(company.domain));
}

/** "$1,250,000" style, for claim text. */
export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const today = () => new Date().toISOString().slice(0, 10);
