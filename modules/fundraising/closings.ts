import type { Db } from "../../lib/db.js";
import {
  closings, equalizationItems, getClosing, getRaise, insertActivity, insertClosing, insertEqualization, setClosingStatus, settleEqualization, subscriptions, terms, updateProspect,
  updateRaise, updateSubscription, type ClosingRow, type SubscriptionRow,
} from "../../ledger/fundraising.js";
import { callItems, calls, funds, getFund, partners } from "../../ledger/lp.js";
import { FUNDRAISING_LABELS } from "../../ledger/labels.js";
import { offeringIssues, type Issue } from "../../engines/fundraising.js";
import { equalization, type PriorCall } from "../../engines/fund-accounting.js";
import { addPartner, createFund } from "../lp/index.js";
import { queue } from "../outbox/index.js";
import { readiness, subscriber } from "./subscriptions.js";
import { addDays, FundraisingInvalid, firmName, isDay, longDate, mailChannel, raiseOr404, text, usd } from "./common.js";

/**
 * Closings. A draft closing groups accepted subscriptions; the checks run on
 * everyone admitted so far plus the newcomers (hard cap, investor count,
 * qualified purchasers, 506(c) verification, the 25% benefit plan test), and
 * on each subscription (KYC, sanctions, signatures). A different person
 * approves it. Approval admits the investors to the fund's register in LP
 * Reporting (creating the fund at the first closing), and at a later
 * closing works out equalization: newcomers pay in their share of earlier
 * calls, with interest at the LPA's rate, and earlier investors get their
 * excess back. Form D is due 15 days after the first sale.
 */

export const EQUALIZATION_DUE_DAYS = 14;

async function closingOr404(db: Db, id: string) {
  const c = await getClosing(db, id);
  if (!c) throw new FundraisingInvalid("No such closing.");
  return c;
}

async function checks(db: Db, c: { raise_id: string; id?: string }, newcomers: SubscriptionRow[]) {
  const r = (await getRaise(db, c.raise_id))!;
  const all = await subscriptions(db, r.id);
  const admitted = all.filter((s) => s.status === "admitted");
  const issues: Issue[] = offeringIssues(
    { exemption: r.exemption, offering: r.offering, hardCapUsd: r.hard_cap_usd, minCommitmentUsd: r.min_commitment_usd, vcoc: r.vcoc },
    [...admitted, ...newcomers].map(subscriber),
  );
  const perInvestor = newcomers.map((s) => ({ subscriptionId: s.id, investor: s.investor_name, open: readiness(s, r).filter((x) => x !== "Not yet accepted by a partner") }));
  return { issues, perInvestor, blocked: issues.some((i) => i.severity === "block") || perInvestor.some((p) => p.open.length > 0) };
}

export async function draftClosing(db: Db, raiseId: string, input: { closingDate?: unknown; subscriptionIds?: unknown; note?: unknown }, by: string) {
  const r = await raiseOr404(db, raiseId);
  if (!isDay(input.closingDate)) throw new FundraisingInvalid("Pick the closing date.");
  const ids = Array.isArray(input.subscriptionIds) ? input.subscriptionIds.map(String) : [];
  if (!ids.length) throw new FundraisingInvalid("Pick the investors to admit.");
  const subs = (await subscriptions(db, raiseId)).filter((s) => ids.includes(s.id));
  if (subs.length !== ids.length) throw new FundraisingInvalid("No such subscription in this raise.");
  const bad = subs.filter((s) => s.status !== "accepted" || s.closing_id);
  if (bad.length) throw new FundraisingInvalid(`${bad.map((s) => s.investor_name).join(", ")}: only accepted subscriptions not already in a closing can be admitted.`);
  const prior = (await closings(db, raiseId)).filter((c) => c.status === "approved");
  if (prior.length && input.closingDate < prior[prior.length - 1]!.closing_date) throw new FundraisingInvalid("A closing can't be dated before the previous one.");
  if (r.final_close_deadline && input.closingDate > r.final_close_deadline) throw new FundraisingInvalid(`The LPA's final closing deadline is ${longDate(r.final_close_deadline)}; extending it usually needs LPAC or investor consent.`);
  const c = await insertClosing(db, { raiseId, closingDate: input.closingDate, note: text(input.note), subscriptionIds: ids }, by);
  return { closing: c, ...(await checks(db, c, subs)) };
}

