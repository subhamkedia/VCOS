import type { Db } from "../../lib/db.js";
import { audit, insertClaim, insertEvidence, recordDecision } from "../../ledger/repository.js";
import { decisionsOf, insertRealization, latestMarks, realizations, type RealizationKind } from "../../ledger/portfolio.js";
import {
  bids, cvs, elections, exitPlans, exits, extensions, getCv, getExit, getFundLife, getPublicHolding, getReceivable, insertBid, insertCv, insertExit,
  insertExtension, insertInKindPlan, insertPublicHolding, insertQsbsReview, insertReceivable, latestQsbs, prices, publicHoldings, receivables, saveExitPlan,
  saveFundLife, setElection, setWindDownItem, updateCv, updateExit, updatePublicHolding, updateReceivable, upsertPrices, windDownItems,
  type ExitKind, type ExitRow, type ExitStage, type ReceivableStatus,
} from "../../ledger/exits.js";
import { boardMeetings } from "../../ledger/portfolio.js";
import { distributions, funds, getFund, partners } from "../../ledger/lp.js";
import { consents, getConsent } from "../../ledger/fundraising.js";
import { EXIT_LABELS } from "../../ledger/labels.js";
import {
  cvElections, fundLife, inKindPrice, liquidityForecast, qsbs, QSBS_CHECKS, READINESS, receivableValue, saleWindow, shareSplit, splitConsideration, tailOptions,
  WIND_DOWN_STEPS, type Consideration, type PriceMethod,
} from "../../engines/exits.js";
import { parseCsv } from "../../lib/csv.js";
import { getProfile } from "../firm/profile.js";
import { draftDistribution, previewDistribution } from "../lp/capital.js";
import { holding, holdings, isDay, PortfolioInvalid, today, type Holding } from "./common.js";
import { fundShare, holdingValue, publicSharesLeft, valueInputs } from "./value.js";

/**
 * Exits and liquidity, inside Portfolio. Each company has an exit plan (the
 * likely path, when, for how much, and how ready it is). An exit process
 * (a sale, an IPO, a secondary sale, a tender, a buyback, a wind-down) runs
 * through its stages with bids; the fund's consent as a shareholder is a
 * partner's decision with its rationale (principle 5). Closing it records
 * the money back, what's left to collect (escrows, holdbacks, earnouts,
 * each settled later by a partner), listed shares, and the company's new
 * status as a claim. Listed shares are sold within the lock-up and Rule
 * 144, or distributed in kind through LP Reporting, where a second person
 * approves. QSBS is reviewed per investment; each fund's term, extensions,
 * tail options, continuation vehicle and wind-down are tracked.
 *
 * The math is engines/exits.ts. Nothing here moves money or shares: it
 * records what happened and prepares drafts for approval.
 */

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s%]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const ofEnum = <T extends string>(v: unknown, labels: Record<string, string>, message: string): T => {
  if (typeof v !== "string" || !(v in labels)) throw new PortfolioInvalid(message);
  return v as T;
};

/** Consent is needed from the fund whenever it sells or its shares are voted on; an IPO needs none. */
const NEEDS_CONSENT = new Set<ExitKind>(["acquisition", "secondary", "tender", "buyback", "wind_down"]);
const ORDER: ExitStage[] = ["exploring", "preparing", "marketing", "offers", "signed", "closed"];

// ---------------------------------------------------------------------------
// Exit plans
// ---------------------------------------------------------------------------

export async function saveExitPlanFor(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  await holding(db, companyId);
  const path = ofEnum<"acquisition" | "ipo" | "secondary" | "hold" | "wind_down">(input.path, EXIT_LABELS.paths, "Pick the likely path.");
  const year = num(input.targetYear);
  if (year !== null && (year < 2000 || year > 2100)) throw new PortfolioInvalid("Enter the target year, like 2028.");
  const [low, base, high] = [num(input.lowUsd), num(input.baseUsd), num(input.highUsd)];
  if ([low, base, high].some((v) => v !== null && v < 0)) throw new PortfolioInvalid("Values can't be negative.");
  if (low !== null && high !== null && low > high) throw new PortfolioInvalid("The low case is above the high case.");
  const prob = num(input.probabilityPct);
  if (prob !== null && (prob < 0 || prob > 100)) throw new PortfolioInvalid("The probability is a percent, 0 to 100.");
  const readiness = Object.fromEntries(READINESS.map((r) => [r.key, (input.readiness as Record<string, unknown> | undefined)?.[r.key] === true]));
  const buyers = (Array.isArray(input.buyers) ? input.buyers : String(input.buyers ?? "").split(/[,\n]/)).map((b) => String(b).trim()).filter(Boolean).slice(0, 30);
  await saveExitPlan(db, { company_id: companyId, path, target_year: year, low_usd: low, base_usd: base, high_usd: high, probability_pct: prob, buyers, readiness, note: text(input.note) }, by);
}

// ---------------------------------------------------------------------------
// Exit processes
// ---------------------------------------------------------------------------

export async function startExit(db: Db, companyId: string, input: Record<string, unknown>, by: string): Promise<ExitRow> {
  await holding(db, companyId);
  const kind = ofEnum<ExitKind>(input.kind, EXIT_LABELS.kinds, "Pick the kind of exit.");
  if ((await exits(db, { companyId })).some((x) => x.kind === kind && !["closed", "abandoned"].includes(x.stage))) throw new PortfolioInvalid(`There's already an open ${EXIT_LABELS.kinds[kind]!.toLowerCase()} for this company.`);
  if (input.expectedClose !== undefined && input.expectedClose !== "" && !isDay(input.expectedClose)) throw new PortfolioInvalid("Enter the expected closing date.");
  return insertExit(db, {
    companyId, kind, counterparty: text(input.counterparty), expectedClose: isDay(input.expectedClose) ? input.expectedClose : null,
    equityValueUsd: num(input.equityValueUsd), ourExpectedUsd: num(input.ourExpectedUsd), shares: num(input.shares), pricePerShare: num(input.pricePerShare),
    terms: {}, note: text(input.note),
  }, by);
}

async function exitOr404(db: Db, id: string) {
  const x = await getExit(db, id);
  if (!x) throw new PortfolioInvalid("No such exit.");
  return x;
}

