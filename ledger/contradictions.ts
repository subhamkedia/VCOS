import { getPredicate, PILOT_LADDER, predicateLabel, type PredicateDef } from "./predicates.js";
import { ENUM_VALUE_LABELS, formatValue, sourceTypeLabel } from "./labels.js";

export type SourceType = "primary" | "third_party" | "self_reported" | "inference" | "internal";

export interface ClaimRow {
  id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  as_of: string | null;
  source_type: SourceType;
  evidence_id: string;
  cited_text: string | null;
}

export interface Conflict {
  predicate: string;
  claimIds: [string, string];
  severity: "low" | "medium" | "high";
  detail: string;
}

/** Default window: claims further apart than this are change over time, not contradiction. */
export const COMPARISON_WINDOW_DAYS = 120;

const INDEPENDENT: SourceType[] = ["primary", "third_party"];

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  return denom === 0 ? 0 : Math.abs(a - b) / denom;
}

function severityFor(a: ClaimRow, b: ClaimRow, magnitude: "small" | "large"): Conflict["severity"] {
  if (a.source_type === "inference" || b.source_type === "inference") return "low";
  const selfVsIndependent =
    (a.source_type === "self_reported" && INDEPENDENT.includes(b.source_type)) ||
    (b.source_type === "self_reported" && INDEPENDENT.includes(a.source_type));
  if (selfVsIndependent && magnitude === "large") return "high";
  return "medium";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Free-text values agree if one is a more specific form of the other:
 * "Pittsburgh, PA" and "Pittsburgh, PA, United States". Locations agree
 * when the city matches.
 */
export function stringsCompatible(def: PredicateDef, a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (def.kind === "enum") return false;
  if (def.id === "company.hq_location") return norm(a.split(",")[0] ?? a) === norm(b.split(",")[0] ?? b);
  return na.includes(nb) || nb.includes(na);
}

const rung = (c: ClaimRow) => {
  const r = (c.value as { rung: string }).rung;
  return `${(ENUM_VALUE_LABELS[r] ?? r).toLowerCase()} (${sourceTypeLabel(c.source_type).toLowerCase()})`;
};
const side = (c: ClaimRow) => `${formatValue(c.predicate, c.value)} (${sourceTypeLabel(c.source_type).toLowerCase()})`;

/**
 * Find pairs of current claims about the same subject and predicate that
 * cannot both be true. Pure function: callers load claims and persist the
 * result.
 */
export function findConflicts(claims: ClaimRow[]): Conflict[] {
  const byPredicate = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    const list = byPredicate.get(c.predicate) ?? [];
    list.push(c);
    byPredicate.set(c.predicate, list);
  }

  const out: Conflict[] = [];
  for (const [predicate, list] of byPredicate) {
    const def = getPredicate(predicate);
    if (predicate === "pilot.status") {
      out.push(...pilotConflicts(list));
      continue;
    }
    if (def.cardinality === "many" || def.comparable === false) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const conflict = compare(def, list[i]!, list[j]!);
        if (conflict) out.push(conflict);
      }
    }
  }
  return out;
}

function withinWindow(def: PredicateDef, a: ClaimRow, b: ClaimRow): boolean {
  if (!def.timeVarying) return true;
  const d = daysApart(a.as_of, b.as_of);
  return d === null || d <= (def.windowDays ?? COMPARISON_WINDOW_DAYS);
}

function compare(def: PredicateDef, a: ClaimRow, b: ClaimRow): Conflict | null {
  if (!withinWindow(def, a, b)) return null;

  if (typeof a.value === "number" && typeof b.value === "number") {
    const tol = def.tolerance ?? 0.1;
    const d = relDiff(a.value, b.value);
    if (d <= tol) return null;
    const magnitude = d > Math.max(2 * tol, 0.25) ? "large" : "small";
    return {
      predicate: def.id,
      claimIds: [a.id, b.id],
      severity: severityFor(a, b, magnitude),
      detail: `${predicateLabel(def.id)}: ${side(a)} vs ${side(b)}, ${Math.round(d * 100)}% apart`,
    };
  }

  if (stringsCompatible(def, String(a.value), String(b.value))) return null;
  return {
    predicate: def.id,
    claimIds: [a.id, b.id],
    severity: severityFor(a, b, def.kind === "enum" ? "large" : "small"),
    detail: `${predicateLabel(def.id)}: ${side(a)} vs ${side(b)}`,
  };
}

/**
 * Pilot claims conflict when two sources put the same customer on different
 * rungs within the window. Self-reported rungs above an independent rung are
 * high severity: that's the "deployed at five sites" trap.
 */
function pilotConflicts(list: ClaimRow[]): Conflict[] {
  const def = getPredicate("pilot.status");
  const byCustomer = new Map<string, ClaimRow[]>();
  for (const c of list) {
    const v = c.value as { customer: string; rung: string };
    const key = v.customer.toLowerCase().replace(/[^a-z0-9]/g, "");
    byCustomer.set(key, [...(byCustomer.get(key) ?? []), c]);
  }
  const out: Conflict[] = [];
  for (const claims of byCustomer.values()) {
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i]!;
        const b = claims[j]!;
        if (!withinWindow(def, a, b)) continue;
        const ra = PILOT_LADDER.indexOf((a.value as { rung: (typeof PILOT_LADDER)[number] }).rung);
        const rb = PILOT_LADDER.indexOf((b.value as { rung: (typeof PILOT_LADDER)[number] }).rung);
        if (ra === rb) continue;
        const [hi, lo] = ra > rb ? [a, b] : [b, a];
        const overclaim = hi.source_type === "self_reported" && INDEPENDENT.includes(lo.source_type);
        const customer = (a.value as { customer: string }).customer;
        out.push({
          predicate: def.id,
          claimIds: [a.id, b.id],
          severity: overclaim ? "high" : severityFor(a, b, "small"),
          detail: `${predicateLabel("pilot.status")} with ${customer}: ${rung(hi)} vs ${rung(lo)}`,
        });
      }
    }
  }
  return out;
}
