import { z } from "zod";
import type { Db } from "../../lib/db.js";
import { audit, currentClaims, getEntity, insertClaim, insertEvidence, recordDecision, PASS_REASONS } from "../../ledger/repository.js";
import { getDeal, listDeals, updateDeal, type DealRow } from "../../ledger/diligence.js";
import {
  closingItems, getIcMeeting, getWire, icMeetings, icVotes, insertCapTable, insertCustomClosingItem, insertIcMeeting, insertInvestment, insertTermSheet,
  insertWire, latestCapTable, listInvestments, seedClosingItems, setTermSheetStatus, termSheets, updateClosingItem, updateIcMeeting, updateWire, wires,
  type ClosingStatus, type IcMeetingRow, type TermSheetStatus,
} from "../../ledger/execution.js";
import { formatValue, predicateLabel } from "../../ledger/labels.js";
import { proForma, holdingsAfter, shadowSeries, type Holding, type Note, type ProForma, type Safe } from "../../engines/cap-table.js";
import { exitScenarios, type CommonClass, type PreferredSeries } from "../../engines/waterfall.js";
import { capTableFromCsv, cartaCapTableHoldings } from "../../connectors/carta.js";
import { closingStatusFor, docusignEnvelopes } from "../../connectors/docusign.js";
import { sanctionsLists, screen, type SanctionsEntry } from "../../connectors/ofac.js";
import { assertScreeningCleared } from "../compliance/gate.js";
import { getProfile, type FirmProfile } from "../firm/profile.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { checkTerms, HOUSE_DEFAULTS, TermSheet, type TermCheck } from "./terms.js";
import { tally, shifts, RULE_LABELS, type Ballot, type Rule, type Vote } from "./ic.js";
import { CATEGORY_LABELS, closingTemplate, readyToClose } from "./closing.js";

export { RULE_LABELS, CATEGORY_LABELS };
export { STANDING_LABELS } from "./terms.js";

/**
 * Investment Execution: from IC to a closed investment.
 *
 * - Term sheets as structured, versioned terms, each term checked against
 *   the NVCA model and the firm's house terms.
 * - The company's cap table (entered, imported from a Carta or Pulley
 *   export, or pulled from Carta), and the pro forma after the round with
 *   SAFE and note conversion and the option pool, computed in engines/.
 * - Exit scenarios through the waterfall: what the fund gets at each exit.
 * - The IC meeting: independent votes before discussion, votes after, the
 *   firm's approval rule applied in code, recusals recorded.
 * - The closing checklist, with DocuSign signature status, OFAC sanctions
 *   screening, and wire controls: a call-back to a known number and two
 *   approvals. VC OS never moves money or sends a document.
 * - The investment record the Portfolio module starts from.
 */

export class ExecutionInvalid extends Error {}

const invalid = (e: z.ZodError) => new ExecutionInvalid(e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));

async function need(db: Db, dealId: string): Promise<DealRow> {
  const d = await getDeal(db, dealId);
  if (!d) throw new ExecutionInvalid("No such deal.");
  return d;
}

const erisa = (p: FirmProfile | undefined) => Boolean(p?.fund.lpTypes.some((t) => /institutional|pension|endow/i.test(t)));
const firmName = (p: FirmProfile | undefined) => p?.firm.name ?? "Our fund";

// ---------------------------------------------------------------------------
// Term sheets
// ---------------------------------------------------------------------------

export async function saveTermSheet(db: Db, dealId: string, input: { terms: unknown; status?: TermSheetStatus; note?: string }, by: string) {
  const d = await need(db, dealId);
  if (["passed", "closed"].includes(d.stage)) throw new ExecutionInvalid("This deal is decided.");
  const parsed = TermSheet.safeParse(input.terms);
  if (!parsed.success) throw invalid(parsed.error);
  const t = parsed.data;
  if (t.security === "preferred" && !(t.preMoneyUsd && t.raiseUsd)) throw new ExecutionInvalid("A priced round needs a pre-money valuation and a round size.");
  if (t.security !== "preferred" && !(t.valuationCapUsd || t.discountPct || t.mfn)) throw new ExecutionInvalid("A SAFE or note needs a cap, a discount or an MFN clause.");
  if (t.ourAllocationUsd && t.raiseUsd && t.ourAllocationUsd > t.raiseUsd) throw new ExecutionInvalid("Our allocation is bigger than the round.");
  const row = await insertTermSheet(db, dealId, { terms: t, status: input.status ?? "draft", source: "entered", note: input.note }, by);
  if (row.status === "signed") await recordSignedTerms(db, d, row.version, t, by);
  return row;
}

export async function setTermStatus(db: Db, dealId: string, version: number, status: TermSheetStatus, by: string) {
  const d = await need(db, dealId);
  const row = (await termSheets(db, dealId)).find((x) => x.version === version);
  if (!row) throw new ExecutionInvalid("No such term sheet version.");
  await setTermSheetStatus(db, dealId, version, status, by);
  if (status === "signed") await recordSignedTerms(db, d, version, TermSheet.parse(row.terms), by);
}

