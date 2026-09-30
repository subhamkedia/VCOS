import type { Db } from "../../lib/db.js";
import { sha256 } from "../../lib/text.js";
import { newToken, type SubscriptionRef } from "../../ledger/platform.js";
import {
  docs, getDoc, getProspect, getRaise, getSubscription, insertActivity, insertSubscription, subscriptions, updateProspect, updateSubscription, type RaiseRow, type SubscriptionRow,
} from "../../ledger/fundraising.js";
import { FUNDRAISING_LABELS, LP_LABELS } from "../../ledger/labels.js";
import { offeringIssues, type Subscriber } from "../../engines/fundraising.js";
import { sanctionsLists, screen, type SanctionsEntry } from "../../connectors/ofac.js";
import { parallelStatus, type ParallelStatus } from "../../connectors/parallel.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { EMAIL, emailsOf, FundraisingInvalid, firmName, isDay, longDate, mailChannel, money, raiseOr404, text, today, usd } from "./common.js";

/**
 * Subscriptions: how a committed investor becomes a limited partner.
 * The firm invites the investor to a private link (no account) to complete
 * the subscription questionnaire: who it is, how it's an accredited
 * investor (Rule 501(a)) and, for a 3(c)(7) fund, a qualified purchaser;
 * whether it's a benefit plan investor or a pooled vehicle; its tax form;
 * for an entity, its beneficial owners. The firm then screens the investor
 * and its owners against OFAC's lists, clears KYC, records how it verified
 * accreditation (a 506(c) offering needs more than self-certification), and
 * sends the subscription documents for signature as a DocuSign draft. A
 * partner accepts or rejects (with a reason). Bank details are never asked
 * for or stored.
 */

export const SUBSCRIPTION_DAYS = 45;
const NATURAL_BASES = ["income", "net_worth", "professional", "knowledgeable_employee", "insider"];
const ENTITY_BASES = ["institution", "plan", "entity_assets", "entity_investments", "family_office", "all_owners"];

async function subOr404(db: Db, id: string) {
  const s = await getSubscription(db, id);
  if (!s) throw new FundraisingInvalid("No such subscription.");
  return s;
}

export async function inviteSubscriber(db: Db, raiseId: string, input: Record<string, unknown>, by: string, appUrl: string) {
  const r = await raiseOr404(db, raiseId);
  if (r.status !== "open") throw new FundraisingInvalid("This raise is closed.");
  const p = typeof input.prospectId === "string" && input.prospectId ? await getProspect(db, input.prospectId) : null;
  if (input.prospectId && (!p || p.raise_id !== raiseId)) throw new FundraisingInvalid("No such prospect in this raise.");
  const name = text(input.investorName) ?? p?.name ?? null;
  if (!name) throw new FundraisingInvalid("Enter the investor's legal name.");
  const kind = String(input.kind ?? p?.kind ?? "other");
  if (!(kind in LP_LABELS.partnerKinds)) throw new FundraisingInvalid("Pick the type of investor.");
  const emails = input.emails !== undefined ? emailsOf(input.emails) : p?.emails ?? [];
  if (!emails.length) throw new FundraisingInvalid("Enter an email for the investor: the link goes there.");
  if (emails.some((e) => !EMAIL.test(e))) throw new FundraisingInvalid("Check the email addresses.");
  if ((await subscriptions(db, raiseId)).some((s) => s.investor_name.toLowerCase() === name.toLowerCase() && s.status !== "withdrawn" && s.status !== "rejected")) {
    throw new FundraisingInvalid(`${name} already has a subscription in this raise.`);
  }
  const token = newToken();
  const s = await insertSubscription(db, {
    raiseId, prospectId: p?.id ?? null, investorName: name, kind, naturalPerson: input.naturalPerson === true || kind === "individual",
    commitmentUsd: money(input.commitmentUsd) ?? p?.committed_usd ?? p?.soft_circle_usd ?? null, emails, tokenHash: sha256(token), days: SUBSCRIPTION_DAYS,
  }, by);
  const url = `${appUrl.replace(/\/$/, "")}/subscribe/${token}`;
  if (p) await insertActivity(db, { prospectId: p.id, occurredOn: today(), kind: "document", summary: "Invited to subscribe" }, by);
  const channel = await mailChannel(db);
  let outboxId: string | null = null;
  if (channel) {
    const firm = await firmName(db);
    outboxId = await queue(db, channel, {
      to: emails, subject: `${r.name}: your subscription`,
      body: [`Dear ${p?.contact_name ?? name},`, "", `Thank you for committing to ${r.name}. Please complete the investor questionnaire at this private link (valid ${SUBSCRIPTION_DAYS} days; no account needed):`, "", url, "",
        "It asks how you qualify to invest and, for an entity, who owns it; it never asks for bank details. We'll send the subscription documents for signature separately.", "",
        "With thanks,", firm].join("\n"),
    }, { summary: `Subscription invitation: ${name}`, proposedBy: by });
  }
  return { subscription: s, url, outboxId };
}