/** Move a process along, or record what changed. Closing goes through closeExit; abandoning needs the reason. */
export async function updateExitProcess(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const x = await exitOr404(db, id);
  if (x.stage === "closed" || x.stage === "abandoned") throw new PortfolioInvalid(`This exit is ${EXIT_LABELS.stages[x.stage]!.toLowerCase()}.`);
  const stage = input.stage === undefined ? undefined : ofEnum<ExitStage>(input.stage, EXIT_LABELS.stages, "Pick the stage.");
  if (stage === "closed") throw new PortfolioInvalid("Record the closing with its figures.");
  const reason = text(input.abandonedReason);
  if (stage === "abandoned" && !reason) throw new PortfolioInvalid("Say why it was abandoned: price, terms, a buyer walked, the market.");
  if (stage === "signed" && NEEDS_CONSENT.has(x.kind) && !x.consent_decision_id) throw new PortfolioInvalid("Record the fund's consent before marking it signed.");
  if (input.expectedClose !== undefined && input.expectedClose !== "" && !isDay(input.expectedClose)) throw new PortfolioInvalid("Enter the expected closing date.");
  await updateExit(db, id, {
    stage, abandoned_reason: stage === "abandoned" ? reason : undefined, counterparty: text(input.counterparty) ?? undefined,
    expected_close: isDay(input.expectedClose) ? input.expectedClose : undefined, equity_value_usd: num(input.equityValueUsd) ?? undefined,
    our_expected_usd: num(input.ourExpectedUsd) ?? undefined, shares: num(input.shares) ?? undefined, price_per_share: num(input.pricePerShare) ?? undefined,
    note: text(input.note) ?? undefined,
  }, by);
}

export async function addBid(db: Db, exitId: string, input: Record<string, unknown>, by: string) {
  const x = await exitOr404(db, exitId);
  if (x.stage === "closed" || x.stage === "abandoned") throw new PortfolioInvalid("This exit is over.");
  const bidder = text(input.bidder);
  if (!bidder) throw new PortfolioInvalid("Name the bidder.");
  const kind = ofEnum<"ioi" | "loi" | "final">(input.kind, EXIT_LABELS.bidKinds, "Pick the kind of bid.");
  const value = num(input.valueUsd);
  if (!value || value <= 0) throw new PortfolioInvalid("Enter the value offered.");
  await insertBid(db, { exitId, bidder, kind, valueUsd: value, consideration: text(input.consideration), receivedOn: isDay(input.receivedOn) ? input.receivedOn : today(), note: text(input.note) }, by);
  if (ORDER.indexOf(x.stage) < ORDER.indexOf("offers")) await updateExit(db, exitId, { stage: "offers" }, by);
}

/**
 * The fund's decision as a shareholder: to vote for the sale, sell in the
 * secondary or tender, or support the wind-down. A partner decides, with a
 * rationale; it's kept as a decision.
 */
export async function consentToExit(db: Db, exitId: string, input: Record<string, unknown>, by: string) {
  const x = await exitOr404(db, exitId);
  if (!NEEDS_CONSENT.has(x.kind)) throw new PortfolioInvalid("An IPO doesn't need the fund's consent here; record the lock-up when it lists.");
  if (x.stage === "closed" || x.stage === "abandoned") throw new PortfolioInvalid("This exit is over.");
  const choice = ofEnum<"approve" | "decline" | "abstain">(input.choice, EXIT_LABELS.consent, "Pick consent, decline or abstain.");
  const rationale = text(input.rationale);
  if (!rationale || rationale.length < 15) throw new PortfolioInvalid("Explain the decision: price against our mark and the alternatives, the terms, and the fund's position.");
  const id = await recordDecision(db, { entityId: x.company_id, kind: "exit_consent", actor: by, rationale, value: { exitId, kind: x.kind, choice, equityValueUsd: x.equity_value_usd, ourExpectedUsd: x.our_expected_usd } });
  await updateExit(db, exitId, { consent_decision_id: choice === "approve" ? id : null }, by);
  return { decisionId: id };
}

async function firmName(db: Db) {
  return (await getProfile(db))?.profile.firm.name ?? "The firm";
}

/** The company's new status, as a claim citing the exit record. */
async function statusClaim(db: Db, x: ExitRow, status: "acquired" | "ipo" | "shut_down", on: string, by: string) {
  const labels = { acquired: `acquired${x.counterparty ? ` by ${x.counterparty}` : ""}`, ipo: `listed${x.counterparty ? ` on ${x.counterparty}` : ""}`, shut_down: "wound down" };
  const content = `Exit record: ${x.company_name} was ${labels[status]} on ${on}, recorded by ${await firmName(db)}.`;
  const { evidence } = await insertEvidence(db, { kind: "note", source: "exit", uri: `exit:${x.id}`, title: "Exit record", content, occurredAt: on, accessScope: "confidential", metadata: { companyId: x.company_id, exitId: x.id } }, by);
  const cited = labels[status];
  const at = content.indexOf(cited);
  await insertClaim(db, { subjectId: x.company_id, predicate: "company.status", value: status, asOf: on, evidenceId: evidence.id, sourceType: "internal", confidence: 1, extractedBy: by, spanStart: at, spanEnd: at + cited.length, citedText: cited }).catch(() => undefined);
}

function costOf(h: Holding) {
  const invested = h.investments.reduce((a, i) => a + i.amount_usd, 0);
  const shares = h.investments.every((i) => i.shares !== null) ? h.investments.reduce((a, i) => a + (i.shares ?? 0), 0) : null;
  return { invested, shares, perShare: shares ? invested / shares : null };
}

/** QSBS lots for a holding and what selling on a date would do to each. */
async function qsbsWarnings(db: Db, h: Holding, on: string) {
  const reviews = await latestQsbs(db);
  const out: string[] = [];
  for (const i of h.investments) {
    const r = reviews.get(i.id);
    if (r?.status === "not_eligible") continue;
    const q = qsbs({ acquiredOn: i.close_date, basisUsd: i.amount_usd }, on);
    if (q.next && Date.parse(q.next.on) - Date.parse(on) < 366 * 86_400_000) {
      out.push(`${i.series_name ?? i.security} (${i.close_date}): selling on ${on} excludes ${q.exclusionPct}% of the gain under QSBS; on ${q.next.on} it would be ${q.next.pct}%.`);
    }
  }
  return out;
}

