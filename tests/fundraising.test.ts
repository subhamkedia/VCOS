import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { config } from "../lib/config.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm, testRoot } from "./helpers.js";
import { createFirm, dataRoomByToken, subscriptionByToken } from "../ledger/platform.js";
import { listOutbox } from "../ledger/repository.js";
import { callItems, partners } from "../ledger/lp.js";
import { answers } from "../ledger/fundraising.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { connectWithOAuth } from "../modules/connections/index.js";
import * as F from "../modules/fundraising/index.js";
import * as L from "../modules/lp/index.js";
import type { SanctionsEntry } from "../connectors/ofac.js";
import { parseParallel } from "../connectors/parallel.js";

// Fictional firm, fund, investors and people throughout.

beforeAll(async () => {
  setSecretKeyForTests(randomBytes(32));
  await testRoot();
});
afterEach(() => {
  config.googleClientId = "";
  config.googleClientSecret = "";
});

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const APP = "https://app.example";
const PDF = new TextEncoder().encode("%PDF-1.4 fictional deck");
const NO_HITS = { lists: async () => ({ entries: [] as SanctionsEntry[], fetchedAt: "2026-09-01T00:00:00Z" }) };
const tokenOf = (url: string, path: string) => url.split(`/${path}/`)[1]!;

async function firm(offering: "506b" | "506c" = "506b") {
  const { root, db } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, {
    ...p,
    firm: { ...p.firm, legalName: "Northbeam Management LLC", foundedYear: 2020, hq: "Pittsburgh, PA", aumUsd: 60e6, fundsRaised: 1, teamSize: 7, investmentTeamSize: 4 },
    fund: { ...p.fund, name: "Northbeam Fund II", targetSizeUsd: 40e6, hardCapUsd: 50e6, firstCloseDate: "2025-01-15", investmentPeriodYears: 4, termYears: 10, managementFeePct: 2, carryPct: 20, hurdlePct: 0, gpCommitmentPct: 1, icApproval: "majority", icMembers: 3 },
  }, PAT);
  const raise = await F.createRaise(db, { minCommitmentUsd: 250_000, offering }, LEE);
  return { root, db, raise };
}

async function gmail(db: Db) {
  config.googleClientId = "app-client";
  config.googleClientSecret = "app-secret";
  await connectWithOAuth(db, "gmail", "rt-northbeam", "pat@northbeam.vc", PAT).catch(() => undefined);
}

/** Invite, submit, screen, clear, sign and accept one investor. */
async function subscribe(root: Db, db: Db, raiseId: string, o: { name: string; kind: string; commitment: number; natural?: boolean; basis?: string; plan?: boolean }) {
  const inv = await F.inviteSubscriber(db, raiseId, { investorName: o.name, kind: o.kind, naturalPerson: o.natural ?? false, commitmentUsd: o.commitment, emails: `ir@${o.name.split(" ")[0]!.toLowerCase()}.example` }, PAT, APP);
  const ref = (await subscriptionByToken(root, tokenOf(inv.url, "subscribe")))!;
  await F.subscriptionSubmit(scopedDb(root, ref.firmId), ref, {
    legalName: o.name, commitmentUsd: o.commitment, accreditedBasis: o.basis ?? (o.natural ? "net_worth" : "entity_investments"), taxForm: "w9", jurisdiction: "US-PA",
    noticeEmails: `ir@${o.name.split(" ")[0]!.toLowerCase()}.example`, noOwnerOver25: true, benefitPlan: o.plan ?? false, accurate: true, signedName: "A. Signer",
  });
  await F.screenSubscriber(db, inv.subscription.id, PAT, NO_HITS);
  await F.reviewSubscription(db, inv.subscription.id, { kycStatus: "cleared", signedOn: "2025-01-10" }, PAT);
  await F.decideSubscription(db, inv.subscription.id, { accept: true }, LEE);
  return inv.subscription.id;
}

