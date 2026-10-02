import { z } from "zod";
import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { normalizeDomain } from "../../lib/text.js";
import { extractClaims } from "../../agents/extractor/index.js";
import { resolveOrCreate } from "../../agents/resolver/index.js";
import { writeMemo, MEMO_AGENT_VERSION } from "../../agents/memo-writer/index.js";
import {
  audit, companyProfile, currentClaims, getEntity, insertClaim, insertEvidence, openContradictions, recordDecision, PASS_REASONS, SHAREABLE_SCOPES,
} from "../../ledger/repository.js";
import {
  closeGeneratedQuestions, companyNotes, companySources, dealActivity, dealItems, dealMemos, dealQuestions, dealRuns, DEAL_STAGES,
  deleteCustomItem, getContradiction, getDeal, getMemo, insertCustomQuestion, insertDeal, insertMemo, listDeals, openDealFor,
  setContradictionStatus, settledContradictions, updateDeal, updateQuestion as patchQuestion, upsertGeneratedQuestion, upsertItem,
  type DealFlags, type DealStage, type ItemStatus, type QuestionStatus,
} from "../../ledger/diligence.js";
import { formatValue, predicateLabel, sourceTypeLabel } from "../../ledger/labels.js";
import { roundMath, type RoundMath } from "../../engines/round-math.js";
import { getProfile, construction } from "../firm/profile.js";
import { profile as companyView } from "../companies/index.js";
import { meetings as meetingsFor } from "../meetings/index.js";
import { queue } from "../outbox/index.js";
import { isReady } from "../connections/index.js";
import { CHECKLIST, evaluateChecklist, FLAG_LABELS, NOTE_KINDS, readiness, suggestFlags, WORKSTREAMS, type NoteKind, type Workstream } from "./checklist.js";
import { generateQuestions } from "./questions.js";
import { citables, draftMemo, memoMarkdown, say, WRITER_VERSION, type Calc, type MemoInputs } from "./memo.js";
import { checkMemo, type MemoDoc } from "./memo-check.js";

export { gather } from "./gather.js";
export { CHECKLIST, WORKSTREAMS, NOTE_KINDS, FLAG_LABELS };

/**
 * Diligence: one deal per company the firm is seriously looking at.
 *
 * Everything known about the company stays in the claim ledger; this module
 * is the workflow around it: a checklist evaluated against the ledger,
 * questions for the founders drawn from gaps and conflicts, a contradiction
 * board where people explain or settle disagreements (settling writes a new
 * claim; nothing is overwritten), notes from reference and customer calls,
 * research runs across every connected source, the round math against the
 * fund, the cited IC memo, and the decision to pass or go to IC with its
 * reason recorded.
 */

export class DiligenceInvalid extends Error {}

const need = async (db: Db, dealId: string) => {
  const d = await getDeal(db, dealId);
  if (!d) throw new DiligenceInvalid("No such deal.");
  return d;
};

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

/** Start diligence on a company already in the ledger, or a new one by name and website. */
export async function startDeal(
  db: Db,
  input: { companyId?: string; company?: { name: string; domain?: string } },
  by: string,
): Promise<{ id: string; existing: boolean }> {
  let companyId = input.companyId;
  if (!companyId) {
    const name = input.company?.name?.trim();
    if (!name) throw new DiligenceInvalid("Pick a company, or enter a name.");
    const domain = normalizeDomain(input.company?.domain) ?? undefined;
    if (input.company?.domain?.trim() && !domain) throw new DiligenceInvalid("Website should look like acme.com.");
    companyId = (await resolveOrCreate(db, { type: "company", name, domain, source: "diligence" }, { seedClaims: false })).entity.id;
  }
  const company = await getEntity(db, companyId);
  if (!company || company.type !== "company") throw new DiligenceInvalid("No such company.");
  const open = await openDealFor(db, company.id);
  if (open) return { id: open.id, existing: true };
  const flags = suggestFlags(await currentClaims(db, company.id));
  const id = await insertDeal(db, { companyId: company.id, lead: by, flags, createdBy: by });
  await refreshQuestions(db, id);
  return { id, existing: false };
}

