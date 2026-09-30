import { describe, it, expect, beforeAll } from "vitest";
import { testFirm, testRoot } from "./helpers.js";
import { scopedDb } from "../lib/db.js";
import { createFirm } from "../ledger/platform.js";
import { currentClaims } from "../ledger/repository.js";
import { insertInvestment } from "../ledger/execution.js";
import { realizations } from "../ledger/portfolio.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { startDeal } from "../modules/diligence/index.js";
import * as P from "../modules/portfolio/index.js";
import * as L from "../modules/lp/index.js";
import * as C from "../modules/compliance/index.js";
import * as F from "../modules/fundraising/index.js";

// Fictional firm, companies, investors and people throughout.

beforeAll(async () => {
  await testRoot();
});

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const ANA = "human:ana@northbeam.vc";

async function firm() {
  const { root, db } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, { ...p, fund: { ...p.fund, name: "Northbeam Fund I", committedUsd: 50e6, firstCloseDate: "2019-01-15", vintage: 2019, carryPct: 20, hurdlePct: 0, waterfall: "european", termYears: 10, extensionYears: 2 } }, PAT);
  const company = async (name: string, closeDate: string, board: string) => {
    const { id: dealId } = await startDeal(db, { company: { name, domain: `${name.toLowerCase().replace(/\s+/g, "")}.example` } }, PAT);
    const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [dealId])).rows[0]!.company_id;
    await insertInvestment(db, { dealId, companyId, fundName: "Northbeam Fund I", security: "preferred", seriesName: "Seed Preferred", closeDate, amountUsd: 2e6, shares: 2_000_000, pricePerShare: 1, postMoneyUsd: 12e6, ownershipFdPct: 16, boardRole: board, rights: {} }, PAT);
    return companyId;
  };
  return { root, db, company };
}

async function lpFund(db: Awaited<ReturnType<typeof firm>>["db"]) {
  const fund = await L.createFund(db, {}, LEE);
  await L.addPartner(db, fund.id, { name: "Harbor Pension Plan", kind: "pension", commitmentUsd: 30e6, emails: "ir@harborpension.example" }, PAT);
  await L.addPartner(db, fund.id, { name: "Aster Family Office", kind: "family_office", commitmentUsd: 19.5e6, emails: "cio@asterfo.example" }, PAT);
  await L.addPartner(db, fund.id, { name: "Northbeam GP", kind: "gp", commitmentUsd: 0.5e6, emails: "pat@northbeam.vc" }, PAT);
  return fund;
}

