import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm, testRoot } from "./helpers.js";
import { createFirm, subscriptionByToken } from "../ledger/platform.js";
import { insertInvestment } from "../ledger/execution.js";
import { insertClaim, insertEvidence } from "../ledger/repository.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { startDeal } from "../modules/diligence/index.js";
import * as C from "../modules/compliance/index.js";
import * as F from "../modules/fundraising/index.js";
import * as L from "../modules/lp/index.js";

// Fictional firm, people and companies throughout.

beforeAll(async () => {
  setSecretKeyForTests(randomBytes(32));
  await testRoot();
});

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const ANA = "human:ana@northbeam.vc";

async function firm() {
  const { root, db } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, { ...p, fund: { ...p.fund, name: "Northbeam Fund II", targetSizeUsd: 40e6, firstCloseDate: "2026-01-15" } }, PAT);
  return { root, db };
}

async function deal(db: Db, name: string, board = "seat") {
  const { id } = await startDeal(db, { company: { name, domain: `${name.toLowerCase().replace(/\W/g, "")}.example` } }, PAT);
  const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [id])).rows[0]!.company_id;
  return { dealId: id, companyId, invest: (fund: string, closeDate: string) => insertInvestment(db, { dealId: id, companyId, fundName: fund, security: "preferred", seriesName: "Seed", closeDate, amountUsd: 1e6, shares: 1e6, pricePerShare: 1, postMoneyUsd: 10e6, ownershipFdPct: 10, boardRole: board, rights: {} }, PAT) };
}

describe("the regulatory profile and calendar", () => {
  it("dates Form D and each state's notice from the first sale (acceptance, else the first closing), and marks what's filed", async () => {
    const { root, db } = await firm();
    expect(await C.profile(db)).toMatchObject({ adviser_status: "era", configured: false });
    await expect(C.setProfile(db, { adviserStatus: "offshore" }, PAT)).rejects.toThrow(/Pick the adviser/);
    await C.setProfile(db, { adviserStatus: "era", ccoEmail: "lee@northbeam.vc" }, PAT);
    const raise = await F.createRaise(db, {}, LEE);
    const sub = await F.inviteSubscriber(db, raise.id, { investorName: "Keystone Insurance", kind: "insurance", emails: "alts@keystone.example", commitmentUsd: 5e6 }, PAT, "https://app.example");
    const ref = (await subscriptionByToken(root, sub.url.split("/subscribe/")[1]!))!;
    await F.subscriptionSubmit(scopedDb(root, ref.firmId), ref, { legalName: "Keystone Insurance", commitmentUsd: 5e6, accreditedBasis: "institution", taxForm: "w9", jurisdiction: "US, Pennsylvania", noticeEmails: "alts@keystone.example", noOwnerOver25: true, accurate: true, signedName: "J. Doe" });
    await F.screenSubscriber(db, sub.subscription.id, PAT, { lists: async () => ({ entries: [], fetchedAt: "2026-01-01T00:00:00Z" }) });
    await F.reviewSubscription(db, sub.subscription.id, { kycStatus: "cleared", signedOn: "2026-01-10" }, PAT);
    await F.decideSubscription(db, sub.subscription.id, { accept: true }, LEE);
    const cl = await F.draftClosing(db, raise.id, { closingDate: "2026-01-15", subscriptionIds: [sub.subscription.id] }, PAT);
    await F.approveClosing(db, cl.closing.id, LEE);
    const cal = await C.calendar(db);
    const formD = cal.find((o) => o.key === "formd_Northbeam Fund II")!;
    expect(formD).toMatchObject({ due: "2026-01-30", state: "overdue" });
    expect(cal.find((o) => o.key === "bluesky_Northbeam Fund II_PA")).toMatchObject({ due: "2026-01-30", title: "PA notice filing for Northbeam Fund II" });
    expect(cal.find((o) => o.key === "formd_amend_Northbeam Fund II_1")).toMatchObject({ due: "2027-01-15" }); // still offering
    expect(cal.find((o) => o.key.startsWith("adv_"))).toBeTruthy();
    await C.recordFiling(db, { form: "form_d", obligationKey: formD.key, filedOn: "2026-01-28", reference: "0001234567-26-000001" }, LEE);
    expect((await C.calendar(db)).find((o) => o.key === formD.key)).toMatchObject({ state: "done", filing: { reference: "0001234567-26-000001" } });
    expect(C.usState("US-TX")).toBe("TX");
    expect(C.usState("Canada, Ontario")).toBeNull();
    const hits = await C.findFormD("Northbeam Fund II", { search: async () => [{ cik: "1234567", adsh: "0001234567-26-000001", name: "Northbeam Fund II, L.P.", fileDate: "2026-01-28" }] });
    expect(hits[0]!.url).toBe("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/");
  });
});

