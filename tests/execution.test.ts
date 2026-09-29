import { describe, it, expect, beforeAll } from "vitest";
import { scopedDb, type Db } from "../lib/db.js";
import { testFirm, testRoot } from "./helpers.js";
import { createFirm } from "../ledger/platform.js";
import { currentClaims } from "../ledger/repository.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { decide, startDeal } from "../modules/diligence/index.js";
import {
  advanceIc, approveWire, castVote, closeDeal, confirmWire, executionView, importCapTableCsv, investments, markWireSent, model, pipeline,
  recordWireInstructions, recuse, saveCapTable, saveTermSheet, scheduleIc, screenSanctions, setTermStatus, startClosing, syncSignatures,
  updateItem, verifyWire,
} from "../modules/execution/index.js";
import { checkTerms, HOUSE_DEFAULTS, TermSheet } from "../modules/execution/terms.js";
import { tally } from "../modules/execution/ic.js";
import { closingTemplate } from "../modules/execution/closing.js";
import { capTableFromCsv } from "../connectors/carta.js";
import { parseSanctions, screen } from "../connectors/ofac.js";
import { closingStatusFor, parseEnvelopes } from "../connectors/docusign.js";
import { pending } from "../modules/outbox/index.js";
import { insertInvestment, insertWire, seedClosingItems } from "../ledger/execution.js";

// Fictional firm, company and people throughout.

beforeAll(() => testRoot());

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const SAM = "human:sam@northbeam.vc";

async function firm(rule = "majority") {
  const { root, db } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, {
    ...p,
    fund: { ...p.fund, committedUsd: 100e6, icApproval: rule, lpTypes: ["Institutional (pensions, endowments)", "Family offices"] },
    mandate: { ...p.mandate, checkSizeUsd: { min: 1e6, max: 5e6 } },
  }, PAT);
  return { root, db };
}

const TERMS = {
  security: "preferred", seriesName: "Series A Preferred", preMoneyUsd: 24e6, raiseUsd: 8e6, ourAllocationUsd: 3e6, leadInvestor: "Northbeam",
  poolTopUpPostPct: 10, liquidation: { multiple: 1, participation: "none", seniority: "pari_passu" }, managementRightsLetter: true,
  board: { size: 5, investorSeats: 2, commonSeats: 2, independentSeats: 1, ours: "seat" }, noShopDays: 30,
};

const CSV = `Stakeholder,Share Class,Shares
Maya Lindqvist,Common,4000000
Raj Patel,Common,3000000
Seed investors,Series Seed Preferred,1500000
Employees,Options outstanding,500000
Available pool,Unissued pool,1000000
Total,,10000000
`;

async function dealAtIc(db: Db) {
  const { id } = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, PAT);
  await decide(db, id, { kind: "advance", rationale: "Competitive round; IC to review open diligence items live." }, PAT);
  return id;
}