describe("selling a company", () => {
  it("runs the process, needs the fund's consent, and records cash at closing, escrows and earnouts", async () => {
    const { db, company } = await firm();
    const id = await company("Kestrel Robotics", "2021-03-31", "seat");
    await P.saveExitPlanFor(db, id, { path: "acquisition", targetYear: 2026, baseUsd: 9e6, probabilityPct: 60, buyers: "Acme Industrial, Girder Corp", readiness: { ip: true, data_room: true } }, ANA);
    const x = await P.startExit(db, id, { kind: "acquisition", counterparty: "Acme Industrial", equityValueUsd: 60e6, ourExpectedUsd: 9e6 }, ANA);
    await expect(P.startExit(db, id, { kind: "acquisition" }, ANA)).rejects.toThrow(/already an open/);
    await P.addBid(db, x.id, { bidder: "Acme Industrial", kind: "loi", valueUsd: 60e6, consideration: "All cash, 10% escrow for 12 months" }, ANA);
    await expect(P.updateExitProcess(db, x.id, { stage: "signed" }, ANA)).rejects.toThrow(/consent/);
    await expect(P.closeExit(db, x.id, { closedOn: "2026-06-30", totalUsd: 9e6 }, PAT)).rejects.toThrow(/consent/);
    await expect(P.consentToExit(db, x.id, { choice: "approve", rationale: "ok" }, PAT)).rejects.toThrow(/Explain/);
    await P.consentToExit(db, x.id, { choice: "approve", rationale: "4.5x our cost and above our $7.5M mark; no competing bid above $55M after a banker-run process." }, PAT);
    await P.updateExitProcess(db, x.id, { stage: "signed" }, ANA);

    const preview = await P.previewClose(db, x.id, { closedOn: "2026-06-30", totalUsd: 9e6, escrowPct: 10, expenseFundUsd: 20_000, earnouts: [{ description: "2027 revenue target", maxUsd: 1.5e6, probabilityPct: 40, dueOn: "2028-03-31" }] });
    expect(preview).toMatchObject({ split: { atCloseCashUsd: 8_080_000, expectedUsd: 9_600_000 } });
    expect(preview.warnings.join(" ")).toMatch(/Trados/); // no board approval with a conflict note on record
    await P.closeExit(db, x.id, { closedOn: "2026-06-30", totalUsd: 9e6, escrowPct: 10, expenseFundUsd: 20_000, earnouts: [{ description: "2027 revenue target", maxUsd: 1.5e6, probabilityPct: 40, dueOn: "2028-03-31" }] }, PAT);
    await expect(P.closeExit(db, x.id, { closedOn: "2026-06-30", totalUsd: 9e6 }, PAT)).rejects.toThrow(/already closed/);

    const status = (await currentClaims(db, id, { predicates: ["company.status"] })).pop();
    expect(status).toMatchObject({ value: "acquired", cited_text: "acquired by Acme Industrial" });
    let v = await P.companyExits(db, id);
    expect(v.receivables.map((r) => [r.kind, r.amount_usd, r.valueUsd])).toEqual([["escrow", 900_000, 900_000], ["expense_fund", 20_000, 20_000], ["earnout", 1_500_000, 600_000]]);
    let row = (await P.overview(db)).companies.find((c) => c.companyId === id)!;
    expect(row).toMatchObject({ realized: 8_080_000, fairValue: 1_520_000, valueBasis: "exited", pendingUsd: 1_520_000 });

    // The escrow comes back short after a claim; the earnout isn't earned.
    const escrow = v.receivables.find((r) => r.kind === "escrow")!;
    await expect(P.settleReceivable(db, escrow.id, { amountUsd: 700_000 }, PAT)).rejects.toThrow(/say why/);
    await P.settleReceivable(db, escrow.id, { amountUsd: 700_000, on: "2026-07-15", note: "Buyer's claim for an undisclosed customer credit settled at $200k." }, PAT);
    const earn = v.receivables.find((r) => r.kind === "earnout")!;
    await P.reviseReceivable(db, earn.id, { expectedPct: 10, note: "H1 2027 revenue tracking 40% below the target." }, ANA);
    v = await P.companyExits(db, id);
    expect(v.receivables.find((r) => r.id === escrow.id)).toMatchObject({ status: "released", settled_usd: 700_000, valueUsd: 0 });
    expect(v.receivables.find((r) => r.id === earn.id)!.valueUsd).toBe(150_000);
    row = (await P.overview(db)).companies.find((c) => c.companyId === id)!;
    expect(row).toMatchObject({ realized: 8_780_000, fairValue: 170_000 });
    expect((await realizations(db, id)).map((r) => r.kind)).toEqual(["sale", "escrow_release"]);
  });
});

