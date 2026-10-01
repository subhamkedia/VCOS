import type { Db } from "../../lib/db.js";
import { recordDecision } from "../../ledger/repository.js";
import { insertInvestment } from "../../ledger/execution.js";
import { insertDeal, openDealFor, updateDeal, type FollowOn } from "../../ledger/diligence.js";
import { saveTermSheet } from "../execution/index.js";
import {
  getInitiative, insertBoardMeeting, insertInitiative, insertRealization, removeContact, updateInitiative, upsertContact,
  type BoardMeetingRow, type InitiativeRow, type RealizationRow,
} from "../../ledger/portfolio.js";
import { buildSeries, signals, suggestedHealth, summarize, type Health } from "../../engines/kpi.js";
import { isReady } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { holding, isDay, kpiClaims, PortfolioInvalid, today } from "./common.js";

/**
 * The judgment and the work of managing a portfolio: health ratings,
 * reserve plans and follow-on decisions (principle 5: judgment is data),
 * money back, board meetings, and the help the firm gives (value creation),
 * measured by outcome.
 */

export const HEALTH_LABELS: Record<Health, string> = { on_track: "On track", watch: "Watch", at_risk: "At risk" };

const text = (v: unknown, min = 0, max = 5000) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length >= min ? s.slice(0, max) : null;
};
const money = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && String(v ?? "") !== "" ? n : null;
};

/** A person rates the company; the signals' suggestion is kept next to it. */
export async function rateHealth(db: Db, companyId: string, input: { rating: unknown; rationale: unknown }, by: string) {
  await holding(db, companyId);
  const rating = input.rating as Health;
  if (!(rating in HEALTH_LABELS)) throw new PortfolioInvalid("Pick a rating.");
  const rationale = text(input.rationale, 10);
  if (!rationale) throw new PortfolioInvalid("Say why, in a sentence or two.");
  const sig = signals(summarize(buildSeries(await kpiClaims(db, companyId)), today()));
  return recordDecision(db, { entityId: companyId, kind: "health_rating", actor: by, value: { rating, suggested: suggestedHealth(sig), signals: sig.map((s) => s.key) }, rationale });
}

/** How much of the reserve pool is set aside for this company. A plan, not an obligation: re-underwrite each follow-on. */
export async function planReserve(db: Db, companyId: string, input: { amountUsd: unknown; rationale: unknown }, by: string) {
  await holding(db, companyId);
  const amount = money(input.amountUsd);
  if (amount === null) throw new PortfolioInvalid("Enter the amount to reserve (zero for none).");
  const rationale = text(input.rationale, 10);
  if (!rationale) throw new PortfolioInvalid("Say why: the round you expect and what it depends on.");
  return recordDecision(db, { entityId: companyId, kind: "reserve_plan", actor: by, value: { amountUsd: amount }, rationale });
}

/**
 * A follow-on decision on a new round: invest (pro rata or more), invest
 * less, or pass. Recorded either way; an investment also records the
 * follow-on check.
 */