describe("the raise and its pipeline", () => {
  it("starts from the firm profile and keeps the offering's terms", async () => {
    const { db, raise } = await firm();
    expect(raise).toMatchObject({ name: "Northbeam Fund II", target_usd: 40e6, hard_cap_usd: 50e6, min_commitment_usd: 250_000, exemption: "3c1", offering: "506b", equalization_rate_pct: 8 });
    await expect(F.editRaise(db, raise.id, { hardCapUsd: 30e6 }, LEE)).rejects.toThrow(/below the target/);
    await expect(F.createRaise(db, {}, LEE)).rejects.toThrow(/already a raise/);
  });

  it("moves prospects through stages, logs every change, and needs a reason to decline", async () => {
    const { db, raise } = await firm();
    const p = await F.addProspect(db, raise.id, { name: "Allegheny Teachers' Pension", kind: "pension", askUsd: 10e6, emails: "pm@alleghenytpp.example", nextStep: "Send deck", nextStepOn: "2025-01-02" }, PAT);
    await F.editProspect(db, p.id, { stage: "meeting" }, PAT);
    await expect(F.editProspect(db, p.id, { stage: "declined" }, PAT)).rejects.toThrow(/Say why/);
    await expect(F.editProspect(db, p.id, { stage: "closed" }, PAT)).rejects.toThrow(/closing/);
    await expect(F.editProspect(db, p.id, { stage: "soft_circle" }, PAT)).rejects.toThrow(/soft-circled amount/);
    await F.editProspect(db, p.id, { stage: "soft_circle", softCircleUsd: 8e6 }, PAT);
    await F.logActivity(db, p.id, { kind: "meeting", summary: "IC pre-read with the pension's staff" }, PAT);
    const q = await F.addProspect(db, raise.id, { name: "Halvorsen Family Office", kind: "family_office", askUsd: 5e6 }, PAT);
    await F.editProspect(db, q.id, { stage: "declined", declineReason: "Over-allocated to venture this year" }, PAT);
    const log = await F.prospectActivity(db, p.id);
    expect(log.map((a) => a.kind)).toEqual(expect.arrayContaining(["stage", "meeting"]));
    const v = await F.raiseView(db, raise.id);
    expect(v.pipeline).toMatchObject({ softCircled: 8e6, weighted: 6e6 });
    expect(v.prospects.find((x) => x.name === "Allegheny Teachers' Pension")!.overdue).toBe(true);
    const csv = "Organization,Investor Type,Email,Ask,Introduced By\nKeystone Insurance,Insurance company,alts@keystone.example,\"$4,000,000\",Maya\nHalvorsen Family Office,Family office,,,\n";
    const imp = await F.importProspectsCsv(db, raise.id, { name: "crm.csv", text: csv }, PAT);
    expect(imp.added).toBe(1);
    expect(imp.skipped[0]!.reason).toMatch(/already in this raise/);
    const aff = await F.importAffinityList(db, raise.id, 42, PAT, { list: async () => [{ id: 1, name: "Riverside Fund of Funds", domains: [] }, { id: 2, name: "Keystone Insurance", domains: [] }] });
    expect(aff).toEqual({ found: 2, added: 1 });
  });
});

