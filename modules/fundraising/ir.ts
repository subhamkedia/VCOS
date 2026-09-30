import type { Db } from "../../lib/db.js";
import {
  answerRequest, consents, decideConsent, endMember, getConsent, insertConsent, insertMember, insertRequest, members, recordVote, requests, votes,
} from "../../ledger/fundraising.js";
import { getFund, getPartner, partners } from "../../ledger/lp.js";
import { FUNDRAISING_LABELS } from "../../ledger/labels.js";
import { queue } from "../outbox/index.js";
import { addDays, EMAIL, FundraisingInvalid, firmName, isDay, longDate, mailChannel, text, today } from "./common.js";

/**
 * Investor relations after the close: the LP advisory committee (members,
 * consent requests such as conflict approvals and valuation questions,
 * each member's vote, and the outcome), and requests from investors, each
 * with a due date so none waits unanswered. The LPA sets what needs LPAC
 * consent and what counts as approval; VC OS records the votes and checks
 * the tally against a majority of current members.
 */

async function fundOr404(db: Db, id: string) {
  const f = await getFund(db, id);
  if (!f) throw new FundraisingInvalid("No such fund.");
  return f;
}

const active = (m: { until: string | null }, on: string) => !m.until || m.until >= on;

export async function addLpacMember(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  const p = await getPartner(db, String(input.partnerId ?? ""));
  if (!p || p.fund_id !== fundId) throw new FundraisingInvalid("Pick an investor in this fund.");
  if (p.kind === "gp") throw new FundraisingInvalid("The LPAC is made of limited partners, not the GP.");
  const rep = text(input.representative);
  if (!rep) throw new FundraisingInvalid("Name the investor's representative.");
  const email = text(input.email);
  if (email && !EMAIL.test(email)) throw new FundraisingInvalid("Check the email address.");
  if ((await members(db, fundId)).some((m) => m.partner_id === p.id && active(m, today()))) throw new FundraisingInvalid(`${p.name} already has a seat.`);
  await insertMember(db, { fundId, partnerId: p.id, representative: rep, email: email ?? p.emails[0] ?? null, since: isDay(input.since) ? input.since : today() }, by);
}

export async function endLpacMember(db: Db, memberId: string, input: { until?: unknown }, by: string) {
  await endMember(db, memberId, isDay(input.until) ? input.until : today(), by);
}

export async function requestConsent(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  const f = await fundOr404(db, fundId);
  const kind = String(input.kind ?? "other");
  if (!(kind in FUNDRAISING_LABELS.consentKinds)) throw new FundraisingInvalid("Pick what the consent is for.");
  const topic = text(input.topic);
  const detail = text(input.detail);
  if (!topic || !detail) throw new FundraisingInvalid("Give the request a title and explain what the committee is asked to approve, including any conflict and how it's mitigated.");
  const ms = (await members(db, fundId)).filter((m) => active(m, today()));
  if (!ms.length) throw new FundraisingInvalid("Seat the LPAC's members first.");
  const dueOn = isDay(input.dueOn) ? input.dueOn : addDays(today(), 14);
  const c = await insertConsent(db, { fundId, kind, topic, detail, requestedOn: today(), dueOn }, by);
  const channel = await mailChannel(db);
  let queued = 0;
  if (channel) {
    const firm = await firmName(db);
    const to = ms.map((m) => m.email).filter((e): e is string => Boolean(e));
    if (to.length) {
      await queue(db, channel, {
        to, subject: `${f.name} LPAC: ${topic}`,
        body: [`Dear members of the Advisory Committee,`, "", `${firm} asks the committee to consider the following (${FUNDRAISING_LABELS.consentKinds[kind]!.toLowerCase()}):`, "", detail, "", `Please give your decision by ${longDate(dueOn)}.`, "", "With thanks,", firm].join("\n"),
      }, { summary: `LPAC consent request: ${topic}`, proposedBy: by });
      queued = 1;
    }
  }
  return { consent: c, queued };
}

