/**
 * Price-based anti-dilution after a down round. Deterministic and tested.
 *
 * Weighted average (NVCA): CP2 = CP1 x (A + B) / (A + C), where
 *   A = shares outstanding before the new issue (broad-based: common,
 *       preferred as converted and outstanding options; narrow-based:
 *       outstanding shares only),
 *   B = shares the new money would buy at CP1,
 *   C = shares actually issued.
 * Full ratchet: CP2 = the new issue price.
 * The preferred then converts into original issue price / CP2 common
 * shares per preferred share.
 */

export type AntiDilution = "broad_wa" | "narrow_wa" | "full_ratchet" | "none";

export interface AntiDilutionInput {
  kind: AntiDilution;
  /** Current conversion price (usually the series' original issue price). */
  conversionPrice: number;
  originalIssuePrice: number;
  /** Shares of the series. */
  seriesShares: number;
  /** A: shares deemed outstanding before the issue (per the formula's base). */
  sharesOutstanding: number;
  newMoney: number;
  newPrice: number;
}

export function adjustConversion(x: AntiDilutionInput): { conversionPrice: number; conversionRatio: number; extraCommonShares: number } {
  if (!(x.conversionPrice > 0 && x.newPrice > 0 && x.originalIssuePrice > 0)) throw new Error("Prices must be positive.");
  if (x.newPrice >= x.conversionPrice || x.kind === "none") {
    const ratio = x.originalIssuePrice / x.conversionPrice;
    return { conversionPrice: x.conversionPrice, conversionRatio: ratio, extraCommonShares: 0 };
  }
  let cp2: number;
  if (x.kind === "full_ratchet") cp2 = x.newPrice;
  else {
    const A = x.sharesOutstanding;
    const B = x.newMoney / x.conversionPrice;
    const C = x.newMoney / x.newPrice;
    cp2 = (x.conversionPrice * (A + B)) / (A + C);
  }
  const ratio = x.originalIssuePrice / cp2;
  const before = x.originalIssuePrice / x.conversionPrice;
  return { conversionPrice: cp2, conversionRatio: ratio, extraCommonShares: Math.floor(x.seriesShares * (ratio - before)) };
}