describe("term sheets", () => {
  it("checks each term against NVCA norms and the firm's house terms", () => {
    const t = TermSheet.parse({ ...TERMS, liquidation: { multiple: 2, participation: "full", seniority: "senior" }, antiDilution: "full_ratchet", dividends: { kind: "cumulative", ratePct: 8 }, managementRightsLetter: false, poolTopUpPostPct: 20 });
    const c = Object.fromEntries(checkTerms(t, HOUSE_DEFAULTS, { erisaLps: true, sensitiveTech: true }).map((x) => [x.key, x]));
    expect(c["liquidation.multiple"]).toMatchObject({ nvca: "off_market", house: "outside" });
    expect(c["liquidation.participation"]).toMatchObject({ nvca: "investor_friendly", house: "outside" });
    expect(c.antiDilution).toMatchObject({ nvca: "off_market", house: "outside" });
    expect(c.dividends).toMatchObject({ nvca: "off_market", house: "outside" });
    expect(c.pool).toMatchObject({ house: "outside" });
    expect(c.managementRightsLetter).toMatchObject({ house: "outside" });
    expect(c.managementRightsLetter!.note).toMatch(/ERISA/);
    expect(c.oisp).toMatchObject({ house: "outside" });
    const std = checkTerms(TermSheet.parse(TERMS), HOUSE_DEFAULTS, { erisaLps: true });
    expect(std.filter((x) => x.house === "outside").map((x) => x.key)).toEqual([]);
    expect(std.find((x) => x.key === "liquidation.multiple")!.nvca).toBe("standard");
  });

  it("versions term sheets; signing one records the round as primary-source claims", async () => {
    const { db } = await firm();
    const id = await dealAtIc(db);
    await expect(saveTermSheet(db, id, { terms: { security: "preferred" } }, PAT)).rejects.toThrow(/pre-money valuation and a round size/);
    await expect(saveTermSheet(db, id, { terms: { security: "safe_post" } }, PAT)).rejects.toThrow(/cap, a discount or an MFN/);
    const v1 = await saveTermSheet(db, id, { terms: { ...TERMS, preMoneyUsd: 20e6 }, status: "proposed" }, PAT);
    const v2 = await saveTermSheet(db, id, { terms: TERMS, status: "negotiating" }, PAT);
    expect([v1.version, v2.version]).toEqual([1, 2]);
    await setTermStatus(db, id, 2, "signed", PAT);
    const view = await executionView(db, id, PAT);
    expect(view.termSheets.map((s) => [s.version, s.status])).toEqual([[2, "signed"], [1, "superseded"]]);
    const raise = await currentClaims(db, view.deal.company_id, { predicates: ["raise.amount", "raise.pre_money"] });
    expect(raise.map((c) => [c.predicate, c.value, c.source_type])).toEqual(expect.arrayContaining([["raise.amount", 8e6, "primary"], ["raise.pre_money", 24e6, "primary"]]));
  });
});

describe("cap table and the model", () => {
  it("imports a Carta-style export and models the round with our stake and returns", async () => {
    expect(capTableFromCsv(CSV).holdings.map((h) => h.kind)).toEqual(["common", "common", "preferred", "options", "pool"]);
    expect(() => capTableFromCsv("a,b\n1,2")).toThrow(/holder column/);
    const { db } = await firm();
    const id = await dealAtIc(db);
    const ct = await importCapTableCsv(db, id, { name: "kestrel-captable.csv", text: CSV }, PAT);
    expect(ct).toMatchObject({ version: 1, source: "csv", skipped: 1 });
    expect((await model(db, id)).error).toMatch(/term sheet/);
    await saveTermSheet(db, id, { terms: TERMS }, PAT);
    // The seed series has a 1x non-participating preference at $1.00.
    await saveCapTable(db, id, { holdings: ct.holdings, seriesTerms: [{ name: "Series Seed Preferred", issuePrice: 1, multiple: 1, participating: false, seniority: 2 }] }, PAT);
    const m = await model(db, id);
    expect(m.error).toBeNull();
    const p = m.proForma!;
    // 10M existing, pool topped up to 10% of post; $24M pre includes the top-up.
    expect(p.pool.afterPct).toBeGreaterThan(9.99);
    expect(p.pool.afterPct).toBeLessThan(10.01);
    expect(Math.abs(p.postMoneyImplied - 32e6) / 32e6).toBeLessThan(1e-4);
    expect(m.ours!.amount).toBe(3e6);
    expect(m.ours!.postPct).toBeCloseTo(9.375, 2); // $3M of $32M post
    // Below the preference stack we get our money back; well above it, we convert.
    const at = (x: number) => m.scenarios.find((s) => Math.abs(s.exit / p.postMoneyImplied - x) < 0.01)!;
    expect(at(0.5).multiple).toBeCloseTo(1, 2);
    expect(at(10).converted).toBe(true);

    // A post-money SAFE converts into a shadow series whose preference is its
    // own conversion price, so its claim in a downside is what it paid ($1M), not
    // its shares times the new round's price.
    await saveCapTable(db, id, {
      holdings: ct.holdings, safes: [{ holder: "Angel SAFE", amount: 1e6, kind: "post", cap: 10e6 }],
      seriesTerms: [{ name: "Series Seed Preferred", issuePrice: 1, multiple: 1, participating: false, seniority: 2 }],
    }, PAT);
    const withSafe = await model(db, id);
    const conv = withSafe.proForma!.conversions[0]!;
    expect(conv.price).toBeLessThan(withSafe.proForma!.pricePerShare);
    const seedPref = 1_500_000; // 1.5M seed shares at $1.00
    const newMoney = 8e6;
    const safePref = conv.shares * conv.price; // about $1M
    expect(Math.abs(safePref - 1e6)).toBeLessThan(5);
    const low = withSafe.scenarios[0]!; // 0.25x post-money: below the preference stack
    expect(low.proceeds).toBeCloseTo((low.exit * 3e6) / (seedPref + newMoney + safePref), -2);
    expect(at(10).multiple).toBeGreaterThan(9);
  });
});

