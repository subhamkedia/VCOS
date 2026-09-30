import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { config } from "../lib/config.js";
import { encryptJson, setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm, testRoot } from "./helpers.js";
import { fakeFetch, json } from "./fake-fetch.js";
import { createFirm, lpPortalByToken } from "../ledger/platform.js";
import { insertClaim, insertEvidence, listOutbox } from "../ledger/repository.js";
import { saveConnection } from "../ledger/workspace.js";
import { insertInvestment } from "../ledger/execution.js";
import { callItems, partners } from "../ledger/lp.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { connectWithOAuth } from "../modules/connections/index.js";
import { startDeal } from "../modules/diligence/index.js";
import * as P from "../modules/portfolio/index.js";
import * as L from "../modules/lp/index.js";
import { parseBankCsv } from "../connectors/bank.js";
import { CONNECTORS } from "../connectors/registry.js";
import type { Letter, Snapshot } from "../modules/lp/reports.js";

// Fictional firm, fund, investors and companies throughout.

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
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

async function lpFirm() {
  const { root, db, firm } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, {
    ...p,
    fund: {
      ...p.fund, name: "Northbeam Fund I", committedUsd: 50e6, firstCloseDate: "2025-01-15", investmentPeriodYears: 5, vintage: 2025,
      managementFeePct: 2, feeStepDownPct: 1.5, feeBasisAfterPeriod: "invested", carryPct: 20, hurdlePct: 8, waterfall: "european", gpCommitmentPct: 1,
    },
  }, PAT);
  const fund = await L.createFund(db, {}, LEE);
  const add = (name: string, kind: string, commitmentUsd: number, emails: string) => L.addPartner(db, fund.id, { name, kind, commitmentUsd, emails }, PAT);
  await add("Harbor Pension Plan", "pension", 30e6, "ir@harborpension.example");
  await add("Aster Family Office", "family_office", 15e6, "cio@asterfo.example");
  await add("Linden Endowment", "endowment_foundation", 2.25e6, "ops@linden.example");
  await add("Birch Foundation", "endowment_foundation", 2.25e6, "");
  await add("Northbeam GP", "gp", 0.5e6, "pat@northbeam.vc");
  return { root, db, firm, fund };
}

async function gmail(db: Db) {
  config.googleClientId = "app-client";
  config.googleClientSecret = "app-secret";
  await connectWithOAuth(db, "gmail", "rt-northbeam", "pat@northbeam.vc", PAT).catch(() => undefined);
}

async function holding(db: Db) {
  const { id: dealId } = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, PAT);
  const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [dealId])).rows[0]!.company_id;
  await insertInvestment(db, {
    dealId, companyId, fundName: "Northbeam Fund I", security: "preferred", seriesName: "Seed Preferred", closeDate: "2025-03-31",
    amountUsd: 2e6, shares: 2_000_000, pricePerShare: 1, postMoneyUsd: 12e6, ownershipFdPct: 16.67, boardRole: "seat", rights: {},
  }, PAT);
  return companyId;
}

const FIRST_CALL = { noticeDate: "2025-01-20", dueDate: "2025-02-10", investmentsUsd: 2_000_000, expensesUsd: 50_000, fee: { from: "2025-01-15", to: "2025-06-30" }, purpose: "Kestrel Robotics seed; organizational costs" };