/** Everything about one closing: who's in it, the checks, and the equalization it would produce. */
export async function closingView(db: Db, id: string) {
  const c = await closingOr404(db, id);
  const subs = (await subscriptions(db, c.raise_id)).filter((s) => s.closing_id === id);
  const ck = c.status === "draft" ? await checks(db, c, subs) : { issues: [], perInvestor: [], blocked: false };
  const eq = c.status === "approved" ? await equalizationItems(db, id) : c.status === "draft" ? await previewEqualization(db, c, subs) : [];
  return { closing: c, investors: subs.map((s) => ({ id: s.id, name: s.investor_name, commitment: s.commitment_usd, kind: s.kind })), ...ck, equalization: eq };
}

/** Earlier calls, as the equalization engine needs them. */
async function priorCalls(db: Db, fundId: string, before: string): Promise<PriorCall[]> {
  const cs = (await calls(db, fundId)).filter((x) => x.status === "approved" && x.due_date <= before);
  const items = await callItems(db, { fundId });
  return cs.map((x) => ({ date: x.due_date, fees: x.fees_usd, capital: items.filter((i) => i.call_id === x.id).map((i) => ({ partnerId: i.partner_id, amount: i.investment_usd + i.expense_usd })) }));
}

async function previewEqualization(db: Db, c: ClosingRow, subs: SubscriptionRow[]) {
  const r = (await getRaise(db, c.raise_id))!;
  if (!r.fund_id) return [];
  const pc = await priorCalls(db, r.fund_id, c.closing_date);
  if (!pc.length) return [];
  const existing = await partners(db, r.fund_id);
  const all = [...existing.map((p) => ({ id: p.id, commitment: p.commitment_usd, feePaying: p.fee_paying })), ...subs.map((s) => ({ id: s.id, commitment: s.commitment_usd ?? 0, feePaying: s.kind !== "gp" }))];
  const names = new Map<string, string>([...existing.map((p) => [p.id, p.name] as [string, string]), ...subs.map((s) => [s.id, s.investor_name] as [string, string])]);
  return equalization(pc, all, subs.map((s) => s.id), c.closing_date, r.equalization_rate_pct).map((l) => ({
    partner_id: l.partnerId, partner_name: names.get(l.partnerId), capital_usd: l.capital, fee_usd: l.fee, interest_usd: l.interest, detail: l.lines,
  }));
}

export async function approveClosing(db: Db, id: string, by: string) {
  const c = await closingOr404(db, id);
  if (c.status !== "draft") throw new FundraisingInvalid(`This closing is already ${FUNDRAISING_LABELS.closingStatus[c.status]!.toLowerCase()}.`);
  if (c.created_by === by) throw new FundraisingInvalid("Someone other than the person who prepared the closing approves it.");
  const r = (await getRaise(db, c.raise_id))!;
  const subs = (await subscriptions(db, r.id)).filter((s) => s.closing_id === id);
  const ck = await checks(db, c, subs);
  if (ck.blocked) {
    const reasons = [...ck.issues.filter((i) => i.severity === "block").map((i) => i.message), ...ck.perInvestor.filter((p) => p.open.length).map((p) => `${p.investor}: ${p.open.join(", ").toLowerCase()}.`)];
    throw new FundraisingInvalid(`Not ready to close. ${reasons.join(" ")}`);
  }
  // The fund: linked, found by name, or created from the firm profile at the first closing.
  let fundId = r.fund_id ?? (await funds(db)).find((f) => f.name.toLowerCase() === r.name.toLowerCase())?.id ?? null;
  if (!fundId) fundId = (await createFund(db, { name: r.name, inception: c.closing_date }, by)).id;
  if (r.fund_id !== fundId) await updateRaise(db, r.id, { fund_id: fundId }, by);
  const existing = await partners(db, fundId);
  const pc = await priorCalls(db, fundId, c.closing_date);
  const sideTerms = await terms(db, r.id);
  const admitted: { sub: SubscriptionRow; partnerId: string }[] = [];
  for (const s of subs) {
    const q = s.questionnaire as { foiaSubject?: boolean };
    const own = sideTerms.filter((t) => t.subscription_id === s.id);
    const p = await addPartner(db, fundId, {
      name: s.investor_name, kind: s.kind, commitmentUsd: s.commitment_usd, emails: s.emails, closing: c.number, admittedOn: c.closing_date,
      taxStatus: s.tax_form && s.tax_form !== "w9" ? "foreign" : s.kind === "pension" || s.kind === "endowment_foundation" ? "tax_exempt" : "taxable",
      investorStatus: s.qualified_purchaser ? "qualified_purchaser" : "accredited", erisa: s.benefit_plan, kycVerifiedOn: c.closing_date,
      sideLetter: own.length ? own.map((t) => `${FUNDRAISING_LABELS.termCategories[t.category]}: ${t.text}`).join("\n") + (q.foiaSubject ? "\nSubject to public records laws." : "") : q.foiaSubject ? "Subject to public records laws." : undefined,
    }, by);
    admitted.push({ sub: s, partnerId: p.id });
    await updateSubscription(db, s.id, { status: "admitted", partner_id: p.id, token_revoked_at: new Date().toISOString() }, by, "fundraising.subscription.admitted");
    if (s.prospect_id) {
      await updateProspect(db, s.prospect_id, { stage: "closed", committed_usd: s.commitment_usd }, by);
      await insertActivity(db, { prospectId: s.prospect_id, occurredOn: c.closing_date, kind: "stage", summary: `Admitted at closing ${c.number}: ${usd(s.commitment_usd ?? 0)}` }, by);
    }
  }
  // Equalization, when earlier investors have already paid in.
  let lines: ReturnType<typeof equalization> = [];
  if (existing.length && pc.length) {
    const all = [...existing, ...(await partners(db, fundId)).filter((p) => admitted.some((a) => a.partnerId === p.id))].map((p) => ({ id: p.id, commitment: p.commitment_usd, feePaying: p.fee_paying }));
    lines = equalization(pc, all, admitted.map((a) => a.partnerId), c.closing_date, r.equalization_rate_pct);
    await db.transaction((tx) => insertEqualization(tx, id, lines.map((l) => ({ partnerId: l.partnerId, capital: l.capital, fee: l.fee, interest: l.interest, dueOn: addDays(c.closing_date, EQUALIZATION_DUE_DAYS), detail: l.lines }))));
  }
  await setClosingStatus(db, id, "approved", by);
  const notices = await closingNotices(db, c, fundId, admitted.map((a) => a.partnerId), lines, by);
  const first = c.number === 1;
  return {
    fundId, admitted: admitted.length, equalization: lines.length, notices,
    // Rule 503: Form D within 15 calendar days after the first sale (the first investor irrevocably committed).
    formDDueOn: first ? addDays(c.closing_date, 15) : null,
  };
}

