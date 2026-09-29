/**
 * Exit waterfall: who gets what from a sale at a given price, under the
 * preferred stock's liquidation preferences. Deterministic and tested.
 *
 * - Each preferred series has a preference of multiple x original issue
 *   price x shares, paid in order of seniority (1 = paid first). Series at
 *   the same rank share pro rata to their preference when there isn't
 *   enough to pay all of them (pari passu).
 * - Non-participating preferred takes the greater of its preference or
 *   what it would get as common. Participating preferred takes its
 *   preference and then shares with common, up to a cap (a multiple of its
 *   issue price) if there is one; above the cap it may convert instead.
 * - Each series' convert-or-not choice depends on the others', so the
 *   engine iterates: any series better off switching switches, until no
 *   series wants to (an equilibrium; the usual way these are modeled).
 * - Unissued pool shares get nothing. Options are exercised only when the
 *   per-share value exceeds their strike; the strike is netted out.
 * - Accrued dividends, escrows, fees and management carve-outs are not
 *   modeled; pass net proceeds.
 */

export interface PreferredSeries {
  name: string;
  shares: number;
  issuePrice: number;
  multiple: number;
  participating: boolean;
  /** Total return cap for participating preferred, as a multiple of issue price. */
  capMultiple?: number;
  seniority: number;
  /** Common shares per preferred share. */
  conversionRatio?: number;
}

export interface CommonClass {
  name: string;
  shares: number;
  /** Options: strike price per share. Common: 0. */
  strike?: number;
}

export interface WaterfallResult {
  exitValue: number;
  perCommonShare: number;
  classes: { name: string; kind: "preferred" | "common"; shares: number; payout: number; perShare: number; converted?: boolean; capped?: boolean }[];
}

const EPS = 1e-9;

function distribute(exit: number, prefs: PreferredSeries[], commons: CommonClass[], converting: Set<string>): WaterfallResult {
  let remaining = exit;
  const payout = new Map<string, number>();
  const capped = new Set<string>();
  // 1. Preferences, by seniority, for series that don't convert.
  const holding = prefs.filter((p) => !converting.has(p.name));
  const ranks = [...new Set(holding.map((p) => p.seniority))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const tier = holding.filter((p) => p.seniority === rank);
    const owed = tier.map((p) => p.multiple * p.issuePrice * p.shares);
    const total = owed.reduce((a, b) => a + b, 0);
    const paid = Math.min(total, remaining);
    tier.forEach((p, i) => payout.set(p.name, total > 0 ? (paid * owed[i]!) / total : 0));
    remaining -= paid;
  }
  // 2. The rest, as-converted, among common, converted preferred and participating preferred.
  type Part = { name: string; shares: number; strike: number; limit: number };
  const parts: Part[] = [
    ...commons.map((c) => ({ name: c.name, shares: c.shares, strike: c.strike ?? 0, limit: Infinity })),
    ...prefs.filter((p) => converting.has(p.name)).map((p) => ({ name: p.name, shares: p.shares * (p.conversionRatio ?? 1), strike: 0, limit: Infinity })),
    ...holding.filter((p) => p.participating).map((p) => ({
      name: p.name, shares: p.shares * (p.conversionRatio ?? 1), strike: 0,
      limit: p.capMultiple ? Math.max(0, p.capMultiple * p.issuePrice * p.shares - (payout.get(p.name) ?? 0)) : Infinity,
    })),
  ];
  // Water-filling with caps: capped participants take their limit, the rest share what's left.
  const share = (active: Part[]) => {
    let pot = remaining + active.reduce((a, p) => a + p.strike * p.shares, 0);
    let open = active.filter((p) => p.shares > 0);
    const fixed = new Map<string, number>();
    for (;;) {
      const shares = open.reduce((a, p) => a + p.shares, 0);
      const ps = shares > 0 ? pot / shares : 0;
      const over = open.filter((p) => p.shares * ps > p.limit + EPS);
      if (!over.length) return { perShare: ps, fixed };
      for (const p of over) {
        fixed.set(p.name, p.limit);
        pot -= p.limit;
      }
      open = open.filter((p) => !over.includes(p));
    }
  };
  // Options exercise only when in the money: add them from the lowest strike while the value per share exceeds it.
  const byStrike = parts.filter((p) => p.strike > 0).sort((a, b) => a.strike - b.strike);
  let active = parts.filter((p) => p.strike === 0);
  let result = share(active);
  for (const o of byStrike) {
    const trial = share([...active, o]);
    if (trial.perShare > o.strike + EPS) {
      active = [...active, o];
      result = trial;
    } else break;
  }
  const perShare = result.perShare;
  for (const p of active) {
    const gross = result.fixed.get(p.name) ?? p.shares * perShare;
    if (result.fixed.has(p.name)) capped.add(p.name);
    payout.set(p.name, (payout.get(p.name) ?? 0) + gross - p.strike * p.shares);
  }
  return {
    exitValue: exit,
    perCommonShare: perShare,
    classes: [
      ...prefs.map((p) => ({ name: p.name, kind: "preferred" as const, shares: p.shares, payout: payout.get(p.name) ?? 0, perShare: (payout.get(p.name) ?? 0) / p.shares, converted: converting.has(p.name), capped: capped.has(p.name) })),
      ...commons.map((c) => ({ name: c.name, kind: "common" as const, shares: c.shares, payout: Math.max(0, payout.get(c.name) ?? 0), perShare: c.shares ? Math.max(0, payout.get(c.name) ?? 0) / c.shares : 0 })),
    ],
  };
}

/** Distribute `exit` among the classes, with each preferred series choosing whether to convert. Pure. */
export function waterfall(exit: number, prefs: PreferredSeries[], commons: CommonClass[]): WaterfallResult {
  if (!(exit >= 0)) throw new Error("Exit value must be zero or more.");
  const converting = new Set<string>();
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const p of prefs) {
      // Participating preferred without a cap never gains by converting.
      if (p.participating && !p.capMultiple) continue;
      const now = distribute(exit, prefs, commons, converting).classes.find((c) => c.name === p.name)!.payout;
      const flipped = new Set(converting);
      if (flipped.has(p.name)) flipped.delete(p.name);
      else flipped.add(p.name);
      const alt = distribute(exit, prefs, commons, flipped).classes.find((c) => c.name === p.name)!.payout;
      if (alt > now + 1e-6) {
        converting.clear();
        for (const x of flipped) converting.add(x);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return distribute(exit, prefs, commons, converting);
}

/** Our proceeds and multiple across exit values: the returns table on a deal page. Pure. */
export function exitScenarios(exits: number[], prefs: PreferredSeries[], commons: CommonClass[], ours: { series: string; shares: number; invested: number }) {
  return exits.map((exit) => {
    const w = waterfall(exit, prefs, commons);
    const cls = w.classes.find((c) => c.name === ours.series);
    const proceeds = cls ? (cls.payout * ours.shares) / cls.shares : 0;
    return { exit, proceeds, multiple: ours.invested ? proceeds / ours.invested : 0, converted: Boolean(cls?.converted), perCommonShare: w.perCommonShare };
  });
}