describe("funds and investors", () => {
  it("copies the fund's economics from the firm profile and keeps the GP's commitment free of fees and carry", async () => {
    const { db, fund } = await lpFirm();
    expect(fund.terms).toMatchObject({ managementFeePct: 2, feeStepDownPct: 1.5, feeBasisAfterPeriod: "invested", carryPct: 20, hurdlePct: 8, catchUpPct: 100, waterfall: "european", investmentPeriodEnd: "2030-01-14", gpCommitmentPct: 1 });
    const ps = await partners(db, fund.id);
    expect(ps.find((p) => p.kind === "gp")).toMatchObject({ fee_paying: false });
    await expect(L.createFund(db, {}, LEE)).rejects.toThrow(/already a fund/);
    await expect(L.setTerms(db, fund.id, { carryPct: 70 }, LEE)).rejects.toThrow(/between 0 and 50/);
    await expect(L.addPartner(db, fund.id, { name: "Harbor Pension Plan", kind: "pension", commitmentUsd: 1 }, PAT)).rejects.toThrow(/already an investor/);
    await expect(L.addPartner(db, fund.id, { name: "Quill Capital", kind: "pension", commitmentUsd: 1e6, emails: "not-an-email" }, PAT)).rejects.toThrow(/email/);
  });

  it("imports the investor register from a fund administrator's export", async () => {
    const { db, fund } = await lpFirm();
    const csv = [
      "Investor Name,Investor Type,Commitment Amount,Email,Close,Admission Date,Fee Paying,Tax Exempt",
      "Juniper Insurance Co,Insurance company,\"$3,000,000\",treasury@juniper.example,2,03/15/2025,Yes,No",
      "Maple Retirement System,Public pension,\"1,000,000\",invest@maple.example,2,2025-03-15,yes,yes",
      "Harbor Pension Plan,Pension,30000000,,1,,,",
      ",,,,,,,",
      "Nameless,,,,,,,",
    ].join("\n");
    const r = await L.importPartnersCsv(db, fund.id, { name: "register.csv", text: csv }, PAT);
    expect(r.added).toBe(2);
    expect(r.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/already in the fund/), expect.stringMatching(/No name or commitment/)]);
    const j = (await partners(db, fund.id)).find((p) => p.name === "Juniper Insurance Co")!;
    expect(j).toMatchObject({ kind: "insurance", commitment_usd: 3e6, closing: 2, admitted_on: "2025-03-15", emails: ["treasury@juniper.example"], tax_status: "taxable" });
    expect((await partners(db, fund.id)).find((p) => p.name === "Maple Retirement System")).toMatchObject({ kind: "pension", tax_status: "tax_exempt" });
    expect(L.kindFrom("General Partner commitment")).toBe("gp");
    expect(L.kindFrom("Sovereign wealth")).toBe("sovereign");
  });
});

