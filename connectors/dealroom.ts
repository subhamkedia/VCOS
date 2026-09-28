import { config, requireKey } from "../lib/config.js";
import { normalizeDomain, normalizeLinkedIn } from "../lib/text.js";
import { asArray, asNumber, asString, pick, requestJson } from "./http.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Dealroom API v1 (https://api.dealroom.co/api/v1). HTTP basic auth with
 * the API key as the user name. Search companies by website domain and map
 * the first hit. Vendor scope: stays internal.
 *
 * Dealroom reports funding in EUR by default, so funding totals stay in the
 * evidence rather than becoming USD claims. Field names follow Dealroom's
 * docs; run `pnpm ingest dealroom <domain> --dry-run` with your key first.
 */
export const DEALROOM = "https://api.dealroom.co/api/v1";
const FIELDS = "id,name,tagline,website_url,linkedin_url,hq_locations,launch_year,employees_latest,founders,investors,path";

function headers() {
  return { Authorization: `Basic ${Buffer.from(`${requireKey("dealroomApiKey")}:`).toString("base64")}`, "Content-Type": "application/json" };
}

export function dealroomToRecord(c: Record<string, unknown>, fetchedAt = new Date().toISOString()): SourceRecord {
  const name = asString(c.name) ?? "Unknown company";
  const id = asString(c.id) ?? (asNumber(c.id) !== undefined ? String(c.id) : undefined);
  const domain = normalizeDomain(asString(c.website_url)) ?? undefined;
  const linkedin = normalizeLinkedIn(asString(c.linkedin_url)) ?? undefined;
  const hq = asArray(c.hq_locations)[0] ?? {};
  const location = [asString(pick(hq, "city.name")), asString(pick(hq, "country.name"))].filter(Boolean).join(", ") || undefined;
  const founders = asArray(pick(c, "founders.items") ?? c.founders).map((f) => asString(f.name)).filter((n): n is string => Boolean(n));
  const asOf = fetchedAt.slice(0, 10);

  const claims: StructuredClaim[] = [];
  const push = (predicate: string, value: unknown, when: string | null = asOf) => {
    if (value !== undefined && value !== null && value !== "") claims.push({ predicate, value, asOf: when ?? undefined, confidence: 0.7 });
  };
  push("company.description", asString(c.tagline));
  if (domain) push("company.website", domain);
  push("company.hq_location", location);
  const launched = asNumber(c.launch_year);
  if (launched) push("company.founded_year", launched, null);
  push("team.headcount", asNumber(c.employees_latest));
  for (const f of founders) push("team.founder", f, null);
  for (const inv of asArray(pick(c, "investors.items") ?? c.investors)) push("funding.investor", asString(inv.name), null);

  return {
    evidence: {
      kind: "api_record", source: "dealroom", uri: asString(c.path) ? `https://app.dealroom.co/companies/${asString(c.path)}` : undefined,
      title: `Dealroom: ${name}`, content: JSON.stringify(c, null, 2), mimeType: "application/json", accessScope: "vendor", occurredAt: fetchedAt,
    },
    subject: {
      type: "company", name, domain, linkedin, founders, location, source: "dealroom",
      externalIds: id ? [{ kind: "dealroom", value: id }] : [],
    },
    claims,
    sourceType: "third_party",
  };
}

export async function dealroomByDomain(domain: string, fetchImpl?: FetchLike): Promise<SourceRecord> {
  const d = normalizeDomain(domain);
  if (!d) throw new Error(`Not a domain: ${domain}`);
  const res = await requestJson<{ items?: Record<string, unknown>[] }>("dealroom", `${DEALROOM}/companies`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ keyword: d, keyword_type: "website_domain", keyword_match_type: "exact", fields: FIELDS, limit: 5 }),
    fetchImpl,
  });
  const hit = (res.items ?? []).find((c) => normalizeDomain(asString(c.website_url)) === d) ?? res.items?.[0];
  if (!hit) throw new Error(`Dealroom has no company for ${d}`);
  return dealroomToRecord(hit);
}

export async function dealroomCheck(fetchImpl?: FetchLike): Promise<string> {
  await dealroomByDomain("dealroom.co", fetchImpl);
  return "key accepted";
}

export const dealroomConfigured = () => Boolean(config.dealroomApiKey);