describe("the data room", () => {
  it("shows investors only reviewed documents, after they acknowledge confidentiality, and records every open", async () => {
    const { root, db, raise } = await firm();
    await gmail(db);
    const p = await F.addProspect(db, raise.id, { name: "Three Rivers Foundation", kind: "endowment_foundation", emails: "cio@threerivers.example" }, PAT);
    await expect(F.shareDataRoom(db, p.id, {}, PAT, APP)).rejects.toThrow(/No documents are approved/);
    const deck = await F.uploadDoc(db, raise.id, { name: "Fund II deck.pdf", bytes: PDF }, { category: "deck" }, PAT);
    expect(deck).toMatchObject({ marketing: true, status: "draft", version: 1 });
    await expect(F.uploadDoc(db, raise.id, { name: "notes.exe", bytes: PDF }, { category: "deck" }, PAT)).rejects.toThrow(/Upload a PDF/);
    await expect(F.approveDoc(db, deck.id, PAT)).rejects.toThrow(/Someone other than/);
    await F.approveDoc(db, deck.id, LEE);
    const lpa = await F.uploadDoc(db, raise.id, { name: "LPA.pdf", bytes: PDF }, { category: "lpa" }, PAT);
    expect(lpa.marketing).toBe(false); // still waits for review before investors see it
    const shared = await F.shareDataRoom(db, p.id, {}, PAT, APP);
    expect(shared.outboxId).toBeTruthy();
    const ref = (await dataRoomByToken(root, tokenOf(shared.url, "data-room")))!;
    const fdb = scopedDb(root, ref.firmId);
    expect((await F.dataRoomView(fdb, ref))).toMatchObject({ acknowledged: false, documents: [] });
    await expect(F.openDoc(fdb, ref, deck.id, "view")).rejects.toThrow(/Acknowledge/);
    await F.acknowledgeDataRoom(fdb, ref);
    const view = await F.dataRoomView(fdb, ref);
    expect(view.documents.map((d) => d.title)).toEqual(["Fund II deck"]);
    await expect(F.openDoc(fdb, ref, lpa.id, "view")).rejects.toThrow(/No such document/);
    const file = await F.openDoc(fdb, ref, deck.id, "download");
    expect(new TextDecoder().decode(file.content)).toContain("%PDF");
    const e = await F.engagement(db, raise.id);
    expect(e.byProspect[0]).toMatchObject({ prospectId: p.id, downloads: 1, documents: 1 });
    expect((await F.prospectActivity(db, p.id)).some((a) => a.summary === "Downloaded Fund II deck")).toBe(true);
    await F.revokeDataRoom(db, p.id, PAT);
    expect(await dataRoomByToken(root, tokenOf(shared.url, "data-room"))).toBeNull();
  });
});