// ---------------------------------------------------------------------------
// What the investor sees
// ---------------------------------------------------------------------------

async function refSub(db: Db, ref: SubscriptionRef) {
  const s = await subOr404(db, ref.subscriptionId);
  const r = (await getRaise(db, s.raise_id))!;
  return { s, r };
}

export async function subscriptionView(db: Db, ref: SubscriptionRef) {
  const { s, r } = await refSub(db, ref);
  const L = FUNDRAISING_LABELS;
  const subDocs = (await docs(db, r.id)).filter((d) => d.status === "approved" && ["subscription", "lpa", "ppm"].includes(d.category));
  const seen = new Set<string>();
  return {
    firm: await firmName(db), raise: r.name, investor: s.investor_name, status: s.status, naturalPerson: s.natural_person,
    commitmentUsd: s.commitment_usd, minCommitmentUsd: r.min_commitment_usd,
    needsQualifiedPurchaser: r.exemption === "3c7", generalSolicitation: r.offering === "506c",
    accreditedBases: (s.natural_person ? NATURAL_BASES : ENTITY_BASES).map((id) => ({ id, label: L.accreditedBases[id]! })),
    qpBases: Object.entries(L.qpBases).map(([id, label]) => ({ id, label })),
    taxForms: Object.entries(L.taxForms).map(([id, label]) => ({ id, label })),
    documents: subDocs.filter((d) => !seen.has(d.title) && seen.add(d.title)).map((d) => ({ title: d.title, category: L.docCategories[d.category] })),
    answers: s.questionnaire,
  };
}