describe("deal screening", () => {
  it("blocks a prohibited outbound investment, and dates the Treasury notice for a notifiable one", async () => {
    const { db } = await firm();
    await C.setProfile(db, { adviserStatus: "era" }, PAT);
    const a = await deal(db, "Kestrel Robotics");
    await expect(C.assertScreeningCleared(db, a.dealId)).rejects.toThrow(/Run the regulatory screening/);
    await C.screenDeal(db, a.dealId, { outbound: { countryOfConcern: true, sector: "quantum" } }, PAT);
    await expect(C.assertScreeningCleared(db, a.dealId)).rejects.toThrow(/prohibited outbound/);
    const b = await deal(db, "Harbin Motion Systems");
    const s = await C.screenDeal(db, b.dealId, { outbound: { countryOfConcern: true, sector: "ai", aiNotifiable: true } }, PAT);
    expect(s.outbound).toBe("notifiable");
    await C.assertScreeningCleared(db, b.dealId);
    await b.invest("Northbeam Fund II", "2026-03-01");
    expect((await C.calendar(db)).find((o) => o.form === "outbound_notice")).toMatchObject({ due: "2026-03-31", subject: "Harbin Motion Systems" });
    // CFIUS: a critical-technology company with a foreign investor getting rights needs counsel's view on record.
    const c = await deal(db, "Girderline");
    await expect(C.screenDeal(db, c.dealId, { exportControl: "ear", cfius: { foreignRights: true } }, PAT)).rejects.toThrow(/counsel/);
    expect((await C.screenDeal(db, c.dealId, { exportControl: "ear", cfius: { foreignRights: true }, counselNote: "Maria Chen (outside counsel): passive LP, no filing." }, PAT)).cfius).toBe("review");
  });
});