describe("capital calls", () => {
  it("allocates to the cent, charges the fee to fee payers only, and warns about short notice", async () => {
    const { db, fund } = await lpFirm();
    const p = await L.previewCall(db, fund.id, FIRST_CALL);
    const fee = (49.5e6 * 0.02 * 167) / 365;
    expect(p.totals.fees).toBeCloseTo(fee, 2);
    expect(sum(p.items.map((i) => i.amount))).toBeCloseTo(2_050_000 + p.totals.fees, 2);
    expect(sum(p.items.map((i) => i.investment))).toBe(2_000_000);
    expect(sum(p.items.map((i) => i.fee))).toBeCloseTo(p.totals.fees, 2);
    const gp = p.items.find((i) => i.name === "Northbeam GP")!;
    expect(gp).toMatchObject({ fee: 0, investment: 20_000, expense: 500 });
    expect(p.items.find((i) => i.name === "Harbor Pension Plan")!.investment).toBe(1_200_000);
    expect(p.warnings).toEqual([]);
    const short = await L.previewCall(db, fund.id, { ...FIRST_CALL, dueDate: "2025-01-27" });
    expect(short.warnings[0]).toMatch(/business days' notice/);
    await expect(L.previewCall(db, fund.id, { ...FIRST_CALL, investmentsUsd: 60e6 })).rejects.toThrow(/left to fund/);
    await expect(L.previewCall(db, fund.id, { noticeDate: "2025-01-20", dueDate: "2025-02-10" })).rejects.toThrow(/needs an amount/);
  });

  it("needs a second person to approve, then drafts one notice per investor and sends nothing", async () => {
    const { db, fund } = await lpFirm();
    await gmail(db);
    const { call } = await L.draftCall(db, fund.id, FIRST_CALL, PAT);
    expect(call).toMatchObject({ number: 1, status: "draft" });
    await expect(L.approveCall(db, call.id, PAT)).rejects.toThrow(/Someone other than/);
    const r = await L.approveCall(db, call.id, LEE);
    expect(r).toMatchObject({ approved: true, channel: "gmail_draft", queued: 4, noEmail: ["Birch Foundation"] });
    const drafts = await listOutbox(db, "pending");
    expect(drafts).toHaveLength(4);
    const harbor = drafts.find((d) => (d.payload.to as string[]).includes("ir@harborpension.example"))!;
    expect(harbor.payload.subject).toMatch(/capital call 1, due February 10, 2025/);
    expect(harbor.payload.body).toMatch(/Investments: \$1,200,000\.00/);
    expect(harbor.payload.body).toMatch(/never change our bank details by email/);
    expect(drafts.every((d) => d.status === "pending")).toBe(true);
    await expect(L.cancelCall(db, call.id, LEE)).rejects.toThrow(/Only a draft/);
    // The same fee period can't be called twice.
    await expect(L.previewCall(db, fund.id, { dueDate: "2025-08-10", noticeDate: "2025-07-20", fee: { from: "2025-06-01", to: "2025-12-31" } })).rejects.toThrow(/already in call 1/);
  });

  it("matches receipts from a bank statement or Mercury, by amount and then by name, and never twice", async () => {
    const { db, fund } = await lpFirm();
    const { call } = await L.draftCall(db, fund.id, FIRST_CALL, PAT);
    await L.approveCall(db, call.id, LEE);
    const items = await callItems(db, { callId: call.id });
    const owed = (name: string) => items.find((i) => i.partner_name === name)!.amount_usd;
    const csv = [
      "Date,Description,Credit,Debit,Reference",
      `02/07/2025,WIRE IN HARBOR PENSION PLAN,"${owed("Harbor Pension Plan").toLocaleString("en-US")}",,FED-001`,
      `02/10/2025,WIRE IN LINDEN ENDOWMENT,${owed("Linden Endowment")},,FED-002`,
      `02/10/2025,Birch Foundation capital call,${owed("Birch Foundation")},,FED-003`,
      "02/11/2025,Bank fee,,25.00,FEE-1",
      "02/12/2025,Unknown sender,999.99,,FED-004",
    ].join("\n");
    const r = await L.importBankCsv(db, fund.id, { name: "statement.csv", text: csv }, PAT);
    expect(r).toMatchObject({ rows: 5, added: 5, matched: 3, unmatched: 1 });
    const after = await callItems(db, { callId: call.id });
    for (const name of ["Harbor Pension Plan", "Linden Endowment", "Birch Foundation"]) {
      expect(after.find((i) => i.partner_name === name)).toMatchObject({ received_usd: owed(name), bank_txn_id: expect.any(String) });
    }
    expect(after.find((i) => i.partner_name === "Aster Family Office")!.received_usd).toBe(0);
    expect((await L.importBankCsv(db, fund.id, { name: "statement.csv", text: csv }, PAT)).added).toBe(0);

    // Mercury, read only: the fund's account, posted incoming wires.
    await saveConnection(db, { connectorId: "mercury", credentials: encryptJson({ mercuryApiToken: "secret-token:mercury_test" }), connectedBy: PAT, accountLabel: "Northbeam Fund I" });
    const f = fakeFetch({
      "https://api.mercury.com/api/v1/accounts": json({ accounts: [{ id: "acc-1", name: "Fund I Operating", kind: "checking", currentBalance: 1 }] }),
      "https://api.mercury.com/api/v1/account/acc-1/transactions": json({ total: 2, transactions: [
        { id: "m-1", amount: owed("Aster Family Office"), status: "sent", postedAt: "2025-02-09T15:00:00Z", counterpartyName: "Aster Family Office LLC" },
        { id: "m-2", amount: 5000, status: "pending", createdAt: "2025-02-09T15:00:00Z", counterpartyName: "Someone" },
      ] }),
    });
    const m = await L.syncBank(db, fund.id, { since: "2025-01-01" }, PAT, { fetchImpl: f.impl });
    expect(m).toMatchObject({ fetched: 1, added: 1, matched: 1 });
    expect(f.calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer secret-token:mercury_test" });
    expect((await callItems(db, { callId: call.id })).find((i) => i.partner_name === "Aster Family Office")!.received_usd).toBe(owed("Aster Family Office"));
  });

  it("reads statement exports with signed amounts, US dates and repeated rows", () => {
    const r = parseBankCsv("Posted Date,Amount,Payee,Memo\n1/5/2026,\"1,000.00\",Quill,Call 2\n1/5/2026,\"1,000.00\",Quill,Call 2\n1/6/2026,(250.00),Vendor,Fee\n,,,\n");
    expect(r.rows.map((x) => [x.postedOn, x.amount])).toEqual([["2026-01-05", 1000], ["2026-01-05", 1000], ["2026-01-06", -250]]);
    expect(new Set(r.rows.map((x) => x.externalId)).size).toBe(3);
    expect(() => parseBankCsv("Foo,Bar\n1,2\n")).toThrow(/date column/);
  });
});

/** A year and a half of a fund's life: a call, an investment, a partial sale, two distributions, expenses and a mark. */
async function fundLife() {
  const f = await lpFirm();
  const { db, fund } = f;
  const companyId = await holding(db);
  const { call } = await L.draftCall(db, fund.id, FIRST_CALL, PAT);
  await L.approveCall(db, call.id, LEE);
  await L.addExpense(db, fund.id, { incurredOn: "2025-02-15", amountUsd: 40_000, category: "organizational", description: "Fund formation counsel" }, PAT);
  await L.addExpense(db, fund.id, { incurredOn: "2026-04-30", amountUsd: 12_000, category: "fund_admin", description: "Fund administrator, Q1" }, PAT);
  await L.addExpense(db, fund.id, { incurredOn: "2026-05-02", amountUsd: 5_000, category: "other", description: "GP staff time on fund audit", relatedParty: true }, PAT);
  await L.addExpense(db, fund.id, { incurredOn: "2026-05-20", amountUsd: 10_000, feeOffset: true, description: "Board fee from Kestrel Robotics" }, PAT);
  await P.recordRealization(db, companyId, { kind: "partial_sale", occurredOn: "2026-05-10", amountUsd: 6_000_000 }, PAT);
  const d1 = await L.draftDistribution(db, fund.id, { paidOn: "2026-05-15", grossUsd: 1_000_000, companyId, purpose: "Kestrel secondary sale, first tranche" }, PAT);
  await L.approveDistribution(db, d1.distribution.id, LEE);
  await L.markDistributionPaid(db, d1.distribution.id, LEE);
  const d2 = await L.draftDistribution(db, fund.id, { paidOn: "2026-06-20", grossUsd: 5_000_000, companyId, purpose: "Kestrel secondary sale, second tranche" }, PAT);
  await L.approveDistribution(db, d2.distribution.id, LEE);
  await L.markDistributionPaid(db, d2.distribution.id, LEE);
  const m = await P.proposeMark(db, companyId, { method: "milestone", asOf: "2026-06-30", priorValue: 2_000_000, adjustmentPct: 100, rationale: "Remaining stake after the secondary, at the secondary's price." }, PAT);
  await P.reviewMark(db, m.id, { approve: true }, LEE);
  return { ...f, companyId, d1, d2 };
}

describe("distributions and the waterfall", () => {
  it("returns capital first, then the hurdle, then the GP's catch-up, taking carry only from fee payers", async () => {
    const { db, fund, companyId } = await lpFirm().then(async (f) => ({ ...f, companyId: await holding(f.db) }));
    const { call } = await L.draftCall(db, fund.id, FIRST_CALL, PAT);
    await L.approveCall(db, call.id, LEE);
    const small = await L.previewDistribution(db, fund.id, { paidOn: "2026-05-15", grossUsd: 1_000_000, companyId });
    expect(small.carry).toBe(0);
    expect(sum(small.items.map((i) => i.gross))).toBe(1_000_000);
    const d1 = await L.draftDistribution(db, fund.id, { paidOn: "2026-05-15", grossUsd: 1_000_000, companyId }, PAT);
    await expect(L.approveDistribution(db, d1.distribution.id, PAT)).rejects.toThrow(/Someone other than/);
    await L.approveDistribution(db, d1.distribution.id, LEE);
    const big = await L.previewDistribution(db, fund.id, { paidOn: "2026-06-20", grossUsd: 5_000_000, companyId });
    // Fee payers put in 99% of the called capital and get 99% of the proceeds; carry is 20% of their total profit with a full catch-up.
    const payersIn = sum((await callItems(db, { callId: call.id })).filter((i) => i.partner_name !== "Northbeam GP").map((i) => i.amount_usd));
    const payersOut = 0.99 * 6_000_000;
    expect(big.carry).toBeCloseTo(0.2 * (payersOut - payersIn), 0);
    expect(big.items.find((i) => i.name === "Northbeam GP")).toMatchObject({ gross: 50_000, carry: 0, net: 50_000 });
    expect(sum(big.items.map((i) => i.carry))).toBeCloseTo(big.carry, 2);
    expect(sum(big.items.map((i) => i.net)) + big.carry).toBeCloseTo(5_000_000, 2);
    expect(big.lines[0]).toMatch(/8% hurdle/);
  });

  it("holds carry in escrow on a deal-by-deal fund and warns below ILPA's 30%", async () => {
    const { db, fund, companyId } = await lpFirm().then(async (f) => ({ ...f, companyId: await holding(f.db) }));
    await L.setTerms(db, fund.id, { waterfall: "american", escrowPct: 10, hurdlePct: 0 }, LEE);
    const { call } = await L.draftCall(db, fund.id, FIRST_CALL, PAT);
    await L.approveCall(db, call.id, LEE);
    await expect(L.previewDistribution(db, fund.id, { grossUsd: 5e6, paidOn: "2026-06-20" })).rejects.toThrow(/needs the investment/);
    const p = await L.previewDistribution(db, fund.id, { grossUsd: 5e6, paidOn: "2026-06-20", companyId });
    // Deal by deal: carry on this investment's own profit (fee payers' share of $2M cost).
    expect(p.carry).toBeCloseTo(0.2 * (0.99 * 5e6 - 0.99 * 2e6), 0);
    expect(p.escrow).toBeCloseTo(p.carry * 0.1, 1);
    expect(p.warnings.join(" ")).toMatch(/30%/);
  });
});

describe("fee offsets", () => {
  it("reduce the next fee call once, and the report shows any not yet applied", async () => {
    const { db, fund } = await fundLife();
    const r = await L.prepareReport(db, fund.id, { period: "2026-Q2" }, PAT);
    expect((r.snapshot as unknown as Snapshot).feesExpenses.managementFees.offsetsUnapplied).toBe(10_000);
    const next = { noticeDate: "2026-07-01", dueDate: "2026-07-20", fee: { from: "2026-07-01", to: "2026-09-30" } };
    const p = await L.previewCall(db, fund.id, next);
    expect(p.feeResult).toMatchObject({ offsets: 10_000 });
    expect(p.feeResult!.net).toBeCloseTo(p.feeResult!.gross - 10_000, 2);
    const { call } = await L.draftCall(db, fund.id, next, PAT);
    await L.approveCall(db, call.id, LEE);
    const later = await L.previewCall(db, fund.id, { noticeDate: "2026-10-01", dueDate: "2026-10-20", fee: { from: "2026-10-01", to: "2026-12-31" } });
    expect(later.feeResult!.offsets).toBe(0);
  });
});

describe("capital accounts and returns", () => {
  it("roll forward for the quarter, the year and inception, and add up to NAV", async () => {
    const { db, fund } = await fundLife();
    const v = await L.fundView(db, fund.id, "2026-06-30");
    const st = v.statements;
    for (const s of [...st.statements, { ...st.total, name: "total" }]) {
      for (const k of ["quarter", "year", "inception"] as const) {
        const c = s[k];
        const rolled = c.beginning + c.contributions - c.distributions - c.managementFees - c.expenses - c.closeInterest + c.realizedGain + c.unrealizedGain - c.carriedInterest;
        expect(rolled, `${s.name} ${k}`).toBeCloseTo(c.ending, 1);
      }
    }
    expect(st.total.inception.ending + v.gpCarry.accrued).toBeCloseTo(v.summary.nav, 1);
    const gp = st.statements.find((s) => s.kind === "gp")!;
    expect(gp.inception.managementFees).toBe(0);
    expect(gp.inception.carriedInterest).toBe(0);
    // This quarter: two distributions and the gain on the sale and mark; no contributions.
    expect(st.total.quarter.contributions).toBe(0);
    expect(st.total.quarter.distributions).toBeGreaterThan(0);
    expect(v.performance.net.tvpi!).toBeGreaterThan(1);
    expect(v.performance.net.tvpi!).toBeLessThan(v.performance.gross.moic!); // fees, expenses and carry come off
    expect(v.performance.cashFlows.at(-1)).toMatchObject({ date: "2026-06-30", type: "nav" });
    expect(v.schedule[0]).toMatchObject({ company: "Kestrel Robotics", cost: 2e6, realized: 6e6, fairValue: 4e6, status: "held" });
  });
});

describe("quarterly reports", () => {
  it("cite the books and public claims only, are approved by a second person, and are final once approved", async () => {
    const { root, db, fund, companyId } = await fundLife();
    const pub = (await insertEvidence(db, { kind: "web_page", source: "news", content: "Kestrel Robotics raised a $25M Series A.", title: "Kestrel raises Series A", accessScope: "public" })).evidence;
    await insertClaim(db, { subjectId: companyId, predicate: "funding.round.amount", value: 25_000_000, asOf: "2026-05-01", evidenceId: pub.id, sourceType: "third_party", extractedBy: "test" });
    const conf = (await insertEvidence(db, { kind: "email", source: "gmail", content: "We are now 42 people.", accessScope: "confidential" })).evidence;
    await insertClaim(db, { subjectId: companyId, predicate: "team.headcount", value: 42, asOf: "2026-05-01", evidenceId: conf.id, sourceType: "self_reported", extractedBy: "test" });

    await expect(L.prepareReport(db, fund.id, { period: "2026-Q2", commentary: "We returned $9.9M to investors this quarter." }, PAT)).rejects.toThrow(/states something the books don't/);
    await expect(L.prepareReport(db, fund.id, { period: "2099-Q1" }, PAT)).rejects.toThrow(/hasn't ended/);
    const r = await L.prepareReport(db, fund.id, { period: "2026-Q2", commentary: "Kestrel Robotics had a strong quarter. We sold part of our stake to a strategic buyer." }, PAT);
    expect(r).toMatchObject({ period: "2026-Q2", version: 1, status: "draft", as_of: "2026-06-30" });
    const letter = r.letter as unknown as Letter;
    expect(letter.check.ok).toBe(true);
    const text = JSON.stringify(letter.sections);
    expect(text).toMatch(/Kestrel Robotics: .*\$25M/);
    expect(text).not.toMatch(/headcount|\b42\b/i); // a confidential claim never reaches a letter
    for (const s of letter.sections.filter((x) => x.id !== "commentary")) for (const x of s.sentences) expect(x.cites.length, x.text).toBeGreaterThan(0);
    expect(letter.sections.at(-1)).toMatchObject({ heading: "From the general partner", sentences: [{ kind: "view", cites: [] }, { kind: "view", cites: [] }] });
    const snap = r.snapshot as unknown as Snapshot;
    expect(snap.feesExpenses.expenses.find((e) => e.category === "fund_admin")!.quarter).toBe(12_000);
    expect(snap.feesExpenses.relatedParty).toEqual([expect.objectContaining({ description: "GP staff time on fund audit", amount: 5_000 })]);
    expect(snap.feesExpenses.carry.paidQuarter).toBeGreaterThan(0);
    expect(snap.performance.marketingNote).toMatch(/equal prominence/);

    await expect(L.approveReport(db, r.id, PAT)).rejects.toThrow(/Someone other than/);
    await L.approveReport(db, r.id, LEE);
    await expect(root.query("update lp_reports set letter = '{}'::jsonb where id = $1", [r.id])).rejects.toThrow(/final/);
    await expect(root.query("delete from lp_reports where id = $1", [r.id])).rejects.toThrow(/kept/);
    const v2 = await L.prepareReport(db, fund.id, { period: "2026-Q2" }, PAT);
    expect(v2.version).toBe(2);
    await expect(L.approveReport(db, v2.id, LEE)).rejects.toThrow(/already approved/);
    await L.withdrawReport(db, r.id, LEE);
    await L.approveReport(db, v2.id, LEE);

    const cap = L.exportCsv(await L.report(db, v2.id), "capital-accounts");
    expect(cap.filename).toBe("Northbeam-Fund-I-2026-Q2-capital-accounts.csv");
    expect(cap.text.split("\n")[0]).toBe("Investor,Line,Quarter,Year to date,Inception to date");
    expect(cap.text).toMatch(/Harbor Pension Plan,Ending balance,/);
    expect(L.exportCsv(await L.report(db, v2.id), "performance").text).toMatch(/Net IRR/);
    expect(L.exportCsv(await L.report(db, v2.id), "fees-expenses").text).toMatch(/Fund administration,12000/);
    expect(L.exportCsv(await L.report(db, v2.id), "investments").text).toMatch(/Kestrel Robotics,2025-03-31,2000000,6000000,4000000/);

    const cal = await L.calendar(db, fund.id, 2026);
    expect(cal.find((d) => d.key === "q2_2026")).toMatchObject({ due: "2026-08-14", done: true, state: "done" });
    expect(cal.find((d) => d.key === "q1_2026")).toMatchObject({ done: false, state: "overdue" });
  });

  it("go to each investor through a private link that shows only its own account", async () => {
    const { root, db, fund } = await fundLife();
    await gmail(db);
    const r = await L.prepareReport(db, fund.id, { period: "2026-Q2" }, PAT);
    await expect(L.queueReportNotices(db, r.id, PAT, APP)).rejects.toThrow(/approved/);
    await L.approveReport(db, r.id, LEE);
    const before = (await listOutbox(db, "pending")).length;
    const q = await L.queueReportNotices(db, r.id, PAT, APP);
    expect(q).toMatchObject({ queued: 3, noEmail: ["Birch Foundation"] }); // never the GP's own commitment
    const notices = (await listOutbox(db, "pending")).slice(before);
    const harbor = notices.find((n) => (n.payload.to as string[]).includes("ir@harborpension.example"))!;
    const token = String(harbor.payload.body).match(/\/investor\/(\S+)/)![1]!;
    const ref = (await lpPortalByToken(root, token))!;
    const view = await L.lpPortalView(scopedDb(root, ref.firmId), ref);
    expect(view.investor.name).toBe("Harbor Pension Plan");
    expect(view.reports).toHaveLength(1);
    expect(view.reports[0]!.statement!.partnerId).toBe(ref.partnerId);
    expect(view.calls[0]).toMatchObject({ number: 1, investment: 1_200_000 });
    expect(view.distributions).toHaveLength(2);
    const seen = JSON.stringify(view);
    for (const other of ["Aster Family Office", "Linden Endowment", "Birch Foundation", "Northbeam GP", "cio@asterfo.example"]) expect(seen).not.toContain(other);
    const own = await L.lpPortalStatementCsv(scopedDb(root, ref.firmId), ref, r.id);
    expect(own.text).toContain("Harbor Pension Plan");
    expect(own.text).not.toContain("Aster");
    expect(own.text).not.toContain("All partners");
    const harborId = (await partners(db, fund.id)).find((p) => p.name === "Harbor Pension Plan")!.id;
    await L.revokeLpPortal(db, harborId, PAT);
    expect(await lpPortalByToken(root, token)).toBeNull();
  });
});

describe("tax documents", () => {
  it("track K-1s by investor and show progress on the calendar", async () => {
    const { db, fund } = await lpFirm();
    const lps = (await partners(db, fund.id)).filter((p) => p.kind !== "gp");
    await L.setTaxDoc(db, fund.id, { partnerId: lps[0]!.id, taxYear: 2025, kind: "k1", status: "delivered", deliveredOn: "2026-03-10" }, PAT);
    await L.setTaxDoc(db, fund.id, { partnerId: lps[1]!.id, taxYear: 2025, kind: "k1", status: "pending", note: "Awaiting the K-3 footnotes" }, PAT);
    const k1 = (await L.calendar(db, fund.id, 2025)).find((d) => d.key === "k1_2025")!;
    expect(k1).toMatchObject({ due: "2026-03-15", done: false, progress: "1 of 4 delivered", state: "overdue" });
    await expect(L.setTaxDoc(db, fund.id, { partnerId: lps[0]!.id, taxYear: 2025, kind: "w9" }, PAT)).rejects.toThrow(/Pick the document/);
  });
});

describe("connectors", () => {
  it("offers the fund's bank read only: no connector can move money", () => {
    const lp = CONNECTORS.filter((c) => c.lp).map((c) => c.id);
    expect(lp).toEqual(expect.arrayContaining(["mercury", "bank-csv", "fund-admin-csv", "gmail", "outlook"]));
    expect(CONNECTORS.find((c) => c.id === "mercury")!.writes).toBeUndefined();
  });
});

describe("firm isolation", () => {
  it("keeps every LP table and every investor link to its firm", async () => {
    const { root, db, fund } = await fundLife();
    const harborId = (await partners(db, fund.id)).find((p) => p.name === "Harbor Pension Plan")!.id;
    await L.importBankCsv(db, fund.id, { name: "s.csv", text: "Date,Amount,Description\n2025-02-08,100,Test\n" }, PAT);
    await L.setTaxDoc(db, fund.id, { partnerId: harborId, taxYear: 2025, kind: "k1", status: "pending" }, PAT);
    await L.prepareReport(db, fund.id, { period: "2026-Q2" }, PAT);
    const link = await L.createLpPortalLink(db, harborId, PAT, APP);
    const tables = ["funds", "fund_partners", "capital_calls", "call_items", "distributions", "distribution_items", "fund_expenses", "bank_transactions", "tax_documents", "lp_reports", "lp_portal_links"];
    for (const t of tables) expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBeGreaterThan(0);
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    for (const t of tables) expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    await expect(L.fundView(other, fund.id)).rejects.toThrow(/No such fund/);
    expect((await L.overview(other)).funds).toEqual([]);
    // Expenses are append-only, even inside the firm.
    await expect(db.query("update fund_expenses set amount_usd = 1")).rejects.toThrow();
    const ref = (await lpPortalByToken(root, link.url.split("/investor/")[1]!))!;
    expect(ref.firmId).not.toBe((await other.query<{ id: string }>("select current_firm() as id")).rows[0]!.id);
  });
});