export async function subscriptionSubmit(db: Db, ref: SubscriptionRef, input: Record<string, unknown>) {
  const { s, r } = await refSub(db, ref);
  const legalName = text(input.legalName);
  if (!legalName) throw new FundraisingInvalid("Enter your legal name, exactly as it will appear on the fund's register.");
  const commitment = money(input.commitmentUsd);
  if (!commitment || commitment <= 0) throw new FundraisingInvalid("Enter your commitment.");
  const basis = String(input.accreditedBasis ?? "");
  const bases = s.natural_person ? NATURAL_BASES : ENTITY_BASES;
  if (!bases.includes(basis)) throw new FundraisingInvalid("Pick how you qualify as an accredited investor.");
  const qp = r.exemption === "3c7" ? String(input.qpBasis ?? "") : "";
  if (r.exemption === "3c7" && !(qp in FUNDRAISING_LABELS.qpBases) && basis !== "knowledgeable_employee") throw new FundraisingInvalid("Pick how you qualify as a qualified purchaser: this fund accepts only qualified purchasers.");
  const taxForm = String(input.taxForm ?? "");
  if (!(taxForm in FUNDRAISING_LABELS.taxForms)) throw new FundraisingInvalid("Pick the tax form you'll provide.");
  const jurisdiction = text(input.jurisdiction);
  if (!jurisdiction) throw new FundraisingInvalid("Enter your country and, in the US, your state of residence or organization.");
  const emails = emailsOf(input.noticeEmails);
  if (!emails.length || emails.some((e) => !EMAIL.test(e))) throw new FundraisingInvalid("Enter at least one email for notices, correctly formed.");
  const owners = Array.isArray(input.beneficialOwners) ? (input.beneficialOwners as { name?: unknown; pct?: unknown }[]).map((o) => ({ name: text(o.name) ?? "", pct: money(o.pct) ?? 0 })).filter((o) => o.name) : [];
  if (!s.natural_person && !owners.length && input.noOwnerOver25 !== true) throw new FundraisingInvalid("List anyone who owns 25% or more of the investing entity, or confirm that no one does.");
  if (owners.some((o) => o.pct < 0 || o.pct > 100)) throw new FundraisingInvalid("Ownership percentages are between 0 and 100.");
  const minReps = input.minimumInvestmentReps === true;
  if (input.accurate !== true) throw new FundraisingInvalid("Confirm that your answers are true and complete.");
  const signedName = text(input.signedName);
  if (!signedName) throw new FundraisingInvalid("Type your name to sign the questionnaire.");
  const questionnaire = {
    legalName, accreditedBasis: basis, qpBasis: qp || null, benefitPlan: input.benefitPlan === true, pooledVehicle: input.pooledVehicle === true,
    knowledgeableEmployee: basis === "knowledgeable_employee", taxForm, jurisdiction, noticeEmails: emails, beneficialOwners: owners, noOwnerOver25: input.noOwnerOver25 === true,
    foiaSubject: input.foiaSubject === true, sourceOfFunds: text(input.sourceOfFunds), minimumInvestmentReps: minReps, signedName, signedAt: new Date().toISOString(),
  };
  await updateSubscription(db, s.id, {
    investor_name: legalName, commitment_usd: commitment, questionnaire, accredited: true, accredited_basis: basis, qualified_purchaser: Boolean(qp), qp_basis: qp || null,
    knowledgeable_employee: basis === "knowledgeable_employee", benefit_plan: input.benefitPlan === true, pooled_vehicle: input.pooledVehicle === true,
    minimum_investment_reps: minReps, tax_form: taxForm, jurisdiction, emails, beneficial_owners: owners, status: "submitted", submitted_at: new Date().toISOString(),
    verification: s.verification ?? "self_certified",
  }, "investor", "fundraising.subscription.submitted");
  if (s.prospect_id) {
    await updateProspect(db, s.prospect_id, { stage: "committed", committed_usd: commitment }, "investor");
    await insertActivity(db, { prospectId: s.prospect_id, occurredOn: today(), kind: "document", summary: `Subscription questionnaire submitted: ${usd(commitment)}` }, "investor");
  }
  return { submitted: true, belowMinimum: r.min_commitment_usd !== null && commitment < r.min_commitment_usd };
}

// ---------------------------------------------------------------------------
// The firm's review
// ---------------------------------------------------------------------------

export function subscriber(s: SubscriptionRow): Subscriber {
  return {
    id: s.id, name: s.investor_name, natural: s.natural_person, commitment: s.commitment_usd ?? 0, accredited: s.accredited, qualifiedPurchaser: s.qualified_purchaser,
    knowledgeableEmployee: s.knowledgeable_employee, benefitPlanInvestor: s.benefit_plan, pooledVehicle: s.pooled_vehicle, verification: s.verification,
    minimumInvestmentReps: s.minimum_investment_reps, gp: s.kind === "gp",
  };
}

/** What still stands between a subscription and a closing. */
export function readiness(s: SubscriptionRow, r: RaiseRow): string[] {
  const out: string[] = [];
  if (s.status === "invited") out.push("Questionnaire not yet submitted");
  if (!s.commitment_usd) out.push("No commitment amount");
  if (!s.sanctions) out.push("Not yet screened against OFAC's lists");
  else if (s.sanctions.hits.length && s.kyc_status !== "cleared") out.push("Potential sanctions match to clear");
  if (s.kyc_status !== "cleared") out.push(s.kyc_status === "flagged" ? "KYC flagged" : "KYC not yet cleared");
  if (r.offering === "506c" && (!s.verification || s.verification === "self_certified")) out.push("Accreditation not verified (506(c))");
  if (!s.signed_on) out.push("Subscription documents not signed");
  if (s.status === "submitted") out.push("Not yet accepted by a partner");
  return out;
}