/** What closing would record, for the person to check before they do. Nothing is saved. */
export async function previewClose(db: Db, exitId: string, input: Record<string, unknown>) {
  const x = await exitOr404(db, exitId);
  const h = await holding(db, x.company_id);
  const on = isDay(input.closedOn) ? input.closedOn : today();
  const cost = costOf(h);
  const warnings = await qsbsWarnings(db, h, on);
  if (NEEDS_CONSENT.has(x.kind) && !x.consent_decision_id) warnings.unshift("The fund's consent isn't recorded yet.");
  if (x.kind === "acquisition" || x.kind === "wind_down") {
    const sale = (await boardMeetings(db, x.company_id)).some((m) => m.resolutions.some((r) => r.kind === "sale") && m.conflict_review);
    if (x.kind === "acquisition" && !sale) warnings.push("No board meeting on record approving the sale with a note on preferred and common interests (Trados).");
  }
  if (x.kind === "acquisition") {
    const c = considerationFrom(input, on);
    const split = splitConsideration(c);
    return { kind: x.kind, on, split, cost, gainUsd: round2(split.expectedUsd - cost.invested), warnings: [...warnings, ...split.warnings] };
  }
  if (x.kind === "ipo") {
    const shares = num(input.shares) ?? cost.shares;
    if (!shares) throw new PortfolioInvalid("Enter our shares after the listing (the investment records don't have share counts).");
    const ticker = text(input.ticker);
    if (!ticker) throw new PortfolioInvalid("Enter the ticker.");
    const affiliate = input.affiliate === undefined ? h.investments.some((i) => i.board_role === "seat") : input.affiliate === true;
    const w = saleWindow({ acquiredOn: h.investments[0]!.close_date, listedOn: on, lockupDays: num(input.lockupDays) ?? 180, affiliate, shares, sharesOutstanding: num(input.sharesOutstanding) ?? undefined, price: num(input.pricePerShare) ?? undefined });
    return { kind: x.kind, on, shares, ticker: ticker.toUpperCase(), window: w, valueUsd: num(input.pricePerShare) ? round2(shares * num(input.pricePerShare)!) : null, cost, warnings: [...warnings, ...w.reporting] };
  }
  if (x.kind === "wind_down") {
    const amount = num(input.amountUsd) ?? 0;
    return { kind: x.kind, on, amountUsd: amount, cost, gainUsd: round2(amount - cost.invested), warnings };
  }
  // A secondary sale, tender or buyback of some or all of our shares.
  const shares = num(input.shares) ?? x.shares;
  const price = num(input.pricePerShare) ?? x.price_per_share;
  if (!shares || shares <= 0 || !price || price <= 0) throw new PortfolioInvalid("Enter the shares sold and the price per share.");
  const inputs = await valueInputs(db);
  const real = await realizations(db, x.company_id);
  const v = holdingValue(h, (await latestMarks(db)).get(x.company_id), real, inputs);
  if (v.privateShares !== null && shares > v.privateShares + 1e-6) throw new PortfolioInvalid(`We hold ${v.privateShares.toLocaleString("en-US")} shares; that's fewer than ${shares.toLocaleString("en-US")}.`);
  const proceeds = round2(shares * price);
  const basis = cost.perShare ? round2(cost.perShare * shares) : null;
  const mark = (await latestMarks(db)).get(x.company_id);
  const markPerShare = mark && cost.shares ? mark.fair_value_usd / (v.privateShares ?? cost.shares) : null;
  if (markPerShare && price < markPerShare * 0.8) warnings.push(`The price is ${Math.round((1 - price / markPerShare) * 100)}% below our latest mark per share.`);
  if (x.kind === "secondary") warnings.push("A transfer usually needs the company's consent and clears its right of first refusal (often 30 days) and any co-sale rights.");
  if (x.kind === "tender") warnings.push("A tender offer stays open at least 20 business days (Rule 14e-1).");
  return { kind: x.kind, on, shares, price, proceedsUsd: proceeds, costBasisUsd: basis, gainUsd: basis === null ? null : round2(proceeds - basis), remainingShares: v.privateShares === null ? null : v.privateShares - shares, warnings };
}

function considerationFrom(input: Record<string, unknown>, on: string): Consideration {
  const total = num(input.totalUsd);
  if (total === null || total < 0) throw new PortfolioInvalid("Enter the fund's total consideration from the funds flow.");
  const earnouts = (Array.isArray(input.earnouts) ? input.earnouts : []).map((e: Record<string, unknown>) => {
    if (!isDay(e.dueOn)) throw new PortfolioInvalid("Enter when each earnout is decided.");
    return { description: text(e.description) ?? "Earnout", maxUsd: num(e.maxUsd) ?? 0, probabilityPct: num(e.probabilityPct) ?? 0, dueOn: e.dueOn };
  });
  const deferred = (Array.isArray(input.deferred) ? input.deferred : []).map((d: Record<string, unknown>) => {
    if (!isDay(d.dueOn)) throw new PortfolioInvalid("Enter when each deferred payment is due.");
    return { description: text(d.description) ?? "Deferred payment", amountUsd: num(d.amountUsd) ?? 0, dueOn: d.dueOn };
  });
  try {
    const c: Consideration = {
      closeDate: on, totalUsd: total, stockUsd: num(input.stockUsd) ?? 0, escrowPct: num(input.escrowPct) ?? 0, escrowMonths: num(input.escrowMonths) ?? undefined,
      adjustmentEscrowPct: num(input.adjustmentEscrowPct) ?? 0, adjustmentMonths: num(input.adjustmentMonths) ?? undefined, holdbackPct: num(input.holdbackPct) ?? 0,
      holdbackMonths: num(input.holdbackMonths) ?? undefined, expenseFundUsd: num(input.expenseFundUsd) ?? 0, earnouts, deferred,
    };
    splitConsideration(c);
    return c;
  } catch (e) {
    throw new PortfolioInvalid((e as Error).message);
  }
}

