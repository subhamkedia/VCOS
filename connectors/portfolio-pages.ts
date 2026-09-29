import { normalizeDomain } from "../lib/text.js";
import { fetchPublic, type Resolver } from "./http.js";
import { htmlToText } from "./web.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Portfolio and cohort pages of accelerators, incubators, venture studios,
 * VCs, CVCs and university programs. A firm adds a page; each run reads the
 * companies listed on it, so new cohorts and new investments show up in
 * Sourcing.
 *
 * How a page is read:
 * - robots.txt is checked first; a page it disallows is skipped with a
 *   clear message. Requests identify themselves and go one at a time.
 * - Companies are the page's outbound links to company homepages: links to
 *   the organization's own site, social networks, news, app stores and
 *   databases are ignored, as are deep links (articles, not homepages).
 *   Names come from the link text or logo alt text, else the domain.
 * - Structured data (schema.org JSON-LD) is used when the page has it.
 *
 * Pages that build their list with JavaScript come back empty; the error
 * says so. Each company is its own small piece of public evidence, so a
 * re-run finds nothing new unless the listing changed.
 */

export const ORG_TYPES = [
  { id: "accelerator", label: "Accelerator" },
  { id: "incubator", label: "Incubator" },
  { id: "venture_studio", label: "Venture studio" },
  { id: "vc", label: "Venture capital firm" },
  { id: "cvc", label: "Corporate VC" },
  { id: "university", label: "University program" },
  { id: "angel_network", label: "Angel network" },
  { id: "other", label: "Other" },
] as const;

export type OrgType = (typeof ORG_TYPES)[number]["id"];
const INVESTOR_TYPES: OrgType[] = ["vc", "cvc", "angel_network"];

export const USER_AGENT = "VC-OS-portfolio-reader/0.1 (+reads public portfolio pages once per schedule)";

// Links to these are never portfolio companies.
const IGNORED_DOMAINS = [
  "twitter.com", "x.com", "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be", "tiktok.com", "threads.net",
  "medium.com", "substack.com", "github.com", "gitlab.com", "apple.com", "google.com", "goo.gl", "g.co", "bit.ly", "t.co", "lnkd.in",
  "crunchbase.com", "pitchbook.com", "angel.co", "wellfound.com", "dealroom.co", "cbinsights.com", "tracxn.com", "f6s.com",
  "wikipedia.org", "techcrunch.com", "forbes.com", "bloomberg.com", "businessinsider.com", "cnbc.com", "reuters.com", "wsj.com",
  "nytimes.com", "ft.com", "venturebeat.com", "vimeo.com", "spotify.com", "soundcloud.com", "calendly.com", "typeform.com",
  "hubspot.com", "mailchimp.com", "eventbrite.com", "zoom.us", "notion.so", "notion.site", "wordpress.com", "wix.com", "squarespace.com",
  "webflow.io", "cloudflare.com", "gstatic.com", "googleapis.com", "cdn.jsdelivr.net", "unpkg.com", "w3.org", "schema.org",
  "ycombinator.com", "producthunt.com", "play.google.com", "apps.apple.com", "discord.gg", "discord.com", "slack.com", "whatsapp.com",
];

const GENERIC_TEXT = /^(visit( website| site)?|website|learn more|read more|more|details|view|see more|link|here|click here|→|↗|›|»|homepage|home|site)$/i;

export interface ListedCompany {
  name: string;
  domain: string;
  url: string;
  description?: string;
}

/** Registrable domain, near enough: the last two labels, or three under a two-letter country code with a short second level. */
export function siteOf(domain: string): string {
  const parts = domain.split(".");
  if (parts.length > 2 && parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

const ignored = (domain: string) => IGNORED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));

const stripTags = (s: string) => htmlToText(s).text.replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"))?.slice(2).find((x) => x !== undefined);

function cleanName(raw: string | undefined): string | undefined {
  const n = (raw ?? "").replace(/\b(logo|company logo|icon)\b/gi, "").replace(/[→↗›»↘➔]/g, " ").replace(/\s+/g, " ").replace(/^[\s|·–-]+|[\s|·–-]+$/g, "").trim();
  if (!n || n.length > 80 || GENERIC_TEXT.test(n)) return undefined;
  return n;
}