async function closingNotices(db: Db, c: ClosingRow, fundId: string, newIds: string[], lines: ReturnType<typeof equalization>, by: string) {
  const channel = await mailChannel(db);
  if (!channel) return { channel: null, queued: 0 };
  const f = (await getFund(db, fundId))!;
  const firm = await firmName(db);
  const ps = await partners(db, fundId);
  let queued = 0;
  for (const p of ps.filter((x) => x.emails.length)) {
    const l = lines.find((x) => x.partnerId === p.id);
    const isNew = newIds.includes(p.id);
    if (!isNew && !l) continue;
    const due = addDays(c.closing_date, EQUALIZATION_DUE_DAYS);
    const body = isNew
      ? [`Dear ${p.name},`, "", `Welcome to ${f.name}. You were admitted as a limited partner at the fund's closing on ${longDate(c.closing_date)}, with a commitment of ${usd(p.commitment_usd)}.`, "",
          ...(l ? [`Because you joined after earlier capital calls, you owe ${usd(l.capital + l.fee + l.interest)} by ${longDate(due)}: ${usd(l.capital)} as your share of earlier calls, ${l.fee ? `${usd(l.fee)} of management fees from the first closing, ` : ""}and ${usd(l.interest)} of interest to earlier investors under the LPA.`, ""] : []),
          "Please wire only to the fund's account in your subscription documents. We will never change our bank details by email; if instructions ever seem to change, call us on a number you already have before sending anything.", "", "With thanks,", firm]
      : [`Dear ${p.name},`, "", `${f.name} admitted new investors at its closing on ${longDate(c.closing_date)}. Under the LPA they pay in their share of earlier capital calls with interest, and you'll receive ${usd(-l!.capital - l!.interest)}: ${usd(-l!.capital)} of capital, which may be called again, and ${usd(-l!.interest)} of interest.`, "", "With thanks,", firm];
    await queue(db, channel, { to: p.emails, subject: `${f.name}: closing of ${longDate(c.closing_date)}`, body: body.join("\n") }, { summary: `Closing ${c.number} notice: ${p.name}`, proposedBy: by });
    queued++;
  }
  return { channel, queued };
}

export async function cancelClosing(db: Db, id: string, by: string) {
  const c = await closingOr404(db, id);
  if (c.status !== "draft") throw new FundraisingInvalid("Only a draft closing can be cancelled.");
  await setClosingStatus(db, id, "cancelled", by);
}

export async function settle(db: Db, itemId: string, input: { on?: unknown }, by: string) {
  await settleEqualization(db, itemId, isDay(input.on) ? input.on : new Date().toISOString().slice(0, 10), by);
}

