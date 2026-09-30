import { waterfall, type CommonClass, type PreferredSeries } from "./waterfall.js";

/**
 * Fair value of one position at a measurement date, by the techniques the
 * IPEV Valuation Guidelines (December 2025 edition, in effect for periods
 * from 1 April 2026) and ASC 820 recognize for venture investments. Every
 * mark shows its steps, so it can be reviewed and explained.
 *
 * - Calibrated to a recent round: our shares at the price of an arm's-length
 *   round, adjusted if things have changed since. The price of a recent
 *   investment (PRI) is a starting point to calibrate against, not a
 *   default: the older the round, the more it needs checking.
 * - Milestone adjustment: the last mark moved up or down for progress
 *   against the milestones the round was priced on (IPEV's milestone
 *   analysis for early-stage companies).
 * - Multiple of revenue (or ARR): enterprise value = metric x multiple from
 *   comparable companies; equity = EV + cash - debt; our share of equity
 *   through the preferences (the waterfall), since classes differ in rights.
 * - Exit proceeds, and write-off (zero).
 * - Cost: acceptable only close to the investment date, when nothing has
 *   changed; it too is checked against the calibration.
 *
 * Deterministic and unit-tested. A model may explain a mark, never set one.
 */

export type Method = "recent_round" | "milestone" | "revenue_multiple" | "exit" | "public_price" | "write_off" | "cost";

export const METHOD_LABELS: Record<Method, string> = {
  recent_round: "Calibrated to a recent round",
  milestone: "Milestone adjustment",
  revenue_multiple: "Multiple of revenue",
  exit: "Exit proceeds",
  public_price: "Quoted price",
  write_off: "Written off",
  cost: "At cost",
};

export type MarkInput =
  | { method: "recent_round"; ourShares: number; roundPrice: number; roundDate: string; adjustmentPct?: number }
  | { method: "milestone"; priorValue: number; adjustmentPct: number }
  | {
      method: "revenue_multiple";
      metricValue: number;
      metricLabel: string;
      multiple: number;
      cash?: number;
      debt?: number;
      /** Our share of equity when there's no cap table: fully diluted percent. */
      ownershipPct?: number;
      /** With a cap table: every class, and ours, so preferences are applied. */
      classes?: { prefs: PreferredSeries[]; commons: CommonClass[]; ourSeries: string; ourShares: number };
      /** Discount for the company's stage, size or liquidity versus the comparables, percent. */
      discountPct?: number;
    }
  | { method: "exit"; proceeds: number }
  | { method: "public_price"; shares: number; price: number; priceDate: string }
  | { method: "write_off" }
  | { method: "cost"; invested: number; investedDate: string };

