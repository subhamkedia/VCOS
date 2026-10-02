import { describe, it, expect, beforeAll } from "vitest";
import { scopedDb } from "../lib/db.js";
import { testFirm, testRoot } from "./helpers.js";
import { lpPortalByToken, subscriptionByToken } from "../ledger/platform.js";
import { currentClaims } from "../ledger/repository.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { decide, startDeal } from "../modules/diligence/index.js";
import * as X from "../modules/execution/index.js";
import * as P from "../modules/portfolio/index.js";
import * as L from "../modules/lp/index.js";
import * as F from "../modules/fundraising/index.js";
import * as C from "../modules/compliance/index.js";

// One fund's life across every module, checking what each hands the next.
// Fictional firm, fund, investors, company and people throughout.

beforeAll(() => testRoot());

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const ANA = "human:ana@northbeam.vc";

const CAP = "Stakeholder,Share Class,Shares\nMaya Lindqvist,Common,4000000\nRaj Patel,Common,3000000\nSeed investors,Series Seed Preferred,1500000\nAvailable pool,Unissued pool,1500000\nTotal,,10000000\n";
const TERMS = {
  security: "preferred", seriesName: "Series A Preferred", preMoneyUsd: 24e6, raiseUsd: 8e6, ourAllocationUsd: 3e6, leadInvestor: "Northbeam",
  poolTopUpPostPct: 10, liquidation: { multiple: 1, participation: "none", seniority: "pari_passu" }, managementRightsLetter: true,
  board: { size: 5, investorSeats: 2, commonSeats: 2, independentSeats: 1, ours: "seat" }, noShopDays: 30,
};

/**
 * The books balance: NAV is the investors' capital accounts plus the GP's
 * accrued carry, each
 * account rolls forward, and LP Reporting's schedule of investments agrees
 * with Portfolio's numbers for the same fund and date.
 */
async function booksBalance(db: Parameters<typeof L.fundView>[0], fundId: string, asOf?: string) {
  const f = await L.fundView(db, fundId, asOf);
  const st = f.statements;
  const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThan(0.05);
  // The GP's accrued carry sits in its own account: investors' capital plus it is the fund's NAV.
  near(st.statements.reduce((a, x) => a + x.inception.ending, 0) + Math.max(0, st.gpCarry.accrued), f.summary.nav, "capital accounts + GP carry vs NAV");
  for (const x of [...st.statements, { name: "total", inception: st.total.inception }]) {
    const t = x.inception;
    near(t.beginning + t.contributions - t.distributions - t.managementFees - t.expenses + t.closeInterest + t.realizedGain + t.unrealizedGain - t.carriedInterest, t.ending, `${x.name} rollforward`);
  }
  near(f.schedule.reduce((a, r) => a + r.fairValue, 0), f.performance.gross.unrealized, "schedule vs gross unrealized");
  const pf = await P.overview(db, asOf, f.fund.name);
  near(pf.metrics.invested, f.performance.gross.invested, "Portfolio vs LP invested");
  near(pf.metrics.realized, f.performance.gross.realized, "Portfolio vs LP realized");
  near(pf.metrics.unrealized, f.performance.gross.unrealized, "Portfolio vs LP unrealized");
  return f;
}

