import type { Db } from "../../lib/db.js";
import { getValuation, insertValuation, latestMarks, reviewValuation, valuations } from "../../ledger/portfolio.js";
import { buildSeries, monthText, summarize } from "../../engines/kpi.js";
import { mark, METHOD_LABELS, type MarkInput, type Method } from "../../engines/valuation.js";
import { model } from "../execution/index.js";
import { holding, isDay, kpiClaims, PortfolioInvalid, today } from "./common.js";

/**
 * Fair value marks, one per company per measurement date (usually quarter
 * end). A person prepares a mark with a method and a written rationale;
 * a different person approves it (a valuation committee of at least two).
 * Inputs the ledger already knows (our shares, ARR, cash, debt, cost, the
 * last mark, the cap table) are filled in from it and cited. The math is
 * engines/valuation.ts; the reasoning is the rationale.
 */

export { METHOD_LABELS };

export async function proposeMark(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  const h = await holding(db, companyId);
  const method = input.method as Method;
  if (!(method in METHOD_LABELS)) throw new PortfolioInvalid("Pick a method.");
  const asOf = isDay(input.asOf) ? input.asOf : null;
  if (!asOf) throw new PortfolioInvalid("Pick the measurement date.");
  if (asOf > today()) throw new PortfolioInvalid("The measurement date can't be in the future.");
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale.length < 10) throw new PortfolioInvalid("Explain the mark in a sentence or two: what supports it.");
  const n = (k: string) => (input[k] === undefined || input[k] === null || input[k] === "" ? undefined : Number(input[k]));
  const invested = h.investments.reduce((a, i) => a + i.amount_usd, 0);
  const shares = h.investments.reduce((a, i) => a + (i.shares ?? 0), 0);
  const cites: string[] = [];
  let engineInput: MarkInput;
  switch (method) {
    case "recent_round": {
      const price = n("roundPrice");
      if (!price || price <= 0) throw new PortfolioInvalid("Enter the round's price per share.");
      if (!isDay(input.roundDate)) throw new PortfolioInvalid("Enter the round's date.");
      const ourShares = n("ourShares") ?? shares;
      if (!ourShares) throw new PortfolioInvalid("Enter our shares: the investment record doesn't have them.");
      engineInput = { method, ourShares, roundPrice: price, roundDate: input.roundDate, adjustmentPct: n("adjustmentPct") };
      break;
    }
    case "milestone": {
      const prior = n("priorValue") ?? (await latestMarks(db)).get(companyId)?.fair_value_usd ?? invested;
      const adj = n("adjustmentPct");
      if (adj === undefined || !Number.isFinite(adj)) throw new PortfolioInvalid("Enter the adjustment, in percent (negative for down).");
      engineInput = { method, priorValue: prior, adjustmentPct: adj };
      break;
    }
    case "revenue_multiple": {
      const multiple = n("multiple");
      if (multiple === undefined || multiple < 0) throw new PortfolioInvalid("Enter the multiple from comparable companies.");
      const sum = summarize(buildSeries(await kpiClaims(db, companyId)), asOf);
      let metricValue = n("metricValue");
      let metricLabel = String(input.metricLabel ?? "ARR");
      if (metricValue === undefined) {
        if (sum.arr) { metricValue = sum.arr.value; metricLabel = `ARR (${monthText(sum.arr.month)})`; cites.push(sum.arr.claimId); }
        else if (sum.revenue) { metricValue = sum.revenue.value * 12; metricLabel = `Monthly revenue x 12 (${monthText(sum.revenue.month)})`; cites.push(sum.revenue.claimId); }
        else throw new PortfolioInvalid("There's no ARR or revenue on record: enter the figure.");
      }
      const cash = n("cash") ?? sum.cash?.value ?? 0;
      if (n("cash") === undefined && sum.cash) cites.push(sum.cash.claimId);
      const debtClaim = (await kpiClaims(db, companyId)).filter((c) => c.predicate === "debt.balance").pop();
      const debt = n("debt") ?? (typeof debtClaim?.value === "number" ? debtClaim.value : 0);
      if (n("debt") === undefined && debtClaim) cites.push(debtClaim.id);
      // Apply preferences when the cap table from execution is there.
      const m = await model(db, h.dealId);
      const classes = m.classes && input.proRata !== true ? m.classes : undefined;
      const ownershipPct = n("ownershipPct") ?? h.investments.find((i) => i.ownership_fd_pct !== null)?.ownership_fd_pct ?? undefined;
      if (!classes && ownershipPct === undefined) throw new PortfolioInvalid("Enter our fully diluted ownership.");
      engineInput = { method, metricValue, metricLabel, multiple, cash, debt, discountPct: n("discountPct"), classes, ownershipPct };
      break;
    }
    case "exit": {
      const proceeds = n("proceeds");
      if (proceeds === undefined || proceeds < 0) throw new PortfolioInvalid("Enter the proceeds due to the fund.");
      engineInput = { method, proceeds };
      break;
    }
    case "write_off":
      engineInput = { method };
      break;
    case "cost":
      engineInput = { method, invested, investedDate: h.investments[0]!.close_date };
      break;
  }
  let result;
  try {
    result = mark(engineInput, asOf);
  } catch (err) {
    throw new PortfolioInvalid((err as Error).message);
  }
  const stored = { ...engineInput, classes: undefined, usedCapTable: "classes" in engineInput && Boolean(engineInput.classes), cites };
  return insertValuation(db, { companyId, asOf, method, fairValueUsd: Math.round(result.value * 100) / 100, inputs: stored, steps: result.steps, warnings: result.warnings, rationale }, by);
}

/** A second person approves or rejects. The preparer can't review their own mark. */
export async function reviewMark(db: Db, id: string, input: { approve: boolean; note?: string }, by: string) {
  const v = await getValuation(db, id);
  if (!v) throw new PortfolioInvalid("No such mark.");
  if (v.status !== "proposed") throw new PortfolioInvalid(`This mark is already ${v.status}.`);
  if (v.prepared_by === by) throw new PortfolioInvalid("Someone other than the preparer reviews a mark.");
  if (!input.approve && !input.note?.trim()) throw new PortfolioInvalid("Say why the mark is rejected.");
  const clash = (await valuations(db, { companyId: v.company_id, status: "approved" })).find((x) => x.as_of === v.as_of);
  if (input.approve && clash) throw new PortfolioInvalid(`There's already an approved mark for ${v.as_of}. Record a new date, or reject this one.`);
  await reviewValuation(db, id, input.approve, input.note?.trim() || null, by);
}