describe("the DDQ", () => {
  it("drafts what the records support with sources, needs a second person, and shares only approved answers", async () => {
    const { db } = await firm();
    const d = await F.draftFromRecords(db, PAT);
    expect(d.drafted).toBeGreaterThan(5);
    const saved = new Map((await answers(db)).map((a) => [a.question_key, a]));
    expect(saved.get("terms.economics")!.answer).toMatch(/Management fee 2% .* Carried interest 20%, no preferred return/);
    expect(saved.get("terms.economics")!.sources[0]).toMatch(/Firm profile/);
    expect(saved.get("process.decision")!.answer).toMatch(/Simple majority/);
    expect(saved.has("track.performance")).toBe(false); // no approved report yet: nothing to say
    await expect(F.approveDdqAnswer(db, "terms.economics", PAT)).rejects.toThrow(/Someone other than/);
    await F.approveDdqAnswer(db, "terms.economics", LEE);
    await F.saveAnswer(db, "legal.litigation", { answer: "None." }, PAT);
    await F.draftFromRecords(db, PAT);
    expect((await answers(db)).find((a) => a.question_key === "terms.economics")!.status).toBe("approved"); // never overwritten
    const md = await F.exportDdq(db, {}, PAT);
    expect(md.text).toMatch(/## Fund terms[\s\S]*Management fee 2%/);
    expect(md.text).toMatch(/Has the firm or any of its principals been subject to litigation[\s\S]*?_To follow._/);
    const csv = await F.exportDdq(db, { format: "csv" }, PAT);
    expect(csv.text.split("\n")[0]).toBe("Section,Question,Answer,Sources,Approved on");
  });
});

describe("subscriptions", () => {
  it("collect the questionnaire without an account, screen and verify, and are accepted by a partner", async () => {
    const { root, db, raise } = await firm("506c");
    await gmail(db);
    const inv = await F.inviteSubscriber(db, raise.id, { investorName: "Keystone Insurance Mutual", kind: "insurance", commitmentUsd: 2e6, emails: "alts@keystone.example" }, PAT, APP);
    expect(inv.outboxId).toBeTruthy();
    const ref = (await subscriptionByToken(root, tokenOf(inv.url, "subscribe")))!;
    const sdb = scopedDb(root, ref.firmId);
    const v = await F.subscriptionView(sdb, ref);
    expect(v).toMatchObject({ generalSolicitation: true, needsQualifiedPurchaser: false });
    expect(v.accreditedBases.map((b) => b.id)).toContain("entity_investments");
    await expect(F.subscriptionSubmit(sdb, ref, { legalName: "Keystone Insurance Mutual", commitmentUsd: 2e6, accreditedBasis: "income" })).rejects.toThrow(/accredited/);
    await expect(F.subscriptionSubmit(sdb, ref, { legalName: "Keystone Insurance Mutual", commitmentUsd: 2e6, accreditedBasis: "institution", taxForm: "w9", jurisdiction: "US-PA", noticeEmails: "alts@keystone.example", accurate: true, signedName: "J. Doe" })).rejects.toThrow(/25% or more/);
    await F.subscriptionSubmit(sdb, ref, {
      legalName: "Keystone Insurance Mutual", commitmentUsd: 2e6, accreditedBasis: "institution", taxForm: "w9", jurisdiction: "US-PA", noticeEmails: "alts@keystone.example",
      beneficialOwners: [{ name: "Ivan Petrovsky", pct: 30 }], accurate: true, signedName: "J. Doe", minimumInvestmentReps: true,
    });
    // A potential sanctions match on an owner flags KYC; clearing it needs a reason.
    const entries: SanctionsEntry[] = [{ id: "1", list: "SDN", name: "PETROVSKY, Ivan", type: "individual", program: "RUSSIA-EO14024", aliases: [] }];
    const scr = await F.screenSubscriber(db, inv.subscription.id, PAT, { lists: async () => ({ entries, fetchedAt: "2026-09-01T00:00:00Z" }) });
    expect(scr.hits).toHaveLength(1);
    await expect(F.reviewSubscription(db, inv.subscription.id, { kycStatus: "cleared" }, PAT)).rejects.toThrow(/Say why/);
    await expect(F.decideSubscription(db, inv.subscription.id, { accept: true }, LEE)).rejects.toThrow(/Clear KYC/);
    await F.reviewSubscription(db, inv.subscription.id, { kycStatus: "cleared", kycNote: "Different person: date of birth and nationality don't match the SDN entry." }, PAT);
    // 506(c): self-certification isn't verification; the minimum-investment method works at $1M+ with the representations.
    await F.reviewSubscription(db, inv.subscription.id, { verification: "self_certified" }, PAT);
    await expect(F.decideSubscription(db, inv.subscription.id, { accept: true }, LEE)).rejects.toThrow(/reasonable steps to verify/);
    await F.reviewSubscription(db, inv.subscription.id, { verification: "minimum_investment" }, PAT);
    expect(await F.decideSubscription(db, inv.subscription.id, { accept: true }, LEE)).toMatchObject({ accepted: true });
    expect(await subscriptionByToken(root, tokenOf(inv.url, "subscribe"))).toBeNull(); // decided: the link stops working
    const other = await F.inviteSubscriber(db, raise.id, { investorName: "Quill Capital", kind: "corporate", emails: "x@quill.example" }, PAT, APP);
    await expect(F.decideSubscription(db, other.subscription.id, { accept: false }, LEE)).rejects.toThrow(/submitted/);
  });

  it("read Parallel Markets' accreditation and identity results", () => {
    expect(parseParallel({ accreditations: [{ status: "current", expires_at: "2026-12-01T00:00:00Z" }] }, { identity_details: { status: "approved" } }))
      .toEqual({ accredited: true, accreditationStatus: "current", accreditationExpires: "2026-12-01", identityStatus: "approved", kycCleared: true });
    expect(parseParallel({ accreditations: [] }, {}).accredited).toBe(false);
  });

  it("queue the subscription documents as a DocuSign draft, never sent", async () => {
    const { db, raise } = await firm();
    const sub = await F.inviteSubscriber(db, raise.id, { investorName: "Riverside Fund of Funds", kind: "fund_of_funds", emails: "ops@riverside.example" }, PAT, APP);
    await expect(F.sendSubscriptionDocs(db, sub.subscription.id, {}, PAT)).rejects.toThrow(/Upload the subscription agreement/);
    const d = await F.uploadDoc(db, raise.id, { name: "Subscription agreement.pdf", bytes: PDF }, { category: "subscription" }, PAT);
    await F.approveDoc(db, d.id, LEE);
    const r = await F.sendSubscriptionDocs(db, sub.subscription.id, {}, PAT);
    const item = (await listOutbox(db, "pending")).find((x) => x.id === r.outboxId)!;
    expect(item).toMatchObject({ channel: "docusign_draft", status: "pending" });
  });
});

describe("closings", () => {
  it("admit investors into LP Reporting, then equalize a later closing so NAV doesn't move", async () => {
    const { root, db, raise } = await firm();
    await gmail(db);
    const a = await subscribe(root, db, raise.id, { name: "Allegheny Teachers' Pension", kind: "pension", commitment: 20e6 });
    const b = await subscribe(root, db, raise.id, { name: "Northbeam GP", kind: "gp", commitment: 0.4e6 });
    const draft = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: [a, b] }, PAT);
    expect(draft.blocked).toBe(false);
    await expect(F.approveClosing(db, draft.closing.id, PAT)).rejects.toThrow(/Someone other than/);
    const first = await F.approveClosing(db, draft.closing.id, LEE);
    expect(first).toMatchObject({ admitted: 2, equalization: 0, formDDueOn: "2025-01-30" });
    const ps = await partners(db, first.fundId);
    expect(ps.map((p) => [p.name, p.commitment_usd, p.fee_paying, p.closing])).toEqual([["Allegheny Teachers' Pension", 20e6, true, 1], ["Northbeam GP", 0.4e6, false, 1]]);
    // A call before the second closing: $2M for investments and a fee.
    const { call } = await L.draftCall(db, first.fundId, { noticeDate: "2025-02-01", dueDate: "2025-02-20", investmentsUsd: 2e6, fee: { from: "2025-01-15", to: "2025-06-30" } }, PAT);
    await L.approveCall(db, call.id, LEE);
    const paid = await callItems(db, { callId: call.id });
    // Second closing, a year later: a $20.4M investor doubles the fund.
    const c = await subscribe(root, db, raise.id, { name: "Three Rivers Foundation", kind: "endowment_foundation", commitment: 20.4e6 });
    const second = await F.draftClosing(db, raise.id, { closingDate: "2026-02-20", subscriptionIds: [c] }, PAT);
    const preview = (await F.closingView(db, second.closing.id)).equalization;
    expect(preview.find((l) => l.partner_name === "Three Rivers Foundation")!.capital_usd).toBeCloseTo(1e6, 0);
    const done = await F.approveClosing(db, second.closing.id, LEE);
    expect(done.equalization).toBe(3);
    const eq = (await F.closingView(db, second.closing.id)).equalization;
    const three = eq.find((l) => l.partner_name === "Three Rivers Foundation")!;
    expect(three.capital_usd).toBeCloseTo(1e6, 0); // half of the $2M
    const feePaid = paid.find((i) => i.partner_name === "Allegheny Teachers' Pension")!.fee_usd;
    expect(three.fee_usd).toBeCloseTo(feePaid * (20.4 / 20), 1); // its own fee from the first closing
    expect(three.interest_usd).toBeCloseTo(1e6 * 0.08, -2); // about a year at 8%
    const allegheny = eq.find((l) => l.partner_name === "Allegheny Teachers' Pension")!;
    expect(allegheny.capital_usd).toBeLessThan(0);
    expect(eq.reduce((s, l) => s + l.interest_usd, 0)).toBeCloseTo(0, 2);
    const v = await L.fundView(db, first.fundId, "2026-03-31");
    const st = v.statements.statements.find((s) => s.name === "Three Rivers Foundation")!;
    expect(st.inception.closeInterest).toBeCloseTo(three.interest_usd, 2);
    expect(st.unfunded).toBeCloseTo(20.4e6 - three.capital_usd - three.fee_usd, 0);
    // NAV is what the fund holds: contributions less fees; interest passes between partners.
    const called = paid.reduce((s, i) => s + i.amount_usd, 0);
    expect(v.summary.nav).toBeCloseTo(called - paid.reduce((s, i) => s + i.fee_usd, 0), 0);
    for (const s of v.statements.statements) {
      const q = s.inception;
      expect(q.contributions - q.distributions - q.managementFees - q.expenses - q.closeInterest + q.realizedGain + q.unrealizedGain - q.carriedInterest).toBeCloseTo(q.ending, 1);
    }
    expect((await listOutbox(db, "pending")).some((o) => /closing of February 20, 2026/.test(String(o.payload.subject)))).toBe(true);
  });

  it("won't close past the hard cap or into plan assets", async () => {
    const { root, db, raise } = await firm();
    await F.editRaise(db, raise.id, { hardCapUsd: 40e6 }, LEE);
    const a = await subscribe(root, db, raise.id, { name: "Allegheny Teachers' Pension", kind: "pension", commitment: 15e6, plan: true });
    const b = await subscribe(root, db, raise.id, { name: "Keystone Insurance", kind: "insurance", commitment: 30e6 });
    const d = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: [a, b] }, PAT);
    expect(d.issues.map((i) => i.key)).toEqual(expect.arrayContaining(["hard_cap", "erisa_25"]));
    await expect(F.approveClosing(db, d.closing.id, LEE)).rejects.toThrow(/hard cap.*plan assets/);
    await F.cancelClosing(db, d.closing.id, LEE);
    await F.editRaise(db, raise.id, { hardCapUsd: 50e6, vcoc: true }, LEE);
    const again = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: [a, b] }, PAT);
    expect(again.blocked).toBe(false);
  });
});