/** Record the closing: money back, what's left to collect, listed shares, the company's status. A partner does it. */
export async function closeExit(db: Db, exitId: string, input: Record<string, unknown>, by: string) {
  const x = await exitOr404(db, exitId);
  if (x.stage === "closed" || x.stage === "abandoned") throw new PortfolioInvalid(`This exit is already ${EXIT_LABELS.stages[x.stage]!.toLowerCase()}.`);
  if (NEEDS_CONSENT.has(x.kind) && !x.consent_decision_id) throw new PortfolioInvalid("Record the fund's consent first.");
  if (!isDay(input.closedOn)) throw new PortfolioInvalid("Enter the closing date.");
  if (input.closedOn > today()) throw new PortfolioInvalid("Record the closing once it has happened.");
  const on = input.closedOn;
  const p = await previewClose(db, exitId, input);
  const h = await holding(db, x.company_id);
  const note = text(input.note);
  if (x.kind === "acquisition" && "split" in p && p.split) {
    const s = p.split;
    if (s.atCloseCashUsd > 0 || s.stockUsd === 0) await insertRealization(db, { companyId: x.company_id, occurredOn: on, amountUsd: s.atCloseCashUsd, kind: "sale", exitId, note: note ?? `Cash at closing${x.counterparty ? ` from ${x.counterparty}` : ""}`, detail: { expectedUsd: s.expectedUsd, maximumUsd: s.maximumUsd } }, by);
    for (const r of s.receivables) await insertReceivable(db, { exitId, companyId: x.company_id, kind: r.kind, description: r.description, amountUsd: r.amountUsd, expectedPct: r.expectedPct, dueOn: r.dueOn }, by);
    if (s.stockUsd > 0) {
      const ticker = text(input.stockTicker);
      const shares = num(input.stockShares);
      if (!ticker || !shares) throw new PortfolioInvalid("Enter the buyer's ticker and the shares the fund receives.");
      await insertPublicHolding(db, { companyId: x.company_id, exitId, ticker: ticker.toUpperCase(), exchange: text(input.stockExchange), listedOn: on, acquiredOn: h.investments[0]!.close_date, shares, sharesOutstanding: num(input.stockSharesOutstanding), lockupDays: num(input.stockLockupDays) ?? 0, affiliate: false }, by);
      await upsertPrices(db, ticker.toUpperCase(), [{ date: on, close: round2(s.stockUsd / shares) }], "closing", by);
    }
    await updateExit(db, exitId, { stage: "closed", closed_on: on, closing: { split: s } }, by);
    await statusClaim(db, x, "acquired", on, by);
  } else if (x.kind === "ipo" && "ticker" in p) {
    const price = num(input.pricePerShare);
    await insertPublicHolding(db, {
      companyId: x.company_id, exitId, ticker: p.ticker!, exchange: text(input.exchange) ?? x.counterparty, listedOn: on, acquiredOn: h.investments[0]!.close_date, shares: p.shares!,
      sharesOutstanding: num(input.sharesOutstanding), lockupDays: num(input.lockupDays) ?? 180, affiliate: input.affiliate === undefined ? h.investments.some((i) => i.board_role === "seat") : input.affiliate === true,
    }, by);
    if (price) await upsertPrices(db, p.ticker!, [{ date: on, close: price }], "ipo", by);
    await updateExit(db, exitId, { stage: "closed", closed_on: on, price_per_share: price ?? undefined, shares: p.shares!, closing: { window: p.window } }, by);
    await statusClaim(db, x, "ipo", on, by);
  } else if (x.kind === "wind_down") {
    const amount = num(input.amountUsd) ?? 0;
    await insertRealization(db, { companyId: x.company_id, occurredOn: on, amountUsd: amount, kind: amount > 0 ? "sale" : "write_off", exitId, note: note ?? "Wind-down" }, by);
    await updateExit(db, exitId, { stage: "closed", closed_on: on, closing: { amountUsd: amount } }, by);
    await statusClaim(db, x, "shut_down", on, by);
  } else if ("proceedsUsd" in p) {
    const kind: RealizationKind = x.kind === "tender" ? "tender" : x.kind === "secondary" ? "secondary" : "partial_sale";
    await insertRealization(db, { companyId: x.company_id, occurredOn: on, amountUsd: p.proceedsUsd!, kind, exitId, shares: p.shares, priceUsd: p.price, note: note ?? `${EXIT_LABELS.kinds[x.kind]}${x.counterparty ? ` to ${x.counterparty}` : ""}`, detail: { costBasisUsd: p.costBasisUsd, gainUsd: p.gainUsd } }, by);
    await updateExit(db, exitId, { stage: "closed", closed_on: on, shares: p.shares, price_per_share: p.price, closing: { proceedsUsd: p.proceedsUsd, gainUsd: p.gainUsd } }, by);
  }
  await audit(db, by, "exit.close", exitId, { kind: x.kind });
  return p;
}

// ---------------------------------------------------------------------------
// Escrows, holdbacks and earnouts
// ---------------------------------------------------------------------------

/**
 * Money arrives from escrow or an earnout, or the buyer's claim or a missed
 * target means it won't. A partner records it; anything short of the full
 * amount needs a note.
 */
export async function settleReceivable(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const r = await getReceivable(db, id);
  if (!r) throw new PortfolioInvalid("No such item.");
  if (r.status !== "pending" && r.status !== "partial") throw new PortfolioInvalid(`This is already ${EXIT_LABELS.receivableStatus[r.status]!.toLowerCase()}.`);
  const on = isDay(input.on) ? input.on : today();
  const amount = num(input.amountUsd) ?? 0;
  const left = round2(r.amount_usd - r.settled_usd);
  if (amount < 0 || amount > left + 0.005) throw new PortfolioInvalid(`Enter an amount up to the ${left.toLocaleString("en-US", { style: "currency", currency: "USD" })} still outstanding.`);
  const final = input.final !== false;
  const note = text(input.note);
  if (final && amount < left - 0.005 && !note) throw new PortfolioInvalid("Less than the full amount: say why (a buyer's claim, a price adjustment, a missed target).");
  const settled = round2(r.settled_usd + amount);
  const status: ReceivableStatus = !final ? "partial" : amount >= left - 0.005 ? (r.kind === "earnout" ? "earned" : "released") : settled > 0 ? (r.kind === "earnout" ? "earned" : "released") : r.kind === "earnout" ? "forfeited" : "claimed";
  if (amount > 0) await insertRealization(db, { companyId: r.company_id, occurredOn: on, amountUsd: amount, kind: r.kind === "earnout" ? "earnout" : "escrow_release", exitId: r.exit_id, receivableId: id, note: note ?? r.description }, by);
  await updateReceivable(db, id, { status, settledUsd: settled, settledOn: on, note }, by);
  return { status, settled };
}

/** Revise the odds or the date of an item still outstanding, with a note on why. */
export async function reviseReceivable(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const r = await getReceivable(db, id);
  if (!r) throw new PortfolioInvalid("No such item.");
  if (r.status !== "pending" && r.status !== "partial") throw new PortfolioInvalid("This item is settled.");
  const pct = num(input.expectedPct);
  if (pct !== null && (pct < 0 || pct > 100)) throw new PortfolioInvalid("The expected share is a percent, 0 to 100.");
  const note = text(input.note);
  if (!note) throw new PortfolioInvalid("Say what changed: a claim notice, results against the earnout target, a new release date.");
  await updateReceivable(db, id, { expectedPct: pct ?? undefined, dueOn: isDay(input.dueOn) ? input.dueOn : undefined, note }, by);
}

// ---------------------------------------------------------------------------
// Listed shares
// ---------------------------------------------------------------------------

export async function addPublicHolding(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  const h = await holding(db, companyId);
  const ticker = text(input.ticker)?.toUpperCase();
  if (!ticker) throw new PortfolioInvalid("Enter the ticker.");
  if (!isDay(input.listedOn)) throw new PortfolioInvalid("Enter the listing date.");
  const shares = num(input.shares);
  if (!shares || shares <= 0) throw new PortfolioInvalid("Enter the shares held.");
  return insertPublicHolding(db, {
    companyId, exitId: null, ticker, exchange: text(input.exchange), listedOn: input.listedOn, acquiredOn: isDay(input.acquiredOn) ? input.acquiredOn : h.investments[0]!.close_date,
    shares, sharesOutstanding: num(input.sharesOutstanding), lockupDays: num(input.lockupDays) ?? 180, affiliate: input.affiliate === true,
  }, by);
}