export interface Mark {
  method: Method;
  value: number;
  steps: string[];
  /** Things a reviewer should check before approving. */
  warnings: string[];
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const monthsSince = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (86_400_000 * 30.4375);

export function mark(input: MarkInput, asOf: string): Mark {
  const steps: string[] = [];
  const warnings: string[] = [];
  switch (input.method) {
    case "recent_round": {
      if (input.ourShares <= 0 || input.roundPrice <= 0) throw new Error("Shares and the round price must be positive.");
      const base = input.ourShares * input.roundPrice;
      steps.push(`${input.ourShares.toLocaleString("en-US")} shares x $${input.roundPrice.toFixed(4)} (the round's price) = ${usd(base)}.`);
      const adj = input.adjustmentPct ?? 0;
      const value = base * (1 + adj / 100);
      if (adj) steps.push(`Adjusted ${adj > 0 ? "+" : ""}${adj}% for changes since the round: ${usd(value)}.`);
      const age = monthsSince(input.roundDate, asOf);
      if (age > 12) warnings.push(`The round is ${Math.round(age)} months old. The price of a recent investment is not a default; check it against current performance and the market.`);
      warnings.push("Our class's rights may differ from the round's security: check the calibration if they do.");
      return { method: input.method, value, steps, warnings };
    }
    case "milestone": {
      if (input.priorValue < 0) throw new Error("The prior mark can't be negative.");
      const value = Math.max(0, input.priorValue * (1 + input.adjustmentPct / 100));
      steps.push(`Prior mark ${usd(input.priorValue)}, ${input.adjustmentPct >= 0 ? "+" : ""}${input.adjustmentPct}% for progress against milestones = ${usd(value)}.`);
      if (Math.abs(input.adjustmentPct) > 50) warnings.push("A move over 50% usually needs a round, a term sheet or a multiple to support it.");
      return { method: input.method, value, steps, warnings };
    }
    case "revenue_multiple": {
      if (input.metricValue < 0 || input.multiple < 0) throw new Error("The metric and the multiple can't be negative.");
      const ev = input.metricValue * input.multiple;
      steps.push(`${input.metricLabel} ${usd(input.metricValue)} x ${input.multiple}x = enterprise value ${usd(ev)}.`);
      const disc = input.discountPct ?? 0;
      const evAdj = ev * (1 - disc / 100);
      if (disc) steps.push(`Less ${disc}% for stage, size and liquidity versus the comparables: ${usd(evAdj)}.`);
      const equity = Math.max(0, evAdj + (input.cash ?? 0) - (input.debt ?? 0));
      steps.push(`Plus cash ${usd(input.cash ?? 0)}, less debt ${usd(input.debt ?? 0)}: equity value ${usd(equity)}.`);
      let value: number;
      if (input.classes) {
        const w = waterfall(equity, input.classes.prefs, input.classes.commons);
        const cls = w.classes.find((c) => c.name === input.classes!.ourSeries);
        if (!cls) throw new Error(`No class named ${input.classes.ourSeries} in the cap table.`);
        value = cls.shares > 0 ? (cls.payout / cls.shares) * input.classes.ourShares : 0;
        steps.push(`Through the preferences, ${input.classes.ourSeries} gets ${usd(cls.payout)}${cls.converted ? " (converting to common)" : " (its preference)"}; our ${input.classes.ourShares.toLocaleString("en-US")} shares: ${usd(value)}.`);
      } else if (input.ownershipPct !== undefined) {
        value = equity * (input.ownershipPct / 100);
        steps.push(`Our ${input.ownershipPct}% fully diluted: ${usd(value)}.`);
        warnings.push("Allocated pro rata: liquidation preferences aren't applied. Add the cap table to apply them.");
      } else throw new Error("Give our ownership, or the cap table's classes.");
      return { method: input.method, value, steps, warnings };
    }
    case "exit":
      if (input.proceeds < 0) throw new Error("Proceeds can't be negative.");
      steps.push(`Proceeds due to the fund from the sale: ${usd(input.proceeds)}.`);
      return { method: input.method, value: input.proceeds, steps, warnings };
    case "public_price": {
      if (input.shares <= 0 || input.price <= 0) throw new Error("Shares and the price must be positive.");
      const value = input.shares * input.price;
      steps.push(`${input.shares.toLocaleString("en-US")} shares x $${input.price.toFixed(4)} (closing price on ${input.priceDate}) = ${usd(value)}.`);
      // ASC 820 as amended by ASU 2022-03: a contractual sale restriction (a lock-up) isn't a discount.
      steps.push("No discount for the lock-up: a contractual restriction on selling belongs to the holder, not the shares (ASC 820, ASU 2022-03).");
      if ((Date.parse(asOf) - Date.parse(input.priceDate)) / 86_400_000 > 5) warnings.push(`The price is from ${input.priceDate}; use the closing price on the measurement date.`);
      return { method: input.method, value, steps, warnings };
    }
    case "write_off":
      steps.push("The company has failed or the position is worthless: written off to zero.");
      return { method: input.method, value: 0, steps, warnings };
    case "cost": {
      steps.push(`Held at cost: ${usd(input.invested)}.`);
      const age = monthsSince(input.investedDate, asOf);
      if (age > 12) warnings.push(`Invested ${Math.round(age)} months ago. Cost is rarely fair value this long after; use another method.`);
      warnings.push("Cost is only a fair value if it still calibrates: confirm nothing material has changed.");
      return { method: input.method, value: input.invested, steps, warnings };
    }
  }
}