/** A signed term sheet's economics are facts about the round: claims from a primary source. */
async function recordSignedTerms(db: Db, d: DealRow, version: number, t: TermSheet, by: string) {
  const lines: [string, unknown, string][] = [];
  if (t.raiseUsd) lines.push(["raise.amount", t.raiseUsd, `Round size: ${formatValue("raise.amount", t.raiseUsd)}.`]);
  if (t.preMoneyUsd) lines.push(["raise.pre_money", t.preMoneyUsd, `Pre-money valuation: ${formatValue("raise.pre_money", t.preMoneyUsd)}.`]);
  if (t.leadInvestor) lines.push(["raise.lead_investor", t.leadInvestor, `Lead investor: ${t.leadInvestor}.`]);
  const stage = /seed/i.test(t.seriesName) ? "seed" : /series a/i.test(t.seriesName) ? "series_a" : /series b/i.test(t.seriesName) ? "series_b" : /series c/i.test(t.seriesName) ? "series_c" : null;
  if (stage) lines.push(["raise.stage", stage, `Stage: ${formatValue("raise.stage", stage)}.`]);
  if (!lines.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const content = `Signed term sheet (version ${version}) for ${d.company_name}, recorded by ${by.replace(/^human:/, "")} on ${date}.\n${lines.map((l) => l[2]).join("\n")}`;
  const { evidence } = await insertEvidence(db, {
    kind: "document", source: "term-sheet", uri: `term-sheet:${d.id}:v${version}`, title: `Signed term sheet v${version}`, content, occurredAt: date,
    accessScope: "confidential", metadata: { companyId: d.company_id, dealId: d.id, version },
  }, by);
  for (const [predicate, value, cited] of lines) {
    const at = content.indexOf(cited);
    await insertClaim(db, {
      subjectId: d.company_id, predicate, value, asOf: date, evidenceId: evidence.id, sourceType: "primary", confidence: 0.97,
      extractedBy: by, spanStart: at, spanEnd: at + cited.length, citedText: cited,
    }).catch(() => undefined); // the same value twice is fine to skip
  }
  await updateClosingItem(db, d.id, "term_sheet_signed", { status: "signed" }, by).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Cap table
// ---------------------------------------------------------------------------

const HoldingSchema = z.object({ holder: z.string().trim().min(1), className: z.string().trim().min(1), shares: z.number().nonnegative(), kind: z.enum(["common", "preferred", "options", "pool"]) });
const SafeSchema = z.object({ holder: z.string().trim().min(1), amount: z.number().positive(), kind: z.enum(["post", "pre", "mfn"]), cap: z.number().positive().optional(), discountPct: z.number().min(0).max(100).optional() });
const NoteSchema = z.object({ holder: z.string().trim().min(1), principal: z.number().positive(), ratePct: z.number().min(0).max(100), issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), cap: z.number().positive().optional(), discountPct: z.number().min(0).max(100).optional() });
const SeriesSchema = z.object({ name: z.string().trim().min(1), issuePrice: z.number().positive(), multiple: z.number().min(0).default(1), participating: z.boolean().default(false), capMultiple: z.number().min(1).optional(), seniority: z.number().int().min(1).default(2) });
const CapInput = z.object({ holdings: z.array(HoldingSchema).min(1), safes: z.array(SafeSchema).default([]), notes: z.array(NoteSchema).default([]), seriesTerms: z.array(SeriesSchema).default([]) });

export async function saveCapTable(db: Db, dealId: string, input: unknown, by: string, source: "entered" | "csv" | "carta" = "entered", evidenceId?: string) {
  await need(db, dealId);
  const p = CapInput.safeParse(input);
  if (!p.success) throw invalid(p.error);
  if (!p.data.holdings.some((h) => h.shares > 0)) throw new ExecutionInvalid("The cap table has no shares.");
  return insertCapTable(db, dealId, { ...p.data, source, evidenceId }, by);
}

/** Import a cap table export (Carta, Pulley, spreadsheet). The file is kept as confidential evidence. */
export async function importCapTableCsv(db: Db, dealId: string, file: { name: string; text: string }, by: string, keep: { safes?: Safe[]; notes?: Note[]; seriesTerms?: unknown[] } = {}) {
  const d = await need(db, dealId);
  const { holdings, skipped } = capTableFromCsv(file.text);
  const { evidence } = await insertEvidence(db, {
    kind: "document", source: "cap-table-file", uri: `file:${file.name}`, title: `Cap table: ${file.name}`, content: file.text.slice(0, 500_000),
    accessScope: "confidential", metadata: { companyId: d.company_id, dealId },
  }, by);
  const prior = await latestCapTable(db, dealId);
  const row = await saveCapTable(db, dealId, {
    holdings, safes: keep.safes ?? prior?.safes ?? [], notes: keep.notes ?? prior?.notes ?? [], seriesTerms: keep.seriesTerms ?? prior?.series_terms ?? [],
  }, by, "csv", evidence.id);
  return { ...row, skipped };
}

/** Pull a cap table Carta shares with the firm (Investor API). */
export async function importCartaCapTable(db: Db, dealId: string, ids: { firmId: string; fundId: string; companyId: string; capTableId: string }, by: string, fetchJson?: (path: string) => Promise<unknown>) {
  await need(db, dealId);
  if (!fetchJson && !(await isReady(db, "carta"))) throw new ExecutionInvalid("Connect Carta first, or import a cap table file.");
  const path = `/investors/firms/${encodeURIComponent(ids.firmId)}/funds/${encodeURIComponent(ids.fundId)}/investments/${encodeURIComponent(ids.companyId)}/capitalizationTables/${encodeURIComponent(ids.capTableId)}`;
  const json = fetchJson ? await fetchJson(path) : await withFirmCredentials(db, ["carta"], async () => {
    const { setting } = await import("../../lib/config.js");
    const { requestJson } = await import("../../connectors/http.js");
    const base = (setting("cartaApiBase") || "https://api.carta.com").replace(/\/$/, "");
    const tokenRes = await requestJson<{ access_token?: string }>("carta", "https://login.app.carta.com/o/access_token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${setting("cartaClientId")}:${setting("cartaClientSecret")}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "read_investor_capitalizationtables" }),
    });
    return requestJson("carta", `${base}/v1alpha1${path}`, { headers: { Authorization: `Bearer ${tokenRes.access_token}` } });
  });
  const holdings = cartaCapTableHoldings(json);
  if (!holdings.length) throw new ExecutionInvalid("Carta returned a cap table with no holdings.");
  const prior = await latestCapTable(db, dealId);
  return saveCapTable(db, dealId, { holdings, safes: prior?.safes ?? [], notes: prior?.notes ?? [], seriesTerms: prior?.series_terms ?? [] }, by, "carta");
}