describe("a fund's life, module to module", () => {
  it("raises the fund, calls capital, invests, values, sells, distributes and reports, with every figure agreeing", async () => {
    const { root, db } = await testFirm("Northbeam");
    const p = await starterProfile("Northbeam");
    await saveProfile(db, {
      ...p,
      fund: { ...p.fund, name: "Northbeam Fund", number: "I", targetSizeUsd: 50e6, firstCloseDate: "2025-01-15", investmentPeriodYears: 5, carryPct: 20, hurdlePct: 0, waterfall: "european", managementFeePct: 2 },
      mandate: { ...p.mandate, checkSizeUsd: { min: 1e6, max: 5e6 } },
    }, PAT);
    await C.setProfile(db, { adviserStatus: "era", ccoEmail: "lee@northbeam.vc" }, PAT);

    // Fundraising → LP Reporting: an admitted investor becomes a partner of the fund the closing creates.
    const raise = await F.createRaise(db, {}, LEE);
    expect(raise.name).toBe("Northbeam Fund I");
    const inv = await F.inviteSubscriber(db, raise.id, { investorName: "Harbor Pension Plan", kind: "pension", emails: "ir@harborpension.example", commitmentUsd: 30e6 }, PAT, "https://app.example");
    const ref = (await subscriptionByToken(root, inv.url.split("/subscribe/")[1]!))!;
    await F.subscriptionSubmit(scopedDb(root, ref.firmId), ref, { legalName: "Harbor Pension Plan", commitmentUsd: 30e6, accreditedBasis: "plan", taxForm: "w9", jurisdiction: "US, Pennsylvania", noticeEmails: "ir@harborpension.example", noOwnerOver25: true, benefitPlan: false, accurate: true, signedName: "A. Officer" });
    await F.screenSubscriber(db, inv.subscription.id, PAT, { lists: async () => ({ entries: [], fetchedAt: "2025-01-10T00:00:00Z" }) });
    await F.reviewSubscription(db, inv.subscription.id, { kycStatus: "cleared", signedOn: "2025-01-10" }, PAT);
    await F.decideSubscription(db, inv.subscription.id, { accept: true }, LEE);
    const cl = await F.draftClosing(db, raise.id, { closingDate: "2025-01-15", subscriptionIds: [inv.subscription.id] }, PAT);
    await F.approveClosing(db, cl.closing.id, LEE);
    const fund = (await L.overview(db)).funds.find((f) => f.name === "Northbeam Fund I")!;
    expect(fund).toBeTruthy();
    expect((await L.fundView(db, fund.id)).investors.map((i) => [i.name, i.commitment_usd])).toEqual([["Harbor Pension Plan", 30e6]]);
    // … and Compliance dates the raise's Form D and the Pennsylvania notice.
    const cal = await C.calendar(db);
    expect(cal.find((o) => o.key === "formd_Northbeam Fund I")).toBeTruthy();
    expect(cal.find((o) => o.key === "bluesky_Northbeam Fund I_PA")).toBeTruthy();

    // LP Reporting: a capital call, approved by a second person, funds the fund.
    const { call } = await L.draftCall(db, fund.id, { noticeDate: "2025-01-20", dueDate: "2025-02-10", investmentsUsd: 3e6, expensesUsd: 30_000, fee: { from: "2025-01-15", to: "2025-06-30" }, purpose: "Kestrel Robotics Series A" }, ANA);
    await L.approveCall(db, call.id, LEE);

    // Sourcing → Diligence: a pass is kept; a strong company goes to diligence and on to IC.
    const pet = await startDeal(db, { company: { name: "PetPal", domain: "petpal.example" } }, ANA);
    await decide(db, pet.id, { kind: "pass", reasonCode: "thesis_fit", rationale: "Consumer pet care is outside the mandate." }, PAT);
    const { id: dealId } = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, ANA);
    await decide(db, dealId, { kind: "advance", rationale: "Competitive round; IC to review open diligence items live." }, PAT);

    // Execution: IC votes before and after discussion, the round, the close behind the screening and wire controls.
    const m = await X.scheduleIc(db, dealId, { members: ["pat@northbeam.vc", "lee@northbeam.vc"] }, PAT);
    await X.castVote(db, m.id, { vote: "yes", conviction: 4 }, PAT);
    await X.castVote(db, m.id, { vote: "yes", conviction: 3 }, LEE);
    await X.advanceIc(db, m.id, {}, PAT);
    await X.advanceIc(db, m.id, {}, PAT);
    await X.castVote(db, m.id, { vote: "yes", conviction: 5 }, PAT);
    await X.castVote(db, m.id, { vote: "yes", conviction: 4 }, LEE);
    await X.advanceIc(db, m.id, {}, PAT);
    await X.importCapTableCsv(db, dealId, { name: "cap.csv", text: CAP }, ANA);
    await X.saveTermSheet(db, dealId, { terms: TERMS, status: "signed" }, ANA);
    await X.startClosing(db, dealId, PAT);
    const ev = await X.executionView(db, dealId, PAT);
    expect(ev.funds).toContain("Northbeam Fund I");
    for (const i of ev.closing.items.filter((x) => x.required && !["wire_callback", "wire_approvals", "funds_sent", "wire_instructions"].includes(x.key))) {
      if (!["signed", "done"].includes(i.status)) await X.updateItem(db, dealId, i.key, { status: "done" }, ANA);
    }
    const w = await X.recordWireInstructions(db, dealId, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "6789" }, ANA);
    await X.verifyWire(db, w.id, { numberSource: "CEO's mobile from the first meeting", confirmed: true }, ANA);
    await X.approveWire(db, w.id, PAT);
    await X.approveWire(db, w.id, LEE);
    await X.markWireSent(db, w.id, { bankReference: "REF1" }, PAT);
    await expect(X.closeDeal(db, dealId, { closeDate: "2025-02-15" }, PAT)).rejects.toThrow(/regulatory screening/);
    await C.screenDeal(db, dealId, { outbound: { countryOfConcern: false, sector: "none" }, exportControl: "none" }, ANA);
    const invest = await X.closeDeal(db, dealId, { closeDate: "2025-02-15" }, PAT);
    expect(invest).toMatchObject({ fund_name: "Northbeam Fund I", amount_usd: 3e6 });

    // Execution → Portfolio and LP Reporting: the same holding, at cost.
    const companyId = invest.company_id;
    const pf = await P.overview(db);
    expect(pf.fund.name).toBe("Northbeam Fund I");
    expect(pf.companies.map((c) => [c.name, c.invested, c.fairValue])).toEqual([["Kestrel Robotics", 3e6, 3e6]]);
    expect((await L.fundView(db, fund.id)).schedule.map((r) => [r.company, r.cost, r.fairValue])).toEqual([["Kestrel Robotics", 3e6, 3e6]]);

    // Portfolio: a mark approved by a second person flows to LP Reporting.
    const mark = await P.proposeMark(db, companyId, { method: "milestone", asOf: "2026-06-30", adjustmentPct: 50, rationale: "Two paid pilots converted to production contracts." }, ANA);
    await P.reviewMark(db, mark.id, { approve: true }, PAT);
    expect((await L.fundView(db, fund.id, "2026-07-01")).schedule[0]).toMatchObject({ fairValue: 4.5e6, status: "held" });

    // Portfolio → Execution: a follow-on is decided in Portfolio and closes in Execution behind the same controls.
    const fo = await P.decideFollowOn(db, companyId, { decision: "invest", roundName: "Series A-2 Preferred", roundDate: "2026-07-20", amountUsd: 1e6, preMoneyUsd: 30e6, roundSizeUsd: 5e6, fundName: "Northbeam Fund I", rationale: "Production contracts doubled; taking our pro rata at a fair step-up." }, PAT);
    expect(fo.investmentId).toBeNull();
    const fv0 = await X.executionView(db, fo.dealId!, PAT);
    expect(fv0.deal).toMatchObject({ stage: "approved", our_check_usd: 1e6 });
    expect(fv0.termSheets[0]!.terms).toMatchObject({ seriesName: "Series A-2 Preferred", preMoneyUsd: 30e6, raiseUsd: 5e6, ourAllocationUsd: 1e6 });
    const { call: call2 } = await L.draftCall(db, fund.id, { noticeDate: "2026-07-01", dueDate: "2026-07-14", investmentsUsd: 1e6, purpose: "Kestrel Robotics Series A-2" }, ANA);
    await L.approveCall(db, call2.id, LEE);
    await X.setTermStatus(db, fo.dealId!, 1, "signed", ANA);
    await X.startClosing(db, fo.dealId!, PAT);
    for (const i of (await X.executionView(db, fo.dealId!, PAT)).closing.items.filter((x) => x.required && !["wire_callback", "wire_approvals", "funds_sent", "wire_instructions"].includes(x.key))) {
      if (!["signed", "done"].includes(i.status)) await X.updateItem(db, fo.dealId!, i.key, { status: "done" }, ANA);
    }
    const w2 = await X.recordWireInstructions(db, fo.dealId!, { amountUsd: 1e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "6789" }, ANA);
    await X.verifyWire(db, w2.id, { numberSource: "CEO's mobile from the first meeting", confirmed: true }, ANA);
    await X.approveWire(db, w2.id, PAT);
    await X.approveWire(db, w2.id, LEE);
    await X.markWireSent(db, w2.id, { bankReference: "REF2" }, PAT);
    await expect(X.closeDeal(db, fo.dealId!, { closeDate: "2026-07-20" }, PAT)).rejects.toThrow(/regulatory screening/);
    await C.screenDeal(db, fo.dealId!, { outbound: { countryOfConcern: false, sector: "none" }, exportControl: "none" }, ANA);
    expect(await X.closeDeal(db, fo.dealId!, { closeDate: "2026-07-20" }, PAT)).toMatchObject({ fund_name: "Northbeam Fund I", amount_usd: 1e6, round_kind: "follow_on" });
    // New money after the mark is held at cost beside the marked shares, in both modules.
    expect((await P.overview(db, "2026-07-31")).companies[0]).toMatchObject({ invested: 4e6, fairValue: 5.5e6 });
    expect((await L.fundView(db, fund.id, "2026-07-31")).schedule[0]).toMatchObject({ cost: 4e6, fairValue: 5.5e6 });
    await booksBalance(db, fund.id, "2026-07-31");

    // Exits: the sale records cash and an escrow; both modules see the same split.
    const x = await P.startExit(db, companyId, { kind: "acquisition", counterparty: "Acme Industrial" }, ANA);
    await P.consentToExit(db, x.id, { choice: "approve", rationale: "Three times cost, above our mark, after a full process with two bidders." }, PAT);
    await P.closeExit(db, x.id, { closedOn: "2026-08-31", totalUsd: 9e6, escrowPct: 10 }, PAT);
    expect((await currentClaims(db, companyId, { predicates: ["company.status"] })).pop()?.value).toBe("acquired");
    expect((await P.overview(db)).companies[0]).toMatchObject({ realized: 8.1e6, fairValue: 0.9e6, status: "exited" });
    expect((await L.fundView(db, fund.id)).schedule[0]).toMatchObject({ realized: 8.1e6, fairValue: 0.9e6, status: "exited" });
    await booksBalance(db, fund.id);

    // Portfolio → LP Reporting: the proceeds become a distribution a second person approves; the investor's account shows it.
    expect((await P.liquidityOverview(db)).undistributed).toEqual([{ companyId, name: "Kestrel Robotics", receivedUsd: 8.1e6, distributedUsd: 0 }]);
    const d = await P.distributeProceeds(db, companyId, { amountUsd: 8.1e6, paidOn: "2026-09-15" }, ANA);
    await L.approveDistribution(db, d.distributionId, LEE);
    await L.markDistributionPaid(db, d.distributionId, LEE);
    expect((await P.liquidityOverview(db)).undistributed).toEqual([]);
    const fv = await booksBalance(db, fund.id);
    expect(fv.summary.distributed).toBeCloseTo(8.1e6 - fv.gpCarry.paid, 0);
    expect(fv.performance.net.dpi).toBeGreaterThan(1.5);

    // LP Reporting: the quarter's report carries the sale; the letter cites the books.
    const r = await L.prepareReport(db, fund.id, { period: "2026-Q3" }, ANA);
    const rep = await L.report(db, r.id);
    expect(JSON.stringify(rep.snapshot)).toContain("Kestrel Robotics");
    const facts = rep.letter.sections.flatMap((x) => x.sentences).filter((x) => x.kind === "fact");
    expect(facts.every((x) => x.cites.length > 0)).toBe(true);
    expect(facts.map((x) => x.text).join(" ")).toMatch(/Kestrel Robotics: exited; \$4M invested returned \$8\.1M, with \$900K still to come/);

    // LP Reporting → the investor and Fundraising: once a second person approves the report, the
    // investor sees it with its own statement, and the next raise's DDQ quotes it, net beside gross.
    await L.approveReport(db, r.id, LEE);
    const harbor = (await L.fundView(db, fund.id)).investors.find((i) => i.name === "Harbor Pension Plan")!;
    const link = await L.createLpPortalLink(db, harbor.id, PAT, "https://app.example");
    const lpRef = (await lpPortalByToken(root, link.url.split("/investor/")[1]!))!;
    const portal = await L.lpPortalView(scopedDb(root, lpRef.firmId), lpRef);
    expect(portal.reports.map((x) => x.period)).toEqual(["2026-Q3"]);
    expect(portal.distributions.map((x) => x.net)).toEqual([fv.summary.distributed]);
    await F.draftFromRecords(db, PAT);
    const perf = (await F.ddqView(db)).flatMap((s) => s.questions).find((q) => q.key === "track.performance")!;
    expect(perf.answer?.answer).toMatch(/^Northbeam Fund I, as of September 30, 2026: net IRR .*; gross IRR .*Gross returns are before/);

    // Compliance kept its records along the way: the screening, and the Form D once filed.
    // LP Reporting's register tells Compliance whom pay-to-play may cover.
    expect(await C.governmentInvestors(db)).toEqual([{ name: "Harbor Pension Plan", kind: "pension", where: ["Northbeam Fund I"] }]);
    expect((await C.overview(db, { person: PAT, team: [], reviewer: true })).screenings.map((s) => s.company_name)).toEqual(["Kestrel Robotics", "Kestrel Robotics"]);
  });
});
