import { normalizeDomain } from "../lib/text.js";
import { fetchPublic, type Resolver } from "./http.js";
import type { FetchLike, SourceRecord } from "./types.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Readable text from HTML: drops scripts, styles and nav chrome, keeps paragraph breaks. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? htmlToText(title).text : null, text };
}

/**
 * Snapshot a public web page as Evidence. If `company` is given, the page is
 * about that company and the extractor runs on it. Whether it counts as
 * self-reported (their own site) or third-party (press) is decided per claim
 * by the extractor.
 */
export async function fetchWebPage(
  url: string,
  opts: { company?: string; companyDomain?: string; fetchImpl?: FetchLike; resolve?: Resolver } = {},
): Promise<SourceRecord> {
  // Public addresses only, checked again at every redirect: a person types this URL into the app.
  const res = await fetchPublic("The page", url, {
    headers: { "User-Agent": "VC-OS research bot (contact in SEC_USER_AGENT)", Accept: "text/html,*/*" },
    fetchImpl: opts.fetchImpl, resolve: opts.resolve,
  });
  const html = await res.text();
  const { title, text } = htmlToText(html);
  if (text.length < 40) throw new Error(`Page at ${url} has almost no text (is it rendered by JavaScript?)`);
  const pageDomain = normalizeDomain(url);
  // Never infer the company's domain from the page URL: a TechCrunch article
  // about Acme is not acme's domain. Only use one the caller states.
  const domain = opts.companyDomain;
  return {
    evidence: {
      kind: "web_page", source: "web", uri: url, title: title ?? url, content: text, accessScope: "public",
      occurredAt: new Date().toISOString(), metadata: { domain: pageDomain, fetchedAt: new Date().toISOString() },
    },
    subject: opts.company ? { type: "company", name: opts.company, domain, source: "web" } : undefined,
    extract: Boolean(opts.company),
  };
}