// ---------------------------------------------------------------------------
// The model: pro forma and returns
// ---------------------------------------------------------------------------

export interface Model {
  proForma: ProForma | null;
  ours: { holder: string; amount: number; shares: number; postPct: number } | null;
  scenarios: { exit: number; proceeds: number; multiple: number; converted: boolean }[];
  error: string | null;
  basedOn: { termSheetVersion: number | null; capTableVersion: number | null };
  /** Every class after the round, for waterfalls (exit scenarios here, fair value marks in Portfolio). */
  classes?: { prefs: PreferredSeries[]; commons: CommonClass[]; ourSeries: string; ourShares: number };
}

export async function model(db: Db, dealId: string): Promise<Model> {
  const cap = await latestCapTable(db, dealId);
  const ts = (await termSheets(db, dealId)).find((x) => x.status !== "superseded") ?? null;
  const basedOn = { termSheetVersion: ts?.version ?? null, capTableVersion: cap?.version ?? null };
  const empty = (error: string | null): Model => ({ proForma: null, ours: null, scenarios: [], error, basedOn });
  if (!cap || !ts) return empty(!cap ? "Add the company's cap table to model the round." : "Add a term sheet to model the round.");
  const t = TermSheet.parse(ts.terms);
  if (t.security !== "preferred") return empty("SAFEs and notes convert at the next priced round; model that round when its terms are known.");
  const profile = (await getProfile(db))?.profile;
  const us = firmName(profile);
  const ours = t.ourAllocationUsd ?? 0;
  const others = (t.raiseUsd ?? 0) - ours;
  const investments = [...(ours > 0 ? [{ holder: us, amount: ours }] : []), ...(others > 0 ? [{ holder: "Other investors in the round", amount: others }] : [])];
  try {
    const p = proForma(cap.holdings as Holding[], cap.safes as Safe[], cap.notes as Note[], {
      seriesName: t.seriesName, preMoney: t.preMoneyUsd!, investments, poolTargetPostPct: t.poolTopUpPostPct, closeDate: new Date().toISOString().slice(0, 10),
    });
    const mine = p.newShares.find((n) => n.holder === us);
    // Waterfall classes after the round.
    const after = holdingsAfter(p, cap.holdings as Holding[], t.seriesName);
    const seriesTerms = (cap.series_terms as z.infer<typeof SeriesSchema>[]) ?? [];
    const newRank = t.liquidation.seniority === "pari_passu" ? 2 : 1;
    const prefs: PreferredSeries[] = [
      ...seriesTerms.map((s) => ({ name: s.name, shares: after.filter((h) => h.kind === "preferred" && h.className === s.name).reduce((a, h) => a + h.shares, 0), issuePrice: s.issuePrice, multiple: s.multiple, participating: s.participating, capMultiple: s.capMultiple, seniority: s.seniority })),
      { name: t.seriesName, shares: after.filter((h) => h.className === t.seriesName).reduce((a, h) => a + h.shares, 0), issuePrice: p.pricePerShare, multiple: t.liquidation.multiple, participating: t.liquidation.participation !== "none", capMultiple: t.liquidation.participation === "capped" ? t.liquidation.capMultiple : undefined, seniority: newRank },
      // Converted SAFEs and notes: same rights, preference at their conversion price.
      ...p.conversions.map((c) => ({ name: shadowSeries(t.seriesName, c), shares: c.shares, issuePrice: c.price, multiple: t.liquidation.multiple, participating: t.liquidation.participation !== "none", capMultiple: t.liquidation.participation === "capped" ? t.liquidation.capMultiple : undefined, seniority: newRank })),
    ].filter((s) => s.shares > 0);
    const known = new Set(prefs.map((s) => s.name));
    const commons: CommonClass[] = [{
      name: "Common and options",
      shares: after.filter((h) => h.kind === "common" || h.kind === "options" || (h.kind === "preferred" && !known.has(h.className))).reduce((a, h) => a + h.shares, 0),
    }];
    const post = p.postMoneyImplied;
    const scenarios = mine
      ? exitScenarios([0.25, 0.5, 1, 2, 3, 5, 10].map((m) => Math.round(post * m)), prefs, commons, { series: t.seriesName, shares: mine.shares, invested: mine.amount })
      : [];
    return {
      proForma: p, basedOn, error: null,
      ours: mine ? { holder: us, amount: mine.amount, shares: mine.shares, postPct: (mine.shares / p.postMoneyFullyDiluted) * 100 } : null,
      scenarios: scenarios.map(({ exit, proceeds, multiple, converted }) => ({ exit, proceeds, multiple, converted })),
      classes: mine ? { prefs, commons, ourSeries: t.seriesName, ourShares: mine.shares } : undefined,
    };
  } catch (err) {
    return empty((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Investment committee
// ---------------------------------------------------------------------------

export async function scheduleIc(db: Db, dealId: string, input: { members: string[]; chair?: string; scheduledFor?: string; memoVersion?: number; termSheetVersion?: number }, by: string) {
  const d = await need(db, dealId);
  if (d.stage !== "ic") throw new ExecutionInvalid("Send the deal to IC from Diligence first.");
  const open = (await icMeetings(db, dealId)).find((m) => m.phase !== "decided" && m.phase !== "cancelled");
  if (open) throw new ExecutionInvalid("There's already an IC meeting open for this deal.");
  const members = [...new Set(input.members.map((m) => (m.startsWith("human:") ? m : `human:${m}`).toLowerCase()))];
  if (members.length < 1) throw new ExecutionInvalid("Add the IC members.");
  const chair = input.chair ? (input.chair.startsWith("human:") ? input.chair : `human:${input.chair}`).toLowerCase() : by;
  const rule = ((await getProfile(db))?.profile.fund.icApproval ?? "majority") as Rule;
  return insertIcMeeting(db, dealId, { members, chair, rule, scheduledFor: input.scheduledFor ?? null, memoVersion: input.memoVersion ?? null, termSheetVersion: input.termSheetVersion ?? null }, by);
}

const VoteInput = z.object({ vote: z.enum(["yes", "no", "abstain"]), conviction: z.number().int().min(1).max(5), note: z.string().max(5000).optional() });

async function meetingOf(db: Db, meetingId: string): Promise<IcMeetingRow & { deal: DealRow }> {
  const m = await getIcMeeting(db, meetingId);
  if (!m) throw new ExecutionInvalid("No such IC meeting.");
  return { ...m, deal: await need(db, m.deal_id) };
}

/** A member's vote. Before discussion it's independent and hidden from everyone until the chair opens discussion. */
export async function castVote(db: Db, meetingId: string, input: unknown, by: string) {
  const m = await meetingOf(db, meetingId);
  if (!m.members.includes(by)) throw new ExecutionInvalid("Only IC members of this meeting vote.");
  const phase = m.phase === "pre_vote" ? "ic_vote_pre" : m.phase === "post_vote" ? "ic_vote_post" : null;
  if (!phase) throw new ExecutionInvalid(m.phase === "discussion" ? "Discussion is open: final votes open when the chair calls them." : "Voting is closed.");
  const p = VoteInput.safeParse(input);
  if (!p.success) throw invalid(p.error);
  const mine = (await icVotes(db, meetingId)).filter((v) => v.actor === by && v.kind === phase);
  if (mine.some((v) => v.value.vote === "recused")) throw new ExecutionInvalid("You recused yourself from this deal.");
  if (mine.length) throw new ExecutionInvalid("You've already voted in this round. Change your mind after discussion, in the final vote.");
  await recordDecision(db, { entityId: m.deal.company_id, kind: phase, actor: by, value: { vote: p.data.vote, conviction: p.data.conviction, meetingId, note: p.data.note ?? null }, rationale: p.data.note });
}

export async function recuse(db: Db, meetingId: string, reason: string, by: string) {
  const m = await meetingOf(db, meetingId);
  if (!m.members.includes(by)) throw new ExecutionInvalid("Only IC members of this meeting can recuse.");
  if (!reason?.trim()) throw new ExecutionInvalid("Say what the conflict is.");
  if (m.phase === "decided") throw new ExecutionInvalid("The meeting is decided.");
  for (const kind of ["ic_vote_pre", "ic_vote_post"] as const) {
    await recordDecision(db, { entityId: m.deal.company_id, kind, actor: by, value: { vote: "recused", meetingId, recused: true }, rationale: reason.trim() });
  }
}

/**
 * The chair moves the meeting on: votes in -> discussion -> final votes ->
 * decided. Deciding applies the firm's rule to the final votes; approval
 * moves the deal to closing prep, a decline records a pass with its reason.
 */
export async function advanceIc(db: Db, meetingId: string, input: { notes?: string; passReason?: (typeof PASS_REASONS)[number]; passRationale?: string }, by: string) {
  const m = await meetingOf(db, meetingId);
  if (by !== m.chair) throw new ExecutionInvalid("Only the chair moves the meeting on.");
  const votes = await icVotes(db, meetingId);
  if (m.phase === "pre_vote") {
    const voted = new Set(votes.filter((v) => v.kind === "ic_vote_pre").map((v) => v.actor));
    const missing = m.members.filter((x) => !voted.has(x));
    if (missing.length) throw new ExecutionInvalid(`Waiting for independent votes from ${missing.map((x) => x.replace(/^human:/, "")).join(", ")}.`);
    await updateIcMeeting(db, meetingId, { phase: "discussion", notes: input.notes }, by);
    return getIcMeeting(db, meetingId);
  }
  if (m.phase === "discussion") {
    await updateIcMeeting(db, meetingId, { phase: "post_vote", notes: input.notes }, by);
    return getIcMeeting(db, meetingId);
  }
  if (m.phase === "post_vote") {
    const post: Ballot[] = votes.filter((v) => v.kind === "ic_vote_post").map((v) => ({ member: v.actor, vote: v.value.vote as Vote, conviction: v.value.conviction }));
    const t = tally(m.rule as Rule, m.members, post, m.chair);
    if (t.outcome === "no_quorum") throw new ExecutionInvalid(`No decision yet: ${t.detail}`);
    if (t.outcome === "declined" && !input.passReason) throw new ExecutionInvalid(`The committee declined (${t.detail}) Record the main reason to close the meeting.`);
    await updateIcMeeting(db, meetingId, { phase: "decided", outcome: t.outcome, notes: input.notes }, by);
    if (t.outcome === "approved") {
      await recordDecision(db, { entityId: m.deal.company_id, kind: "advance", actor: by, value: { dealId: m.deal_id, to: "approved", meetingId, tally: t, rule: m.rule }, rationale: `IC approved: ${t.detail}` });
      await updateDeal(db, m.deal_id, { stage: "approved" }, by);
    } else {
      await recordDecision(db, { entityId: m.deal.company_id, kind: "pass", actor: by, reasonCode: input.passReason, rationale: input.passRationale ?? `IC declined: ${t.detail}`, value: { dealId: m.deal_id, meetingId, tally: t, rule: m.rule } });
      await updateDeal(db, m.deal_id, { stage: "passed" }, by);
    }
    return getIcMeeting(db, meetingId);
  }
  throw new ExecutionInvalid("This meeting is closed.");
}

export async function cancelIc(db: Db, meetingId: string, by: string) {
  const m = await meetingOf(db, meetingId);
  if (by !== m.chair) throw new ExecutionInvalid("Only the chair cancels the meeting.");
  if (m.phase === "decided") throw new ExecutionInvalid("The meeting is decided.");
  await updateIcMeeting(db, meetingId, { phase: "cancelled" }, by);
}

/** A meeting as a viewer may see it: before discussion, others' pre-votes are hidden (only who has voted shows). */
async function meetingView(db: Db, m: IcMeetingRow, viewer: string) {
  const votes = await icVotes(db, m.id);
  const hidden = m.phase === "pre_vote";
  const pre = votes.filter((v) => v.kind === "ic_vote_pre");
  const post = votes.filter((v) => v.kind === "ic_vote_post");
  const ballot = (v: (typeof votes)[number]): Ballot => ({ member: v.actor, vote: v.value.vote as Vote, conviction: v.value.conviction });
  const show = (v: (typeof votes)[number]) => ({ member: v.actor, vote: v.value.vote, conviction: v.value.conviction ?? null, note: v.value.note ?? v.rationale ?? null, at: v.created_at });
  return {
    ...m,
    ruleLabel: RULE_LABELS[m.rule as Rule] ?? m.rule,
    voted: { pre: pre.map((v) => v.actor), post: post.map((v) => v.actor) },
    preVotes: hidden ? pre.filter((v) => v.actor === viewer).map(show) : pre.map(show),
    postVotes: post.map(show),
    preTally: hidden ? null : tally(m.rule as Rule, m.members, pre.map(ballot), m.chair),
    postTally: m.phase === "post_vote" || m.phase === "decided" ? tally(m.rule as Rule, m.members, post.map(ballot), m.chair) : null,
    shifts: m.phase === "decided" || m.phase === "post_vote" ? shifts(pre.map(ballot), post.map(ballot)) : [],
    isMember: m.members.includes(viewer),
    isChair: m.chair === viewer,
  };
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

async function flags(db: Db, d: DealRow) {
  const profile = (await getProfile(db))?.profile;
  return { profile, erisaLps: erisa(profile), sensitiveTech: Boolean(d.flags.sensitive_tech) };
}

/** Start closing an approved deal: the checklist is built from the signed (or latest) terms. */
export async function startClosing(db: Db, dealId: string, by: string) {
  const d = await need(db, dealId);
  if (d.stage !== "approved" && d.stage !== "closing") throw new ExecutionInvalid("Closing starts after IC approves the deal.");
  await refreshChecklist(db, d, by);
  if (d.stage === "approved") await updateDeal(db, dealId, { stage: "closing" }, by);
}

async function checklistTemplate(db: Db, d: DealRow) {
  const ts = (await termSheets(db, d.id)).find((x) => x.status === "signed") ?? (await termSheets(db, d.id))[0];
  const t = ts ? TermSheet.parse(ts.terms) : TermSheet.parse({ security: "preferred" });
  const f = await flags(db, d);
  return { template: closingTemplate(t, { sensitiveTech: f.sensitiveTech, erisaLps: f.erisaLps }), signed: ts?.status === "signed" };
}

async function refreshChecklist(db: Db, d: DealRow, by: string) {
  const { template, signed } = await checklistTemplate(db, d);
  await seedClosingItems(db, d.id, template, by);
  if (signed) await updateClosingItem(db, d.id, "term_sheet_signed", { status: "signed" }, by).catch(() => undefined);
}

/** Checklist items in working order (the template's), with items people added last. */
async function orderedItems(db: Db, d: DealRow) {
  const items = await closingItems(db, d.id);
  const { template } = await checklistTemplate(db, d);
  const rank = new Map(template.map((t, i) => [t.key, i]));
  return items.sort((a, b) => (rank.get(a.key) ?? 1e6) - (rank.get(b.key) ?? 1e6) || a.updated_at.localeCompare(b.updated_at));
}

const CLOSING_STATUSES: ClosingStatus[] = ["open", "requested", "received", "signed", "filed", "done", "waived", "na", "red_flag"];

export async function updateItem(db: Db, dealId: string, key: string, patch: { status?: ClosingStatus; owner?: string | null; dueDate?: string | null; note?: string | null; envelopeId?: string | null }, by: string) {
  await need(db, dealId);
  if (patch.status && !CLOSING_STATUSES.includes(patch.status)) throw new ExecutionInvalid("Unknown status.");
  if ((patch.status === "waived" || patch.status === "na" || patch.status === "red_flag") && !patch.note?.trim()) throw new ExecutionInvalid("Say why.");
  if (patch.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) throw new ExecutionInvalid("Due date should be YYYY-MM-DD.");
  if (patch.envelopeId && !/^[0-9a-f-]{36}$/i.test(patch.envelopeId)) throw new ExecutionInvalid("That doesn't look like a DocuSign envelope id.");
  // Funding steps only change through the wire controls.
  if (["wire_callback", "wire_approvals", "funds_sent"].includes(key) && patch.status && patch.status !== "open") throw new ExecutionInvalid("This step completes from the wire record, not by hand.");
  await updateClosingItem(db, dealId, key, patch, by);
}

export async function addClosingItem(db: Db, dealId: string, input: { title: string; category?: string; required?: boolean }, by: string) {
  await need(db, dealId);
  const title = input.title?.trim();
  if (!title) throw new ExecutionInvalid("Give the item a title.");
  const key = `custom:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}:${Date.now().toString(36)}`;
  await insertCustomClosingItem(db, dealId, { key, category: input.category ?? "documents", title, required: input.required ?? false }, by);
  return key;
}

/**
 * Screen the company, its founders, its legal name and the round's lead
 * against OFAC's lists. The result is kept as internal evidence; no match
 * completes the item, a potential match flags it for a person.
 */
export async function screenSanctions(db: Db, dealId: string, by: string, deps: { lists?: () => Promise<{ entries: SanctionsEntry[]; fetchedAt: string }>; extraNames?: string[] } = {}) {
  const d = await need(db, dealId);
  const claims = await currentClaims(db, d.company_id);
  const names = [...new Set([
    d.company_name,
    ...claims.filter((c) => ["company.legal_name", "team.founder", "raise.lead_investor"].includes(c.predicate)).map((c) => String(c.value)),
    ...(deps.extraNames ?? []),
  ].map((n) => n.trim()).filter(Boolean))];
  const { entries, fetchedAt } = await (deps.lists ?? (() => sanctionsLists()))();
  const results = screen(names, entries);
  const hits = results.filter((r) => r.hits.length);
  const content = [
    `OFAC sanctions screening for ${d.company_name}, run by ${by.replace(/^human:/, "")} against the SDN and Consolidated lists as of ${fetchedAt.slice(0, 10)} (${entries.length} entries).`,
    ...results.map((r) => r.hits.length
      ? `${r.name}: POTENTIAL MATCH with ${r.hits.map((h) => `${h.matchedName} (${h.entry.list}, ${h.entry.program || "program n/a"}, ${h.how}, ${Math.round(h.score * 100)}%)`).join("; ")}`
      : `${r.name}: no match`),
  ].join("\n");
  const { evidence } = await insertEvidence(db, {
    kind: "note", source: "ofac", uri: `ofac:screen:${dealId}:${Date.now()}`, title: "Sanctions screening", content, accessScope: "internal",
    occurredAt: new Date().toISOString(), metadata: { companyId: d.company_id, dealId, names, hits: hits.length },
  }, by);
  await refreshChecklist(db, d, by);
  await updateClosingItem(db, dealId, "sanctions", {
    status: hits.length ? "red_flag" : "done", evidenceId: evidence.id,
    note: hits.length ? `${hits.length} potential ${hits.length === 1 ? "match" : "matches"}: review before closing. Most are namesakes; clear each one with a reason.` : `${names.length} names screened, no matches (lists as of ${fetchedAt.slice(0, 10)}).`,
  }, by);
  return { names, results, evidenceId: evidence.id, fetchedAt };
}

/** Update closing items that wait on DocuSign envelopes from their current status. */
export async function syncSignatures(db: Db, dealId: string, by: string, deps: { envelopes?: (ids: string[]) => Promise<{ envelopeId: string; status: string }[]> } = {}) {
  await need(db, dealId);
  const items = (await closingItems(db, dealId)).filter((i) => i.envelope_id);
  if (!items.length) return { updated: 0 };
  if (!deps.envelopes && !(await isReady(db, "docusign"))) throw new ExecutionInvalid("Connect DocuSign first.");
  const envs = deps.envelopes ? await deps.envelopes(items.map((i) => i.envelope_id!)) : await withFirmCredentials(db, ["docusign"], () => docusignEnvelopes(items.map((i) => i.envelope_id!)));
  let updated = 0;
  for (const i of items) {
    const e = envs.find((x) => x.envelopeId === i.envelope_id);
    if (!e) continue;
    const status = closingStatusFor(e.status);
    if (status !== "open" && status !== i.status) {
      await updateClosingItem(db, dealId, i.key, { status, note: `DocuSign: ${e.status}` }, by);
      updated++;
    }
  }
  return { updated };
}

/** Prepare a DocuSign envelope as a draft, through the approval outbox. Nothing is sent. */
export async function queueSignatureDraft(db: Db, dealId: string, input: { itemKey: string; file: { name: string; base64: string }; signers: { name: string; email: string }[] }, by: string) {
  const d = await need(db, dealId);
  if (!(await isReady(db, "docusign"))) throw new ExecutionInvalid("Connect DocuSign first.");
  const item = (await closingItems(db, dealId)).find((i) => i.key === input.itemKey);
  if (!item) throw new ExecutionInvalid("No such closing item.");
  const id = await queue(db, "docusign_draft", {
    subject: `${d.company_name}: ${item.title}`.slice(0, 100), documents: [input.file], signers: input.signers, dealId, itemKey: item.key,
  }, { summary: `DocuSign draft: ${item.title} (${d.company_name})`, proposedBy: by, entityId: d.company_id });
  await updateClosingItem(db, dealId, item.key, { status: item.status === "open" ? "requested" : item.status, note: "DocuSign draft waiting for approval." }, by);
  return { outboxId: id };
}

// ---------------------------------------------------------------------------
// Wire controls
// ---------------------------------------------------------------------------

const WireInput = z.object({
  amountUsd: z.number().positive(),
  beneficiary: z.string().trim().min(2),
  bankName: z.string().trim().min(2),
  accountLast4: z.string().regex(/^\d{4}$/, "Last four digits only; VC OS doesn't store full account numbers."),
});

export async function recordWireInstructions(db: Db, dealId: string, input: unknown, by: string) {
  const d = await need(db, dealId);
  if (d.stage !== "closing") throw new ExecutionInvalid("Record wire instructions while the deal is closing.");
  const p = WireInput.safeParse(input);
  if (!p.success) throw invalid(p.error);
  const open = (await wires(db, dealId)).filter((w) => !["cancelled", "confirmed"].includes(w.status));
  for (const w of open) await updateWire(db, w.id, { status: "cancelled" }, by); // new instructions replace old ones, and must be verified again
  const w = await insertWire(db, dealId, p.data, by);
  await updateClosingItem(db, dealId, "wire_instructions", { status: "received" }, by).catch(() => undefined);
  await updateClosingItem(db, dealId, "wire_callback", { status: "open" }, by).catch(() => undefined);
  await updateClosingItem(db, dealId, "wire_approvals", { status: "open" }, by).catch(() => undefined);
  return w;
}

/**
 * Record the call-back: someone phoned the company at a number they already
 * had (not one from the email with the instructions) and confirmed the
 * bank, beneficiary and account.
 */
export async function verifyWire(db: Db, wireId: string, input: { numberSource: string; confirmed: boolean }, by: string) {
  const w = await getWire(db, wireId);
  if (!w) throw new ExecutionInvalid("No such wire.");
  if (w.status !== "received") throw new ExecutionInvalid(`This wire is ${w.status}.`);
  if (!input.confirmed) throw new ExecutionInvalid("Only record the call-back once the company confirmed the details by phone.");
  const src = input.numberSource?.trim() ?? "";
  if (src.length < 5) throw new ExecutionInvalid("Say where the phone number came from (e.g. 'CEO's mobile from our first meeting').");
  if (/instruction|this email|the email|wire email|signature/i.test(src)) throw new ExecutionInvalid("Use a number you had before the instructions arrived, not one from them.");
  await updateWire(db, wireId, { status: "verified", callbackBy: by, callbackNumberSource: src, callback: true }, by);
  const dealId = (await db.query<{ deal_id: string }>("select deal_id from wires where id = $1", [wireId])).rows[0]!.deal_id;
  await updateClosingItem(db, dealId, "wire_callback", { status: "done", note: `Confirmed by ${by.replace(/^human:/, "")}: ${src}` }, by).catch(() => undefined);
}

/** Two different people approve; the person who entered the instructions can't be both. */
export async function approveWire(db: Db, wireId: string, by: string) {
  const w = await getWire(db, wireId);
  if (!w) throw new ExecutionInvalid("No such wire.");
  if (w.status !== "verified") throw new ExecutionInvalid(w.status === "received" ? "Confirm the instructions by phone first." : `This wire is ${w.status}.`);
  if (w.approvals.includes(by)) throw new ExecutionInvalid("You've already approved this wire; a second person must approve.");
  if (w.approvals.length === 0 && by === w.created_by && w.callback_by === by) throw new ExecutionInvalid("You entered and verified these instructions; someone else must approve first.");
  const approvals = [...w.approvals, by];
  await updateWire(db, wireId, { approvals, status: approvals.length >= 2 ? "approved" : "verified" }, by);
  if (approvals.length >= 2) {
    const dealId = (await db.query<{ deal_id: string }>("select deal_id from wires where id = $1", [wireId])).rows[0]!.deal_id;
    await updateClosingItem(db, dealId, "wire_approvals", { status: "done", note: `Approved by ${approvals.map((a) => a.replace(/^human:/, "")).join(" and ")}` }, by).catch(() => undefined);
  }
  return { approvals: approvals.length, needed: 2 };
}

/** A person sent the wire from the bank; record the bank's reference. */
export async function markWireSent(db: Db, wireId: string, input: { bankReference: string }, by: string) {
  const w = await getWire(db, wireId);
  if (!w) throw new ExecutionInvalid("No such wire.");
  if (w.status !== "approved") throw new ExecutionInvalid("The wire needs two approvals before it's sent.");
  if (!input.bankReference?.trim()) throw new ExecutionInvalid("Enter the bank's reference for the wire.");
  await updateWire(db, wireId, { status: "sent", bankReference: input.bankReference.trim(), sent: true }, by);
  const dealId = (await db.query<{ deal_id: string }>("select deal_id from wires where id = $1", [wireId])).rows[0]!.deal_id;
  await updateClosingItem(db, dealId, "funds_sent", { status: "done", note: `Bank reference ${input.bankReference.trim()}` }, by).catch(() => undefined);
}

export async function confirmWire(db: Db, wireId: string, by: string) {
  const w = await getWire(db, wireId);
  if (!w) throw new ExecutionInvalid("No such wire.");
  if (w.status !== "sent") throw new ExecutionInvalid("Mark the wire sent first.");
  await updateWire(db, wireId, { status: "confirmed", confirmed: true }, by);
  const dealId = (await db.query<{ deal_id: string }>("select deal_id from wires where id = $1", [wireId])).rows[0]!.deal_id;
  await updateClosingItem(db, dealId, "funds_received", { status: "done" }, by).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

const CloseInput = z.object({
  closeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fundName: z.string().trim().min(1).optional(),
  boardRole: z.enum(["seat", "observer", "none"]).optional(),
});

/**
 * Record the closed investment, once every required closing item is done
 * and the wire is sent. The figures come from the signed terms and the
 * pro forma (math in engines/). The investment record is what Portfolio
 * starts from; the decision is logged as `invest`.
 */
export async function closeDeal(db: Db, dealId: string, input: unknown, by: string) {
  const d = await need(db, dealId);
  if (d.stage !== "closing") throw new ExecutionInvalid("Only a deal in closing can close.");
  const p = CloseInput.safeParse(input);
  if (!p.success) throw invalid(p.error);
  const items = await closingItems(db, dealId);
  const ready = readyToClose(items);
  if (!ready.ready) throw new ExecutionInvalid(`Still open: ${ready.open.map((k) => items.find((i) => i.key === k)?.title ?? k).join("; ")}.`);
  const signed = (await termSheets(db, dealId)).find((x) => x.status === "signed");
  if (!signed) throw new ExecutionInvalid("Mark the signed term sheet first.");
  // Compliance: the deal's regulatory screening (outbound investment, CFIUS, export controls).
  try {
    await assertScreeningCleared(db, dealId);
  } catch (err) {
    throw new ExecutionInvalid((err as Error).message);
  }
  const t = TermSheet.parse(signed.terms);
  const m = await model(db, dealId);
  const profile = (await getProfile(db))?.profile;
  const amount = m.ours?.amount ?? t.ourAllocationUsd;
  if (!amount) throw new ExecutionInvalid("Set our allocation on the signed term sheet.");
  const inv = await insertInvestment(db, {
    dealId, companyId: d.company_id, fundName: p.data.fundName ?? profile?.fund.name ?? "Fund", security: t.security, seriesName: t.seriesName, closeDate: p.data.closeDate,
    amountUsd: amount, shares: m.ours?.shares ?? null, pricePerShare: m.proForma?.pricePerShare ?? null, postMoneyUsd: m.proForma?.postMoneyImplied ?? (t.security !== "preferred" ? t.valuationCapUsd ?? null : null),
    ownershipFdPct: m.ours?.postPct ?? null, boardRole: p.data.boardRole ?? t.board.ours,
    rights: { proRata: t.proRata, informationRights: t.informationRights, managementRightsLetter: t.managementRightsLetter, liquidation: t.liquidation, antiDilution: t.antiDilution, mfn: t.mfn },
  }, by);
  await recordDecision(db, { entityId: d.company_id, kind: "invest", actor: by, value: { dealId, investmentId: inv.id, amountUsd: amount, closeDate: p.data.closeDate } });
  // Facts about the company: our fund is now an investor.
  const content = `Closing record: ${firmName(profile)} invested ${formatValue("raise.amount", amount)} in ${d.company_name}'s ${t.seriesName} on ${p.data.closeDate}.`;
  const { evidence } = await insertEvidence(db, { kind: "note", source: "closing", uri: `closing:${dealId}`, title: "Closing record", content, occurredAt: p.data.closeDate, accessScope: "confidential", metadata: { companyId: d.company_id, dealId } }, by);
  await insertClaim(db, { subjectId: d.company_id, predicate: "funding.investor", value: firmName(profile), asOf: p.data.closeDate, evidenceId: evidence.id, sourceType: "internal", confidence: 1, extractedBy: by }).catch(() => undefined);
  await updateDeal(db, dealId, { stage: "closed" }, by);
  await audit(db, by, "deal.close", dealId, { investment: inv.id });
  return inv;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function executionView(db: Db, dealId: string, viewer: string) {
  const d = await need(db, dealId);
  if (d.stage === "closing" || d.stage === "approved") await refreshChecklist(db, d, viewer);
  const profile = (await getProfile(db))?.profile;
  const house = profile?.terms ?? HOUSE_DEFAULTS;
  const sheets = await termSheets(db, dealId);
  const f = await flags(db, d);
  const checks: Record<number, TermCheck[]> = {};
  for (const s of sheets) checks[s.version] = checkTerms(TermSheet.parse(s.terms), house, { erisaLps: f.erisaLps, sensitiveTech: f.sensitiveTech });
  const meetings = await Promise.all((await icMeetings(db, dealId)).map((m) => meetingView(db, m, viewer)));
  const items = await orderedItems(db, d);
  return {
    deal: d,
    termSheets: sheets.map((s) => ({ ...s, checks: checks[s.version] })),
    house,
    capTable: await latestCapTable(db, dealId),
    model: await model(db, dealId),
    meetings,
    icRule: RULE_LABELS[(profile?.fund.icApproval ?? "majority") as Rule],
    closing: { items, categories: CATEGORY_LABELS, ready: readyToClose(items) },
    wires: await wires(db, dealId),
    investments: await listInvestments(db, { dealId }),
    passReasons: PASS_REASONS,
    labels: { raiseAmount: predicateLabel("raise.amount") },
  };
}

/** Deals from IC onward, for the Execution screen. */
export async function pipeline(db: Db) {
  const rows = await listDeals(db, { stages: ["ic", "approved", "closing", "closed"] });
  const out = [];
  for (const d of rows) {
    const items = await closingItems(db, d.id);
    const meetings = await icMeetings(db, d.id);
    const ts = (await termSheets(db, d.id))[0];
    const inv = d.stage === "closed" ? (await listInvestments(db, { dealId: d.id }))[0] : undefined;
    out.push({
      ...d,
      // The check on the latest term sheet, else the one set in diligence.
      our_check_usd: (ts?.terms as { ourAllocationUsd?: number } | undefined)?.ourAllocationUsd ?? d.our_check_usd,
      termSheet: ts ? { version: ts.version, status: ts.status } : null,
      ic: meetings[0] ? { phase: meetings[0].phase, outcome: meetings[0].outcome } : null,
      closing: items.length ? { done: items.filter((i) => ["done", "signed", "filed", "received", "waived", "na"].includes(i.status)).length, total: items.length, redFlags: items.filter((i) => i.status === "red_flag").length } : null,
      investment: inv ? { amount: inv.amount_usd, closeDate: inv.close_date } : null,
    });
  }
  return out;
}

export const investments = listInvestments;