export async function editPublicHolding(db: Db, id: string, input: Record<string, unknown>, by: string) {
  if (!(await getPublicHolding(db, id))) throw new PortfolioInvalid("No such holding.");
  await updatePublicHolding(db, id, { sharesOutstanding: num(input.sharesOutstanding), lockupDays: num(input.lockupDays) ?? undefined, affiliate: typeof input.affiliate === "boolean" ? input.affiliate : undefined }, by);
}

/** Closing prices, typed in or from a CSV with Date and Close (and optionally Volume) columns, as brokers and data sites export them. */
export async function recordPrices(db: Db, ticker: string, input: { prices?: unknown; csv?: unknown }, by: string) {
  const t = ticker.trim().toUpperCase();
  if (!(await publicHoldings(db)).some((h) => h.ticker === t)) throw new PortfolioInvalid(`We don't hold ${t}.`);
  let rows: { date: string; close: number; volume: number | null }[] = [];
  if (typeof input.csv === "string") {
    const table = parseCsv(input.csv);
    const head = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const di = head.findIndex((h) => h === "date");
    const ci = head.findIndex((h) => h === "close" || h === "close/last" || h === "adj close" || h === "closing price");
    const vi = head.findIndex((h) => h === "volume");
    if (di < 0 || ci < 0) throw new PortfolioInvalid("The CSV needs Date and Close columns.");
    for (const r of table.slice(1)) {
      const d = normDate(r[di] ?? "");
      const c = num(r[ci]);
      if (d && c && c > 0) rows.push({ date: d, close: c, volume: vi >= 0 ? num(r[vi]) : null });
    }
  } else if (Array.isArray(input.prices)) {
    rows = (input.prices as Record<string, unknown>[]).flatMap((p) => (isDay(p.date) && num(p.close) && num(p.close)! > 0 ? [{ date: p.date as string, close: num(p.close)!, volume: num(p.volume) }] : []));
  }
  if (!rows.length) throw new PortfolioInvalid("No prices found: each needs a date and a closing price.");
  if (rows.some((r) => r.date > today())) throw new PortfolioInvalid("A price is dated in the future.");
  return { recorded: await upsertPrices(db, t, rows, typeof input.csv === "string" ? "csv" : "manual", by) };
}

function normDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

async function listedView(db: Db, id: string) {
  const h = await getPublicHolding(db, id);
  if (!h) throw new PortfolioInvalid("No such holding.");
  const real = await realizations(db, h.company_id);
  const px = await prices(db, h.ticker, { limit: 60 });
  const last = px[px.length - 1];
  const vol4 = px.slice(-20).reduce((a, p) => a + (p.volume ?? 0), 0) / 4;
  const left = publicSharesLeft(h, real);
  const window = saleWindow({ acquiredOn: h.acquired_on, listedOn: h.listed_on, lockupDays: h.lockup_days, affiliate: h.affiliate, shares: left, sharesOutstanding: h.shares_outstanding ?? undefined, avgWeeklyVolume: vol4 || undefined, price: last?.close });
  const sold90 = real.filter((r) => (r.kind === "public_sale" || r.kind === "in_kind") && r.detail?.publicHoldingId === h.id && Date.parse(r.occurred_on) > Date.now() - 90 * 86_400_000).reduce((a, r) => a + (r.shares ?? 0), 0);
  return { holding: h, sharesLeft: left, lastPrice: last ?? null, valueUsd: last ? round2(left * last.close) : null, window, soldLast3Months: sold90, prices: px };
}

/** Sell listed shares. A partner records it; the lock-up, Rule 144 and the volume limit are checked. */
export async function sellPublic(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const v = await listedView(db, id);
  const on = isDay(input.on) ? input.on : today();
  const shares = num(input.shares);
  const price = num(input.priceUsd);
  if (!shares || shares <= 0 || !price || price <= 0) throw new PortfolioInvalid("Enter the shares sold and the average price.");
  if (shares > v.sharesLeft + 1e-6) throw new PortfolioInvalid(`We hold ${v.sharesLeft.toLocaleString("en-US")} shares.`);
  if (on < v.window.earliestSale) throw new PortfolioInvalid(`These shares can't be sold before ${v.window.earliestSale} (lock-up and Rule 144).`);
  if (v.window.volumeLimit && v.soldLast3Months + shares > v.window.volumeLimit) throw new PortfolioInvalid(`That's over the Rule 144 volume limit of ${v.window.volumeLimit.toLocaleString("en-US")} shares in three months (${v.soldLast3Months.toLocaleString("en-US")} already).`);
  const h = await holding(db, v.holding.company_id);
  const cost = costOf(h);
  const basis = cost.perShare && v.holding.exit_id && (await getExit(db, v.holding.exit_id))?.kind === "ipo" ? round2(cost.perShare * shares) : null;
  await insertRealization(db, {
    companyId: v.holding.company_id, occurredOn: on, amountUsd: round2(shares * price), kind: "public_sale", shares, priceUsd: price, exitId: v.holding.exit_id,
    note: text(input.note) ?? `Sold ${shares.toLocaleString("en-US")} ${v.holding.ticker}`, detail: { publicHoldingId: id, costBasisUsd: basis },
  }, by);
  return { proceedsUsd: round2(shares * price), form144: v.window.form144 ? "File Form 144 with the SEC by the time the sell order is placed." : null };
}

// ---------------------------------------------------------------------------
// In-kind distributions
// ---------------------------------------------------------------------------

/** The LP Reporting fund a company belongs to, by the investment records' fund name. */
async function fundFor(db: Db, h: Holding, fundId: unknown) {
  if (typeof fundId === "string" && fundId) {
    const f = await getFund(db, fundId);
    if (!f) throw new PortfolioInvalid("No such fund.");
    return f;
  }
  const names = new Set(h.investments.map((i) => i.fund_name.toLowerCase()));
  const matches = (await funds(db)).filter((f) => names.has(f.name.toLowerCase()));
  if (matches.length !== 1) throw new PortfolioInvalid("Pick the fund that holds the investment (set it up in LP Reporting first).");
  return matches[0]!;
}

function priceMethod(input: Record<string, unknown>, on: string): PriceMethod {
  return input.method === "average" ? { kind: "average", days: num(input.days) ?? 5, endingOn: on } : { kind: "close", on };
}

