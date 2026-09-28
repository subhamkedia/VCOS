import { normalizeDomain } from "../lib/text.js";
import { asArray, asNumber, asString, request, requestJson } from "./http.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Y Combinator's public company directory. No key needed.
 *
 * - Company lists come from yc-oss (https://github.com/yc-oss/api), a daily
 *   JSON mirror of YC's own directory search index: one file per batch.
 * - Founder names come from each company's page on ycombinator.com, which
 *   embeds its data as JSON.
 * - "Launch HN" posts on Hacker News give real mentions of each company as
 *   the founders wrote them ("Launch HN: Acme (YC W26) – ...").
 *
 * Network access needed: yc-oss.github.io, www.ycombinator.com, hn.algolia.com.
 */

export const YC_OSS = "https://yc-oss.github.io/api";

export interface YcCompany {
  slug: string;
  name: string;
  formerNames: string[];
  website?: string;
  domain?: string;
  location?: string;
  oneLiner?: string;
  description?: string;
  batch: string; // "Winter 2026"
  teamSize?: number;
  status?: string;
  industries: string[];
  founders?: string[];
  url: string;
}

/** "Winter 2026" -> "winter-2026" (yc-oss file name); "W26" style codes too. */
export function batchSlug(batch: string): string {
  const code = batch.trim().match(/^([WSXF])(\d{2})$/i);
  if (code) {
    const season = { W: "winter", S: "summer", X: "spring", F: "fall" }[code[1]!.toUpperCase() as "W" | "S" | "X" | "F"];
    return `${season}-20${code[2]}`;
  }
  return batch.trim().toLowerCase().replace(/\s+/g, "-");
}

/** "Winter 2026" -> "W26", as it appears in "(YC W26)". */
export function batchCode(batch: string): string {
  const m = batch.trim().match(/^(winter|spring|summer|fall)[\s-]+(\d{4})$/i);
  if (!m) return batch;
  const letter = { winter: "W", spring: "X", summer: "S", fall: "F" }[m[1]!.toLowerCase() as "winter"];
  return `${letter}${m[2]!.slice(2)}`;
}

/** Map one yc-oss record. Pure. */
export function parseYcCompany(r: Record<string, unknown>): YcCompany | null {
  const slug = asString(r.slug);
  const name = asString(r.name);
  if (!slug || !name) return null;
  const website = asString(r.website);
  const formerNames = (Array.isArray(r.former_names) ? r.former_names : [])
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n && n.toLowerCase() !== name.toLowerCase());
  const loc = asString(r.all_locations)?.split(";")[0]?.trim();
  return {
    slug,
    name,
    formerNames,
    website,
    domain: normalizeDomain(website) ?? undefined,
    location: loc || undefined,
    oneLiner: asString(r.one_liner),
    description: asString(r.long_description),
    batch: asString(r.batch) ?? "",
    teamSize: asNumber(r.team_size),
    status: asString(r.status),
    industries: (Array.isArray(r.industries) ? r.industries : []).filter((x): x is string => typeof x === "string"),
    url: asString(r.url) ?? `https://www.ycombinator.com/companies/${slug}`,
  };
}

export async function fetchYcBatch(batch: string, fetchImpl?: FetchLike): Promise<YcCompany[]> {
  const rows = await requestJson<unknown[]>("yc-oss", `${YC_OSS}/batches/${batchSlug(batch)}.json`, { fetchImpl });
  return (Array.isArray(rows) ? rows : []).flatMap((r) => {
    const c = parseYcCompany(r as Record<string, unknown>);
    return c ? [c] : [];
  });
}

/** Every YC company ever (a few thousand records). Used to find real look-alike names. */
export async function fetchYcAll(fetchImpl?: FetchLike): Promise<YcCompany[]> {
  const rows = await requestJson<unknown[]>("yc-oss", `${YC_OSS}/companies/all.json`, { fetchImpl });
  return (Array.isArray(rows) ? rows : []).flatMap((r) => {
    const c = parseYcCompany(r as Record<string, unknown>);
    return c ? [c] : [];
  });
}

