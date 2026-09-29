import { fetchPublic, type Resolver } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * Reading other people's websites politely: public addresses only (the SSRF
 * guard in http.ts), robots.txt respected, an honest User-Agent, and a
 * small page budget per run.
 */

export const USER_AGENT = "VC-OS-reader/0.1 (+reads public pages for investment research; respects robots.txt)";

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
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && ("vc-os-reader".startsWith(a) || "vc-os-portfolio-reader".startsWith(a))));
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


export interface PoliteOptions {
  fetchImpl?: FetchLike;
  resolve?: Resolver;
  /** robots.txt per origin, shared across calls in one run. */
  robotsCache?: Map<string, string | null>;
}

/** GET a public page if the site's robots.txt allows it. Throws with a readable reason otherwise. */
export async function politeGet(url: string, opts: PoliteOptions = {}): Promise<Response> {
  const u = new URL(url);
  const headers = { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" };
  const cache = opts.robotsCache ?? new Map<string, string | null>();
  if (!cache.has(u.origin)) {
    const robots = await fetchPublic(u.hostname, `${u.origin}/robots.txt`, { headers, fetchImpl: opts.fetchImpl, resolve: opts.resolve }).catch((err: Error) => {
      if (/public internet|http\(s\)|user name/.test(err.message)) throw err;
      return null; // no robots.txt: allowed
    });
    cache.set(u.origin, robots ? await robots.text() : null);
  }
  const rules = cache.get(u.origin);
  if (rules && !robotsAllows(rules, u.pathname + u.search)) {
    throw new Error(`${u.hostname}'s robots.txt asks readers not to fetch ${u.pathname}.`);
  }
  return fetchPublic(u.hostname, url, { headers, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
}