describe("side letters and MFN", () => {
  it("offer MFN holders what equal or smaller investors got, and add what they elect", async () => {
    const { root, db, raise } = await firm();
    const big = await subscribe(root, db, raise.id, { name: "Allegheny Teachers' Pension", kind: "pension", commitment: 15e6 });
    const small = await subscribe(root, db, raise.id, { name: "Keystone Insurance", kind: "insurance", commitment: 5e6 });
    await F.addTerm(db, big, { category: "mfn", text: "Most favored nation, per the fund's MFN provisions." }, LEE);
    await F.addTerm(db, small, { category: "reporting", text: "Quarterly portfolio company ESG data." }, LEE);
    await F.addTerm(db, small, { category: "lpac_seat", text: "A seat on the LPAC." }, LEE);
    const pkg = await F.mfnPackage(db, raise.id, { windowDays: 30 }, PAT);
    expect(pkg.offered).toBe(1);
    const view = await F.sideLetterView(db, raise.id);
    expect(view.elections).toHaveLength(1);
    expect(view.elections[0]!.term!.category).toBe("reporting");
    await F.decideMfn(db, view.elections[0]!.id, { elect: true }, PAT);
    const after = await F.sideLetterView(db, raise.id);
    expect(after.terms.filter((t) => t.investor_name === "Allegheny Teachers' Pension").map((t) => t.category).sort()).toEqual(["mfn", "reporting"]);
    expect(after.obligations.map((o) => o.investor)).toEqual(expect.arrayContaining(["Allegheny Teachers' Pension", "Keystone Insurance"]));
  });
});

