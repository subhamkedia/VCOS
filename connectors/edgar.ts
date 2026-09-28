import { requireKey } from "../lib/config.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * SEC EDGAR Form D: the notice companies file within 15 days of a Reg D
 * sale. Free, official, often earlier than any database. Amount sold is
 * sometimes omitted or cumulative, so claims carry modest confidence.
 *
 * SEC asks every client to send a User-Agent with contact details
 * (SEC_USER_AGENT) and to stay under 10 requests a second.
 */

export interface FormDHit {
  cik: string;
  adsh: string;
  name: string;
  fileDate: string;
  location?: string;
}

export async function searchFormD(
  query: string,
  opts: { from?: string; to?: string; fetchImpl?: FetchLike } = {},
): Promise<FormDHit[]> {
  const params = new URLSearchParams({ q: `"${query}"`, forms: "D" });
  if (opts.from || opts.to) {
    params.set("dateRange", "custom");
    if (opts.from) params.set("startdt", opts.from);
    if (opts.to) params.set("enddt", opts.to);
  }
  const res = await (opts.fetchImpl ?? fetch)(`https://efts.sec.gov/LATEST/search-index?${params}`, {
    headers: { "User-Agent": requireKey("secUserAgent"), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR search ${res.status}`);
  const body = (await res.json()) as { hits?: { hits?: { _source?: Record<string, unknown> }[] } };
  return (body.hits?.hits ?? []).flatMap((h) => {
    const s = h._source ?? {};
    const cik = (s.ciks as string[] | undefined)?.[0];
    const adsh = s.adsh as string | undefined;
    if (!cik || !adsh) return [];
    const display = (s.display_names as string[] | undefined)?.[0] ?? "";
    return [{
      cik,
      adsh,
      name: display.replace(/\s*\(CIK \d+\)\s*$/, "").trim(),
      fileDate: String(s.file_date ?? ""),
      location: (s.biz_locations as string[] | undefined)?.[0],
    }];
  });
}

export function formDUrl(cik: string, adsh: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/primary_doc.xml`;
}

const tag = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i"))?.[1]?.trim();

export interface FormD {
  issuerName: string;
  cik?: string;
  city?: string;
  state?: string;
  yearOfInc?: number;
  industry?: string;
  totalOfferingAmount?: number;
  totalAmountSold?: number;
  dateOfFirstSale?: string;
  investorCount?: number;
  relatedPersons: { name: string; relationships: string[] }[];
}

export function parseFormD(xml: string): FormD {
  const issuer = tag(xml, "primaryIssuer") ?? xml;
  const amounts = tag(xml, "offeringSalesAmounts") ?? "";
  const n = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : undefined);
  const persons = [...xml.matchAll(/<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/gi)].map((m) => {
    const block = m[1] ?? "";
    const first = tag(block, "firstName") ?? "";
    const last = tag(block, "lastName") ?? "";
    const relationships = [...block.matchAll(/<relationship>([\s\S]*?)<\/relationship>/gi)].map((r) => (r[1] ?? "").trim());
    return { name: `${first} ${last}`.trim(), relationships };
  });
  return {
    issuerName: tag(issuer, "entityName") ?? tag(xml, "issuerName") ?? "Unknown issuer",
    cik: tag(issuer, "cik"),
    city: tag(issuer, "city"),
    state: tag(issuer, "stateOrCountry"),
    yearOfInc: n(tag(tag(issuer, "yearOfInc") ?? "", "value")),
    industry: tag(xml, "industryGroupType"),
    totalOfferingAmount: n(tag(amounts, "totalOfferingAmount")),
    totalAmountSold: n(tag(amounts, "totalAmountSold")),
    dateOfFirstSale: tag(tag(xml, "dateOfFirstSale") ?? "", "value"),
    investorCount: n(tag(xml, "totalNumberAlreadyInvested")),
    relatedPersons: persons.filter((p) => p.name),
  };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function formDToRecord(xml: string, hit: Pick<FormDHit, "cik" | "adsh" | "fileDate">): SourceRecord {
  const d = parseFormD(xml);
  const asOf = d.dateOfFirstSale && /^\d{4}-\d{2}-\d{2}$/.test(d.dateOfFirstSale) ? d.dateOfFirstSale : hit.fileDate || undefined;
  const location = [d.city ? titleCase(d.city) : undefined, d.state].filter(Boolean).join(", ") || undefined;

  const claims: StructuredClaim[] = [];
  if (d.totalAmountSold !== undefined && d.totalAmountSold > 0)
    claims.push({ predicate: "funding.round.amount", value: d.totalAmountSold, asOf, confidence: 0.7, citedText: `<totalAmountSold>${d.totalAmountSold}</totalAmountSold>` });
  if (d.yearOfInc) claims.push({ predicate: "company.founded_year", value: d.yearOfInc, confidence: 0.9 });
  if (location) claims.push({ predicate: "company.hq_location", value: location, asOf: hit.fileDate || undefined, confidence: 0.9 });
  for (const p of d.relatedPersons.filter((p) => p.relationships.some((r) => /executive officer/i.test(r))))
    claims.push({ predicate: "team.key_hire", value: `${titleCase(p.name)}, ${p.relationships.join(" / ")}`, asOf: hit.fileDate || undefined, confidence: 0.9 });

  return {
    evidence: {
      kind: "filing",
      source: "sec-edgar",
      uri: formDUrl(hit.cik, hit.adsh),
      title: `Form D: ${d.issuerName} (${hit.fileDate})`,
      content: xml,
      mimeType: "application/xml",
      accessScope: "public",
      occurredAt: hit.fileDate || undefined,
      metadata: { adsh: hit.adsh, totalOfferingAmount: d.totalOfferingAmount, investorCount: d.investorCount, industry: d.industry },
    },
    subject: {
      type: "company",
      name: titleCase(d.issuerName),
      location,
      source: "sec-edgar",
      externalIds: [{ kind: "cik", value: String(Number(d.cik ?? hit.cik)) }],
    },
    claims,
    sourceType: "primary",
  };
}

export async function fetchFormD(hit: FormDHit, fetchImpl: FetchLike = fetch): Promise<SourceRecord> {
  const res = await fetchImpl(formDUrl(hit.cik, hit.adsh), { headers: { "User-Agent": requireKey("secUserAgent") } });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${hit.adsh}`);
  return formDToRecord(await res.text(), hit);
}