describe("the IC meeting", () => {
  it("applies each approval rule", () => {
    const m = [PAT, LEE, SAM];
    expect(tally("majority", m, [{ member: PAT, vote: "yes" }, { member: LEE, vote: "yes" }, { member: SAM, vote: "no" }]).outcome).toBe("approved");
    expect(tally("unanimous", m, [{ member: PAT, vote: "yes" }, { member: LEE, vote: "yes" }, { member: SAM, vote: "abstain" }]).outcome).toBe("declined");
    expect(tally("supermajority", m, [{ member: PAT, vote: "yes" }, { member: LEE, vote: "yes" }, { member: SAM, vote: "no" }]).outcome).toBe("approved");
    expect(tally("champion", m, [{ member: PAT, vote: "yes", conviction: 5 }, { member: LEE, vote: "no", conviction: 3 }, { member: SAM, vote: "no", conviction: 2 }]).outcome).toBe("approved");
    expect(tally("champion", m, [{ member: PAT, vote: "yes", conviction: 5 }, { member: LEE, vote: "no", conviction: 5 }]).outcome).toBe("declined");
    expect(tally("majority", m, [{ member: PAT, vote: "yes" }]).outcome).toBe("no_quorum");
    expect(tally("unanimous", m, [{ member: PAT, vote: "yes" }, { member: LEE, vote: "yes" }, { member: SAM, vote: "recused" }]).outcome).toBe("approved");
    expect(tally("managing_partner", m, [{ member: PAT, vote: "no" }, { member: LEE, vote: "yes" }, { member: SAM, vote: "yes" }], PAT).outcome).toBe("declined");
  });

  it("keeps independent votes hidden until discussion, records both rounds, and moves the deal on", async () => {
    const { db } = await firm("majority");
    const id = await dealAtIc(db);
    const m = await scheduleIc(db, id, { members: ["pat@northbeam.vc", "lee@northbeam.vc", "sam@northbeam.vc"] }, PAT);
    await expect(scheduleIc(db, id, { members: ["pat@northbeam.vc"] }, PAT)).rejects.toThrow(/already an IC meeting/);
    await castVote(db, m.id, { vote: "yes", conviction: 4 }, PAT);
    await expect(castVote(db, m.id, { vote: "no", conviction: 4 }, PAT)).rejects.toThrow(/already voted/);
    await expect(castVote(db, m.id, { vote: "yes", conviction: 4 }, "human:outsider@x.example")).rejects.toThrow(/Only IC members/);
    await castVote(db, m.id, { vote: "no", conviction: 3, note: "Pilot conversion unproven." }, LEE);
    // Lee sees only Lee's own vote before discussion; nobody sees the tally.
    const leeView = (await executionView(db, id, LEE)).meetings[0]!;
    expect(leeView.preVotes.map((v) => v.member)).toEqual([LEE]);
    expect(leeView.preTally).toBeNull();
    expect(leeView.voted.pre).toEqual([PAT, LEE]);
    await expect(advanceIc(db, m.id, {}, PAT)).rejects.toThrow(/Waiting for independent votes from sam/);
    await expect(advanceIc(db, m.id, {}, LEE)).rejects.toThrow(/Only the chair/);
    await recuse(db, m.id, "Personal investment in a competitor.", SAM);
    await advanceIc(db, m.id, { notes: "Discussed pilot conversion risk." }, PAT);
    const open = (await executionView(db, id, LEE)).meetings[0]!;
    expect(open.phase).toBe("discussion");
    expect(open.preVotes).toHaveLength(3);
    expect(open.preTally).toMatchObject({ yes: 1, no: 1, recused: 1 });
    await expect(castVote(db, m.id, { vote: "yes", conviction: 4 }, LEE)).rejects.toThrow(/final votes open/);
    await advanceIc(db, m.id, {}, PAT);
    await castVote(db, m.id, { vote: "yes", conviction: 5 }, PAT);
    await castVote(db, m.id, { vote: "yes", conviction: 3 }, LEE); // changed after discussion
    await advanceIc(db, m.id, {}, PAT);
    const done = await executionView(db, id, PAT);
    expect(done.deal.stage).toBe("approved");
    expect(done.meetings[0]).toMatchObject({ phase: "decided", outcome: "approved" });
    expect(done.meetings[0]!.shifts).toEqual([
      { member: PAT, from: "yes", to: "yes", conviction: [4, 5] },
      { member: LEE, from: "no", to: "yes", conviction: [3, 3] },
    ]);
    const { rows } = await db.query<{ kind: string; n: number }>("select kind, count(*)::int as n from decisions where kind like 'ic_vote%' group by kind order by kind");
    expect(rows).toEqual([{ kind: "ic_vote_post", n: 3 }, { kind: "ic_vote_pre", n: 3 }]);
  });

  it("a decline records a pass with its reason", async () => {
    const { db } = await firm("unanimous");
    const id = await dealAtIc(db);
    const m = await scheduleIc(db, id, { members: ["pat@northbeam.vc", "lee@northbeam.vc"] }, PAT);
    await castVote(db, m.id, { vote: "yes", conviction: 4 }, PAT);
    await castVote(db, m.id, { vote: "no", conviction: 4 }, LEE);
    await advanceIc(db, m.id, {}, PAT);
    await advanceIc(db, m.id, {}, PAT);
    await castVote(db, m.id, { vote: "yes", conviction: 4 }, PAT);
    await castVote(db, m.id, { vote: "no", conviction: 4 }, LEE);
    await expect(advanceIc(db, m.id, {}, PAT)).rejects.toThrow(/Record the main reason/);
    await advanceIc(db, m.id, { passReason: "valuation", passRationale: "Not at this price." }, PAT);
    const v = await executionView(db, id, PAT);
    expect(v.deal.stage).toBe("passed");
  });
});