describe("investor relations", () => {
  it("run LPAC consents to a majority, and keep investor requests on a clock", async () => {
    const { root, db, raise } = await firm();
    const ids = [];
    for (const [name, kind] of [["Allegheny Teachers' Pension", "pension"], ["Keystone Insurance", "insurance"], ["Three Rivers Foundation", "endowment_foundation"]] as const) ids.push(await subscribe(root, db, raise.id, { name, kind, commitment: 5e6 }));
    const cl = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: ids }, PAT);
    const { fundId } = await F.approveClosing(db, cl.closing.id, LEE);
    const lps = await partners(db, fundId);
    for (const p of lps) await F.addLpacMember(db, fundId, { partnerId: p.id, representative: `${p.name} delegate` }, LEE);
    await expect(F.addLpacMember(db, fundId, { partnerId: lps[0]!.id, representative: "Again" }, LEE)).rejects.toThrow(/already has a seat/);
    const { consent } = await F.requestConsent(db, fundId, { kind: "conflict", topic: "Cross-fund investment in Kestrel", detail: "Fund II would invest in a company Fund I holds; priced by an independent lead." }, LEE);
    const ms = (await F.lpacView(db, fundId)).members;
    await F.castVote(db, consent.id, { memberId: ms[0]!.id, vote: "approve" }, PAT);
    await expect(F.decideLpacConsent(db, consent.id, { outcome: "approved" }, LEE)).rejects.toThrow(/Only 1 of 3/);
    await F.castVote(db, consent.id, { memberId: ms[1]!.id, vote: "approve" }, PAT);
    expect(await F.decideLpacConsent(db, consent.id, { outcome: "approved" }, LEE)).toMatchObject({ approve: 2, members: 3, majority: true });
    const r = await F.logRequest(db, { fundId, fromName: "Keystone Insurance", category: "tax", subject: "Estimated 2025 K-1 income", receivedOn: "2025-02-01" }, PAT);
    expect((await F.requestQueue(db)).find((x) => x.id === r.id)).toMatchObject({ status: "open", overdue: true, due_on: "2025-02-11" });
    await F.answerInvestorRequest(db, r.id, { answer: "Sent our estimate on the portal." }, PAT);
    expect((await F.requestQueue(db)).find((x) => x.id === r.id)!.status).toBe("answered");
  });
});

