import { config, requireKey } from "../lib/config.js";
import { normalizeDomain, normalizeLinkedIn } from "../lib/text.js";
import { mapStage } from "./harmonic.js";
import { asArray, asDate, asNumber, asString, pick, requestJson } from "./http.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Crunchbase API v4 (https://api.crunchbase.com/api/v4), key in the
 * X-cb-user-key header. Look up by domain with the organizations search,
 * then map the organization's fields. Vendor scope: stays internal.
 *
 * Field ids follow the v4 docs; run `pnpm ingest crunchbase <domain>
 * --dry-run` against a live key before trusting the mapping.
 */
export const CRUNCHBASE = "https://api.crunchbase.com/api/v4";

export const CRUNCHBASE_FIELDS = [
  "identifier", "short_description", "website_url", "linkedin", "location_identifiers", "founded_on",
  "num_employees_enum", "funding_total", "last_funding_type", "last_funding_at", "founder_identifiers", "investor_identifiers",
];

function headers() {
  return { "X-cb-user-key": requireKey("crunchbaseApiKey"), "Content-Type": "application/json" };
}

export function crunchbaseToRecord(entity: Record<string, unknown>, fetchedAt = new Date().toISOString()): SourceRecord {
  const p = (entity.properties ?? entity) as Record<string, unknown>;
  const name = asString(pick(p, "identifier.value")) ?? "Unknown company";
  const permalink = asString(pick(p, "identifier.permalink"));
  const domain = normalizeDomain(asString(p.website_url) ?? asString(pick(p, "website.value"))) ?? undefined;
  const linkedin = normalizeLinkedIn(asString(pick(p, "linkedin.value"))) ?? undefined;
  const locs = asArray(p.location_identifiers);
  const byType = (t: string) => asString(locs.find((l) => l.location_type === t)?.value);
  const location = [byType("city"), byType("region"), byType("country")].filter(Boolean).join(", ") || undefined;
  const founders = asArray(p.founder_identifiers).map((f) => asString(f.value)).filter((n): n is string => Boolean(n));
  const asOf = fetchedAt.slice(0, 10);

  const claims: StructuredClaim[] = [];
  const push = (predicate: string, value: unknown, when: string | null = asOf) => {
    if (value !== undefined && value !== null && value !== "") claims.push({ predicate, value, asOf: when ?? undefined, confidence: 0.7 });
  };
  push("company.description", asString(p.short_description));
  if (domain) push("company.website", domain);
  push("company.hq_location", location);
  const founded = asDate(pick(p, "founded_on.value") ?? p.founded_on);
  if (founded) push("company.founded_year", Number(founded.slice(0, 4)), null);
  for (const f of founders) push("team.founder", f, null);
  const total = asNumber(pick(p, "funding_total.value_usd"));
  push("funding.total_raised", total);
  const lastAt = asDate(p.last_funding_at);
  const stage = mapStage(asString(p.last_funding_type));
  if (stage) push("funding.round.stage", stage, lastAt ?? asOf);
  for (const inv of asArray(p.investor_identifiers)) push("funding.investor", asString(inv.value), null);
  // num_employees_enum is a range ("c_00011_00050"): kept in the evidence, not a headcount claim.

  return {
    evidence: {
      kind: "api_record", source: "crunchbase", uri: permalink ? `https://www.crunchbase.com/organization/${permalink}` : undefined,
      title: `Crunchbase: ${name}`, content: JSON.stringify(p, null, 2), mimeType: "application/json",
      accessScope: "vendor", occurredAt: fetchedAt,
    },
    subject: {
      type: "company", name, domain, linkedin, founders, location, source: "crunchbase",
      externalIds: permalink ? [{ kind: "crunchbase", value: permalink }] : [],
    },
    claims,
    sourceType: "third_party",
  };
}

/** Find an organization by website domain. One search call plus one entity call. */
export async function crunchbaseByDomain(domain: string, fetchImpl?: FetchLike): Promise<SourceRecord> {
  const d = normalizeDomain(domain);
  if (!d) throw new Error(`Not a domain: ${domain}`);
  const search = await requestJson<{ entities?: Record<string, unknown>[] }>("crunchbase", `${CRUNCHBASE}/searches/organizations`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      field_ids: ["identifier", "website_url"],
      query: [{ type: "predicate", field_id: "website_url", operator_id: "domain_eq", values: [d] }],
      limit: 5,
    }),
    fetchImpl,
  });
  const hit = (search.entities ?? []).find((e) => normalizeDomain(asString(pick(e, "properties.website_url"))) === d) ?? search.entities?.[0];
  const permalink = asString(pick(hit, "properties.identifier.permalink")) ?? asString(pick(hit, "properties.identifier.uuid"));
  if (!permalink) throw new Error(`Crunchbase has no organization for ${d}`);
  const entity = await requestJson<Record<string, unknown>>(
    "crunchbase", `${CRUNCHBASE}/entities/organizations/${encodeURIComponent(permalink)}?field_ids=${CRUNCHBASE_FIELDS.join(",")}`,
    { headers: headers(), fetchImpl },
  );
  return crunchbaseToRecord(entity);
}

export async function crunchbaseCheck(fetchImpl?: FetchLike): Promise<string> {
  await requestJson("crunchbase", `${CRUNCHBASE}/autocompletes?query=stripe&collection_ids=organizations&limit=1`, { headers: headers(), fetchImpl });
  return "key accepted";
}

export const crunchbaseConfigured = () => Boolean(config.crunchbaseApiKey);