describe("closing", () => {
  it("builds the checklist from the terms and the fund", () => {
    const priced = closingTemplate(TermSheet.parse(TERMS), { erisaLps: true, sensitiveTech: true }).map((i) => i.key);
    expect(priced).toEqual(expect.arrayContaining(["spa", "charter", "ira", "voting_agreement", "rofr_cosale", "management_rights_letter", "oisp", "sanctions", "wire_callback", "form_d", "board_onboarding"]));
    const safe = closingTemplate(TermSheet.parse({ security: "safe_post", valuationCapUsd: 10e6 }), {}).map((i) => i.key);
    expect(safe).toContain("safe_or_note");
    expect(safe).not.toContain("spa");
    expect(safe).not.toContain("oisp");
  });

  it("screens sanctions against OFAC's lists: clears clean names and flags potential matches", async () => {
    const sdn = `36,"KESTREL TRADING CO LTD","-0-","SDGT","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"\n2674,"PATEL, Raj","individual","SDNTK","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"\n`;
    const alt = `36,101,"aka","KESTREL TRADERS","-0-"\n`;
    const entries = parseSanctions("SDN", sdn, alt);
    expect(entries[0]).toMatchObject({ name: "KESTREL TRADING CO LTD", aliases: ["KESTREL TRADERS"], program: "SDGT" });
    const r = screen(["Kestrel Robotics", "Raj Patel", "Kestrel Traders Limited"], entries);
    expect(r[0]!.hits).toEqual([]);
    expect(r[1]!.hits[0]).toMatchObject({ how: "same words" });
    expect(r[2]!.hits[0]!.matchedName).toBe("KESTREL TRADERS");

    const { db } = await firm();
    const id = await dealAtIc(db);
    await db.query("update deals set stage = 'approved' where id = $1", [id]);
    await startClosing(db, id, PAT);
    const clean = await screenSanctions(db, id, PAT, { lists: async () => ({ entries, fetchedAt: "2026-10-20T00:00:00Z" }) });
    expect(clean.results.every((x) => x.hits.length === 0)).toBe(true);
    let item = (await executionView(db, id, PAT)).closing.items.find((i) => i.key === "sanctions")!;
    expect(item.status).toBe("done");
    await screenSanctions(db, id, PAT, { lists: async () => ({ entries, fetchedAt: "2026-10-20T00:00:00Z" }), extraNames: ["Raj Patel"] });
    item = (await executionView(db, id, PAT)).closing.items.find((i) => i.key === "sanctions")!;
    expect(item.status).toBe("red_flag");
    expect(item.note).toMatch(/1 potential match/);
  });

  it("tracks DocuSign envelopes and queues drafts for approval, never sending", async () => {
    expect(parseEnvelopes({ envelopes: [{ envelopeId: "e1", status: "completed", emailSubject: "SPA" }] })[0]).toMatchObject({ envelopeId: "e1", status: "completed" });
    expect(closingStatusFor("completed")).toBe("signed");
    expect(closingStatusFor("voided")).toBe("red_flag");
    const { db } = await firm();
    const id = await dealAtIc(db);
    await db.query("update deals set stage = 'approved' where id = $1", [id]);
    await startClosing(db, id, PAT);
    const env = "4b3f9d2e-1c3a-4a6e-9f10-2c7d8e9a0b1c";
    await updateItem(db, id, "spa", { envelopeId: env }, PAT);
    await expect(updateItem(db, id, "ira", { envelopeId: "not-an-id" }, PAT)).rejects.toThrow(/envelope id/);
    expect(await syncSignatures(db, id, PAT, { envelopes: async () => [{ envelopeId: env, status: "completed" }] })).toEqual({ updated: 1 });
    expect((await executionView(db, id, PAT)).closing.items.find((i) => i.key === "spa")!.status).toBe("signed");
    expect(await pending(db)).toEqual([]);
  });

  it("enforces wire controls: call-back to a known number, two approvers, then a person sends it", async () => {
    const { db } = await firm();
    const id = await dealAtIc(db);
    await db.query("update deals set stage = 'approved' where id = $1", [id]);
    await startClosing(db, id, PAT);
    await expect(recordWireInstructions(db, id, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "123456789" }, PAT)).rejects.toThrow(/Last four digits/);
    const w = await recordWireInstructions(db, id, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "6789" }, PAT);
    await expect(approveWire(db, w.id, LEE)).rejects.toThrow(/Confirm the instructions by phone/);
    await expect(verifyWire(db, w.id, { numberSource: "the number in the wire email", confirmed: true }, PAT)).rejects.toThrow(/not one from them/);
    await expect(updateItem(db, id, "wire_callback", { status: "done" }, PAT)).rejects.toThrow(/wire record/);
    await verifyWire(db, w.id, { numberSource: "CFO's mobile, saved from our first diligence call", confirmed: true }, PAT);
    await expect(approveWire(db, w.id, PAT)).rejects.toThrow(/someone else must approve first/);
    await approveWire(db, w.id, LEE);
    await expect(approveWire(db, w.id, LEE)).rejects.toThrow(/second person/);
    await expect(markWireSent(db, w.id, { bankReference: "FED123" }, LEE)).rejects.toThrow(/two approvals/);
    expect(await approveWire(db, w.id, PAT)).toEqual({ approvals: 2, needed: 2 });
    await markWireSent(db, w.id, { bankReference: "FED20261021-0042" }, SAM);
    await confirmWire(db, w.id, PAT);
    const items = Object.fromEntries((await executionView(db, id, PAT)).closing.items.map((i) => [i.key, i.status]));
    expect(items).toMatchObject({ wire_instructions: "received", wire_callback: "done", wire_approvals: "done", funds_sent: "done", funds_received: "done" });
    // New instructions replace old ones and must be verified again (a classic fraud pattern).
    const w2 = await recordWireInstructions(db, id, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "Other Bank", accountLast4: "1111" }, PAT);
    expect(w2.status).toBe("received");
  });

  it("closes the deal into an investment record once the checklist is complete", async () => {
    const { db } = await firm();
    const id = await dealAtIc(db);
    await importCapTableCsv(db, id, { name: "cap.csv", text: CSV }, PAT);
    await saveTermSheet(db, id, { terms: TERMS, status: "signed" }, PAT);
    await db.query("update deals set stage = 'approved' where id = $1", [id]);
    await startClosing(db, id, PAT);
    await expect(closeDeal(db, id, { closeDate: "2026-10-22" }, PAT)).rejects.toThrow(/Still open/);
    const view = await executionView(db, id, PAT);
    for (const i of view.closing.items.filter((x) => x.required && !["wire_callback", "wire_approvals", "funds_sent", "wire_instructions"].includes(x.key))) {
      if (!["signed", "done"].includes(i.status)) await updateItem(db, id, i.key, { status: "done" }, PAT);
    }
    const w = await recordWireInstructions(db, id, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "6789" }, PAT);
    await verifyWire(db, w.id, { numberSource: "CEO's mobile from the first meeting", confirmed: true }, LEE);
    await approveWire(db, w.id, PAT);
    await approveWire(db, w.id, SAM);
    await markWireSent(db, w.id, { bankReference: "REF1" }, PAT);
    const inv = await closeDeal(db, id, { closeDate: "2026-10-22" }, PAT);
    expect(inv).toMatchObject({ amount_usd: 3e6, security: "preferred", series_name: "Series A Preferred", board_role: "seat" });
    expect(inv.ownership_fd_pct).toBeCloseTo(9.375, 1);
    expect((await executionView(db, id, PAT)).deal.stage).toBe("closed");
    expect((await investments(db)).map((i) => i.company_name)).toEqual(["Kestrel Robotics"]);
    const investor = await currentClaims(db, view.deal.company_id, "funding.investor");
    expect(investor.map((c) => c.value)).toContain("Northbeam");
    expect((await pipeline(db))[0]).toMatchObject({ stage: "closed", investment: { amount: 3e6 } });
    await expect(db.query("update investments set amount_usd = 1")).rejects.toThrow(/append-only|permission denied/);
  });
});