describe("the code of ethics", () => {
  it("restricts companies with board seats or listings, and flags pre-clearance against the list", async () => {
    const { db } = await firm();
    const k = await deal(db, "Kestrel Robotics");
    await k.invest("Northbeam Fund II", "2026-01-15");
    const w = await deal(db, "Weldloop", "none");
    await w.invest("Northbeam Fund II", "2026-01-15");
    const ev = (await insertEvidence(db, { kind: "web_page", source: "news", content: "Weldloop lists on Nasdaq.", accessScope: "public" })).evidence;
    await insertClaim(db, { subjectId: w.companyId, predicate: "company.status", value: "ipo", asOf: "2026-05-20", evidenceId: ev.id, sourceType: "third_party", extractedBy: "test" });
    const sugg = await C.restrictedSuggestions(db);
    expect(sugg.map((x) => x.name).sort()).toEqual(["Kestrel Robotics", "Weldloop"]);
    await C.addRestricted(db, { companyId: w.companyId, ticker: "weld", reason: "Board observer; listed May 2026" }, LEE);
    const req = await C.requestPreclearance(db, ANA, { kind: "public_security", security: "Weldloop Inc.", ticker: "WELD", amountUsd: 5000 });
    expect(req.restricted_hit).toBe(true);
    await expect(C.decidePreclearance(db, req.id, { approve: true }, ANA)).rejects.toThrow(/Someone other than/);
    await expect(C.decidePreclearance(db, req.id, { approve: true }, LEE)).rejects.toThrow(/restricted list/);
    await C.decidePreclearance(db, req.id, { approve: false, note: "On the restricted list." }, LEE);
    await expect(C.fileReport(db, ANA, { kind: "transaction", items: [{ security: "Acme Corp" }] })).rejects.toThrow(/trade date/);
    expect(await C.fileReport(db, ANA, { kind: "transaction", period: "2026-Q3", items: [{ security: "Acme Corp", ticker: "acme", action: "buy", quantity: 10, tradedOn: "2026-08-01" }] })).toEqual({ filed: 1 });
    await C.fileReport(db, ANA, { kind: "no_activity", period: "2026-Q2" });
    await expect(db.query("update personal_reports set quantity = 1")).rejects.toThrow();
    await C.fileReport(db, LEE, { kind: "no_activity", period: "2026-Q2" });
    await C.setProfile(db, { adviserStatus: "registered" }, LEE);
    const q2 = async () => (await C.calendar(db, { team: [ANA, LEE] })).find((o) => o.key === "txn_q2_2026")!;
    expect(await q2()).toMatchObject({ state: "done", waitingOn: null }); // both reported for 2026-Q2
    expect((await C.calendar(db, { team: [ANA, LEE, PAT] })).find((o) => o.key === "txn_q2_2026")).toMatchObject({ waitingOn: [PAT] });
    const o = await C.overview(db, { person: ANA, team: [ANA, LEE], reviewer: false });
    expect(o.reports).toHaveLength(2); // only Ana's own: personal trading is private
    expect(o.preclearances.every((r) => r.person === ANA)).toBe(true);
    expect((await C.overview(db, { person: LEE, team: [ANA, LEE], reviewer: true })).reports).toHaveLength(3);
    expect(o.attestations.missing.every((m) => m.person === ANA)).toBe(true);
    await C.attest(db, ANA, { policy: "code_of_ethics" });
    expect(o.attestations.missing.length).toBeGreaterThan((await C.overview(db, { person: ANA, team: [ANA, LEE], reviewer: false })).attestations.missing.length);
  });
});

describe("pay to play, gifts and conflicts", () => {
  it("checks political contributions against the de minimis and gifts against the firm's limit", async () => {
    const { db } = await firm();
    await C.setProfile(db, { adviserStatus: "era", giftLimitUsd: 250 }, PAT);
    const small = await C.requestContribution(db, ANA, { recipient: "Jane Smith", office: "State Treasurer", jurisdiction: "Pennsylvania", election: "2026 general", amountUsd: 300, canVote: true, contributeOn: "2026-10-01" });
    expect(small.result).toMatchObject({ withinDeMinimis: true });
    const more = await C.requestContribution(db, ANA, { recipient: "Jane Smith", office: "State Treasurer", jurisdiction: "Pennsylvania", election: "2026 general", amountUsd: 100, canVote: true, contributeOn: "2026-10-02" });
    expect(more.result).toMatchObject({ total: 400, withinDeMinimis: false, timeOut: true });
    await expect(C.decideContribution(db, more.request.id, { approve: false }, LEE)).rejects.toThrow(/Say why/);
    await C.decideContribution(db, more.request.id, { approve: false, note: "Over the de minimis to an official who appoints the state pension's board." }, LEE);
    const g = await C.logGift(db, ANA, { direction: "received", counterparty: "Harbor Pension", description: "Dinner at the annual meeting", valueUsd: 400, kind: "entertainment" });
    expect(g).toMatchObject({ overLimit: true, limit: 250 });
    await C.decideGift(db, g.gift.id, { approve: true, note: "Business meal with the LP present." }, LEE);
  });

  it("detects conflicts the records show and needs a mitigation to close them", async () => {
    const { db } = await firm();
    const k = await deal(db, "Kestrel Robotics");
    await k.invest("Northbeam Fund I", "2025-01-15");
    await k.invest("Northbeam Fund II", "2026-03-01");
    const fund = await L.createFund(db, { name: "Northbeam Fund II", inception: "2026-01-15" }, LEE);
    await L.addExpense(db, fund.id, { incurredOn: "2026-02-01", amountUsd: 5000, category: "other", description: "GP staff time on the audit", relatedParty: true }, PAT);
    expect(await C.detectConflicts(db, PAT)).toEqual({ added: 2 });
    expect(await C.detectConflicts(db, PAT)).toEqual({ added: 0 }); // idempotent
    const cs = (await C.overview(db, { person: PAT, team: [], reviewer: true })).conflicts;
    expect(cs.map((c) => c.kind).sort()).toEqual(["cross_fund", "related_party"]);
    const cross = cs.find((c) => c.kind === "cross_fund")!;
    await expect(C.resolveConflict(db, cross.id, { status: "closed" }, LEE)).rejects.toThrow(/mitigated/);
    await C.resolveConflict(db, cross.id, { status: "mitigated", mitigation: "LPAC consent; an independent lead priced the round." }, LEE);
  });
});

