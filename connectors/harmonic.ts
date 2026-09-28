import { config, requireKey } from "../lib/config.js";
import { normalizeDomain, normalizeLinkedIn } from "../lib/text.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Harmonic company enrichment: POST https://api.harmonic.ai/companies with
 * an identifier as a query parameter (website_domain, linkedin_url, ...).
 *
 * Field names below follow Harmonic's documented response (name,
 * description, founding_date, headcount, location, funding, people,
 * website). The mapping is defensive because vendors reshape payloads:
 * run `pnpm ingest harmonic <domain> --dry-run` once against a live key
 * and check the claims before trusting it.
 */
export const HARMONIC_BASE = "https://api.harmonic.ai";

type Json = Record<string, unknown>;

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Json)[k] : undefined), o);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const date = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

/** Map Harmonic's funding-type labels onto our stage enum. */
export function mapStage(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const s = label.toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("preseed")) return "pre_seed";
  if (s.includes("seed")) return "seed";
  if (s.includes("seriesa")) return "series_a";
  if (s.includes("seriesb")) return "series_b";
  if (s.includes("seriesc")) return "series_c";
  if (/series[d-z]/.test(s)) return "series_d_plus";
  if (s.includes("grant")) return "grant";
  if (s.includes("debt") || s.includes("loan")) return "debt";
  return "other";
}

/** Turn a Harmonic company payload into a SourceRecord. Pure: easy to test against a saved response. */
export function harmonicToRecord(company: Json, fetchedAt = new Date().toISOString()): SourceRecord {
  const name = str(company.name) ?? str(company.legal_name) ?? "Unknown company";
  const domain = normalizeDomain(str(get(company, "website.domain")) ?? str(get(company, "website.url")) ?? str(company.website)) ?? undefined;
  const linkedin = normalizeLinkedIn(str(get(company, "socials.linkedin.url")) ?? str(company.linkedin_url)) ?? undefined;
  const city = str(get(company, "location.city"));
  const country = str(get(company, "location.country"));
  const location = [city, str(get(company, "location.state")), country].filter(Boolean).join(", ") || undefined;
  const asOf = fetchedAt.slice(0, 10);

  const people = (Array.isArray(company.people) ? company.people : []) as Json[];
  const founders = people
    .filter((p) => /founder/i.test(String(p.title ?? p.role_type ?? "")) && (p.is_current_position ?? true))
    .map((p) => str(p.full_name) ?? str(get(p, "person.full_name")) ?? str(p.name))
    .filter((n): n is string => Boolean(n));

  const claims: StructuredClaim[] = [];
  // `null` = timeless (founders, founding year). Omitted = true as of the fetch.
  const push = (predicate: string, value: unknown, when: string | null | undefined = asOf) => {
    if (value !== undefined && value !== null && value !== "")
      claims.push({ predicate, value, asOf: when ?? undefined, confidence: 0.75 });
  };

  push("company.description", str(company.description) ?? str(company.short_description));
  const founded = date(get(company, "founding_date.date") ?? company.founding_date);
  if (founded) push("company.founded_year", Number(founded.slice(0, 4)), null);
  push("company.hq_location", location);
  if (domain) push("company.website", domain);
  push("team.headcount", num(company.headcount) ?? num(get(company, "headcount.value")));
  for (const f of founders) push("team.founder", f, null);

  const funding = (company.funding ?? {}) as Json;
  push("funding.total_raised", num(funding.funding_total) ?? num(funding.total));
  const lastAt = date(funding.last_funding_at);
  push("funding.round.amount", num(funding.last_funding_total), lastAt ?? asOf);
  push("funding.round.stage", mapStage(str(funding.last_funding_type) ?? str(company.stage)), lastAt ?? asOf);
  const investors = (Array.isArray(funding.investors) ? funding.investors : []) as Json[];
  for (const inv of investors) push("funding.investor", str(inv.name) ?? str(get(inv, "entity.name")), null);

  return {
    evidence: {
      kind: "api_record",
      source: "harmonic",
      uri: str(company.entity_urn) ?? (domain ? `harmonic:domain:${domain}` : undefined),
      title: `Harmonic: ${name}`,
      content: JSON.stringify(company, null, 2),
      mimeType: "application/json",
      accessScope: "vendor",
      occurredAt: fetchedAt,
    },
    subject: {
      type: "company",
      name,
      domain,
      linkedin,
      founders,
      location,
      source: "harmonic",
      externalIds: str(company.entity_urn) ? [{ kind: "harmonic", value: str(company.entity_urn)! }] : [],
    },
    claims,
    sourceType: "third_party",
  };
}

/** Enrich a company by domain. Costs one Harmonic API call. */
export async function harmonicEnrichByDomain(domain: string, fetchImpl: FetchLike = fetch): Promise<SourceRecord> {
  const d = normalizeDomain(domain);
  if (!d) throw new Error(`Not a domain: ${domain}`);
  const url = `${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(d)}&enrich_missing_company=false`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { apikey: requireKey("harmonicApiKey"), Accept: "application/json" },
  });
  if (res.status === 404) throw new Error(`Harmonic has no company for ${d}`);
  if (!res.ok) throw new Error(`Harmonic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return harmonicToRecord((await res.json()) as Json);
}

export const harmonicConfigured = () => Boolean(config.harmonicApiKey);