export async function screenSubscriber(db: Db, id: string, by: string, deps: { lists?: () => Promise<{ entries: SanctionsEntry[]; fetchedAt: string }> } = {}) {
  const s = await subOr404(db, id);
  const names = [...new Set([s.investor_name, ...s.beneficial_owners.map((o) => o.name)].map((n) => n.trim()).filter(Boolean))];
  const { entries, fetchedAt } = await (deps.lists ?? (() => sanctionsLists()))();
  const results = screen(names, entries);
  const hits = results.flatMap((x) => x.hits.map((h) => ({ name: x.name, match: `${h.matchedName} (${h.entry.list}${h.entry.program ? `, ${h.entry.program}` : ""})`, score: h.score })));
  await updateSubscription(db, id, { sanctions: { checkedAt: fetchedAt, names, hits }, ...(hits.length ? { kyc_status: "flagged", kyc_note: `${hits.length} potential sanctions ${hits.length === 1 ? "match" : "matches"}: clear each with a reason.` } : {}) }, by, "fundraising.subscription.screened");
  return { names, hits, listsAsOf: fetchedAt };
}

/** Accreditation and KYC from Parallel Markets, looked up by the investor's email. */
export async function checkWithParallel(db: Db, id: string, by: string, deps: { status?: (email: string) => Promise<ParallelStatus> } = {}) {
  const s = await subOr404(db, id);
  if (!s.emails.length) throw new FundraisingInvalid("The subscription has no email to look up.");
  if (!deps.status && !(await isReady(db, "parallel"))) throw new FundraisingInvalid("Connect Parallel Markets first.");
  const st = deps.status ? await deps.status(s.emails[0]!) : await withFirmCredentials(db, ["parallel"], () => parallelStatus(s.emails[0]!));
  const patch: Record<string, unknown> = {};
  if (st.accredited) { patch.verification = "platform"; patch.accredited = true; }
  await updateSubscription(db, id, patch, by, "fundraising.subscription.parallel");
  return st;
}

export async function reviewSubscription(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const s = await subOr404(db, id);
  if (s.status === "admitted" || s.status === "rejected" || s.status === "withdrawn") throw new FundraisingInvalid(`This subscription is ${FUNDRAISING_LABELS.subscriptionStatus[s.status]!.toLowerCase()}.`);
  const patch: Record<string, unknown> = {};
  if (input.commitmentUsd !== undefined) patch.commitment_usd = money(input.commitmentUsd);
  if (input.verification !== undefined) {
    const v = String(input.verification);
    if (!(v in FUNDRAISING_LABELS.verification)) throw new FundraisingInvalid("Pick how accreditation was verified.");
    patch.verification = v;
  }
  if (input.signedOn !== undefined) patch.signed_on = isDay(input.signedOn) ? input.signedOn : null;
  if (input.kycStatus !== undefined) {
    const k = String(input.kycStatus);
    if (!(k in FUNDRAISING_LABELS.kycStatus)) throw new FundraisingInvalid("Pick the KYC status.");
    const note = text(input.kycNote);
    if (k === "cleared") {
      if (!s.sanctions) throw new FundraisingInvalid("Screen the investor and its owners against OFAC's lists before clearing KYC.");
      if (s.sanctions.hits.length && !note) throw new FundraisingInvalid("Say why each potential sanctions match is a different person or entity.");
      if (!s.natural_person && !s.beneficial_owners.length && !(s.questionnaire as { noOwnerOver25?: boolean }).noOwnerOver25) throw new FundraisingInvalid("The investor hasn't listed its beneficial owners.");
    }
    if (k === "flagged" && !note) throw new FundraisingInvalid("Say what's wrong.");
    Object.assign(patch, { kyc_status: k, kyc_note: note, kyc_by: by });
  }
  await updateSubscription(db, id, patch, by, "fundraising.subscription.review");
}