describe("marketing review", () => {
  it("makes a registered adviser confirm the Marketing Rule checklist before investors see marketing material", async () => {
    const { db } = await firm();
    await C.setProfile(db, { adviserStatus: "registered" }, PAT);
    const raise = await F.createRaise(db, {}, LEE);
    const d = await F.uploadDoc(db, raise.id, { name: "deck.pdf", bytes: new TextEncoder().encode("%PDF-1.4 deck") }, { category: "deck" }, PAT);
    await expect(F.approveDoc(db, d.id, LEE)).rejects.toThrow(/Marketing Rule review/);
    await F.approveDoc(db, d.id, LEE, Object.fromEntries(C.MARKETING_CHECKLIST.map((c) => [c.key, true])));
    expect((await C.overview(db, { person: LEE, team: [], reviewer: true })).marketingReviews[0]).toMatchObject({ title: "deck", reviewer: LEE });
    // Legal documents aren't advertisements.
    const lpa = await F.uploadDoc(db, raise.id, { name: "LPA.pdf", bytes: new TextEncoder().encode("%PDF-1.4 lpa") }, { category: "lpa" }, PAT);
    await F.approveDoc(db, lpa.id, LEE);
  });
});

describe("firm isolation", () => {
  it("keeps every compliance table to its firm", async () => {
    const { root, db } = await firm();
    await C.setProfile(db, { adviserStatus: "era" }, PAT);
    await C.recordFiling(db, { form: "form_adv", filedOn: "2026-03-20" }, LEE);
    const k = await deal(db, "Kestrel Robotics");
    await k.invest("Northbeam Fund I", "2025-01-15");
    await k.invest("Northbeam Fund II", "2026-01-15");
    await C.screenDeal(db, k.dealId, { outbound: { countryOfConcern: false, sector: "none" } }, PAT);
    await C.addRestricted(db, { name: "Weldloop", reason: "Board seat" }, LEE);
    await C.fileReport(db, ANA, { kind: "no_activity", period: "2026-Q2" });
    await C.requestPreclearance(db, ANA, { kind: "ipo", security: "Acme IPO" });
    await C.requestContribution(db, ANA, { recipient: "Jane Smith", office: "Mayor", jurisdiction: "Pittsburgh", election: "2027 primary", amountUsd: 50, canVote: true, contributeOn: "2026-10-01" });
    await C.logGift(db, ANA, { counterparty: "Keystone", description: "Book", valueUsd: 30 });
    await C.detectConflicts(db, PAT);
    await C.attest(db, ANA, { policy: "code_of_ethics" });
    await C.setProfile(db, { adviserStatus: "registered" }, PAT);
    const raise = await F.createRaise(db, {}, LEE);
    const d = await F.uploadDoc(db, raise.id, { name: "deck.pdf", bytes: new TextEncoder().encode("%PDF") }, { category: "deck" }, PAT);
    await F.approveDoc(db, d.id, LEE, Object.fromEntries(C.MARKETING_CHECKLIST.map((c) => [c.key, true])));
    const tables = ["compliance_profiles", "filings", "screenings", "restricted_list", "personal_reports", "preclearances", "political_contributions", "gifts", "conflicts", "attestations", "marketing_reviews"];
    for (const t of tables) expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBeGreaterThan(0);
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    for (const t of tables) expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    expect((await C.profile(other)).configured).toBe(false);
    await expect(db.query("delete from filings")).rejects.toThrow();
  });
});
