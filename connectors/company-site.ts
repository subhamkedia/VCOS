import { normalizeDomain } from "../lib/text.js";
import { htmlToText } from "./web.js";
import { politeGet, type PoliteOptions } from "./polite.js";
import type { CompanyRef } from "./research.js";
import type { SourceRecord, StructuredClaim } from "./types.js";

/**
 * The company's own website: the home page plus the pages that say the most
 * in diligence (about, team, customers, product, technology, careers,
 * press). Each page is public evidence the extractor reads; what the
 * company says about itself is self-reported, so it never outranks a filing
 * or an independent source.
 */

const USEFUL = /\b(about|company|team|leadership|people|founders|customers?|case-stud|clients|partners|product|platform|technology|solutions?|how-it-works|careers|jobs|press|news|newsroom|investors?)\b/i;

/** Same-site links worth reading, most useful first. Pure. */
export function usefulLinks(html: string, pageUrl: string, limit = 7): string[] {
  const base = new URL(pageUrl);
  const site = normalizeDomain(base.hostname);
  const seen = new Set<string>([base.origin + base.pathname.replace(/\/$/, "")]);
  const out: { url: string; rank: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!, base);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || normalizeDomain(u.hostname) !== site) continue;
    if (/\.(pdf|png|jpe?g|gif|svg|zip|mp4)$/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/$/, "");
    if (seen.has(key)) continue;
    const text = htmlToText(m[2]!).text;
    const hit = `${u.pathname} ${text}`.match(USEFUL);
    if (!hit) continue;
    seen.add(key);
    // Shallow pages first: /about beats /blog/2024/05/about-our-intern.
    out.push({ url: key, rank: u.pathname.split("/").filter(Boolean).length });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit).map((x) => x.url);
}

function metaDescription(html: string): string | undefined {
  const m = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']{20,400})["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']{20,400})["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i);
  return m ? htmlToText(m[1]!).text : undefined;
}

function pageRecord(company: CompanyRef, url: string, html: string, home: boolean): SourceRecord | null {
  const { title, text } = htmlToText(html);
  const description = home ? metaDescription(html) : undefined;
  const content = [description ? `Site description: ${description}` : null, text].filter(Boolean).join("\n\n");
  if (content.length < 80) return null;
  const claims: StructuredClaim[] = [];
  if (home && company.domain) claims.push({ predicate: "company.website", value: normalizeDomain(company.domain)!, confidence: 0.95 });
  if (description) claims.push({ predicate: "company.description", value: description, citedText: `Site description: ${description}`, confidence: 0.7 });
  return {
    evidence: {
      kind: "web_page", source: "company-site", uri: url, title: title ?? url, content, accessScope: "public",
      occurredAt: new Date().toISOString(), metadata: { domain: normalizeDomain(url) },
    },
    subject: { type: "company", name: company.name, domain: company.domain, source: "company-site" },
    claims,
    sourceType: "self_reported",
    extract: true,
  };
}

/** Read the company's site. Pages robots.txt disallows, or that fail, are skipped. */
export async function companySite(company: CompanyRef, opts: PoliteOptions & { maxPages?: number } = {}): Promise<SourceRecord[]> {
  if (!company.domain) throw new Error(`No website on record for ${company.name}. Add its domain first.`);
  const shared = { ...opts, robotsCache: opts.robotsCache ?? new Map() };
  const home = `https://${normalizeDomain(company.domain)}/`;
  const res = await politeGet(home, shared);
  const html = await res.text();
  const out: SourceRecord[] = [];
  const first = pageRecord(company, res.url || home, html, true);
  if (first) out.push(first);
  for (const url of usefulLinks(html, res.url || home, (opts.maxPages ?? 8) - 1)) {
    try {
      const page = await politeGet(url, shared);
      const rec = pageRecord(company, url, await page.text(), false);
      if (rec) out.push(rec);
    } catch {
      // A page that fails or is disallowed is simply not read.
    }
  }
  if (!out.length) throw new Error(`${company.domain} has almost no readable text (it may be built with JavaScript).`);
  return out;
}