describe("firm isolation", () => {
  it("keeps term sheets, cap tables, IC meetings, closing items, wires and investments to their firm", async () => {
    const { root, db } = await firm();
    const id = await dealAtIc(db);
    await saveTermSheet(db, id, { terms: TERMS }, PAT);
    await importCapTableCsv(db, id, { name: "cap.csv", text: CSV }, PAT);
    await scheduleIc(db, id, { members: ["pat@northbeam.vc"] }, PAT);
    const deal = (await pipeline(db))[0]!;
    await seedClosingItems(db, id, [{ key: "sanctions", category: "compliance", title: "Sanctions", required: true }], PAT);
    await insertWire(db, id, { amountUsd: 3e6, beneficiary: "Kestrel Robotics, Inc.", bankName: "First Bank", accountLast4: "4821" }, PAT);
    await insertInvestment(db, { dealId: id, companyId: deal.company_id, fundName: "Fund I", security: "preferred", seriesName: "Series A Preferred", closeDate: "2026-09-01", amountUsd: 3e6, shares: null, pricePerShare: null, postMoneyUsd: null, ownershipFdPct: null, boardRole: "seat", rights: {} }, PAT);
    for (const t of ["term_sheets", "cap_tables", "ic_meetings", "closing_items", "wires", "investments"]) {
      expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBeGreaterThan(0);
    }
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    for (const t of ["term_sheets", "cap_tables", "ic_meetings", "closing_items", "wires", "investments"]) {
      expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    }
    await expect(executionView(other, id, PAT)).rejects.toThrow(/No such deal/);
  });
});