export async function decideFollowOn(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  const h = await holding(db, companyId);
  const decision = input.decision;
  if (decision !== "invest" && decision !== "partial" && decision !== "pass") throw new PortfolioInvalid("Pick invest, invest less, or pass.");
  const round = text(input.roundName, 2, 100);
  if (!round) throw new PortfolioInvalid("Name the round (e.g. Series B Preferred).");
  if (!isDay(input.roundDate)) throw new PortfolioInvalid("Enter the round's closing date.");
  const rationale = text(input.rationale, 10);
  if (!rationale) throw new PortfolioInvalid("Say why: the follow-on is a new investment decision.");
  const amount = money(input.amountUsd);
  const proRata = money(input.proRataUsd);
  const preMoney = money(input.preMoneyUsd);
  if (decision !== "pass" && (!amount || amount <= 0)) throw new PortfolioInvalid("Enter the amount we invest.");
  const id = await recordDecision(db, {
    entityId: companyId, kind: "follow_on", actor: by, rationale,
    value: { decision, round, roundDate: input.roundDate, amountUsd: amount ?? 0, proRataUsd: proRata, preMoneyUsd: preMoney },
  });
  if (decision === "pass") return { decisionId: id, investmentId: null, dealId: null };
  const first = h.investments[0]!;
  const fund = text(input.fundName, 1, 200) ?? first.fund_name;
  if (input.alreadyClosed !== true) {
    // A new check is money out: it closes in Execution like any investment, behind the closing
    // checklist, Compliance's screening and the two-person wire controls. The partner's decision
    // stands in for IC unless they send it there.
    if (await openDealFor(db, companyId)) throw new PortfolioInvalid(`${h.name} already has an open deal; finish it in Investment Execution first.`);
    const followOn: FollowOn = { decisionId: id, round, roundDate: input.roundDate as string, amountUsd: amount!, fundName: fund, followOnOf: first.id, preMoneyUsd: preMoney, proRataUsd: proRata };
    const dealId = await insertDeal(db, { companyId, lead: by, flags: { follow_on: followOn }, createdBy: by, stage: input.toIc === true ? "ic" : "approved" });
    await updateDeal(db, dealId, { ourCheckUsd: amount! }, by);
    const roundSize = money(input.roundSizeUsd);
    if (preMoney && roundSize) {
      // A draft of the round's terms to start from; the team confirms them in Execution.
      await saveTermSheet(db, dealId, { terms: { security: "preferred", seriesName: round, preMoneyUsd: preMoney, raiseUsd: roundSize, ourAllocationUsd: amount }, note: "From the follow-on decision" }, by).catch(() => undefined);
    }
    return { decisionId: id, investmentId: null, dealId };
  }
  let investmentId: string | null = null;
  {
    const shares = money(input.shares);
    const price = money(input.pricePerShare);
    const roundSize = money(input.roundSizeUsd);
    const postMoney = preMoney !== null && roundSize !== null ? preMoney + roundSize : null;
    const inv = await insertInvestment(db, {
      // The fund investing: the one asked for (a later fund can follow on), else the first investment's.
      dealId: h.dealId, companyId, fundName: fund, security: String(input.security ?? "preferred"), seriesName: round, closeDate: input.roundDate as string,
      amountUsd: amount!, shares, pricePerShare: price, postMoneyUsd: postMoney,
      ownershipFdPct: money(input.ownershipPct), boardRole: first.board_role, rights: { followOnOf: first.id }, roundKind: "follow_on",
    }, by);
    investmentId = inv.id;
  }
  return { decisionId: id, investmentId, dealId: null };
}

export async function recordRealization(db: Db, companyId: string, input: Record<string, unknown>, by: string): Promise<RealizationRow> {
  await holding(db, companyId);
  const kind = input.kind as RealizationRow["kind"];
  if (!["sale", "partial_sale", "distribution", "dividend", "write_off"].includes(kind)) throw new PortfolioInvalid("Pick what happened.");
  if (!isDay(input.occurredOn)) throw new PortfolioInvalid("Enter the date.");
  const amount = kind === "write_off" ? 0 : money(input.amountUsd);
  if (amount === null) throw new PortfolioInvalid("Enter the amount the fund received.");
  return insertRealization(db, { companyId, occurredOn: input.occurredOn as string, amountUsd: amount, kind, note: text(input.note) }, by);
}

// ---------------------------------------------------------------------------
// Board meetings
// ---------------------------------------------------------------------------

/** Resolutions where preferred and common holders' interests can diverge. */
export const CONFLICT_KINDS = ["financing", "sale", "recapitalization", "down_round"] as const;
export const RESOLUTION_KINDS = ["financing", "sale", "recapitalization", "down_round", "budget", "option_grants", "executive", "auditor", "other"] as const;

export async function addBoardMeeting(db: Db, companyId: string, input: Record<string, unknown>, by: string): Promise<BoardMeetingRow> {
  await holding(db, companyId);
  if (!isDay(input.heldOn)) throw new PortfolioInvalid("Enter the meeting date.");
  const kind = (input.kind ?? "regular") as BoardMeetingRow["kind"];
  if (!["regular", "special", "annual", "written_consent"].includes(kind)) throw new PortfolioInvalid("Unknown meeting type.");
  const ourRole = (input.ourRole ?? "director") as BoardMeetingRow["our_role"];
  if (!["director", "observer", "none"].includes(ourRole)) throw new PortfolioInvalid("Unknown role.");
  const resolutions = (Array.isArray(input.resolutions) ? input.resolutions : []).map((r) => {
    const x = r as Record<string, unknown>;
    const title = text(x.title, 2, 300);
    if (!title) throw new PortfolioInvalid("Each resolution needs a title.");
    const k = String(x.kind ?? "other");
    if (!(RESOLUTION_KINDS as readonly string[]).includes(k)) throw new PortfolioInvalid("Unknown resolution type.");
    const outcome = String(x.outcome ?? "approved");
    if (!["approved", "rejected", "deferred"].includes(outcome)) throw new PortfolioInvalid("Unknown outcome.");
    return { title, kind: k, outcome };
  });
  const conflictReview = text(input.conflictReview);
  // In re Trados (Del. Ch. 2013): a fund's director owes duties to common too.
  if (resolutions.some((r) => (CONFLICT_KINDS as readonly string[]).includes(r.kind)) && (!conflictReview || conflictReview.length < 20)) {
    throw new PortfolioInvalid("This meeting decided a financing, sale or recapitalization: record how the board handled the preferred and common holders' different interests (independent approval, a fairness process, recusal).");
  }
  const attendees = (Array.isArray(input.attendees) ? input.attendees : String(input.attendees ?? "").split(",")).map((a) => String(a).trim()).filter(Boolean);
  return insertBoardMeeting(db, {
    companyId, heldOn: input.heldOn as string, kind, ourRole, attendees, agenda: text(input.agenda), notes: text(input.notes, 0, 50_000), resolutions, conflictReview,
  }, by);
}