const nameFromDomain = (d: string) => {
  const label = d.split(".")[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Companies listed on a portfolio page. Pure: works on saved HTML. */
export function extractPortfolio(html: string, pageUrl: string): ListedCompany[] {
  const page = new URL(pageUrl);
  const home = siteOf(normalizeDomain(page.hostname) ?? page.hostname);
  const found = new Map<string, ListedCompany>();
  const add = (href: string | undefined, name: string | undefined, description?: string) => {
    if (!href) return;
    let u: URL;
    try {
      u = new URL(href, page);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    const domain = normalizeDomain(u.hostname);
    if (!domain || siteOf(domain) === home || ignored(domain)) return;
    // Homepages, not articles: at most one path segment.
    if (u.pathname.split("/").filter(Boolean).length > 1) return;
    const clean = cleanName(name);
    const prev = found.get(domain);
    const betterName = Boolean(clean) && (!prev || prev.name === nameFromDomain(domain));
    if (!prev || betterName) {
      found.set(domain, { name: clean ?? prev?.name ?? nameFromDomain(domain), domain, url: `${u.protocol}//${u.hostname}${u.pathname === "/" ? "" : u.pathname}`, description: description ?? prev?.description });
    }
  };

  // schema.org JSON-LD: Organization items or ItemLists of them.
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) return x.forEach(walk);
        if (!x || typeof x !== "object") return;
        const o = x as Record<string, unknown>;
        if (typeof o.url === "string" && typeof o.name === "string" && /Organization|Corporation/i.test(String(o["@type"] ?? ""))) {
          add(o.url, o.name, typeof o.description === "string" ? o.description : undefined);
        }
        for (const k of ["itemListElement", "item", "@graph", "member", "subOrganization"]) if (o[k]) walk(o[k]);
      };
      walk(JSON.parse(m[1]!));
    } catch {
      // malformed JSON-LD: fall back to links
    }
  }

  // Drop navigation, header and footer, where links are about the organization itself.
  const body = html.replace(/<(nav|header|footer|script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const open = m[1]!;
    const inner = m[2]!;
    const img = inner.match(/<img\b[^>]*>/i)?.[0];
    const name = cleanName(stripTags(inner)) ?? cleanName(attr(open, "aria-label")) ?? cleanName(attr(open, "title")) ?? cleanName(img ? attr(img, "alt") : undefined);
    add(attr(open, "href"), name);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** Is `path` allowed for us? Reads the `*` group and any group naming VC-OS; longest match wins, Allow breaks ties. */
export function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === "allow" || key === "disallow") && value) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "vc-os-portfolio-reader".startsWith(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  const matches = (rule: string) => {
    const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return re.test(path);
  };
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (!matches(r.path)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

export async function fetchPortfolioPage(
  url: string,
  opts: { fetchImpl?: FetchLike; resolve?: Resolver } = {},
): Promise<{ html: string; companies: ListedCompany[] }> {
  const u = new URL(url);
  const headers = { "User-Agent": USER_AGENT, Accept: "text/html,*/*" };
  const robots = await fetchPublic(u.hostname, `${u.origin}/robots.txt`, { headers, ...opts }).catch((err: Error) => {
    if (/public internet|http\(s\)|user name/.test(err.message)) throw err;
    return null; // no robots.txt: allowed
  });
  if (robots && !robotsAllows(await robots.text(), u.pathname + u.search)) {
    throw new Error(`${u.hostname}'s robots.txt asks readers not to fetch ${u.pathname}. Pick another page or ask them for a list.`);
  }
  const res = await fetchPublic(u.hostname, url, { headers, ...opts });
  const html = await res.text();
  const companies = extractPortfolio(html, url);
  if (!companies.length) {
    const text = htmlToText(html).text;
    throw new Error(
      text.length < 400
        ? `${u.hostname} builds its portfolio list with JavaScript, which can't be read yet. Try a plain-HTML page, such as a cohort announcement.`
        : `No company links found on ${url}. Check that it's the page listing their portfolio.`,
    );
  }
  return { html, companies };
}

export interface PortfolioSite {
  orgName: string;
  orgType: OrgType;
  url: string;
}

/** One company on the page, as public third-party evidence tying it to the organization. */
export function portfolioRecord(site: PortfolioSite, c: ListedCompany, fetchedAt = new Date().toISOString()): SourceRecord {
  const typeLabel = ORG_TYPES.find((t) => t.id === site.orgType)?.label ?? "Organization";
  const tie = INVESTOR_TYPES.includes(site.orgType) ? "funding.investor" : "company.program";
  const line = `${c.name} is listed on ${site.orgName}'s portfolio page.`;
  const content = [line, `Website: ${c.domain}`, c.description ? `Description: ${c.description}` : "", `Page: ${site.url}`, `${site.orgName} is a ${typeLabel.toLowerCase()}.`]
    .filter(Boolean).join("\n");
  const claims: StructuredClaim[] = [
    { predicate: "company.website", value: c.domain, asOf: fetchedAt.slice(0, 10), confidence: 0.75 },
    { predicate: tie, value: site.orgName, confidence: 0.8, citedText: line },
  ];
  if (c.description) claims.push({ predicate: "company.description", value: c.description, asOf: fetchedAt.slice(0, 10), confidence: 0.6 });
  return {
    evidence: {
      kind: "web_page", source: "portfolio-page", uri: site.url, title: `${site.orgName} portfolio: ${c.name}`, content,
      accessScope: "public", occurredAt: fetchedAt, metadata: { orgName: site.orgName, orgType: site.orgType, companyUrl: c.url },
    },
    subject: { type: "company", name: c.name, domain: c.domain, source: "portfolio-page" },
    claims,
    sourceType: "third_party",
  };
}

export async function discoverFromPortfolioPage(site: PortfolioSite, opts: { fetchImpl?: FetchLike; resolve?: Resolver } = {}): Promise<SourceRecord[]> {
  const { companies } = await fetchPortfolioPage(site.url, opts);
  const at = new Date().toISOString();
  return companies.map((c) => portfolioRecord(site, c, at));
}