describe("an IPO", () => {
  it("records listed shares, dates the lock-up and filings, values them at the price, and distributes them in kind", async () => {
    const { db, company } = await firm();
    const fund = await lpFund(db);
    const id = await company("Weldloop", "2021-04-15", "seat");
    const x = await P.startExit(db, id, { kind: "ipo", counterparty: "Nasdaq" }, ANA);
    await expect(P.consentToExit(db, x.id, { choice: "approve", rationale: "The IPO is the right path for the company." }, PAT)).rejects.toThrow(/doesn't need/);
    await P.closeExit(db, x.id, { closedOn: "2026-03-02", ticker: "weld", shares: 2_000_000, sharesOutstanding: 20_000_000, pricePerShare: 14 }, PAT);
    expect((await currentClaims(db, id, { predicates: ["company.status"] })).pop()?.value).toBe("ipo");
    let v = await P.companyExits(db, id);
    expect(v.listed[0]).toMatchObject({ holding: { ticker: "WELD", affiliate: true, lockup_days: 180 }, sharesLeft: 2_000_000, window: { lockupEnds: "2026-08-29", earliestSale: "2026-08-29" } });
    expect((await P.overview(db)).companies.find((c) => c.companyId === id)).toMatchObject({ valueBasis: "public", fairValue: 28e6 });

    // Filings for a 10% holder with a director on the board, and a restricted list suggestion.
    const cal = await C.calendar(db);
    expect(cal.map((o) => o.key)).toEqual(expect.arrayContaining(["13g_Weldloop (WELD)", "form3_Weldloop (WELD)"]));
    expect((await C.restrictedSuggestions(db)).find((s) => s.companyId === id)?.reason).toMatch(/Listed as WELD/);

    // Prices from a CSV, and the quoted-price mark with no lock-up discount.
    await P.recordPrices(db, "WELD", { csv: "Date,Close/Last,Volume\n09/28/2026,$19.50,400000\n09/29/2026,$20.00,420000\n2026-09-30,21.00,380000\n" }, ANA);
    await expect(P.recordPrices(db, "ZZZZ", { prices: [{ date: "2026-09-30", close: 1 }] }, ANA)).rejects.toThrow(/don't hold/);
    const m = await P.proposeMark(db, id, { method: "public_price", asOf: "2026-09-30", rationale: "Closing price on the measurement date." }, ANA);
    expect(m.fair_value_usd).toBe(42e6);

    // Selling: the volume limit is the greater of 1% of 20M and the weekly volume.
    await expect(P.sellPublic(db, v.listed[0]!.holding.id, { shares: 150_000, priceUsd: 20, on: "2026-08-01" }, PAT)).rejects.toThrow(/before 2026-08-29/);
    await expect(P.sellPublic(db, v.listed[0]!.holding.id, { shares: 400_000, priceUsd: 20, on: "2026-09-30" }, PAT)).rejects.toThrow(/volume limit/);
    const sale = await P.sellPublic(db, v.listed[0]!.holding.id, { shares: 150_000, priceUsd: 20.5, on: "2026-09-30" }, PAT);
    expect(sale.proceedsUsd).toBe(3_075_000);
    expect(sale.form144).toMatch(/Form 144/);

    // In kind: a draft in LP Reporting; the shares leave the books when a second person approves it.
    const pv = await P.previewInKind(db, v.listed[0]!.holding.id, { shares: 1_000_000, on: "2026-09-30", method: "close" });
    expect(pv).toMatchObject({ fund: "Northbeam Fund I", price: 21, grossUsd: 21e6 });
    expect(pv.allocation.reduce((a, s) => a + s.shares, 0)).toBe(1_000_000);
    const d = await P.distributeInKind(db, v.listed[0]!.holding.id, { shares: 1_000_000, on: "2026-09-30", method: "close" }, ANA);
    v = await P.companyExits(db, id);
    expect(v.listed[0]!.sharesLeft).toBe(1_850_000); // not yet approved
    await L.approveDistribution(db, d.distributionId, PAT);
    v = await P.companyExits(db, id);
    expect(v.listed[0]!.sharesLeft).toBe(850_000);
    expect((await realizations(db, id)).find((r) => r.kind === "in_kind")).toMatchObject({ shares: 1_000_000, amount_usd: 21e6, lp_distribution_id: d.distributionId });
    expect((await L.fundView(db, fund.id)).distributions[0]).toMatchObject({ kind: "in_kind", gross_usd: 21e6 });
  });
});

describe("a secondary sale and QSBS", () => {
  it("sells part of a stake, scales the mark to the shares left, and tracks QSBS", async () => {
    const { db, company } = await firm();
    await lpFund(db);
    const id = await company("Formwork AI", "2025-09-01", "observer");
    const mk = await P.proposeMark(db, id, { method: "milestone", asOf: "2026-06-30", adjustmentPct: 100, rationale: "Doubled revenue and a term sheet at 2x." }, ANA);
    await P.reviewMark(db, mk.id, { approve: true }, PAT);
    const x = await P.startExit(db, id, { kind: "secondary", counterparty: "Harbor Secondaries" }, ANA);
    await P.consentToExit(db, x.id, { choice: "approve", rationale: "Selling a quarter returns cost on the whole position at a modest discount to the mark." }, PAT);
    await expect(P.previewClose(db, x.id, { shares: 3_000_000, pricePerShare: 1.8 })).rejects.toThrow(/fewer than/);
    const p = await P.closeExit(db, x.id, { closedOn: "2026-09-15", shares: 500_000, pricePerShare: 1.8 }, PAT);
    expect(p).toMatchObject({ proceedsUsd: 900_000, costBasisUsd: 500_000, gainUsd: 400_000, remainingShares: 1_500_000 });
    expect((await P.overview(db)).companies.find((c) => c.companyId === id)).toMatchObject({ realized: 900_000, fairValue: 3e6, valueBasis: "mark" }); // $4M mark x 1.5M / 2M shares

    // Stock bought in September 2025 is under the post-2025 rules: nothing excluded until three years.
    const q = (await P.companyExits(db, id)).qsbs[0]!;
    expect(q.result).toMatchObject({ regime: "post_2025", exclusionPct: 0, next: { on: "2028-09-02", pct: 50 } });
    await expect(P.reviewQsbs(db, id, q.investmentId, { checks: { c_corp: true, original_issue: false } }, ANA)).rejects.toThrow(/which requirement/);
    expect(await P.reviewQsbs(db, id, q.investmentId, { checks: { c_corp: true, original_issue: true } }, ANA)).toEqual({ status: "unclear" });

    // The proceeds wait to be distributed.
    const liq = await P.liquidityOverview(db);
    expect(liq.undistributed).toEqual([{ companyId: id, name: "Formwork AI", receivedUsd: 900_000, distributedUsd: 0 }]);
    await P.distributeProceeds(db, id, { amountUsd: 900_000, paidOn: "2026-09-30" }, ANA);
    expect((await P.liquidityOverview(db)).undistributed).toEqual([]);
  });
});

describe("the fund's tail", () => {
  it("tracks the term, extensions with LPAC consent, a continuation vehicle and the wind-down", async () => {
    const { db, company } = await firm();
    const fund = await lpFund(db);
    await company("SiteGrid", "2019-06-01", "none");
    let v = await P.fundLifeView(db, fund.id);
    expect(v).toMatchObject({ termYears: 10, life: { termEnds: "2029-01-14" } }); // inception follows the profile's first close
    await P.setFundLife(db, fund.id, { termYears: 7, maxExtensionYears: 2 }, PAT);
    v = await P.fundLifeView(db, fund.id);
    expect(v.life).toMatchObject({ termEnds: "2026-01-14", stage: "past_term" });
    expect(v.options.map((o) => o.key)).toContain("extension");

    await expect(P.extendFund(db, fund.id, { years: 1, approvedVia: "lpac" }, PAT)).rejects.toThrow(/Link the LPAC/);
    const partners = (await L.fundView(db, fund.id)).investors.filter((i) => i.kind !== "gp");
    await F.addLpacMember(db, fund.id, { partnerId: partners[0]!.id, representative: "Harbor delegate" }, PAT);
    const { consent } = await F.requestConsent(db, fund.id, { kind: "extension", topic: "One-year extension", detail: "Extend to January 2027 to realize the remaining holding, with no management fee in the extension." }, PAT);
    await expect(P.extendFund(db, fund.id, { years: 1, approvedVia: "lpac", lpacConsentId: consent.id }, PAT)).rejects.toThrow(/hasn't approved/);
    await F.castVote(db, consent.id, { memberId: (await F.lpacView(db, fund.id)).members[0]!.id, vote: "approve" }, PAT);
    await F.decideLpacConsent(db, consent.id, { outcome: "approved" }, PAT);
    await P.extendFund(db, fund.id, { years: 1, approvedVia: "lpac", lpacConsentId: consent.id, feeChange: "No management fee" }, PAT);
    await expect(P.extendFund(db, fund.id, { years: 2, approvedVia: "gp" }, PAT)).rejects.toThrow(/1 more year/);
    v = await P.fundLifeView(db, fund.id);
    expect(v.life).toMatchObject({ endsOn: "2027-01-14", stage: "extended", extensionYearsLeft: 1 });

    // A continuation vehicle with too short a window and no status quo option is flagged; silence is a sale.
    const cv = await P.startContinuation(db, fund.id, { name: "Northbeam Continuation I", leadBuyer: "Harbor Secondaries", pricePctOfNav: 95, referenceNavUsd: 20e6, launchedOn: "2026-09-10", deadline: "2026-09-25", statusQuoOffered: false }, PAT);
    expect(cv.issues).toHaveLength(2);
    await expect(P.recordElection(db, cv.process.id, { partnerId: partners[0]!.id, choice: "roll" }, ANA)).rejects.toThrow(/closed/);
    await expect(P.finishContinuation(db, cv.process.id, {}, PAT)).rejects.toThrow(/fairness opinion/);
    await expect(P.finishContinuation(db, cv.process.id, { fairnessOpinion: "Fairness opinion from Demo Valuation LLC: the price is fair." }, PAT)).rejects.toThrow(/LPAC/);
    v = await P.fundLifeView(db, fund.id);
    expect(v.continuation[0]!.tally).toMatchObject({ closed: true, navSold: 20e6 * (49.5 / 49.5) });

    await expect(P.setWindDownStep(db, fund.id, "clawback", { status: "na" }, ANA)).rejects.toThrow(/why/);
    await P.setWindDownStep(db, fund.id, "clawback", { status: "na", note: "No carry was paid." }, ANA);
    expect((await P.fundLifeView(db, fund.id)).windDown.find((s) => s.key === "clawback")).toMatchObject({ status: "na" });
  });

  it("keeps each firm's exits to itself", async () => {
    const { root, db, company } = await firm();
    const id = await company("Kestrel Robotics", "2021-03-31", "seat");
    const x = await P.startExit(db, id, { kind: "acquisition" }, ANA);
    await P.addBid(db, x.id, { bidder: "Acme Industrial", kind: "ioi", valueUsd: 50e6 }, ANA);
    await P.saveExitPlanFor(db, id, { path: "acquisition" }, ANA);
    const other = scopedDb(root, (await createFirm(root, { name: "Elsewhere" })).id); // testFirm would reset the database
    for (const t of ["exit_plans", "exits", "exit_bids", "exit_receivables", "public_holdings", "share_prices", "in_kind_plans", "qsbs_reviews", "fund_life", "fund_extensions", "wind_down_items", "cv_processes", "cv_elections"]) {
      expect((await other.query(`select * from ${t}`)).rows, t).toEqual([]);
    }
    expect((await db.query("select * from exits")).rows).toHaveLength(1);
    await expect(db.query("update exit_bids set value_usd = 1")).rejects.toThrow(); // bids are kept as made
  });
});

describe("one value across modules", () => {
  it("values holdings in LP Reporting the way Portfolio does: escrows, earnouts and listed shares after a sale", async () => {
    const { db, company } = await firm();
    const fund = await lpFund(db);
    const id = await company("Kestrel Robotics", "2021-03-31", "seat");
    const x = await P.startExit(db, id, { kind: "acquisition", counterparty: "Acme Industrial" }, ANA);
    await P.consentToExit(db, x.id, { choice: "approve", rationale: "A full process, above our mark, with clean terms and a modest escrow." }, PAT);
    await P.closeExit(db, x.id, { closedOn: "2026-06-30", totalUsd: 9e6, stockUsd: 1e6, stockTicker: "ACME", stockShares: 50_000, escrowPct: 10 }, PAT);
    const pf = (await P.overview(db)).companies.find((c) => c.companyId === id)!;
    const lpRow = (await L.fundView(db, fund.id)).schedule.find((s) => s.companyId === id)!;
    expect(pf).toMatchObject({ realized: 7.1e6, fairValue: 1.9e6 }); // $0.9M escrow + $1M of the buyer's shares
    expect(lpRow).toMatchObject({ realized: 7.1e6, fairValue: 1.9e6, status: "exited" });
    // As of the day before the sale, it's the private position at cost.
    const before = (await L.fundView(db, fund.id, "2026-06-29")).schedule.find((s) => s.companyId === id)!;
    expect(before).toMatchObject({ realized: 0, fairValue: 2e6, status: "held" });
  });

  it("splits a company held by two funds between them", async () => {
    const { db, company } = await firm();
    const id = await company("Weldloop", "2024-04-15", "seat");
    const dealId = (await db.query<{ id: string }>("select id from deals where company_id = $1", [id])).rows[0]!.id;
    await insertInvestment(db, { dealId, companyId: id, fundName: "Northbeam Fund II", security: "preferred", seriesName: "Series A Preferred", closeDate: "2026-01-15", amountUsd: 3e6, shares: 1_000_000, pricePerShare: 3, ownershipFdPct: 20, boardRole: "seat", rights: {}, roundKind: "follow_on" }, PAT);
    const m = await P.proposeMark(db, id, { method: "recent_round", asOf: "2026-06-30", roundPrice: 3, roundDate: "2026-01-15", ourShares: 3_000_000, rationale: "Priced at the Series A." }, ANA);
    await P.reviewMark(db, m.id, { approve: true }, PAT);
    const f1 = await P.overview(db, "2026-09-30", "Northbeam Fund I");
    const f2 = await P.overview(db, "2026-09-30", "Northbeam Fund II");
    expect(f1.funds).toEqual(["Northbeam Fund I", "Northbeam Fund II"]);
    expect(f1.companies[0]).toMatchObject({ invested: 2e6, fairValue: 6e6 }); // 2M of 3M shares at $3
    expect(f2.companies[0]).toMatchObject({ invested: 3e6, fairValue: 3e6 });
    expect((await P.overview(db, "2026-09-30", "all")).companies[0]).toMatchObject({ invested: 5e6, fairValue: 9e6 });
  });
});
