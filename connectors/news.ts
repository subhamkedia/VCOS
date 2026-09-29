import { normalizeDomain } from "../lib/text.js";
import { asArray, asString, requestJson } from "./http.js";
import { htmlToText } from "./web.js";
import { politeGet, type PoliteOptions } from "./polite.js";
import type { CompanyRef } from "./research.js";
import type { SourceRecord } from "./types.js";

/**
 * News coverage through the GDELT DOC 2.0 API (free, no key): articles from
 * the last three months that name the company as an exact phrase. The
 * newest few are read in full (robots.txt respected); the extractor treats
 * press as third-party. A one-word name ("Kestrel") is too ambiguous on its
 * own, so for those an article must also mention the company's domain or a
 * founder.
 */

const API = "https://api.gdeltproject.org/api/v2/doc/doc";

export interface Article {
  url: string;
  title: string;
  seenAt?: string;
  outlet?: string;
}

/** Parse GDELT's artlist JSON. Pure. */
export function parseArticles(json: unknown): Article[] {
  return asArray((json as { articles?: unknown })?.articles).flatMap((a) => {
    const url = asString(a.url);
    const title = asString(a.title);
    if (!url || !title) return [];
    const s = asString(a.seendate); // 20260912T140000Z
    const seenAt = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)?.slice(1);
    return [{ url, title, outlet: asString(a.domain), seenAt: seenAt ? `${seenAt[0]}-${seenAt[1]}-${seenAt[2]}T${seenAt[3]}:${seenAt[4]}:${seenAt[5]}Z` : undefined }];
  });
}

/** Does this text plausibly talk about this company (not a namesake)? Pure. */
export function mentionsCompany(company: CompanyRef & { founders?: string[] }, text: string): boolean {
  const t = text.toLowerCase();
  const name = company.name.toLowerCase();
  if (!t.includes(name)) return false;
  if (name.split(/\s+/).length >= 2) return true;
  const domain = normalizeDomain(company.domain ?? undefined);
  return Boolean((domain && t.includes(domain)) || company.founders?.some((f) => f.length > 3 && t.includes(f.toLowerCase())));
}

export async function newsArticles(company: CompanyRef, opts: { fetchImpl?: PoliteOptions["fetchImpl"]; max?: number } = {}): Promise<Article[]> {
  const q = new URLSearchParams({ query: `"${company.name.replace(/"/g, "")}"`, mode: "artlist", format: "json", maxrecords: String(opts.max ?? 50), sort: "datedesc" });
  return parseArticles(await requestJson("gdelt", `${API}?${q}`, { fetchImpl: opts.fetchImpl }));
}

export async function companyNews(
  company: CompanyRef & { founders?: string[] },
  opts: PoliteOptions & { read?: number } = {},
): Promise<SourceRecord[]> {
  const articles = await newsArticles(company, { fetchImpl: opts.fetchImpl });
  const out: SourceRecord[] = [];
  const shared = { ...opts, robotsCache: opts.robotsCache ?? new Map() };
  for (const a of articles.slice(0, opts.read ?? 8)) {
    let text: string | null = null;
    try {
      text = htmlToText(await (await politeGet(a.url, shared)).text()).text;
    } catch {
      // Paywalled, blocked or gone: keep the headline only.
    }
    const content = text && text.length > 200 ? `${a.title}\n\n${text}` : `${a.title}\n${a.outlet ?? ""} ${a.seenAt?.slice(0, 10) ?? ""}`.trim();
    if (!mentionsCompany(company, content)) continue;
    out.push({
      evidence: {
        kind: "web_page", source: "news", uri: a.url, title: a.title, content, accessScope: "public",
        occurredAt: a.seenAt, metadata: { outlet: a.outlet ?? null, headlineOnly: !text },
      },
      subject: { type: "company", name: company.name, domain: company.domain, source: "news" },
      extract: true,
    });
  }
  return out;
}