export async function deals(db: Db, opts: { stages?: DealStage[] } = {}) {
  const rows = await listDeals(db, opts);
  const out = [];
  for (const d of rows) {
    const e = await evaluate(db, d.id);
    // Counted from the re-checked list, so the column agrees with the deal's Conflicts tab.
    out.push({ ...d, open_contradictions: e.contradictions.length, readiness: { ready: e.readiness.ready, complete: e.readiness.complete, total: e.readiness.total, requiredOpen: e.readiness.requiredOpen.length } });
  }
  return out;
}

const DealPatch = z.object({
  stage: z.enum(["screening", "diligence"]).optional(),
  lead: z.string().nullable().optional(),
  team: z.array(z.string()).optional(),
  ourCheckUsd: z.number().positive().nullable().optional(),
  flags: z.object({ hardware: z.boolean().optional(), regulated: z.boolean().optional(), sensitive_tech: z.boolean().optional() }).optional(),
  targetIcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable().optional(),
});

/** Lead, team, the firm's intended check, which extra sections apply, target IC date. Moving to IC or passing is `decide`. */
export async function updateDealInfo(db: Db, dealId: string, patch: unknown, by: string) {
  const d = await need(db, dealId);
  const p = DealPatch.safeParse(patch);
  if (!p.success) throw new DiligenceInvalid(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (p.data.stage && !["screening", "diligence"].includes(d.stage)) throw new DiligenceInvalid("This deal has a decision; start a new one to reopen it.");
  await updateDeal(db, dealId, { ...p.data, flags: p.data.flags ? { ...d.flags, ...p.data.flags } : undefined }, by);
  return getDeal(db, dealId);
}

// ---------------------------------------------------------------------------
// The round: facts about the company's raise go into the ledger as claims
// ---------------------------------------------------------------------------

const Round = z.object({
  raiseUsd: z.number().positive().optional(),
  stage: z.enum(["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus", "other"]).optional(),
  preMoneyUsd: z.number().positive().optional(),
  leadInvestor: z.string().trim().min(1).optional(),
  source: z.enum(["term_sheet", "founder", "other"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Record the round's terms as the company or a term sheet states them.
 * They're facts about the company, so they become claims with a note as
 * their evidence: a term sheet is a primary source, a founder's word is
 * self-reported. Recording new terms later is a new claim, not an edit.
 */
export async function recordRound(db: Db, dealId: string, input: unknown, by: string) {
  const d = await need(db, dealId);
  const p = Round.safeParse(input);
  if (!p.success) throw new DiligenceInvalid(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const r = p.data;
  const lines: [string, unknown, string][] = [];
  if (r.raiseUsd) lines.push(["raise.amount", r.raiseUsd, `Round size: ${formatValue("raise.amount", r.raiseUsd)}.`]);
  if (r.stage) lines.push(["raise.stage", r.stage, `Stage: ${formatValue("raise.stage", r.stage)}.`]);
  if (r.preMoneyUsd) lines.push(["raise.pre_money", r.preMoneyUsd, `Pre-money valuation: ${formatValue("raise.pre_money", r.preMoneyUsd)}.`]);
  if (r.leadInvestor) lines.push(["raise.lead_investor", r.leadInvestor, `Lead investor: ${r.leadInvestor}.`]);
  if (!lines.length) throw new DiligenceInvalid("Enter at least one term.");
  const from = r.source === "term_sheet" ? "the term sheet" : r.source === "founder" ? "the founders" : "another source";
  const date = r.date ?? new Date().toISOString().slice(0, 10);
  const content = `Round terms for ${d.company_name}, from ${from}, recorded by ${by.replace(/^human:/, "")} on ${date}.\n${lines.map((l) => l[2]).join("\n")}`;
  const { evidence } = await insertEvidence(db, {
    kind: "note", source: "diligence-note", uri: `note:${dealId}:round:${Date.now()}`, title: `Round terms (${from})`, content,
    occurredAt: date, accessScope: "confidential", metadata: { companyId: d.company_id, noteKind: "round", dealId },
  }, by);
  const ids: string[] = [];
  for (const [predicate, value, cited] of lines) {
    const at = content.indexOf(cited);
    ids.push(await insertClaim(db, {
      subjectId: d.company_id, predicate, value, asOf: date, evidenceId: evidence.id,
      sourceType: r.source === "term_sheet" ? "primary" : "self_reported", confidence: r.source === "term_sheet" ? 0.95 : 0.8,
      extractedBy: by, spanStart: at, spanEnd: at + cited.length, citedText: cited,
    }));
  }
  await refreshQuestions(db, dealId);
  return { claimIds: ids };
}

// ---------------------------------------------------------------------------
// Notes: reference calls, customer calls, expert calls, site visits
// ---------------------------------------------------------------------------

const Note = z.object({
  kind: z.enum(["reference", "customer_call", "expert_call", "site_visit", "note"]),
  title: z.string().trim().min(1, "Give the note a title").max(200),
  text: z.string().trim().min(20, "Write at least a sentence or two").max(50_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  with: z.string().trim().max(200).optional(),
});

/**
 * A note from someone on the deal team. It's confidential evidence on the
 * company, and the extractor reads it like any other source: what a
 * customer says on a reference call is third-party, and can contradict
 * what the founder said.
 */
export async function addNote(db: Db, dealId: string, input: unknown, by: string, llm?: Llm) {
  const d = await need(db, dealId);
  const p = Note.safeParse(input);
  if (!p.success) throw new DiligenceInvalid(p.error.issues.map((i) => i.message).join("; "));
  const n = p.data;
  const label = NOTE_KINDS.find((k) => k.id === n.kind)!.label;
  const content = `${label}${n.with ? ` with ${n.with}` : ""}, written by ${by.replace(/^human:/, "")}.\n\n${n.text}`;
  const { evidence, created } = await insertEvidence(db, {
    kind: "note", source: "diligence-note", uri: `note:${dealId}:${n.kind}:${Date.now()}`, title: n.title, content,
    occurredAt: n.date, accessScope: "confidential", metadata: { companyId: d.company_id, noteKind: n.kind, dealId, with: n.with ?? null },
  }, by);
  let claims = 0;
  if (created && llm) claims = (await extractClaims(db, llm, evidence.id, d.company_id)).claimIds.length;
  await audit(db, by, "deal.note", dealId, { kind: n.kind, evidence: evidence.id });
  await refreshQuestions(db, dealId);
  return { evidenceId: evidence.id, claims, extracted: Boolean(llm) };
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

const ITEM_STATUSES: ItemStatus[] = ["open", "in_progress", "done", "na", "red_flag"];

export async function setItem(db: Db, dealId: string, key: string, patch: { status?: ItemStatus | null; assignee?: string | null; note?: string | null }, by: string) {
  await need(db, dealId);
  const item = CHECKLIST.find((i) => i.key === key) ?? (await dealItems(db, dealId)).find((i) => i.item_key === key && i.custom);
  if (!item) throw new DiligenceInvalid("No such checklist item.");
  if (patch.status && !ITEM_STATUSES.includes(patch.status)) throw new DiligenceInvalid("Unknown status.");
  if (patch.status === "red_flag" && !patch.note?.trim()) throw new DiligenceInvalid("Say what the red flag is.");
  if (patch.status === "na" && !patch.note?.trim()) throw new DiligenceInvalid("Say why it doesn't apply.");
  const workstream = "workstream" in item ? item.workstream : "fit";
  await upsertItem(db, dealId, { key, workstream, ...patch }, by);
  await refreshQuestions(db, dealId);
}

export async function addItem(db: Db, dealId: string, input: { workstream: Workstream; title: string }, by: string) {
  await need(db, dealId);
  if (!WORKSTREAMS.some((w) => w.id === input.workstream)) throw new DiligenceInvalid("Pick a workstream.");
  const title = input.title?.trim();
  if (!title) throw new DiligenceInvalid("Give the item a title.");
  const key = `custom:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}:${Date.now().toString(36)}`;
  await upsertItem(db, dealId, { key, workstream: input.workstream, title, custom: true, status: "open" }, by);
  return key;
}

export async function removeItem(db: Db, dealId: string, key: string, by: string) {
  await need(db, dealId);
  await deleteCustomItem(db, dealId, key, by);
}

// ---------------------------------------------------------------------------
// Evaluation: checklist, readiness and the round math, from the ledger
// ---------------------------------------------------------------------------

async function evaluate(db: Db, dealId: string) {
  const d = await need(db, dealId);
  const claims = await currentClaims(db, d.company_id);
  const notes = (await companyNotes(db, d.company_id))
    .map((n) => ({ ...n, kind: String(n.metadata.noteKind ?? "note") as NoteKind }))
    .filter((n) => NOTE_KINDS.some((k) => k.id === n.kind));
  const profile = await getProfile(db);
  const math = roundFor(d.our_check_usd, claims, profile);
  const checks = Object.values(math.checks);
  const fundFit = d.our_check_usd && checks.length
    ? { ok: checks.every((c) => c.ok), detail: checks.map((c) => c.detail).join(" ") }
    : null;
  const view = await companyView(db, d.company_id);
  const fit = view.fit ? { verdict: String(view.fit.fit_verdict), score: Number(view.fit.fit_score) } : null;
  const items = evaluateChecklist({ claims, notes, flags: d.flags, items: await dealItems(db, dealId), fit, fundFit });
  const open = await openContradictions(db, d.company_id);
  return { deal: d, claims, notes, math, items, readiness: readiness(items, open.filter((x) => x.severity === "high").length), contradictions: open, fit, profile, view };
}

function roundFor(ourCheck: number | null, claims: Awaited<ReturnType<typeof currentClaims>>, profile: Awaited<ReturnType<typeof getProfile>>): RoundMath {
  const latest = (p: string) => claims.filter((c) => c.predicate === p).at(-1)?.value as number | undefined;
  const c = profile ? construction(profile.profile) : null;
  const m = profile?.profile.mandate;
  const f = profile?.profile.fund;
  return roundMath(
    { raiseUsd: latest("raise.amount"), preMoneyUsd: latest("raise.pre_money"), ourCheckUsd: ourCheck ?? undefined },
    {
      checkMinUsd: m?.checkSizeUsd.min, checkMaxUsd: m?.checkSizeUsd.max,
      ownershipMinPct: m?.targetOwnershipPct?.min, ownershipMaxPct: m?.targetOwnershipPct?.max,
      fundSizeUsd: f?.committedUsd ?? f?.targetSizeUsd, maxConcentrationPct: f?.maxConcentrationPct,
      reservePerCompanyUsd: c?.avgReservePerCompanyUsd ?? undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Bring generated questions in line with the ledger. Returns the deal's questions. */
export async function refreshQuestions(db: Db, dealId: string) {
  const e = await evaluate(db, dealId);
  const view = e.view.contradictions as { id: string; predicate: string; detail: string | null; claim_ids: string[] }[];
  const generated = generateQuestions({
    items: e.items, claims: e.claims,
    contradictions: view.map((c) => ({ id: c.id, predicate: c.predicate, detail: c.detail ?? predicateLabel(c.predicate), claim_ids: c.claim_ids })),
  });
  for (const q of generated) await upsertGeneratedQuestion(db, dealId, q);
  await closeGeneratedQuestions(db, dealId, generated.map((q) => q.key));
  return dealQuestions(db, dealId);
}

export async function addQuestion(db: Db, dealId: string, input: { workstream: Workstream; text: string }, by: string) {
  await need(db, dealId);
  const text = input.text?.trim();
  if (!text) throw new DiligenceInvalid("Write the question.");
  if (!WORKSTREAMS.some((w) => w.id === input.workstream)) throw new DiligenceInvalid("Pick a workstream.");
  return insertCustomQuestion(db, dealId, { workstream: input.workstream, text }, by);
}

export async function updateQuestion(db: Db, dealId: string, id: string, patch: { status?: QuestionStatus; answer?: string | null; text?: string }, by: string) {
  await need(db, dealId);
  if (patch.status && !["open", "asked", "answered", "dropped"].includes(patch.status)) throw new DiligenceInvalid("Unknown status.");
  await patchQuestion(db, dealId, id, patch, by);
}

/**
 * Put open questions into an email draft to the founders, through the
 * approval outbox: nothing is sent, and the draft is only created in the
 * mailbox after a partner approves it. The questions are marked asked.
 */
export async function queueQuestionsEmail(db: Db, dealId: string, input: { to: string[]; questionIds: string[]; channel?: "gmail_draft" | "outlook_draft" }, by: string) {
  const d = await need(db, dealId);
  const qs = (await dealQuestions(db, dealId)).filter((q) => input.questionIds.includes(q.id));
  if (!qs.length) throw new DiligenceInvalid("Pick at least one question.");
  const to = (input.to ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!to.length) throw new DiligenceInvalid("Add who it's to.");
  const channel = input.channel ?? ((await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null);
  if (!channel) throw new DiligenceInvalid("Connect Gmail or Outlook first, so the draft can be created in your mailbox.");
  const byWs = WORKSTREAMS.map((w) => ({ w, list: qs.filter((q) => q.workstream === w.id) })).filter((x) => x.list.length);
  const body = [
    "Hi,",
    "",
    "Thanks again for the time. A few questions as we keep going:",
    "",
    ...byWs.flatMap(({ w, list }) => [`${w.label}`, ...list.map((q, i) => `${i + 1}. ${q.text}`), ""]),
    "Happy to take these on a call if that's easier.",
  ].join("\n");
  const id = await queue(db, channel, { to, subject: `${d.company_name}: questions from our diligence`, body }, { summary: `Questions for ${d.company_name} (${qs.length})`, proposedBy: by, entityId: d.company_id });
  for (const q of qs) if (q.status === "open") await patchQuestion(db, dealId, q.id, { status: "asked" }, by);
  return { outboxId: id, channel };
}

// ---------------------------------------------------------------------------
// The contradiction board
// ---------------------------------------------------------------------------

/**
 * Explain a disagreement (both can be true: different dates, different
 * definitions) or settle it by saying which source is right. Settling
 * writes a new claim with the right value, from a note that records who
 * decided and why, superseding the wrong one. Nothing is edited or deleted.
 */
export async function resolveContradiction(
  db: Db,
  dealId: string,
  contradictionId: string,
  input: { status: "explained" | "resolved" | "open"; note?: string; keepClaimId?: string },
  by: string,
) {
  const d = await need(db, dealId);
  const x = await getContradiction(db, contradictionId);
  if (!x) throw new DiligenceInvalid("No such contradiction.");
  const family = new Set([d.company_id, ...(await currentClaims(db, d.company_id)).map((c) => c.subject_id)]);
  if (!family.has(x.subject_id)) throw new DiligenceInvalid("That contradiction is about another company.");
  const note = input.note?.trim() || null;
  if (input.status !== "open" && !note) throw new DiligenceInvalid("Write a note: what explains it, or why one source is right.");
  if (input.status === "resolved") {
    if (!input.keepClaimId || !x.claim_ids.includes(input.keepClaimId)) throw new DiligenceInvalid("Pick which source is right.");
    const all = await currentClaims(db, d.company_id);
    const keep = all.find((c) => c.id === input.keepClaimId);
    const drop = all.find((c) => x.claim_ids.includes(c.id) && c.id !== input.keepClaimId);
    if (!keep) throw new DiligenceInvalid("That claim has already been superseded.");
    if (drop) {
      const content = `Settled by ${by.replace(/^human:/, "")}: ${predicateLabel(x.predicate)} is ${formatValue(x.predicate, keep.value)} (${sourceTypeLabel(keep.source_type).toLowerCase()}), not ${formatValue(x.predicate, drop.value)} (${sourceTypeLabel(drop.source_type).toLowerCase()}).\nWhy: ${note}`;
      const { evidence } = await insertEvidence(db, {
        kind: "note", source: "diligence-note", uri: `note:${dealId}:settle:${contradictionId}`, title: `Settled: ${predicateLabel(x.predicate)}`,
        content, accessScope: "internal", metadata: { companyId: d.company_id, noteKind: "settlement", dealId, contradiction: contradictionId },
      }, by);
      await insertClaim(db, {
        subjectId: d.company_id, predicate: x.predicate, value: keep.value, asOf: keep.as_of ?? undefined, evidenceId: evidence.id,
        sourceType: "internal", confidence: 0.9, extractedBy: by, supersedes: drop.id,
      });
    }
  }
  await setContradictionStatus(db, contradictionId, input.status, note, by);
  await refreshQuestions(db, dealId);
}

// ---------------------------------------------------------------------------
// The deal page
// ---------------------------------------------------------------------------

export async function dealView(db: Db, dealId: string) {
  // New evidence arrives from syncs and other people's uploads: bring the question list up to date first (idempotent).
  await refreshQuestions(db, dealId);
  const e = await evaluate(db, dealId);
  const d = e.deal;
  const view = e.view;
  return {
    deal: d,
    company: { id: view.entity.id, name: view.entity.name, identifiers: view.identifiers },
    fit: view.fit,
    claims: view.claims,
    contradictions: view.contradictions,
    settled: await settledContradictions(db, d.company_id),
    checklist: e.items,
    readiness: e.readiness,
    workstreams: WORKSTREAMS,
    flags: d.flags,
    flagLabels: FLAG_LABELS,
    round: {
      raise: e.claims.filter((c) => c.predicate.startsWith("raise.")).map((c) => ({ id: c.id, predicate: c.predicate, label: predicateLabel(c.predicate), display: say(c), source_type: c.source_type })),
      ourCheckUsd: d.our_check_usd,
      math: e.math,
    },
    questions: await dealQuestions(db, dealId),
    notes: e.notes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, with: n.metadata.with ?? null, occurred_at: n.occurred_at ?? n.captured_at, excerpt: n.content.split("\n").slice(2).join(" ").slice(0, 280) })),
    noteKinds: NOTE_KINDS,
    meetings: await meetingsFor(db, { companyId: d.company_id, limit: 50 }),
    sources: await companySources(db, d.company_id),
    runs: await dealRuns(db, dealId),
    memos: await dealMemos(db, dealId),
    decisions: view.decisions,
    activity: await dealActivity(db, dealId, d.company_id),
    passReasons: PASS_REASONS,
  };
}

// ---------------------------------------------------------------------------
// The IC memo
// ---------------------------------------------------------------------------

async function memoInputs(db: Db, dealId: string, shareable: boolean): Promise<MemoInputs> {
  const e = await evaluate(db, dealId);
  const scoped = await companyProfile(db, e.deal.company_id, shareable ? { scopes: SHAREABLE_SCOPES } : {});
  const byId = new Map(scoped.claims.map((c) => [c.id, c]));
  const calcs: Calc[] = [];
  const m = e.math;
  if (!shareable) {
    if (e.deal.our_check_usd && m.postMoneyUsd && m.ownershipPct !== undefined) {
      const text = `At our ${money(e.deal.our_check_usd)} check, entry ownership would be ${m.ownershipPct.toFixed(1)}% at a ${money(m.postMoneyUsd)} post-money valuation.`;
      calcs.push({ id: "calc:round", label: "Round math (code)", text, values: [e.deal.our_check_usd, m.postMoneyUsd, m.ownershipPct] });
    }
    for (const [k, c] of Object.entries(m.checks)) {
      if (c) calcs.push({ id: `calc:check:${k}`, label: "Fund guardrail (code)", text: c.detail, values: [] });
    }
    if (e.fit) calcs.push({ id: "calc:fit", label: "Thesis fit (code)", text: `Thesis fit: ${e.fit.score} out of 100 (${e.fit.verdict}).`, values: [e.fit.score, 100] });
    const refs = e.notes.filter((n) => n.kind === "reference").length;
    const custs = e.notes.filter((n) => n.kind === "customer_call").length;
    if (refs || custs) calcs.push({ id: "calc:references", label: "Diligence notes (count)", text: `The team has logged ${refs} founder reference ${refs === 1 ? "call" : "calls"} and ${custs} customer ${custs === 1 ? "call" : "calls"}.`, values: [refs, custs] });
    const qs = (await dealQuestions(db, dealId)).filter((q) => q.status === "open" || q.status === "asked").length;
    calcs.push({
      id: "calc:status", label: "Diligence status (count)",
      text: `${e.readiness.complete} of ${e.readiness.total} checklist items are complete, with ${qs} open ${qs === 1 ? "question" : "questions"} and ${e.contradictions.length} unresolved ${e.contradictions.length === 1 ? "conflict" : "conflicts"} between sources.`,
      values: [e.readiness.complete, e.readiness.total, qs, e.contradictions.length],
    });
  }
  const contradictions = (e.view.contradictions as { id: string; detail: string | null; claim_ids: string[] }[])
    .filter((x) => x.claim_ids.every((id) => byId.has(id)))
    .map((x) => ({ id: x.id, detail: x.detail ?? "", claim_ids: x.claim_ids }));
  return {
    company: e.deal.company_name,
    claims: scoped.claims.map((c) => ({ id: c.id, predicate: c.predicate, value: c.value, as_of: c.as_of, source_type: c.source_type, evidence: { source: c.evidence.source, title: c.evidence.title, occurred_at: c.evidence.occurred_at } })),
    contradictions, calcs, shareable,
    openItems: e.items.filter((i) => i.required && !i.complete).map((i) => i.title),
    redFlags: e.items.filter((i) => i.state === "red_flag").map((i) => i.title),
  };
}

const money = (n: number) => (n >= 1e6 ? `$${Number.isInteger(n / 1e6) ? n / 1e6 : (n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);

/**
 * Draft a new memo version. The deterministic writer is the default; with
 * `writer: "claude"` the memo-writer agent drafts the prose. Either way the
 * citation check runs in code and only passing sentences are saved.
 * `shareable` drafts from public claims only, for co-investors.
 */
export async function draftMemoFor(db: Db, dealId: string, opts: { shareable?: boolean; writer?: "deterministic" | "claude" }, by: string, llm?: Llm) {
  const inputs = await memoInputs(db, dealId, Boolean(opts.shareable));
  let doc: MemoDoc;
  let draftedBy = WRITER_VERSION;
  if (opts.writer === "claude") {
    if (!llm) throw new DiligenceInvalid("Claude isn't configured on this server. Use the standard draft.");
    const w = await writeMemo(llm, inputs);
    doc = w.doc;
    draftedBy = `agent:${MEMO_AGENT_VERSION}/${w.model}`;
  } else doc = draftMemo(inputs);
  const { doc: checked, result } = checkMemo(doc, citables(inputs));
  if (!checked.sections.some((s) => s.sentences.some((x) => x.kind === "fact"))) {
    throw new DiligenceInvalid("There's nothing cited to write yet. Gather sources or add notes first.");
  }
  return insertMemo(db, dealId, { shareable: Boolean(opts.shareable), body: checked, check: result, draftedBy, createdBy: by });
}

/** One memo version with what each citation points to, and a Markdown export. */
export async function memo(db: Db, dealId: string, version?: number) {
  const d = await need(db, dealId);
  const m = await getMemo(db, dealId, version);
  if (!m) return null;
  const doc = m.body as MemoDoc;
  const ids = [...new Set(doc.sections.flatMap((s) => s.sentences.flatMap((x) => x.cites)))];
  const claims = (await companyProfile(db, d.company_id)).claims;
  // Superseded claims still resolve: a memo keeps pointing at what it was written from.
  const extra = ids.filter((id) => !id.startsWith("calc:") && !claims.some((c) => c.id === id));
  const older = extra.length
    ? (await db.query<{ id: string; predicate: string; value: unknown; source_type: string; title: string | null; source: string; evidence_id: string; as_of: unknown }>(
        "select c.id, c.predicate, c.value, c.source_type, e.title, e.source, c.evidence_id, c.as_of from claims c join evidence e on e.id = c.evidence_id where c.id = any($1::uuid[])",
        [extra],
      )).rows
    : [];
  const refs: Record<string, { label: string; display: string; source: string; evidenceId?: string; sourceType?: string; superseded?: boolean }> = {};
  for (const c of claims) {
    if (ids.includes(c.id)) refs[c.id] = { label: predicateLabel(c.predicate), display: say(c), source: c.evidence.title ?? c.evidence.source, evidenceId: c.evidence_id, sourceType: c.source_type };
  }
  for (const c of older) refs[c.id] = { label: predicateLabel(c.predicate), display: say(c), source: c.title ?? c.source, evidenceId: c.evidence_id, sourceType: c.source_type, superseded: true };
  for (const id of ids.filter((x) => x.startsWith("calc:"))) refs[id] = { label: "Calculated in code", display: "", source: "VC OS fund math" };
  const markdown = memoMarkdown(doc, new Map(Object.entries(refs).map(([id, r]) => [id, `${r.label}${r.display ? `: ${r.display}` : ""}. Source: ${r.source}${r.sourceType ? ` (${sourceTypeLabel(r.sourceType).toLowerCase()})` : ""}${r.superseded ? ", since superseded" : ""}.`])));
  return { ...m, refs, markdown };
}

// ---------------------------------------------------------------------------
// Decisions: judgment is data
// ---------------------------------------------------------------------------

const Decision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass"), reasonCode: z.enum(PASS_REASONS), rationale: z.string().trim().min(10, "Write a sentence on why") }),
  z.object({ kind: z.literal("advance"), rationale: z.string().trim().optional() }),
]);

/**
 * Pass (a reason code and a rationale are required) or send to IC. Going
 * to IC before the checklist is ready needs a written reason; both are
 * recorded as decisions with the readiness at that moment.
 */
export async function decide(db: Db, dealId: string, input: unknown, by: string) {
  const d = await need(db, dealId);
  if (!["screening", "diligence"].includes(d.stage)) throw new DiligenceInvalid(`This deal is already ${d.stage === "ic" ? "at IC" : d.stage}.`);
  const p = Decision.safeParse(input);
  if (!p.success) throw new DiligenceInvalid(p.error.issues.map((i) => i.message).join("; "));
  const e = await evaluate(db, dealId);
  const snapshot = { dealId, readiness: { ready: e.readiness.ready, complete: e.readiness.complete, total: e.readiness.total, requiredOpen: e.readiness.requiredOpen.map((x) => x.key) } };
  if (p.data.kind === "pass") {
    await recordDecision(db, { entityId: d.company_id, kind: "pass", actor: by, reasonCode: p.data.reasonCode, rationale: p.data.rationale, value: snapshot });
    await updateDeal(db, dealId, { stage: "passed" }, by);
  } else {
    if (!e.readiness.ready && (p.data.rationale ?? "").length < 10) {
      throw new DiligenceInvalid(`Diligence isn't complete (${e.readiness.requiredOpen.length} required items open${e.readiness.redFlags.length ? `, ${e.readiness.redFlags.length} red flags` : ""}${e.readiness.highContradictions ? `, ${e.readiness.highContradictions} high-severity conflicts` : ""}). Write why it should go to IC anyway.`);
    }
    await recordDecision(db, { entityId: d.company_id, kind: "advance", actor: by, rationale: p.data.rationale, value: { ...snapshot, to: "ic" } });
    await updateDeal(db, dealId, { stage: "ic" }, by);
  }
  return getDeal(db, dealId);
}

export { DEAL_STAGES };
