/**
 * Pro-forma capitalization for a priced round, including SAFE and
 * convertible-note conversion and an option-pool top-up. Deterministic,
 * unit-tested; a model may explain these numbers but never computes them.
 *
 * Conventions (state them on every output; they're negotiable in a deal):
 * - Pre-money valuation is fully diluted and includes the option-pool
 *   increase and the shares SAFEs and notes convert into (the usual term
 *   sheet convention, "the option pool shuffle"). So:
 *     price = pre-money / (existing fully diluted + pool increase + conversion shares)
 * - Post-money SAFE (YC standard since 2018): cap price = cap / Company
 *   Capitalization, where Company Capitalization is everything outstanding
 *   (as converted), the existing pool, and all converting SAFEs and notes,
 *   but not the new money or the new pool increase.
 * - Pre-money SAFE and notes: cap price = cap / (existing fully diluted
 *   shares + the pool increase), excluding converting securities.
 * - A discount gives price x (1 - discount). An instrument converts at the
 *   lowest of its cap price, its discount price and the round price.
 * - MFN SAFEs with no cap or discount convert at the round price.
 * - Notes convert principal plus simple interest (actual/365) to closing.
 * - Share counts are whole shares, rounded down (cash in lieu of fractions).
 *   The price is rounded to `pricePrecision` decimals (default 4), as on
 *   a charter's Original Issue Price.
 * - The pool top-up makes the unissued pool `poolTargetPostPct` of the
 *   post-money fully diluted capitalization.
 */

export interface Holding {
  holder: string;
  /** "Common", "Series Seed Preferred", "Options outstanding"... */
  className: string;
  shares: number;
  kind: "common" | "preferred" | "options" | "pool";
}

export interface Safe {
  holder: string;
  amount: number;
  kind: "post" | "pre" | "mfn";
  cap?: number;
  discountPct?: number;
}

export interface Note {
  holder: string;
  principal: number;
  ratePct: number;
  issueDate: string;
  cap?: number;
  discountPct?: number;
}

export interface Round {
  seriesName: string;
  preMoney: number;
  investments: { holder: string; amount: number }[];
  /** Unissued pool as a share of post-money fully diluted, after the round. */
  poolTargetPostPct?: number;
  closeDate: string;
  pricePrecision?: number;
}

export interface Conversion {
  holder: string;
  instrument: "Post-money SAFE" | "Pre-money SAFE" | "MFN SAFE" | "Convertible note";
  converting: number;
  interest: number;
  price: number;
  basis: "cap" | "discount" | "round";
  shares: number;
}

export interface ProFormaRow {
  holder: string;
  className: string;
  preShares: number;
  postShares: number;
  prePct: number;
  postPct: number;
}