/** What an in-kind distribution would look like: the price, the value, each investor's shares and the GP's. Nothing is saved. */
export async function previewInKind(db: Db, id: string, input: Record<string, unknown>) {
  const v = await listedView(db, id);
  const on = isDay(input.on) ? input.on : today();
  const shares = Math.floor(num(input.shares) ?? 0);
  if (shares <= 0) throw new PortfolioInvalid("Enter the shares to distribute.");
  if (shares > v.sharesLeft) throw new PortfolioInvalid(`We hold ${v.sharesLeft.toLocaleString("en-US")} shares.`);
  if (on < v.window.lockupEnds) throw new PortfolioInvalid(`The lock-up runs to ${v.window.lockupEnds}; distributing before then breaks it.`);
  const method = priceMethod(input, on);
  let price;
  try {
    price = inKindPrice(await prices(db, v.holding.ticker), method);
  } catch (e) {
    throw new PortfolioInvalid((e as Error).message);
  }
  const h = await holding(db, v.holding.company_id);
  const fund = await fundFor(db, h, input.fundId);
  const gross = round2(shares * price.price);
  const d = await previewDistribution(db, fund.id, { grossUsd: gross, paidOn: on, kind: "in_kind", companyId: v.holding.company_id, purpose: `In-kind distribution of ${shares.toLocaleString("en-US")} ${v.holding.ticker} shares` });
  const recipients = [...d.items.filter((i) => i.net > 0).map((i) => ({ id: i.partnerId, amountUsd: i.net })), ...(d.carry > 0 ? [{ id: "gp_carry", amountUsd: d.carry }] : [])];
  const split = shareSplit(recipients, shares);
  const names = new Map(d.items.map((i) => [i.partnerId, i.name]));
  const allocation = split.map((s) => ({ id: s.id, name: s.id === "gp_carry" ? "General partner (carried interest)" : names.get(s.id) ?? "Investor", shares: s.shares }));
  const warnings = [...d.warnings];
  if (v.holding.affiliate) warnings.push("As an affiliate, the fund's distribution counts toward Rule 144 limits for investors who are also affiliates; tell them.");
  return { holdingId: id, fundId: fund.id, fund: fund.name, ticker: v.holding.ticker, shares, on, method, price: price.price, priceSteps: price.steps, grossUsd: gross, carryUsd: d.carry, allocation, lines: d.lines, warnings };
}

/**
 * Prepare an in-kind distribution: a draft in LP Reporting for a second
 * person to approve. The shares leave the fund's books when it's approved.
 */
export async function distributeInKind(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const p = await previewInKind(db, id, input);
  const v = await listedView(db, id);
  const { distribution } = await draftDistribution(db, p.fundId, { grossUsd: p.grossUsd, paidOn: p.on, kind: "in_kind", companyId: v.holding.company_id, purpose: `In-kind distribution of ${p.shares.toLocaleString("en-US")} ${p.ticker} shares at $${p.price.toFixed(4)}` }, by);
  await insertInKindPlan(db, { distributionId: distribution.id, publicHoldingId: id, shares: p.shares, priceUsd: p.price, method: p.method as unknown as Record<string, unknown>, allocation: p.allocation }, by);
  return { distributionId: distribution.id, fundId: p.fundId, preview: p };
}

/** Cash received from a company that hasn't been distributed to investors yet, with a draft distribution one click away. */
export async function distributeProceeds(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  const h = await holding(db, companyId);
  const fund = await fundFor(db, h, input.fundId);
  const amount = num(input.amountUsd);
  if (!amount || amount <= 0) throw new PortfolioInvalid("Enter the amount to distribute.");
  const r = await draftDistribution(db, fund.id, { grossUsd: amount, paidOn: isDay(input.paidOn) ? input.paidOn : today(), kind: "cash", companyId, purpose: text(input.purpose) ?? `Proceeds from ${h.name}` }, by);
  return { distributionId: r.distribution.id, fundId: fund.id, warnings: r.warnings };
}

// ---------------------------------------------------------------------------
// QSBS
// ---------------------------------------------------------------------------

export async function reviewQsbs(db: Db, companyId: string, investmentId: string, input: Record<string, unknown>, by: string) {
  const h = await holding(db, companyId);
  if (!h.investments.some((i) => i.id === investmentId)) throw new PortfolioInvalid("No such investment in this company.");
  const given = (input.checks ?? {}) as Record<string, unknown>;
  const checks = Object.fromEntries(QSBS_CHECKS.filter((c) => typeof given[c.key] === "boolean").map((c) => [c.key, given[c.key] as boolean]));
  const status = Object.values(checks).some((v) => v === false) ? "not_eligible" : QSBS_CHECKS.every((c) => checks[c.key] === true) ? "eligible" : "unclear";
  const note = text(input.note);
  if (status === "not_eligible" && !note) throw new PortfolioInvalid("Say which requirement fails and how you know.");
  await insertQsbsReview(db, { investmentId, checks, status, note }, by);
  return { status };
}

