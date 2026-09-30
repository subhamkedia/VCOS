import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const LEGAL_SUFFIXES = [
  "incorporated", "inc", "corporation", "corp", "company", "co", "llc", "l l c",
  "ltd", "limited", "gmbh", "ag", "sa", "sas", "bv", "plc", "pbc", "holdings",
];

// Generic tail words. Dropped only for the "core" form, because
// "Acme AI" and "Acme Robotics" can be different companies.
const GENERIC_TAILS = [
  "labs", "lab", "technologies", "technology", "tech", "ai", "robotics",
  "systems", "software", "solutions", "industries", "group", "hq", "io",
];

function stripTail(s: string, words: string[]): string {
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of words) {
      if (s.endsWith(" " + w) && s.length > w.length + 1) {
        s = s.slice(0, -(w.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Normalize a company name: lowercase, strip accents, punctuation and
 * legal suffixes. "Acme Robotics, Inc." -> "acme robotics"
 */
export function normalizeCompanyName(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Collapse dotted abbreviations: "s.a." -> "sa", "l.l.c." -> "llc".
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripTail(s, LEGAL_SUFFIXES).replace(/^the /, "");
}

/** Core name for blocking: also drops generic tails. "Acme Robotics, Inc." -> "acme" */
export function coreCompanyName(name: string): string {
  return stripTail(normalizeCompanyName(name), [...LEGAL_SUFFIXES, ...GENERIC_TAILS]);
}

/** "https://www.Acme.io/about?x=1" -> "acme.io". Returns null if not a domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@").pop() ?? "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/:\d+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Canonical LinkedIn company/person slug: "linkedin.com/company/acme-robotics/" -> "company/acme-robotics". */
export function normalizeLinkedIn(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\/+$/, "");
  // Already normalized ("company/acme"): return as is, so this is idempotent.
  if (/^(company|in|school)\/[^/?#\s]+$/.test(s)) return s;
  const m = s.match(/linkedin\.com\/(company|in|school)\/([^/?#]+)/);
  return m ? `${m[1]}/${decodeURIComponent(m[2] ?? "")}` : null;
}

/** Jaro-Winkler similarity in [0,1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token-set Jaccard on whitespace tokens. */
export function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Normalize a person's name: "Dr. Jane  Q. Doe, PhD" -> "jane q doe". */
export function normalizePersonName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof|phd|mba|jr|sr|ii|iii)\b\.?/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A calendar date as people write it: "September 13, 2026". Pure. */
export const longDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