describe("firm isolation", () => {
  it("keeps every fundraising table and every link to its firm", async () => {
    const { root, db, raise } = await firm();
    const p = await F.addProspect(db, raise.id, { name: "Three Rivers Foundation", kind: "endowment_foundation" }, PAT);
    await F.logActivity(db, p.id, { kind: "note", summary: "Intro from Maya" }, PAT);
    const d = await F.uploadDoc(db, raise.id, { name: "deck.pdf", bytes: PDF }, { category: "deck" }, PAT);
    await F.approveDoc(db, d.id, LEE);
    const shared = await F.shareDataRoom(db, p.id, {}, PAT, APP);
    const ref = (await dataRoomByToken(root, tokenOf(shared.url, "data-room")))!;
    await F.acknowledgeDataRoom(scopedDb(root, ref.firmId), ref);
    await F.openDoc(scopedDb(root, ref.firmId), ref, d.id, "view");
    await F.saveAnswer(db, "legal.litigation", { answer: "None." }, PAT);
    const ids = [await subscribe(root, db, raise.id, { name: "Allegheny Teachers' Pension", kind: "pension", commitment: 10e6 })];
    await F.addTerm(db, ids[0]!, { category: "mfn", text: "MFN." }, LEE);
    const s2 = await subscribe(root, db, raise.id, { name: "Keystone Insurance", kind: "insurance", commitment: 5e6 });
    await F.addTerm(db, s2, { category: "reporting", text: "Extra reporting." }, LEE);
    await F.mfnPackage(db, raise.id, {}, PAT);
    const cl = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: ids }, PAT);
    const { fundId } = await F.approveClosing(db, cl.closing.id, LEE);
    const { call } = await L.draftCall(db, fundId, { noticeDate: "2025-02-01", dueDate: "2025-02-20", investmentsUsd: 1e6 }, PAT);
    await L.approveCall(db, call.id, LEE);
    const cl2 = await F.draftClosing(db, raise.id, { closingDate: "2025-06-30", subscriptionIds: [s2] }, PAT);
    await F.approveClosing(db, cl2.closing.id, LEE);
    const lp = (await partners(db, fundId))[0]!;
    await F.addLpacMember(db, fundId, { partnerId: lp.id, representative: "Delegate" }, LEE);
    const { consent } = await F.requestConsent(db, fundId, { kind: "valuation", topic: "Q2 marks", detail: "Review of the Q2 marks." }, LEE);
    await F.castVote(db, consent.id, { memberId: (await F.lpacView(db, fundId)).members[0]!.id, vote: "approve" }, PAT);
    await F.logRequest(db, { fromName: "Keystone Insurance", category: "reporting", subject: "Q2 report" }, PAT);
    const tables = ["raises", "prospects", "prospect_activities", "dataroom_docs", "dataroom_links", "dataroom_views", "ddq_answers", "subscriptions", "closings", "equalization_items",
      "side_letter_terms", "mfn_elections", "lpac_members", "lpac_consents", "lpac_votes", "investor_requests"];
    for (const t of tables) expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBeGreaterThan(0);
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    for (const t of tables) expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    await expect(F.raiseView(other, raise.id)).rejects.toThrow(/No such raise/);
    expect((await F.overview(other)).raises).toEqual([]);
    // Activity and data room views are append-only.
    await expect(db.query("update prospect_activities set summary = 'x'")).rejects.toThrow();
    expect(ref.firmId).not.toBe((await other.query<{ id: string }>("select current_firm() as id")).rows[0]!.id);
  });
});