const HTML_ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'", "#x27": "'" };
const unescapeHtml = (s: string) => s.replace(/&(quot|amp|lt|gt|apos|#39|#x27);/g, (_, e: string) => HTML_ENTITIES[e]!);

/**
 * Founder names from a ycombinator.com company page. The page embeds its
 * props as HTML-escaped JSON in a `data-page` attribute; if that shape
 * changes, fall back to any "full_name" fields in the page.
 */
export function parseYcFounders(html: string): string[] {
  const attr = html.match(/data-page="([^"]+)"/)?.[1];
  if (attr) {
    try {
      const page = JSON.parse(unescapeHtml(attr)) as { props?: { company?: { founders?: { full_name?: string }[] } } };
      const names = (page.props?.company?.founders ?? []).map((f) => f.full_name?.trim()).filter((n): n is string => Boolean(n));
      if (names.length) return [...new Set(names)];
    } catch {
      // fall through to the loose scan
    }
  }
  const text = unescapeHtml(html);
  return [...new Set([...text.matchAll(/"full_name"\s*:\s*"([^"]{2,80})"/g)].map((m) => m[1]!.trim()))];
}

export async function fetchYcFounders(slug: string, fetchImpl?: FetchLike): Promise<string[]> {
  const res = await request("ycombinator.com", `https://www.ycombinator.com/companies/${encodeURIComponent(slug)}`, {
    fetchImpl,
    headers: { Accept: "text/html" },
  });
  return parseYcFounders(await res.text());
}

export interface LaunchPost {
  mention: string; // the company name as written in the post title
  batch: string; // "W26"
  title: string;
  url?: string;
  domain?: string;
  hnId: string;
  postedAt: string;
}

/** "Launch HN: Acme (YC W26) – Robots for X" -> mention "Acme", batch "W26". Pure. */
export function parseLaunchTitle(title: string): { mention: string; batch: string } | null {
  const m = title.match(/^(?:Launch|Show) HN:\s*(.+?)\s*\(\s*YC\s+([WSXF]\d{2})\s*\)/i);
  if (!m) return null;
  return { mention: m[1]!.trim(), batch: m[2]!.toUpperCase() };
}

/** Launch HN / Show HN posts that name a YC batch, via HN's public Algolia API. */
export async function fetchLaunchPosts(code: string, fetchImpl?: FetchLike): Promise<LaunchPost[]> {
  const out: LaunchPost[] = [];
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ query: `"(YC ${code})"`, tags: "story", hitsPerPage: "200", page: String(page) });
    const body = await requestJson<{ hits?: Record<string, unknown>[]; nbPages?: number }>(
      "hn.algolia.com", `https://hn.algolia.com/api/v1/search_by_date?${params}`, { fetchImpl },
    );
    for (const h of body.hits ?? []) {
      const title = asString(h.title);
      const parsed = title ? parseLaunchTitle(title) : null;
      if (!title || !parsed || parsed.batch !== code.toUpperCase()) continue;
      const url = asString(h.url);
      out.push({
        ...parsed, title, url, domain: normalizeDomain(url) ?? undefined,
        hnId: String(h.objectID ?? ""), postedAt: asString(h.created_at) ?? "",
      });
    }
    if (page + 1 >= (body.nbPages ?? 1)) break;
  }
  return out;
}

/** A YC directory record as ledger evidence: public, third-party. */
export function ycToRecord(c: YcCompany, fetchedAt = new Date().toISOString()): SourceRecord {
  const asOf = fetchedAt.slice(0, 10);
  const claims: StructuredClaim[] = [];
  // `null` = timeless (founders). Omitted = true as of the fetch.
  const push = (predicate: string, value: unknown, when: string | null = asOf) => {
    if (value !== undefined && value !== null && value !== "") claims.push({ predicate, value, asOf: when ?? undefined, confidence: 0.85 });
  };
  push("company.description", c.oneLiner);
  if (c.domain) push("company.website", c.domain);
  push("company.hq_location", c.location);
  push("team.headcount", c.teamSize);
  for (const f of c.founders ?? []) push("team.founder", f, null);
  // YC's industry tags stay in the evidence: company.sector holds thesis.yaml ids only.
  return {
    evidence: {
      kind: "api_record",
      source: "yc",
      uri: c.url,
      title: `YC directory: ${c.name} (${batchCode(c.batch)})`,
      content: JSON.stringify(c, null, 2),
      mimeType: "application/json",
      accessScope: "public",
      occurredAt: fetchedAt,
      metadata: { batch: c.batch, slug: c.slug },
    },
    subject: {
      type: "company", name: c.name, domain: c.domain, founders: c.founders, location: c.location, source: "yc",
    },
    claims,
    sourceType: "third_party",
  };
}
