import { config, requireKey } from "../lib/config.js";
import { normalizeDomain } from "../lib/text.js";
import { mapStage } from "./harmonic.js";
import { asArray, asDate, asNumber, asString, pick, requestJson } from "./http.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * PitchBook API (https://api.pitchbook.com), key in an
 * `Authorization: PB-Token <key>` header. Search by domain for the
 * PitchBook id, then read the company bio and most recent deal.
 * Vendor scope: stays internal, never exported.
 *
 * PitchBook's API is licensed per firm and its docs sit behind that
 * licence, so the paths and field names below are this module's best
 * reading and are kept in one place (PITCHBOOK_PATHS). Run `pnpm ingest
 * pitchbook <domain> --dry-run` with your key and adjust them if needed.
 */
export const PITCHBOOK = "https://api.pitchbook.com";

export const PITCHBOOK_PATHS = {
  search: (domain: string) => `/companies/search?domain=${encodeURIComponent(domain)}`,
  bio: (pbId: string) => `/companies/${encodeURIComponent(pbId)}/bio`,
  lastDeal: (pbId: string) => `/companies/${encodeURIComponent(pbId)}/most-recent-deal`,
  investors: (pbId: string) => `/companies/${encodeURIComponent(pbId)}/active-investors`,
};

function headers() {
  return { Authorization: `PB-Token ${requireKey("pitchbookApiKey")}` };
}

/** Money fields arrive as numbers or { amount, currency }. Only USD becomes a claim. */
function usd(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const amount = asNumber(pick(v, "amount") ?? pick(v, "value"));
  const currency = asString(pick(v, "currency")) ?? "USD";
  return amount !== undefined && currency.toUpperCase() === "USD" ? amount : undefined;
}

export interface PitchBookPayload {
  pbId: string;
  bio: Record<string, unknown>;
  lastDeal?: Record<string, unknown>;
  investors?: Record<string, unknown>[];
}

export function pitchbookToRecord(pb: PitchBookPayload, fetchedAt = new Date().toISOString()): SourceRecord {
  const b = pb.bio;
  const name = asString(b.companyName) ?? asString(b.name) ?? "Unknown company";
  const domain = normalizeDomain(asString(b.website) ?? asString(b.companyWebsite)) ?? undefined;
  const hq = (b.hqLocation ?? b.headquarters ?? {}) as Record<string, unknown>;
  const location = [asString(hq.city), asString(hq.state) ?? asString(hq.stateProvince), asString(hq.country)].filter(Boolean).join(", ") || undefined;
  const asOf = fetchedAt.slice(0, 10);

  const claims: StructuredClaim[] = [];
  const push = (predicate: string, value: unknown, when: string | null = asOf) => {
    if (value !== undefined && value !== null && value !== "") claims.push({ predicate, value, asOf: when ?? undefined, confidence: 0.8 });
  };
  push("company.description", asString(b.description) ?? asString(b.shortDescription));
  if (domain) push("company.website", domain);
  push("company.hq_location", location);
  const founded = asNumber(b.yearFounded);
  if (founded) push("company.founded_year", founded, null);
  push("team.headcount", asNumber(b.employees) ?? asNumber(pick(b, "employeeCount")));
  push("funding.total_raised", usd(b.totalRaised ?? b.totalCapitalRaised));

  const d = pb.lastDeal ?? {};
  const dealDate = asDate(d.dealDate ?? d.date);
  push("funding.round.amount", usd(d.dealSize ?? d.amount), dealDate ?? asOf);
  const stage = mapStage(asString(d.dealType) ?? asString(d.series));
  if (stage) push("funding.round.stage", stage, dealDate ?? asOf);
  push("funding.round.post_money", usd(d.postValuation ?? d.postMoneyValuation), dealDate ?? asOf);
  for (const inv of pb.investors ?? []) push("funding.investor", asString(inv.investorName) ?? asString(inv.name), null);

  return {
    evidence: {
      kind: "api_record", source: "pitchbook", uri: `pitchbook:company:${pb.pbId}`, title: `PitchBook: ${name}`,
      content: JSON.stringify(pb, null, 2), mimeType: "application/json", accessScope: "vendor", occurredAt: fetchedAt,
    },
    subject: {
      type: "company", name, domain, location, source: "pitchbook", externalIds: [{ kind: "pitchbook", value: pb.pbId }],
    },
    claims,
    sourceType: "third_party",
  };
}

export async function pitchbookByDomain(domain: string, fetchImpl?: FetchLike): Promise<SourceRecord> {
  const d = normalizeDomain(domain);
  if (!d) throw new Error(`Not a domain: ${domain}`);
  const get = <T>(p: string) => requestJson<T>("pitchbook", `${PITCHBOOK}${p}`, { headers: headers(), fetchImpl });
  const search = await get<unknown>(PITCHBOOK_PATHS.search(d));
  const items = asArray(Array.isArray(search) ? search : (pick(search, "items") ?? pick(search, "companies")));
  const pbId = asString(items[0]?.companyId) ?? asString(items[0]?.pbId) ?? asString(items[0]?.id);
  if (!pbId) throw new Error(`PitchBook has no company for ${d}`);
  const bio = await get<Record<string, unknown>>(PITCHBOOK_PATHS.bio(pbId));
  const lastDeal = await get<Record<string, unknown>>(PITCHBOOK_PATHS.lastDeal(pbId)).catch(() => undefined);
  const investors = await get<unknown>(PITCHBOOK_PATHS.investors(pbId))
    .then((r) => asArray(Array.isArray(r) ? r : pick(r, "investors")))
    .catch(() => []);
  return pitchbookToRecord({ pbId, bio, lastDeal, investors });
}

export async function pitchbookCheck(fetchImpl?: FetchLike): Promise<string> {
  await requestJson("pitchbook", `${PITCHBOOK}${PITCHBOOK_PATHS.search("pitchbook.com")}`, { headers: headers(), fetchImpl });
  return "key accepted";
}

export const pitchbookConfigured = () => Boolean(config.pitchbookApiKey);
