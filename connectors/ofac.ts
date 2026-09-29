import { parseCsv } from "../lib/csv.js";
import { jaroWinkler, normalizeCompanyName } from "../lib/text.js";
import { request } from "./http.js";
import type { FetchLike } from "./types.js";

/**
 * Sanctions screening against the US Treasury's OFAC lists: the SDN list
 * and the Consolidated (non-SDN) list, with their aliases, downloaded from
 * OFAC's Sanctions List Service (free, no key; a User-Agent is required).
 *
 * The Sanctions List Service publishes files, not a screening API, so
 * matching is done here: exact and word-order-insensitive name matches,
 * plus close spellings (Jaro-Winkler 0.93 and up). Anything it finds is a
 * *potential* match for a person to clear or escalate; it never clears a
 * name on its own if a close match exists.
 */

const BASE = "https://sanctionslistservice.ofac.treas.gov/api/download";
const FILES = [
  { file: "SDN.CSV", list: "SDN" as const, alias: "ALT.CSV" },
  { file: "CONS_PRIM.CSV", list: "Consolidated" as const, alias: "CONS_ALT.CSV" },
];

export interface SanctionsEntry {
  id: string;
  list: "SDN" | "Consolidated";
  name: string;
  type: string;
  program: string;
  aliases: string[];
}

export interface SanctionsHit {
  entry: SanctionsEntry;
  matchedName: string;
  score: number;
  how: "exact" | "same words" | "close spelling";
}

const clean = (v: string | undefined) => (v && v !== "-0-" ? v.trim() : "");

/** Parse SDN.CSV / CONS_PRIM.CSV plus their alias files. Pure. */
export function parseSanctions(list: SanctionsEntry["list"], primary: string, aliases: string): SanctionsEntry[] {
  const alt = new Map<string, string[]>();
  for (const r of parseCsv(aliases)) {
    const id = clean(r[0]);
    const name = clean(r[3]);
    if (id && name) alt.set(id, [...(alt.get(id) ?? []), name]);
  }
  return parseCsv(primary).flatMap((r) => {
    const id = clean(r[0]);
    const name = clean(r[1]);
    if (!id || !name) return [];
    return [{ id, list, name, type: clean(r[2]) || "entity", program: clean(r[3]), aliases: alt.get(id) ?? [] }];
  });
}

/** Lowercase words, legal suffixes dropped, for comparing names in any order ("DOE, John" = "John Doe"). */
export function nameKey(name: string): { flat: string; words: string } {
  const flat = normalizeCompanyName(name.replace(/,/g, " "));
  return { flat, words: flat.split(" ").filter(Boolean).sort().join(" ") };
}

/** Screen names against the lists. Pure. */
export function screen(names: string[], entries: SanctionsEntry[], threshold = 0.93): { name: string; hits: SanctionsHit[] }[] {
  const index = entries.flatMap((e) => [e.name, ...e.aliases].map((n) => ({ e, n, k: nameKey(n) })));
  return names.filter((n) => n.trim()).map((name) => {
    const k = nameKey(name);
    const hits = new Map<string, SanctionsHit>();
    for (const x of index) {
      if (!x.k.flat || !k.flat) continue;
      let hit: SanctionsHit | null = null;
      if (x.k.flat === k.flat) hit = { entry: x.e, matchedName: x.n, score: 1, how: "exact" };
      else if (x.k.words === k.words) hit = { entry: x.e, matchedName: x.n, score: 0.99, how: "same words" };
      else if (Math.abs(x.k.words.length - k.words.length) <= 4) {
        const score = jaroWinkler(x.k.words, k.words);
        if (score >= threshold) hit = { entry: x.e, matchedName: x.n, score, how: "close spelling" };
      }
      if (hit && (!hits.has(x.e.id) || hits.get(x.e.id)!.score < hit.score)) hits.set(x.e.id, hit);
    }
    return { name, hits: [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 10) };
  });
}

let cache: { at: number; entries: SanctionsEntry[] } | null = null;

/** The current lists, downloaded at most every 12 hours per server process. */
export async function sanctionsLists(opts: { fetchImpl?: FetchLike; userAgent?: string } = {}): Promise<{ entries: SanctionsEntry[]; fetchedAt: string }> {
  if (cache && Date.now() - cache.at < 12 * 3_600_000 && !opts.fetchImpl) return { entries: cache.entries, fetchedAt: new Date(cache.at).toISOString() };
  const headers = { "User-Agent": opts.userAgent ?? "VC-OS sanctions screening (contact: see SEC_USER_AGENT)", Accept: "text/csv" };
  const entries: SanctionsEntry[] = [];
  for (const f of FILES) {
    const primary = await (await request("ofac", `${BASE}/${f.file}`, { headers, fetchImpl: opts.fetchImpl })).text();
    const alias = await (await request("ofac", `${BASE}/${f.alias}`, { headers, fetchImpl: opts.fetchImpl })).text().catch(() => "");
    entries.push(...parseSanctions(f.list, primary, alias));
  }
  if (!entries.length) throw new Error("OFAC returned empty lists; try again later.");
  if (!opts.fetchImpl) cache = { at: Date.now(), entries };
  return { entries, fetchedAt: new Date().toISOString() };
}

export async function ofacCheck(fetchImpl?: FetchLike): Promise<string> {
  const { entries } = await sanctionsLists({ fetchImpl });
  return `${entries.length.toLocaleString("en-US")} entries on the SDN and Consolidated lists`;
}
