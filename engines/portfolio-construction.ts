/**
 * Portfolio construction: how a fund's commitments turn into checks.
 * Deterministic and unit-tested (CLAUDE.md: math is code). The setup wizard
 * shows these numbers live; nothing here calls a model.
 *
 *   fees        = fee% × size × investment period
 *               + step-down% × base × (term − investment period)
 *                 where base = size (fee on commitments) or the capital
 *                 available to invest (fee on invested capital, approximated
 *                 as size − investment-period fees − expenses)
 *   investable  = size − fees − expenses + recycled
 *   reserves    = investable × reserves%          (follow-on capital)
 *   initial     = investable − reserves           (first checks)
 *   new : reserve ratio = 1 : reserves / initial
 */

export interface FundInputs {
  sizeUsd: number;
  managementFeePct?: number;
  investmentPeriodYears?: number;
  termYears?: number;
  /** Fee rate after the investment period; defaults to the full fee. */
  feeStepDownPct?: number;
  feeBasisAfterPeriod?: "committed" | "invested";
  /** Fund expenses over the fund's life, as % of commitments. */
  fundExpensesPct?: number;
  /** Proceeds reinvested, as % of commitments. */
  recyclingPct?: number;
  /** Share of investable capital held for follow-ons. */
  reservesPct?: number;
  avgInitialCheckUsd?: number;
  targetInvestments?: number;
  /** Most of the fund any one company may take, as %. */
  maxConcentrationPct?: number;
  checkRangeUsd?: { min: number; max: number };
}

export interface Construction {
  sizeUsd: number;
  managementFeesUsd: number;
  feeLoadPct: number;
  expensesUsd: number;
  recycledUsd: number;
  investableUsd: number;
  initialCapitalUsd: number;
  reserveCapitalUsd: number;
  /** Follow-on dollars per dollar of initial check: 0.8 means 1 : 0.8. */
  reserveRatio: number | null;
  impliedInvestments: number | null;
  impliedAvgInitialCheckUsd: number | null;
  avgReservePerCompanyUsd: number | null;
  /** Initial check plus its share of reserves, as % of the fund. */
  avgPositionPct: number | null;
  warnings: string[];
}

const round = (n: number) => Math.round(n);
const pct = (n: number | undefined) => (n ?? 0) / 100;
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);

export function construct(f: FundInputs): Construction {
  const size = Math.max(0, f.sizeUsd);
  const fee = pct(f.managementFeePct);
  const period = Math.max(0, f.investmentPeriodYears ?? 0);
  const term = Math.max(period, f.termYears ?? period);
  const stepDown = f.feeStepDownPct === undefined ? fee : pct(f.feeStepDownPct);
  const expenses = size * pct(f.fundExpensesPct);
  const periodFees = size * fee * period;
  const postBase = f.feeBasisAfterPeriod === "invested" ? Math.max(0, size - periodFees - expenses) : size;
  const fees = periodFees + postBase * stepDown * (term - period);
  const recycled = size * pct(f.recyclingPct);
  const investable = Math.max(0, size - fees - expenses + recycled);
  const reserves = investable * Math.min(1, Math.max(0, pct(f.reservesPct)));
  const initial = investable - reserves;

  const count = f.targetInvestments && f.targetInvestments > 0 ? f.targetInvestments : null;
  const check = f.avgInitialCheckUsd && f.avgInitialCheckUsd > 0 ? f.avgInitialCheckUsd : null;
  const impliedInvestments = check ? initial / check : null;
  const impliedCheck = count ? initial / count : null;
  const companies = count ?? (impliedInvestments ? Math.max(1, Math.round(impliedInvestments)) : null);
  const avgReserve = companies ? reserves / companies : null;
  const avgPosition = companies && size > 0 ? ((initial + reserves) / companies / size) * 100 : null;

  const warnings: string[] = [];
  if (f.termYears !== undefined && f.investmentPeriodYears !== undefined && f.termYears < f.investmentPeriodYears)
    warnings.push("The fund term is shorter than the investment period.");
  if (size > 0 && fees / size > 0.25) warnings.push(`Fees take ${Math.round((fees / size) * 100)}% of the fund: check the fee rate and step-down.`);
  if (count && check) {
    const gap = (count * check - initial) / initial;
    if (Math.abs(gap) > 0.15) {
      warnings.push(
        gap > 0
          ? `${count} checks of ${money(check)} need ${money(count * check)}, but only ${money(initial)} is set aside for first checks.`
          : `${count} checks of ${money(check)} use ${money(count * check)} of the ${money(initial)} set aside for first checks.`,
      );
    }
  }
  if (check && f.checkRangeUsd && (check < f.checkRangeUsd.min || check > f.checkRangeUsd.max))
    warnings.push(`The average first check (${money(check)}) is outside your check range (${money(f.checkRangeUsd.min)}–${money(f.checkRangeUsd.max)}).`);
  if (avgPosition !== null && f.maxConcentrationPct && avgPosition > f.maxConcentrationPct)
    warnings.push(`An average position (first check plus reserves) is ${avgPosition.toFixed(1)}% of the fund, above your ${f.maxConcentrationPct}% limit.`);

  return {
    sizeUsd: round(size),
    managementFeesUsd: round(fees),
    feeLoadPct: size > 0 ? (fees / size) * 100 : 0,
    expensesUsd: round(expenses),
    recycledUsd: round(recycled),
    investableUsd: round(investable),
    initialCapitalUsd: round(initial),
    reserveCapitalUsd: round(reserves),
    reserveRatio: initial > 0 ? reserves / initial : null,
    impliedInvestments,
    impliedAvgInitialCheckUsd: impliedCheck === null ? null : round(impliedCheck),
    avgReservePerCompanyUsd: avgReserve === null ? null : round(avgReserve),
    avgPositionPct: avgPosition,
    warnings,
  };
}

/** Reserves % from a new-to-reserve ratio: 1 : 1.5 means 60% reserves. */
export function reservesFromRatio(followOnPerInitial: number): number {
  return followOnPerInitial <= 0 ? 0 : (followOnPerInitial / (1 + followOnPerInitial)) * 100;
}
