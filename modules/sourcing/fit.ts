import type { ClaimRow } from "../../ledger/contradictions.js";
import type { FirmProfile } from "../firm/profile.js";
import { ENUM_VALUE_LABELS } from "../../ledger/labels.js";

/**
 * Thesis fit, v0: a transparent first pass that compares what the ledger
 * knows about a company with the firm's mandate. Deterministic code, no
 * model: sector keywords in the description, headquarters against target
 * geographies, last round against target stages, and exclusions as a hard
 * filter. Every reason names the claims it used; missing facts count as
 * "unknown" (half credit), never as a pass.
 *
 * It sorts the pile. The weighted dimensions in the profile (team, moat,
 * GTM...) need evidence and judgment and are scored later with citations.
 */
export const FIT_VERSION = "keyword-fit@0.1";

export type Result = "pass" | "fail" | "unknown";

export interface FitReason {
  criterion: "sector" | "geography" | "stage" | "exclusion";
  result: Result;
  detail: string;
  claimIds: string[];
}

export interface Fit {
  score: number; // 0-100
  verdict: "strong" | "possible" | "weak" | "excluded";
  sectors: string[];
  reasons: FitReason[];
  method: string;
}

const WEIGHTS = { sector: 0.5, geography: 0.25, stage: 0.25 } as const;

// Names a location string may use for a target geography. Unlisted geographies match on their own name.
const GEO_ALIASES: Record<string, string[]> = {
  us: ["united states", "usa", "u.s.", "us"],
  "united states": ["united states", "usa", "u.s.", "us"],
  uk: ["united kingdom", "uk", "england", "scotland", "wales", "london"],
  "united kingdom": ["united kingdom", "uk", "england", "scotland", "wales", "london"],
  canada: ["canada", "toronto", "montreal", "vancouver", "ontario", "quebec", "british columbia"],
  europe: [
    "europe", "united kingdom", "uk", "england", "germany", "france", "netherlands", "sweden", "denmark", "norway", "finland",
    "spain", "italy", "portugal", "switzerland", "austria", "belgium", "ireland", "poland", "estonia", "czech", "lithuania",
    "latvia", "greece", "romania", "hungary", "berlin", "paris", "london", "amsterdam", "stockholm", "munich", "zurich",
  ],
  india: ["india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai"],
  israel: ["israel", "tel aviv"],
  latam: ["mexico", "brazil", "argentina", "chile", "colombia", "peru", "latin america"],
};

// US state codes and names, so "Pittsburgh, PA" counts as US.
const US_STATES = new Set(
  "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc"
    .split(" "),
);

/**
 * A light stemmer, so "robots", "robotic" and "robotics" meet, as do
 * "autonomous" and "autonomy". Short words are left alone ("AI", "BIM").
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (let i = 0; i < 2 && w.length > 4; i++) {
    const s = w.replace(/(ations?|ions?|ics|ic|ous|ies|ing|ers?|ed|es|s|y)$/, "");
    if (s.length < 4 || s === w) break;
    w = s;
  }
  return w;
}

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9.+]+/g, " ").trim().split(" ").map(stem).join(" ")} `;
const has = (hay: string, needle: string) => words(hay).includes(words(needle));

export function geographyMatches(location: string, geography: string): boolean {
  const g = geography.trim().toLowerCase();
  const aliases = GEO_ALIASES[g] ?? [g];
  if (aliases.some((a) => has(location, a))) return true;
  if (aliases.includes("united states")) {
    const parts = location.split(",").map((p) => p.trim().toLowerCase());
    return parts.slice(1).some((p) => US_STATES.has(p));
  }
  return false;
}

const byPred = (claims: ClaimRow[], p: string) => claims.filter((c) => c.predicate === p);
const strOf = (c: ClaimRow) => (typeof c.value === "string" ? c.value : JSON.stringify(c.value));

export function thesisFit(profile: FirmProfile, claims: ClaimRow[]): Fit {
  const reasons: FitReason[] = [];
  const text = [...byPred(claims, "company.description"), ...byPred(claims, "company.sector")];

  // Exclusions first: a hard filter.
  for (const ex of profile.mandate.exclusions) {
    const hit = text.find((c) => has(strOf(c), ex));
    if (hit) reasons.push({ criterion: "exclusion", result: "fail", detail: `Matches exclusion "${ex}"`, claimIds: [hit.id] });
  }

  // Sector: keywords in the description.
  const matched: { id: string; label: string; priority: string; keyword: string; claimId: string }[] = [];
  for (const s of profile.mandate.sectors) {
    for (const k of s.keywords) {
      const c = text.find((x) => has(strOf(x), k));
      if (c) {
        matched.push({ id: s.id, label: s.label, priority: s.priority, keyword: k, claimId: c.id });
        break;
      }
    }
  }
  let sectorScore: number;
  if (!text.length) {
    sectorScore = 0.5;
    reasons.push({ criterion: "sector", result: "unknown", detail: "No description in the ledger yet", claimIds: [] });
  } else if (matched.length) {
    sectorScore = matched.some((m) => m.priority === "core") ? 1 : 0.6;
    reasons.push({
      criterion: "sector", result: "pass",
      detail: matched.map((m) => `${m.label} ("${m.keyword}")`).join(", "),
      claimIds: [...new Set(matched.map((m) => m.claimId))],
    });
  } else {
    sectorScore = 0;
    reasons.push({ criterion: "sector", result: "fail", detail: "No sector keyword in the description", claimIds: text.map((c) => c.id) });
  }

  // Geography: headquarters.
  const hq = byPred(claims, "company.hq_location");
  let geoScore: number;
  if (!hq.length) {
    geoScore = 0.5;
    reasons.push({ criterion: "geography", result: "unknown", detail: "Headquarters unknown", claimIds: [] });
  } else {
    const inGeo = hq.find((c) => profile.mandate.geographies.some((g) => geographyMatches(strOf(c), g)));
    geoScore = inGeo ? 1 : 0;
    reasons.push({
      criterion: "geography", result: inGeo ? "pass" : "fail",
      detail: inGeo ? `Headquartered in ${strOf(inGeo)}` : `${strOf(hq[0]!)} is outside ${profile.mandate.geographies.join(", ")}`,
      claimIds: inGeo ? [inGeo.id] : hq.map((c) => c.id),
    });
  }

  // Stage: most recent round.
  const stage = byPred(claims, "funding.round.stage").sort((a, b) => String(b.as_of ?? "").localeCompare(String(a.as_of ?? "")))[0];
  let stageScore: number;
  if (!stage) {
    stageScore = 0.5;
    reasons.push({ criterion: "stage", result: "unknown", detail: "No funding round in the ledger", claimIds: [] });
  } else {
    const ok = (profile.mandate.stages as string[]).includes(String(stage.value));
    stageScore = ok ? 1 : 0;
    reasons.push({ criterion: "stage", result: ok ? "pass" : "fail", detail: `Last round: ${ENUM_VALUE_LABELS[String(stage.value)] ?? String(stage.value).replace(/_/g, " ")}`, claimIds: [stage.id] });
  }

  const score = Math.round(100 * (WEIGHTS.sector * sectorScore + WEIGHTS.geography * geoScore + WEIGHTS.stage * stageScore));
  const excluded = reasons.some((r) => r.criterion === "exclusion");
  const verdict: Fit["verdict"] = excluded ? "excluded" : sectorScore === 0 ? "weak" : score >= 75 ? "strong" : score >= 50 ? "possible" : "weak";
  return { score: excluded ? 0 : score, verdict, sectors: [...new Set(matched.map((m) => m.id))], reasons, method: FIT_VERSION };
}
