import { asArray, asNumber, asString, requestJson } from "./http.js";
import { sameCompanyName, sameDomain, usd, type CompanyRef } from "./research.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * SBIR and STTR awards from SBIR.gov's public API (no key). For deep-tech
 * and physical-world companies these are often the first outside money and
 * the first government customer. An award counts only when the firm name
 * matches or its website is the company's.
 */

const API = "https://api.www.sbir.gov/public/api/awards";

export interface SbirAward {
  firm: string;
  title: string;
  agency: string;
  branch?: string;
  phase?: string;
  program?: string;
  year?: string;
  amount?: number;
  companyUrl?: string;
  city?: string;
  state?: string;
  link?: string;
}

export function parseSbir(json: unknown): SbirAward[] {
  const rows = Array.isArray(json) ? asArray(json) : asArray((json as { results?: unknown })?.results);
  return rows.flatMap((a) => {
    const firm = asString(a.firm);
    const title = asString(a.award_title);
    if (!firm || !title) return [];
    return [{
      firm, title, agency: asString(a.agency) ?? "Unknown agency", branch: asString(a.branch), phase: asString(a.phase), program: asString(a.program),
      year: asString(a.award_year) ?? (asNumber(a.award_year) ? String(a.award_year) : undefined), amount: asNumber(a.award_amount),
      companyUrl: asString(a.company_url), city: asString(a.city), state: asString(a.state), link: asString(a.award_link),
    }];
  });
}

/** Pure. */
export function sbirRecord(company: CompanyRef, awards: SbirAward[]): SourceRecord | null {
  const mine = awards.filter((a) => sameCompanyName(company, a.firm) || sameDomain(company, a.companyUrl));
  if (!mine.length) return null;
  const line = (a: SbirAward) =>
    `${a.agency}${a.branch ? ` (${a.branch})` : ""} ${a.program ?? "SBIR"} ${a.phase ?? ""}: ${a.title}${a.amount ? `, ${usd(a.amount)}` : ""}${a.year ? `, ${a.year}` : ""}`.replace(/\s+/g, " ").trim();
  const lines = mine.map(line);
  const claims: StructuredClaim[] = mine.map((a, i) => ({ predicate: "grant.award", value: lines[i]!, asOf: a.year ? `${a.year}-12` : undefined, citedText: lines[i], confidence: 0.95 }));
  const loc = mine.find((a) => a.city && a.state);
  if (loc) claims.push({ predicate: "company.hq_location", value: `${loc.city}, ${loc.state}`, confidence: 0.6 });
  return {
    evidence: {
      kind: "api_record", source: "sbir", uri: `sbir:firm:${mine[0]!.firm}`, title: `SBIR/STTR awards to ${mine[0]!.firm}`,
      content: `SBIR and STTR awards to ${mine[0]!.firm}, from SBIR.gov:\n${lines.join("\n")}`, accessScope: "public", occurredAt: new Date().toISOString(),
    },
    subject: { type: "company", name: company.name, domain: company.domain, source: "sbir" },
    sourceType: "primary",
    claims,
  };
}

export async function companySbir(company: CompanyRef, opts: { fetchImpl?: FetchLike } = {}): Promise<SourceRecord[]> {
  const q = new URLSearchParams({ firm: company.name, rows: "100", format: "json" });
  const rec = sbirRecord(company, parseSbir(await requestJson("sbir.gov", `${API}?${q}`, { fetchImpl: opts.fetchImpl })));
  return rec ? [rec] : [];
}