export async function castVote(db: Db, consentId: string, input: Record<string, unknown>, by: string) {
  const c = await getConsent(db, consentId);
  if (!c) throw new FundraisingInvalid("No such consent request.");
  if (c.status !== "open") throw new FundraisingInvalid("This consent is already decided.");
  const vote = String(input.vote ?? "");
  if (!(vote in FUNDRAISING_LABELS.votes)) throw new FundraisingInvalid("Pick the member's vote.");
  const m = (await members(db, c.fund_id)).find((x) => x.id === input.memberId);
  if (!m || !active(m, today())) throw new FundraisingInvalid("Pick a current member of the committee.");
  await recordVote(db, { consentId, memberId: m.id, vote, votedOn: isDay(input.votedOn) ? input.votedOn : today(), note: text(input.note) }, by);
}

export function tally(ms: { id: string; until: string | null }[], vs: { member_id: string; vote: string }[], on: string) {
  const current = ms.filter((m) => active(m, on));
  const counted = vs.filter((v) => current.some((m) => m.id === v.member_id));
  const approve = counted.filter((v) => v.vote === "approve").length;
  const decline = counted.filter((v) => v.vote === "decline").length;
  return { members: current.length, approve, decline, abstain: counted.length - approve - decline, pending: current.length - counted.length, majority: approve > current.length / 2 };
}

/** Record the outcome. Approval needs a majority of current members to have approved (unless the LPA says otherwise, which the note must say). */
export async function decideLpacConsent(db: Db, consentId: string, input: { outcome?: unknown; note?: unknown }, by: string) {
  const c = await getConsent(db, consentId);
  if (!c) throw new FundraisingInvalid("No such consent request.");
  const outcome = String(input.outcome ?? "");
  if (!["approved", "declined", "withdrawn"].includes(outcome)) throw new FundraisingInvalid("Pick the outcome.");
  const t = tally(await members(db, c.fund_id), (await votes(db, c.fund_id)).filter((v) => v.consent_id === consentId), today());
  if (outcome === "approved" && !t.majority && !text(input.note)) throw new FundraisingInvalid(`Only ${t.approve} of ${t.members} members approved. If the LPA's threshold is different, say so in the note.`);
  await decideConsent(db, consentId, outcome as "approved" | "declined" | "withdrawn", today(), by);
  return t;
}

export async function lpacView(db: Db, fundId: string) {
  await fundOr404(db, fundId);
  const ms = await members(db, fundId);
  const vs = await votes(db, fundId);
  return {
    members: ms,
    consents: (await consents(db, fundId)).map((c) => ({ ...c, votes: vs.filter((v) => v.consent_id === c.id), tally: tally(ms, vs.filter((v) => v.consent_id === c.id), c.decided_on ?? today()) })),
    investors: (await partners(db, fundId)).filter((p) => p.kind !== "gp").map((p) => ({ id: p.id, name: p.name })),
  };
}

// ---------------------------------------------------------------------------
// Investor requests
// ---------------------------------------------------------------------------

export async function logRequest(db: Db, input: Record<string, unknown>, by: string) {
  const category = String(input.category ?? "other");
  if (!(category in FUNDRAISING_LABELS.requestCategories)) throw new FundraisingInvalid("Pick what the request is about.");
  const subject = text(input.subject);
  const from = text(input.fromName);
  if (!subject || !from) throw new FundraisingInvalid("Say who asked and what.");
  const receivedOn = isDay(input.receivedOn) ? input.receivedOn : today();
  return insertRequest(db, {
    fundId: text(input.fundId), partnerId: text(input.partnerId), prospectId: text(input.prospectId), fromName: from, category, subject, detail: text(input.detail),
    receivedOn, dueOn: isDay(input.dueOn) ? input.dueOn : addDays(receivedOn, 10),
  }, by);
}

export async function answerInvestorRequest(db: Db, id: string, input: { answer?: unknown; close?: unknown }, by: string) {
  const a = text(input.answer);
  if (!a) throw new FundraisingInvalid("Write the answer, or what was done.");
  await answerRequest(db, id, { answer: a, status: input.close === true ? "closed" : "answered", on: today() }, by);
}

export async function requestQueue(db: Db) {
  const now = today();
  return (await requests(db)).map((r) => ({ ...r, overdue: r.status === "open" && Boolean(r.due_on && r.due_on < now) }));
}