// ---------------------------------------------------------------------------
// Value creation
// ---------------------------------------------------------------------------

export const INITIATIVE_KINDS = ["hiring", "customer_intro", "partnership", "fundraising", "strategy", "operations", "government", "technical", "other"] as const;

export async function addInitiative(db: Db, companyId: string, input: Record<string, unknown>, by: string): Promise<InitiativeRow> {
  await holding(db, companyId);
  const kind = String(input.kind ?? "");
  if (!(INITIATIVE_KINDS as readonly string[]).includes(kind)) throw new PortfolioInvalid("Pick the kind of help.");
  const title = text(input.title, 3, 200);
  if (!title) throw new PortfolioInvalid("Give it a title.");
  if (input.dueOn && !isDay(input.dueOn)) throw new PortfolioInvalid("The due date should be a date.");
  return insertInitiative(db, { companyId, kind, title, detail: text(input.detail), owner: text(input.owner), dueOn: (input.dueOn as string) || null }, by);
}

export async function setInitiative(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const i = await getInitiative(db, id);
  if (!i) throw new PortfolioInvalid("No such initiative.");
  const status = input.status as InitiativeRow["status"] | undefined;
  if (status && !["proposed", "in_progress", "done", "dropped"].includes(status)) throw new PortfolioInvalid("Unknown status.");
  const outcome = input.outcome === undefined ? undefined : text(input.outcome);
  if (status === "done" && !(outcome ?? i.outcome)) throw new PortfolioInvalid("Say what came of it: the outcome is how help is measured.");
  const value = input.valueUsd === undefined || input.valueUsd === "" ? undefined : money(input.valueUsd);
  await updateInitiative(db, id, { status, outcome, valueUsd: value, owner: input.owner === undefined ? undefined : text(input.owner) }, by);
}

/**
 * A double opt-in introduction: an email draft in the firm's mailbox, to
 * the founder and the person being introduced, for a person to send.
 */
export async function queueIntro(db: Db, id: string, input: { to: unknown; subject: unknown; body: unknown }, by: string) {
  const i = await getInitiative(db, id);
  if (!i) throw new PortfolioInvalid("No such initiative.");
  const to = (Array.isArray(input.to) ? input.to : String(input.to ?? "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!to.length || to.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw new PortfolioInvalid("Enter the email addresses.");
  const subject = text(input.subject, 3, 300);
  const body = text(input.body, 10, 20_000);
  if (!subject || !body) throw new PortfolioInvalid("Write the subject and the note.");
  const channel = (await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null;
  if (!channel) throw new PortfolioInvalid("Connect Gmail or Outlook first, so the draft can be created in your mailbox.");
  const outboxId = await queue(db, channel, { to, subject, body }, { summary: `Intro: ${i.title}`, proposedBy: by, entityId: i.company_id });
  await updateInitiative(db, id, { outboxId, status: i.status === "proposed" ? "in_progress" : undefined }, by);
  return { outboxId, channel };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function addContact(db: Db, companyId: string, input: Record<string, unknown>, by: string) {
  await holding(db, companyId);
  const name = text(input.name, 2, 200);
  const email = text(input.email, 3, 300)?.toLowerCase();
  if (!name) throw new PortfolioInvalid("Enter the name.");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PortfolioInvalid("Enter a valid email.");
  return upsertContact(db, companyId, { name, email, role: text(input.role), reporting: Boolean(input.reporting) }, by);
}

export async function deleteContact(db: Db, companyId: string, id: string, by: string) {
  await removeContact(db, companyId, id, by);
}