/** A partner accepts or rejects. Acceptance checks this investor against the offering's rules. */
export async function decideSubscription(db: Db, id: string, input: { accept?: unknown; reason?: unknown }, by: string) {
  const s = await subOr404(db, id);
  const r = (await getRaise(db, s.raise_id))!;
  if (s.status !== "submitted") throw new FundraisingInvalid(s.status === "invited" ? "The investor hasn't submitted its questionnaire yet." : `This subscription is already ${FUNDRAISING_LABELS.subscriptionStatus[s.status]!.toLowerCase()}.`);
  if (input.accept !== true) {
    const reason = text(input.reason);
    if (!reason) throw new FundraisingInvalid("Say why the subscription is rejected.");
    await updateSubscription(db, id, { status: "rejected", rejected_reason: reason, decided_by: by, decided_at: new Date().toISOString() }, by, "fundraising.subscription.rejected");
    return { accepted: false, issues: [] };
  }
  if (s.kyc_status !== "cleared") throw new FundraisingInvalid("Clear KYC before accepting.");
  // This investor's own standing only; the fund-wide limits (hard cap, investor count, the 25% plan test) are checked at the closing.
  const issues = offeringIssues({ exemption: r.exemption, offering: r.offering, hardCapUsd: null, minCommitmentUsd: r.min_commitment_usd, vcoc: r.vcoc }, [subscriber(s)]).filter((i) => i.investor);
  const blocking = issues.filter((i) => i.severity === "block");
  if (blocking.length) throw new FundraisingInvalid(blocking.map((i) => i.message).join(" "));
  await updateSubscription(db, id, { status: "accepted", decided_by: by, decided_at: new Date().toISOString() }, by, "fundraising.subscription.accepted");
  return { accepted: true, issues };
}

export async function withdrawSubscription(db: Db, id: string, by: string) {
  const s = await subOr404(db, id);
  if (s.status === "admitted") throw new FundraisingInvalid("This investor is already admitted; a transfer or withdrawal after closing goes through the LPA.");
  await updateSubscription(db, id, { status: "withdrawn", token_revoked_at: new Date().toISOString() }, by, "fundraising.subscription.withdrawn");
}

/** Queue the subscription documents (approved PDFs in the data room) as a DocuSign draft to the investor. Nothing is sent until someone approves it. */
export async function sendSubscriptionDocs(db: Db, id: string, input: { signerName?: unknown; signerEmail?: unknown }, by: string) {
  const s = await subOr404(db, id);
  const r = (await getRaise(db, s.raise_id))!;
  const pdfs = (await docs(db, r.id)).filter((d) => d.status === "approved" && d.category === "subscription" && d.mime_type === "application/pdf");
  const latest = [...new Map(pdfs.map((d) => [d.title, d])).values()];
  if (!latest.length) throw new FundraisingInvalid("Upload the subscription agreement as a PDF to the data room and have it approved first.");
  const signerEmail = text(input.signerEmail) ?? s.emails[0] ?? null;
  const signerName = text(input.signerName) ?? ((s.questionnaire as { signedName?: string }).signedName || s.investor_name);
  if (!signerEmail || !EMAIL.test(signerEmail)) throw new FundraisingInvalid("Enter the signer's email.");
  const files = [];
  for (const d of latest.slice(0, 5)) files.push({ name: d.file_name, base64: Buffer.from((await getDoc(db, d.id))!.content).toString("base64") });
  const outboxId = await queue(db, "docusign_draft", { subject: `${r.name}: subscription documents`.slice(0, 100), documents: files, signers: [{ name: signerName, email: signerEmail }] },
    { summary: `DocuSign draft: subscription documents for ${s.investor_name}`, proposedBy: by });
  if (s.prospect_id) await insertActivity(db, { prospectId: s.prospect_id, occurredOn: today(), kind: "document", summary: "Subscription documents queued for signature" }, by);
  return { outboxId, documents: files.length };
}

export { longDate };