async function qsbsFor(db: Db, h: Holding, on: string) {
  const reviews = await latestQsbs(db);
  return h.investments.map((i) => ({
    investmentId: i.id, label: `${i.series_name ?? i.security}, ${i.close_date}`, fund: i.fund_name, basisUsd: i.amount_usd, acquiredOn: i.close_date,
    review: reviews.get(i.id) ?? null, result: qsbs({ acquiredOn: i.close_date, basisUsd: i.amount_usd }, on),
  }));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** One company's exit side: the plan, processes with bids, receivables, listed shares, QSBS, and money back. */
export async function companyExits(db: Db, companyId: string) {
  const h = await holding(db, companyId);
  const on = today();
  const xs = await exits(db, { companyId });
  const consentDecisions = await decisionsOf(db, ["exit_consent"], companyId);
  const listed = [];
  for (const p of await publicHoldings(db, companyId)) listed.push(await listedView(db, p.id));
  const real = await realizations(db, companyId);
  const received = real.filter((r) => r.amount_usd > 0 && r.kind !== "in_kind").reduce((a, r) => a + r.amount_usd, 0);
  return {
    plan: (await exitPlans(db, companyId))[0] ?? null,
    readiness: READINESS,
    processes: await Promise.all(xs.map(async (x) => ({ ...x, bids: await bids(db, x.id), consents: consentDecisions.filter((d) => (d.value as { exitId?: string }).exitId === x.id), needsConsent: NEEDS_CONSENT.has(x.kind) }))),
    receivables: (await receivables(db, { companyId })).map((r) => ({ ...r, valueUsd: receivableValue({ amountUsd: r.amount_usd, expectedPct: r.expected_pct, settledUsd: r.settled_usd, status: r.status }), overdue: (r.status === "pending" || r.status === "partial") && r.due_on < on })),
    listed,
    qsbs: await qsbsFor(db, h, on),
    qsbsChecks: QSBS_CHECKS,
    realizations: real,
    receivedUsd: round2(received),
    labels: EXIT_LABELS,
  };
}

/** Across the portfolio: processes, what's due to come back, listed shares, the forecast, and QSBS dates to watch. */
export async function liquidityOverview(db: Db) {
  const on = today();
  const hs = await holdings(db);
  const inputs = await valueInputs(db);
  const marks = await latestMarks(db);
  const allReal = await realizations(db);
  const plans = await exitPlans(db);
  const listed = [];
  for (const p of inputs.publicHoldings) listed.push(await listedView(db, p.id));
  const recs = inputs.receivables.filter((r) => r.status === "pending" || r.status === "partial").map((r) => ({ ...r, valueUsd: receivableValue({ amountUsd: r.amount_usd, expectedPct: r.expected_pct, settledUsd: r.settled_usd, status: r.status }), overdue: r.due_on < on }));
  const qsbsSoon: { company: string; companyId: string; label: string; next: { on: string; pct: number }; exclusionPct: number }[] = [];
  const reviews = await latestQsbs(db);
  for (const h of hs) {
    const v = holdingValue(h, marks.get(h.companyId), allReal.filter((r) => r.company_id === h.companyId), inputs);
    if (v.basis === "exited" && v.pendingUsd === 0) continue;
    for (const i of h.investments) {
      if (reviews.get(i.id)?.status === "not_eligible") continue;
      const q = qsbs({ acquiredOn: i.close_date, basisUsd: i.amount_usd }, on);
      if (q.next && Date.parse(q.next.on) - Date.parse(on) < 366 * 86_400_000) qsbsSoon.push({ company: h.name, companyId: h.companyId, label: `${i.series_name ?? i.security}, ${i.close_date}`, next: q.next, exclusionPct: q.exclusionPct });
    }
  }
  const active = hs.map((h) => h.companyId);
  const forecast = liquidityForecast({
    receivables: recs.map((r) => ({ amountUsd: r.valueUsd, dueOn: r.due_on })),
    publicHoldings: listed.filter((l) => l.valueUsd).map((l) => ({ valueUsd: l.valueUsd!, sellableFrom: l.window.earliestSale })),
    plannedExits: plans.filter((p) => active.includes(p.company_id) && p.target_year && p.base_usd && p.path !== "hold" && !inputs.exits.some((x) => x.company_id === p.company_id && x.stage === "closed" && ["acquisition", "ipo", "wind_down"].includes(x.kind)))
      .map((p) => ({ company: p.company_name ?? "", year: p.target_year!, valueUsd: p.base_usd!, probabilityPct: p.probability_pct ?? 50 })),
  }, on);
  // Cash received from each company that hasn't gone out to investors yet.
  const undistributed: { companyId: string; name: string; receivedUsd: number; distributedUsd: number }[] = [];
  const allFunds = await funds(db);
  const dist = (await Promise.all(allFunds.map((f) => distributions(db, f.id)))).flat().filter((d) => d.status !== "cancelled" && d.kind === "cash");
  for (const h of hs) {
    const received = allReal.filter((r) => r.company_id === h.companyId && r.amount_usd > 0 && r.kind !== "in_kind").reduce((a, r) => a + r.amount_usd, 0);
    const out = dist.filter((d) => d.company_id === h.companyId).reduce((a, d) => a + d.gross_usd, 0);
    if (received - out > 1) undistributed.push({ companyId: h.companyId, name: h.name, receivedUsd: round2(received), distributedUsd: round2(out) });
  }
  return {
    asOf: on,
    processes: inputs.exits.filter((x) => x.stage !== "closed" && x.stage !== "abandoned"),
    recent: inputs.exits.filter((x) => x.stage === "closed").slice(0, 10),
    plans,
    receivables: recs,
    listed,
    forecast,
    qsbsSoon: qsbsSoon.sort((a, b) => a.next.on.localeCompare(b.next.on)),
    undistributed,
    funds: allFunds.map((f) => ({ id: f.id, name: f.name })),
    totals: {
      pendingUsd: round2(recs.reduce((a, r) => a + r.valueUsd, 0)),
      listedUsd: round2(listed.reduce((a, l) => a + (l.valueUsd ?? 0), 0)),
      undistributedUsd: round2(undistributed.reduce((a, u) => a + u.receivedUsd - u.distributedUsd, 0)),
    },
    labels: EXIT_LABELS,
  };
}

// ---------------------------------------------------------------------------
// The fund's life, extensions, continuation vehicles and wind-down
// ---------------------------------------------------------------------------

async function fundOr404(db: Db, fundId: string) {
  const f = await getFund(db, fundId);
  if (!f) throw new PortfolioInvalid("No such fund.");
  return f;
}

export async function fundLifeView(db: Db, fundId: string) {
  const f = await fundOr404(db, fundId);
  const profile = (await getProfile(db))?.profile.fund;
  const saved = await getFundLife(db, fundId);
  const termYears = saved?.term_years ?? profile?.termYears ?? 10;
  const maxExt = saved?.max_extension_years ?? profile?.extensionYears ?? 2;
  const ext = await extensions(db, fundId);
  const on = today();
  const life = fundLife({ inception: f.inception, termYears, extensions: ext, maxExtensionYears: maxExt }, on);
  // What the fund still holds, from Portfolio's values for its companies.
  const inputs = await valueInputs(db);
  const marks = await latestMarks(db);
  const allReal = await realizations(db);
  const mine = (await holdings(db)).filter((h) => h.investments.some((i) => i.fund_name.toLowerCase() === f.name.toLowerCase()));
  const residual = mine.map((h) => {
    const v = holdingValue(h, marks.get(h.companyId), allReal.filter((r) => r.company_id === h.companyId), inputs);
    const share = fundShare(h.investments, f.name);
    return { companyId: h.companyId, name: h.name, ...v, value: round2(v.value * share), privateUsd: round2(v.privateUsd * share), pendingUsd: round2(v.pendingUsd * share), publicUsd: round2(v.publicUsd * share) };
  }).filter((r) => r.value > 0);
  const nav = round2(residual.reduce((a, r) => a + r.value, 0));
  const items = await windDownItems(db, fundId);
  const processes = [];
  const ps = await partners(db, fundId);
  for (const c of await cvs(db, fundId)) {
    const el = await elections(db, c.id);
    const lpNav = ps.filter((p) => p.kind !== "gp");
    const total = lpNav.reduce((a, p) => a + p.commitment_usd, 0);
    const tally = cvElections({
      launchedOn: c.launched_on, deadline: c.deadline, statusQuoOffered: c.status_quo_offered, pricePct: c.price_pct_of_nav,
      investors: lpNav.map((p) => ({ id: p.id, navUsd: round2(c.reference_nav_usd * (p.commitment_usd / total)) })), elections: el.map((e) => ({ id: e.partner_id, choice: e.choice })),
    }, on);
    const consent = c.lpac_consent_id ? await getConsent(db, c.lpac_consent_id) : null;
    processes.push({ ...c, tally, names: Object.fromEntries(lpNav.map((p) => [p.id, p.name])), lpacConsent: consent ? { topic: consent.topic, status: consent.status } : null });
  }
  return {
    fund: { id: f.id, name: f.name, inception: f.inception, vintage: f.vintage },
    termYears, maxExtensionYears: maxExt, configured: Boolean(saved), life, extensions: ext,
    residual, residualNavUsd: nav,
    options: tailOptions({ monthsLeft: life.monthsLeft, residualNavUsd: nav, holdings: residual.length, extensionYearsLeft: life.extensionYearsLeft, publicHoldings: residual.filter((r) => r.publicUsd > 0).length }),
    windDown: WIND_DOWN_STEPS.map((s) => ({ ...s, ...(items.find((i) => i.key === s.key) ?? { status: "open" as const, note: null, updated_by: null, updated_at: null }) })),
    continuation: processes,
    lpacConsents: (await consents(db, fundId)).map((c) => ({ id: c.id, topic: c.topic, status: c.status })),
    labels: EXIT_LABELS,
  };
}

export async function setFundLife(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  const term = num(input.termYears);
  const maxExt = num(input.maxExtensionYears) ?? 2;
  if (!term || term <= 0 || term > 30) throw new PortfolioInvalid("Enter the fund's term in years, as the LPA sets it.");
  if (maxExt < 0 || maxExt > 10) throw new PortfolioInvalid("Enter the most extension years the LPA allows.");
  await saveFundLife(db, fundId, term, maxExt, by);
}

/** Extend the term. Past what the GP can decide alone, it needs the LPAC's (or investors') consent, on record. */
export async function extendFund(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  const v = await fundLifeView(db, fundId);
  const years = num(input.years);
  if (!years || years <= 0 || years > 5) throw new PortfolioInvalid("Enter the extension in years.");
  if (years > v.life.extensionYearsLeft) throw new PortfolioInvalid(`The LPA allows ${v.life.extensionYearsLeft} more year${v.life.extensionYearsLeft === 1 ? "" : "s"} of extension; beyond that needs an amendment.`);
  const via = ofEnum<"gp" | "lpac" | "investors">(input.approvedVia, EXIT_LABELS.approvedVia, "Say who approved it.");
  const consentId = text(input.lpacConsentId);
  if (via === "lpac") {
    const c = consentId ? await getConsent(db, consentId) : null;
    if (!c || c.fund_id !== fundId) throw new PortfolioInvalid("Link the LPAC's consent (ask for it under Fundraising & IR, Investor relations).");
    if (c.status !== "approved") throw new PortfolioInvalid("The LPAC hasn't approved it yet.");
  }
  await insertExtension(db, { fundId, years, approvedVia: via, lpacConsentId: via === "lpac" ? consentId : null, feeChange: text(input.feeChange), note: text(input.note) }, by);
}

export async function setWindDownStep(db: Db, fundId: string, key: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  if (!WIND_DOWN_STEPS.some((s) => s.key === key)) throw new PortfolioInvalid("No such step.");
  const status = ofEnum<"open" | "done" | "na">(input.status, EXIT_LABELS.windDownStatus, "Pick the status.");
  const note = text(input.note);
  if (status === "na" && !note) throw new PortfolioInvalid("Say why it isn't needed.");
  await setWindDownItem(db, fundId, key, status, note, by);
}

/** Start a GP-led continuation vehicle process. The conflict goes to the LPAC; the terms are checked against ILPA's guidance. */
export async function startContinuation(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  const name = text(input.name);
  const lead = text(input.leadBuyer);
  if (!name || !lead) throw new PortfolioInvalid("Name the vehicle and the lead buyer.");
  const price = num(input.pricePctOfNav);
  const nav = num(input.referenceNavUsd);
  if (!price || price <= 0 || price > 200) throw new PortfolioInvalid("Enter the price as a percent of NAV.");
  if (!nav || nav <= 0) throw new PortfolioInvalid("Enter the reference NAV of the assets moving.");
  if (!isDay(input.launchedOn) || !isDay(input.deadline) || input.deadline <= input.launchedOn) throw new PortfolioInvalid("Enter the launch date and the election deadline after it.");
  const companyIds = Array.isArray(input.companyIds) ? (input.companyIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const c = await insertCv(db, {
    fund_id: fundId, name, lead_buyer: lead, company_ids: companyIds, price_pct_of_nav: price, reference_nav_usd: nav, launched_on: input.launchedOn, deadline: input.deadline,
    status_quo_offered: input.statusQuoOffered === true, fairness_opinion: text(input.fairnessOpinion), lpac_consent_id: text(input.lpacConsentId),
  }, by);
  const tally = cvElections({ launchedOn: c.launched_on, deadline: c.deadline, statusQuoOffered: c.status_quo_offered, pricePct: c.price_pct_of_nav, investors: [], elections: [] }, today());
  return { process: c, issues: tally.issues };
}

export async function recordElection(db: Db, processId: string, input: Record<string, unknown>, by: string) {
  const c = await getCv(db, processId);
  if (!c) throw new PortfolioInvalid("No such process.");
  if (c.status !== "open") throw new PortfolioInvalid("This process is over.");
  if (today() > c.deadline) throw new PortfolioInvalid("The election window has closed; investors who didn't elect are treated as selling.");
  const choice = ofEnum<"roll" | "sell" | "status_quo">(input.choice, EXIT_LABELS.elections, "Pick the investor's election.");
  if (choice === "status_quo" && !c.status_quo_offered) throw new PortfolioInvalid("This process doesn't offer a status quo option.");
  const partnerId = text(input.partnerId);
  if (!partnerId || !(await partners(db, c.fund_id)).some((p) => p.id === partnerId && p.kind !== "gp")) throw new PortfolioInvalid("Pick the investor.");
  await setElection(db, processId, partnerId, choice, by);
}

export async function finishContinuation(db: Db, processId: string, input: Record<string, unknown>, by: string) {
  const c = await getCv(db, processId);
  if (!c) throw new PortfolioInvalid("No such process.");
  if (c.status !== "open") throw new PortfolioInvalid("This process is over.");
  const status = input.status === "abandoned" ? "abandoned" : "closed";
  const fairness = text(input.fairnessOpinion) ?? c.fairness_opinion;
  const consentId = text(input.lpacConsentId) ?? c.lpac_consent_id;
  if (status === "closed") {
    if (today() <= c.deadline) throw new PortfolioInvalid(`Investors can elect until ${c.deadline}.`);
    if (!fairness) throw new PortfolioInvalid("Record the fairness opinion (who gave it, and its conclusion) before closing.");
    const consent = consentId ? await getConsent(db, consentId) : null;
    if (!consent || consent.status !== "approved") throw new PortfolioInvalid("The LPAC's approval of the conflict must be on record.");
  }
  await updateCv(db, processId, { status, fairnessOpinion: fairness, lpacConsentId: consentId }, by);
}