export interface ProForma {
  pricePerShare: number;
  preMoneyFullyDiluted: number;
  postMoneyFullyDiluted: number;
  newMoney: number;
  /** Price x post-money fully diluted shares. Differs from pre + new money only by rounding. */
  postMoneyImplied: number;
  headlinePostMoney: number;
  pool: { before: number; increase: number; after: number; afterPct: number };
  conversions: Conversion[];
  rows: ProFormaRow[];
  newShares: { holder: string; amount: number; shares: number }[];
  conventions: string[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const days = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 86_400_000);

export function noteInterest(n: Note, closeDate: string): number {
  return n.principal * (n.ratePct / 100) * (days(n.issueDate, closeDate) / 365);
}

function validate(existing: Holding[], safes: Safe[], notes: Note[], r: Round) {
  const bad = (m: string) => { throw new Error(m); };
  if (!(r.preMoney > 0)) bad("Pre-money valuation must be positive.");
  if (!r.investments.length || r.investments.some((i) => !(i.amount > 0))) bad("Every investment needs a positive amount.");
  if (existing.some((h) => !(h.shares >= 0) || !Number.isFinite(h.shares))) bad("Share counts must be zero or more.");
  if (sum(existing.map((h) => h.shares)) <= 0) bad("The existing capitalization has no shares.");
  if (r.poolTargetPostPct !== undefined && (r.poolTargetPostPct < 0 || r.poolTargetPostPct >= 100)) bad("Pool target must be between 0% and 100%.");
  for (const s of safes) {
    if (!(s.amount > 0)) bad(`${s.holder}: SAFE amount must be positive.`);
    if (s.kind !== "mfn" && !s.cap && !s.discountPct) bad(`${s.holder}: a SAFE needs a cap, a discount, or to be an MFN SAFE.`);
  }
  for (const n of notes) if (!(n.principal > 0)) bad(`${n.holder}: note principal must be positive.`);
}

/** The pro-forma cap table for a priced round. Pure. */
export function proForma(existing: Holding[], safes: Safe[], notes: Note[], r: Round): ProForma {
  validate(existing, safes, notes, r);
  const precision = r.pricePrecision ?? 4;
  const existingFD = sum(existing.map((h) => h.shares));
  const poolBefore = sum(existing.filter((h) => h.kind === "pool").map((h) => h.shares));
  const target = (r.poolTargetPostPct ?? 0) / 100;
  const newMoney = sum(r.investments.map((i) => i.amount));

  // Given a price (and the shares everything converts into at that price), work out the rest.
  const at = (price: number, round: boolean) => {
    const whole = (x: number) => (round ? Math.floor(x + 1e-9) : x);
    let conv: Conversion[] = [];
    let convShares = 0;
    let poolInc = 0;
    // Inner fixed point: post-money SAFE prices depend on the SAFE shares themselves.
    for (let i = 0; i < 200; i++) {
      const newShares = sum(r.investments.map((x) => whole(x.amount / price)));
      const postFD = existingFD + convShares + newShares;
      poolInc = target > 0 ? Math.max(0, (target * (postFD) - poolBefore) / (1 - target)) : 0;
      poolInc = whole(poolInc);
      const companyCap = existingFD + convShares; // post-money SAFE "Company Capitalization"
      const preBase = existingFD + poolInc; // pre-money SAFE and note cap base
      const next: Conversion[] = [];
      for (const s of safes) {
        const capPrice = s.cap ? s.cap / (s.kind === "post" ? companyCap : preBase) : Infinity;
        const discPrice = s.discountPct ? price * (1 - s.discountPct / 100) : Infinity;
        const p = Math.min(capPrice, discPrice, price);
        next.push({
          holder: s.holder, instrument: s.kind === "post" ? "Post-money SAFE" : s.kind === "pre" ? "Pre-money SAFE" : "MFN SAFE",
          converting: s.amount, interest: 0, price: p, basis: p === price ? "round" : p === capPrice ? "cap" : "discount", shares: whole(s.amount / p),
        });
      }
      for (const n of notes) {
        const interest = noteInterest(n, r.closeDate);
        const capPrice = n.cap ? n.cap / preBase : Infinity;
        const discPrice = n.discountPct ? price * (1 - n.discountPct / 100) : Infinity;
        const p = Math.min(capPrice, discPrice, price);
        next.push({
          holder: n.holder, instrument: "Convertible note", converting: n.principal + interest, interest, price: p,
          basis: p === price ? "round" : p === capPrice ? "cap" : "discount", shares: whole((n.principal + interest) / p),
        });
      }
      const total = sum(next.map((c) => c.shares));
      conv = next;
      if (Math.abs(total - convShares) < (round ? 0.5 : 1e-9 * Math.max(1, total))) {
        convShares = total;
        break;
      }
      convShares = total;
    }
    const newShares = r.investments.map((x) => ({ holder: x.holder, amount: x.amount, shares: whole(x.amount / price) }));
    const preFD = existingFD + poolInc + convShares;
    return { conv, convShares, poolInc, newShares, preFD, postFD: preFD + sum(newShares.map((x) => x.shares)) };
  };

  // Outer fixed point on the price: price = pre-money / pre-money fully diluted shares.
  let price = r.preMoney / existingFD;
  for (let i = 0; i < 500; i++) {
    const next = r.preMoney / at(price, false).preFD;
    if (Math.abs(next - price) <= 1e-13 * price) {
      price = next;
      break;
    }
    price = next;
  }
  const factor = 10 ** precision;
  price = Math.round(price * factor) / factor;
  if (!(price > 0)) throw new Error("The round prices shares at zero: check the inputs.");
  const out = at(price, true);

  // Holder table.
  const pre = new Map<string, ProFormaRow>();
  const add = (holder: string, className: string, preShares: number, postShares: number) => {
    const key = `${holder}\u0000${className}`;
    const row = pre.get(key) ?? { holder, className, preShares: 0, postShares: 0, prePct: 0, postPct: 0 };
    row.preShares += preShares;
    row.postShares += postShares;
    pre.set(key, row);
  };
  for (const h of existing) add(h.holder, h.className, h.shares, h.shares);
  if (out.poolInc > 0) add("Option pool", "Pool increase", 0, out.poolInc);
  for (const c of out.conv) add(c.holder, `${r.seriesName} (from ${c.instrument})`, 0, c.shares);
  for (const n of out.newShares) add(n.holder, r.seriesName, 0, n.shares);
  const rows = [...pre.values()].map((x) => ({ ...x, prePct: (x.preShares / existingFD) * 100, postPct: (x.postShares / out.postFD) * 100 }));
  const poolAfter = poolBefore + out.poolInc;
  return {
    pricePerShare: price,
    preMoneyFullyDiluted: out.preFD,
    postMoneyFullyDiluted: out.postFD,
    newMoney,
    postMoneyImplied: price * out.postFD,
    headlinePostMoney: r.preMoney + newMoney,
    pool: { before: poolBefore, increase: out.poolInc, after: poolAfter, afterPct: (poolAfter / out.postFD) * 100 },
    conversions: out.conv,
    rows,
    newShares: out.newShares,
    conventions: [
      "Pre-money is fully diluted and includes the option-pool increase and SAFE and note conversion shares.",
      "Post-money SAFE caps divide by all outstanding shares, the existing pool and converting securities; pre-money SAFE and note caps divide by existing fully diluted shares plus the pool increase.",
      "Each SAFE or note converts at the lowest of its cap price, discount price and the round price; notes add simple interest to closing.",
      `Shares are rounded down to whole shares; the price is rounded to ${precision} decimals.`,
    ],
  };
}

/** Holdings after a round, for the next round or a waterfall. Pure. */
export function holdingsAfter(p: ProForma, existing: Holding[], seriesName: string): Holding[] {
  const out: Holding[] = existing.map((h) => ({ ...h }));
  const pool = out.find((h) => h.kind === "pool");
  if (pool) pool.shares += p.pool.increase;
  else if (p.pool.increase) out.push({ holder: "Option pool", className: "Unissued pool", shares: p.pool.increase, kind: "pool" });
  for (const c of p.conversions) out.push({ holder: c.holder, className: seriesName, shares: c.shares, kind: "preferred" });
  for (const n of p.newShares) out.push({ holder: n.holder, className: seriesName, shares: n.shares, kind: "preferred" });
  return out;
}
