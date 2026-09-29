/**
 * The round in diligence, checked against the fund. Deterministic and
 * unit-tested: a model may explain these numbers, never compute them.
 *
 * Post-money = pre-money + round size (a priced round; any option-pool
 * increase is assumed to be inside the pre-money, the common convention).
 * Entry ownership = our check / post-money.
 */

export interface RoundInputs {
  raiseUsd?: number;
  preMoneyUsd?: number;
  ourCheckUsd?: number;
}

export interface FundGuardrails {
  /** Mandate first-check range. */
  checkMinUsd?: number;
  checkMaxUsd?: number;
  /** Mandate target ownership range, percent. */
  ownershipMinPct?: number;
  ownershipMaxPct?: number;
  /** Fund size (committed, else target) and the most one company may take, percent. */
  fundSizeUsd?: number;
  maxConcentrationPct?: number;
  /** Planned follow-on per company, from portfolio construction. */
  reservePerCompanyUsd?: number;
}

export type Check = { ok: boolean; detail: string };

export interface RoundMath {
  postMoneyUsd?: number;
  ownershipPct?: number;
  /** Our check as a share of the round. */
  shareOfRoundPct?: number;
  /** First check plus planned reserves. */
  totalExposureUsd?: number;
  exposurePctOfFund?: number;
  checks: { checkSize?: Check; ownership?: Check; concentration?: Check; roundFit?: Check };
}

const m = (n: number) => `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const pos = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function roundMath(r: RoundInputs, g: FundGuardrails = {}): RoundMath {
  const out: RoundMath = { checks: {} };
  if (pos(r.raiseUsd) && pos(r.preMoneyUsd)) out.postMoneyUsd = r.preMoneyUsd + r.raiseUsd;
  if (pos(r.ourCheckUsd) && out.postMoneyUsd) out.ownershipPct = (r.ourCheckUsd / out.postMoneyUsd) * 100;
  if (pos(r.ourCheckUsd) && pos(r.raiseUsd)) out.shareOfRoundPct = (r.ourCheckUsd / r.raiseUsd) * 100;
  if (pos(r.ourCheckUsd)) {
    out.totalExposureUsd = r.ourCheckUsd + (g.reservePerCompanyUsd ?? 0);
    if (pos(g.fundSizeUsd)) out.exposurePctOfFund = (out.totalExposureUsd / g.fundSizeUsd) * 100;
  }

  if (pos(r.ourCheckUsd) && (pos(g.checkMinUsd) || pos(g.checkMaxUsd))) {
    const low = pos(g.checkMinUsd) && r.ourCheckUsd < g.checkMinUsd;
    const high = pos(g.checkMaxUsd) && r.ourCheckUsd > g.checkMaxUsd;
    const range = `${pos(g.checkMinUsd) ? m(g.checkMinUsd) : "any"} to ${pos(g.checkMaxUsd) ? m(g.checkMaxUsd) : "any"}`;
    out.checks.checkSize = { ok: !low && !high, detail: low || high ? `${m(r.ourCheckUsd)} is outside your first-check range (${range}).` : `${m(r.ourCheckUsd)} is within your first-check range (${range}).` };
  }
  if (out.ownershipPct !== undefined && (pos(g.ownershipMinPct) || pos(g.ownershipMaxPct))) {
    const low = pos(g.ownershipMinPct) && out.ownershipPct < g.ownershipMinPct;
    const high = pos(g.ownershipMaxPct) && out.ownershipPct > g.ownershipMaxPct;
    const target = `${pos(g.ownershipMinPct) ? pct(g.ownershipMinPct) : "any"} to ${pos(g.ownershipMaxPct) ? pct(g.ownershipMaxPct) : "any"}`;
    out.checks.ownership = { ok: !low && !high, detail: `${pct(out.ownershipPct)} at entry; your target is ${target}.` };
  }
  if (out.exposurePctOfFund !== undefined && pos(g.maxConcentrationPct)) {
    const ok = out.exposurePctOfFund <= g.maxConcentrationPct;
    out.checks.concentration = { ok, detail: `First check plus planned reserves is ${pct(out.exposurePctOfFund)} of the fund; your limit is ${pct(g.maxConcentrationPct)}.` };
  }
  if (pos(r.ourCheckUsd) && pos(r.raiseUsd)) {
    const ok = r.ourCheckUsd <= r.raiseUsd;
    out.checks.roundFit = { ok, detail: ok ? `Our check is ${pct(out.shareOfRoundPct!)} of the round.` : `Our check (${m(r.ourCheckUsd)}) is bigger than the round (${m(r.raiseUsd)}).` };
  }
  return out;
}
