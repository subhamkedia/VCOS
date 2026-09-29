import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { decrypt, setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm, testRoot } from "./helpers.js";
import { createFirm, portalLinkByToken, takePortalOAuth } from "../ledger/platform.js";
import { currentClaims } from "../ledger/repository.js";
import { insertInvestment, listInvestments } from "../ledger/execution.js";
import { accountingLinks, accountingSecret, kpiRequests, setPortalOAuth } from "../ledger/portfolio.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { startDeal } from "../modules/diligence/index.js";
import * as P from "../modules/portfolio/index.js";
import { accountingRecord, mergeMonths, parseQuickbooksBalance, parseQuickbooksPnl, parseXeroBalance, parseXeroPnl } from "../connectors/accounting.js";
import { parseStandardMetrics, platformRecord } from "../connectors/portfolio-platforms.js";
import { predicateForMetric } from "../connectors/kpi-names.js";

// Fictional firm, companies and people throughout.

beforeAll(async () => {
  setSecretKeyForTests(randomBytes(32));
  await testRoot();
});

const PAT = "human:pat@northbeam.vc";
const LEE = "human:lee@northbeam.vc";
const APP = "https://app.example";

async function portfolioFirm() {
  const { root, db, firm } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, { ...p, fund: { ...p.fund, name: "Northbeam Fund I", committedUsd: 50e6, reservesPct: 40 } }, PAT);
  const { id: dealId } = await startDeal(db, { company: { name: "Kestrel Robotics", domain: "kestrelrobotics.example" } }, PAT);
  const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [dealId])).rows[0]!.company_id;
  await insertInvestment(db, {
    dealId, companyId, fundName: "Northbeam Fund I", security: "preferred", seriesName: "Seed Preferred", closeDate: "2025-03-31",
    amountUsd: 2e6, shares: 2_000_000, pricePerShare: 1, postMoneyUsd: 12e6, ownershipFdPct: 16.67, boardRole: "seat", rights: {},
  }, PAT);
  return { root, db, firm, companyId, dealId };
}

/** Six months of books: revenue growing, expenses flat, cash falling. */
function books(): { month: string; revenue: number; expenses: number; cash: number }[] {
  return ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((month, i) => ({
    month, revenue: 80_000 + i * 10_000, expenses: 300_000, cash: 3_000_000 - i * 200_000,
  }));
}

describe("KPI sources", () => {
  it("maps vendor and spreadsheet metric names onto predicates", () => {
    expect(predicateForMetric("MRR")).toBe("revenue.monthly");
    expect(predicateForMetric("ARR (USD)")).toBe("revenue.arr");
    expect(predicateForMetric("Net Burn")).toBe("burn.monthly");
    expect(predicateForMetric("Cash on hand")).toBe("cash.balance");
    expect(predicateForMetric("FTEs")).toBe("team.headcount");
    expect(predicateForMetric("Robots deployed")).toBe("fleet.units_deployed");
    expect(predicateForMetric("Favourite colour")).toBeNull();
  });

  it("reads QuickBooks and Xero monthly reports", () => {
    const col = (m: string, end: string) => ({ ColTitle: m, ColType: "Money", MetaData: [{ Name: "StartDate", Value: `${m}-01` }, { Name: "EndDate", Value: end }] });
    const qCols = { Column: [{ ColTitle: "", ColType: "Account" }, col("2026-05", "2026-05-31"), col("2026-06", "2026-06-30"), { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "StartDate", Value: "2026-05-01" }, { Name: "EndDate", Value: "2026-06-30" }] }] };
    const pnl = parseQuickbooksPnl({
      Columns: qCols,
      Rows: { Row: [
        { group: "Income", Summary: { ColData: [{ value: "Total Income" }, { value: "90000.00" }, { value: "100000.00" }, { value: "190000.00" }] } },
        { group: "COGS", Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "30000" }, { value: "32000" }, { value: "62000" }] } },
        { group: "Expenses", Summary: { ColData: [{ value: "Total Expenses" }, { value: "250000" }, { value: "260000" }, { value: "510000" }] } },
      ] },
    });
    expect(pnl).toEqual([{ month: "2026-05", revenue: 90_000, expenses: 280_000 }, { month: "2026-06", revenue: 100_000, expenses: 292_000 }]);
    const bs = parseQuickbooksBalance({
      Columns: qCols,
      Rows: { Row: [{ group: "TotalAssets", Rows: { Row: [{ group: "CurrentAssets", Rows: { Row: [{ group: "BankAccounts", Summary: { ColData: [{ value: "Total Bank Accounts" }, { value: "2800000" }, { value: "2600000" }, { value: "" }] } }] } }] } }] },
    });
    expect(bs).toEqual([{ month: "2026-05", cash: 2_800_000 }, { month: "2026-06", cash: 2_600_000 }]);

    const xHeader = { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Jun 2026" }, { Value: "31 May 2026" }] };
    const xp = parseXeroPnl({ Reports: [{ Rows: [xHeader,
      { RowType: "Section", Title: "Income", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Income" }, { Value: "100000.00" }, { Value: "90000.00" }] }] },
      { RowType: "Section", Title: "Less Cost of Sales", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Cost of Sales" }, { Value: "32000" }, { Value: "30000" }] }] },
      { RowType: "Section", Title: "Less Operating Expenses", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Operating Expenses" }, { Value: "260000" }, { Value: "250000" }] }] },
    ] }] });
    expect(xp).toEqual([{ month: "2026-06", revenue: 100_000, expenses: 292_000 }, { month: "2026-05", revenue: 90_000, expenses: 280_000 }]);
    const xb = parseXeroBalance({ Reports: [{ Rows: [xHeader, { RowType: "Section", Title: "Bank", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Bank" }, { Value: "2600000" }, { Value: "2800000" }] }] }] }] });
    expect(mergeMonths(xp, xb)).toEqual([
      { month: "2026-05", revenue: 90_000, expenses: 280_000, cash: 2_800_000 },
      { month: "2026-06", revenue: 100_000, expenses: 292_000, cash: 2_600_000 },
    ]);
    // Only closed months are recorded, each figure citing its line.
    const rec = accountingRecord("xero", mergeMonths(xp, xb), { companyName: "Kestrel Robotics", externalId: "t-1", fetchedAt: "2026-06-15T00:00:00Z" })!;
    expect(rec.sourceType).toBe("primary");
    expect(rec.claims!.map((c) => [c.predicate, c.asOf])).toEqual([["revenue.monthly", "2026-05-31"], ["expenses.monthly", "2026-05-31"], ["cash.balance", "2026-05-31"]]);
    expect(rec.evidence.content).toContain(rec.claims![0]!.citedText!);
  });

  it("reads Standard Metrics rows, keeping unknown metrics as evidence only", () => {
    const pts = parseStandardMetrics({ results: [
      { category: "Cash", date: "2026-05-31", value: 2_800_000 }, { category: "Favourite colour", date: "2026-05-31", value: 3 }, { category: "MRR", date: "2026-05-15", value: 90_000 },
    ] });
    const rec = platformRecord("standard-metrics", "Kestrel Robotics", pts, "2026-06-10T00:00:00Z")!;
    expect(rec.claims!.map((c) => [c.predicate, c.asOf])).toEqual([["revenue.monthly", "2026-05-31"], ["cash.balance", "2026-05-31"]]);
    expect(rec.evidence.content).toContain("Favourite colour");
    expect(rec.sourceType).toBe("self_reported");
  });
});

describe("portfolio numbers", () => {
  it("records entered KPIs as cited claims and answers the month's request", async () => {
    const { db, companyId } = await portfolioFirm();
    await P.addContact(db, companyId, { name: "Maya Lindqvist", email: "maya@kestrelrobotics.example", role: "CEO", reporting: true }, PAT);
    const req = await P.requestKpis(db, companyId, { period: "2026-05", dueOn: "2026-06-15" }, PAT, APP);
    expect(req.outboxId).toBeNull(); // no mailbox connected: the link and text come back to copy
    expect(req.email.to).toEqual(["maya@kestrelrobotics.example"]);
    expect(req.link).toMatch(/^https:\/\/app\.example\/portal\/[\w-]{40,}$/);
    await expect(P.recordKpis(db, companyId, { period: "2026-05", values: { "company.description": 1 } }, PAT)).rejects.toThrow(/isn't a metric/);
    await expect(P.recordKpis(db, companyId, { period: "2026-05", values: { "cash.balance": -5 } }, PAT)).rejects.toThrow(/zero or more/);
    await expect(P.recordKpis(db, companyId, { period: "2099-01", values: { "cash.balance": 5 } }, PAT)).rejects.toThrow(/hasn't happened/);
    const r = await P.recordKpis(db, companyId, { period: "2026-05", values: { "cash.balance": "2,800,000", "burn.monthly": 190_000, "team.headcount": 24 } }, PAT);
    expect(r.claims).toBe(3);
    const cash = (await currentClaims(db, companyId, "cash.balance"))[0]!;
    expect(cash).toMatchObject({ value: 2_800_000, as_of: "2026-05-31", source_type: "self_reported" });
    expect(cash.cited_text).toBe("Cash balance, 2026-05: $2,800,000");
    expect((await kpiRequests(db, { companyId }))[0]).toMatchObject({ status: "received", evidence_id: r.evidenceId });
  });

  it("imports a spreadsheet, month by month", async () => {
    const { db, companyId } = await portfolioFirm();
    const csv = "Month,MRR,Cash,Headcount,Pipeline notes\n2026-04,70000,3000000,22,good\n2026-05,80000,2800000,24,ok\n";
    const r = await P.importKpiCsv(db, companyId, { name: "kpis.csv", text: csv }, PAT);
    expect(r.claims).toBe(6);
    expect(r.ignoredColumns).toEqual(["Pipeline notes"]);
    const mrr = await currentClaims(db, companyId, "revenue.monthly");
    expect(mrr.map((c) => [c.as_of, c.value, c.cited_text])).toEqual([["2026-04-30", 70_000, "2026-04,70000,3000000,22,good"], ["2026-05-31", 80_000, "2026-05,80000,2800000,24,ok"]]);
    await expect(P.importKpiCsv(db, companyId, { name: "x.csv", text: "Metric,Value\nfoo,1\n" }, PAT)).rejects.toThrow(/Month column/);
  });

  it("syncs the books (primary wins over what the founder typed), rotates and encrypts tokens, and reports what it skipped", async () => {
    const { root, db, companyId } = await portfolioFirm();
    // The founder connects Xero from the portal link.
    const link = await P.createPortalLink(db, companyId, PAT, APP);
    const token = link.url.split("/portal/")[1]!;
    const ref = (await portalLinkByToken(root, token))!;
    await setPortalOAuth(db, ref.id, { state: "state-1", provider: "xero", verifier: "v" });
    const oauth = (await takePortalOAuth(root, "state-1"))!;
    expect(await takePortalOAuth(root, "state-1")).toBeNull(); // single use
    const done = await P.finishAccountingLink(scopedDb(root, oauth.firmId), oauth, { code: "c", redirectUri: "https://app.example/api/portal/callback" }, {
      exchange: async () => ({ accessToken: "a", refreshToken: "refresh-1" }),
      tenants: async () => [{ id: "tenant-9", name: "Kestrel Robotics Inc" }],
    });
    expect(done).toMatchObject({ company: "Kestrel Robotics", provider: "Xero", externalName: "Kestrel Robotics Inc" });
    const [l] = await accountingLinks(db, companyId);
    const stored = (await accountingSecret(db, l!.id))!;
    expect(stored.secret).not.toContain("refresh-1");
    expect(decrypt(stored.secret)).toBe("refresh-1");

    // The founder had typed a different May revenue: the books win.
    await P.recordKpis(db, companyId, { period: "2026-05", values: { "revenue.monthly": 95_000 } }, PAT);
    const seen: string[] = [];
    const results = await P.syncCompany(db, companyId, PAT, {
      now: new Date("2026-07-05T00:00:00Z"),
      accounting: async (p, id, rt) => { seen.push(`${p}:${id}:${rt}`); return { months: books(), refreshToken: "refresh-2" }; },
      run: { "standard-metrics": async () => [] },
    });
    expect(seen).toEqual(["xero:tenant-9:refresh-1"]);
    expect(decrypt((await accountingSecret(db, l!.id))!.secret)).toBe("refresh-2"); // rotated token saved
    expect(results.find((r) => r.id === "xero")).toMatchObject({ status: "ok", claims: 18 });
    expect(results.find((r) => r.id === "standard-metrics")).toMatchObject({ status: "empty" });
    expect(results.find((r) => r.id === "gmail")).toMatchObject({ status: "skipped", detail: "Not connected." });
    const view = await P.companyView(db, companyId, PAT, "2026-07-05");
    expect(view.summary.revenue).toMatchObject({ month: "2026-06", value: 130_000, sourceType: "primary" });
    const may = view.series.revenue!.find((p) => p.month === "2026-05")!;
    expect(may).toMatchObject({ value: 120_000, sourceType: "primary" });
    // Burn from the income statement: 300k - 130k = 170k; runway = 2.0M / avg(190k, 180k, 170k).
    expect(view.burn.at(-1)).toMatchObject({ month: "2026-06", value: 170_000, basis: "income statement" });
    expect(view.summary.runwayMonths).toBeCloseTo(2_000_000 / 180_000, 6);
    expect(view.signals[0]).toMatchObject({ key: "runway", severity: "medium" });
    expect(view.cites[view.summary.cash!.claimId]).toMatchObject({ sourceType: "primary" });
  });

  it("serves the founder portal only what it needs, and stops when the link is revoked", async () => {
    const { root, db, companyId } = await portfolioFirm();
    await P.requestKpis(db, companyId, { period: "2026-05", dueOn: "2026-06-15", recipients: ["maya@kestrelrobotics.example"], metrics: ["cash.balance", "burn.monthly"] }, PAT, APP);
    const link = await P.createPortalLink(db, companyId, PAT, APP);
    const token = link.url.split("/portal/")[1]!;
    const ref = (await portalLinkByToken(root, token))!;
    const view = await P.portalView(scopedDb(root, ref.firmId), ref);
    expect(view).toMatchObject({ company: "Kestrel Robotics", firm: "Northbeam", requests: [{ period: "2026-05", metrics: ["cash.balance", "burn.monthly"] }] });
    expect(Object.keys(view).sort()).toEqual(["accounting", "company", "firm", "metrics", "requests"]);
    expect(await P.portalSubmit(scopedDb(root, ref.firmId), ref, { period: "2026-05", values: { "cash.balance": 2_750_000, "burn.monthly": 185_000 } })).toEqual({ claims: 2, rejected: 0 });
    expect((await currentClaims(db, companyId, "cash.balance"))[0]).toMatchObject({ value: 2_750_000, source_type: "self_reported" });
    expect(await portalLinkByToken(root, "not-a-real-token-at-all-000000")).toBeNull();
    await P.revokePortal(db, companyId, PAT);
    expect(await portalLinkByToken(root, token)).toBeNull();
  });
});

describe("judgment and value", () => {
  it("needs a second person to approve a mark, and uses the mark for value and MOIC", async () => {
    const { db, companyId } = await portfolioFirm();
    await expect(P.proposeMark(db, companyId, { method: "milestone", asOf: "2026-06-30", adjustmentPct: 50, rationale: "short" }, PAT)).rejects.toThrow(/sentence or two/);
    const m = await P.proposeMark(db, companyId, { method: "milestone", asOf: "2026-06-30", adjustmentPct: 50, rationale: "Second DOT contract signed; paid pilots converting ahead of plan." }, PAT);
    expect(m).toMatchObject({ status: "proposed", fair_value_usd: 3e6 }); // cost 2M + 50%
    expect((await P.overview(db, "2026-07-01")).companies[0]).toMatchObject({ fairValue: 2e6, valueBasis: "cost" });
    await expect(P.reviewMark(db, m.id, { approve: true }, PAT)).rejects.toThrow(/other than the preparer/);
    await expect(P.reviewMark(db, m.id, { approve: false }, LEE)).rejects.toThrow(/why/);
    await P.reviewMark(db, m.id, { approve: true }, LEE);
    await expect(P.reviewMark(db, m.id, { approve: true }, LEE)).rejects.toThrow(/already approved/);
    await expect(db.query("update valuations set fair_value_usd = 1 where id = $1", [m.id])).rejects.toThrow();
    const o = await P.overview(db, "2026-07-01");
    expect(o.companies[0]).toMatchObject({ fairValue: 3e6, valueBasis: "mark", moic: 1.5, mark: { method: "Milestone adjustment" } });
    expect(o.metrics).toMatchObject({ invested: 2e6, unrealized: 3e6, tvpi: 1.5, dpi: 0 });
    // A revenue multiple with no cap table: pro rata, with the warning kept on the mark.
    await P.recordKpis(db, companyId, { period: "2026-05", values: { "revenue.arr": 1_200_000, "cash.balance": 2_000_000 } }, PAT);
    const mult = await P.proposeMark(db, companyId, { method: "revenue_multiple", asOf: "2026-06-30", multiple: 6, rationale: "Comparable robotics companies trade near 6x ARR." }, PAT);
    expect(mult.fair_value_usd).toBeCloseTo((1_200_000 * 6 + 2_000_000) * 0.1667, 0);
    expect(mult.warnings.join(" ")).toMatch(/preferences aren't applied/);
    expect((mult.inputs as { cites: string[] }).cites).toHaveLength(2);
  });

  it("records health ratings, reserve plans, follow-ons and money back as decisions", async () => {
    const { db, companyId } = await portfolioFirm();
    await expect(P.rateHealth(db, companyId, { rating: "watch", rationale: "" }, PAT)).rejects.toThrow(/Say why/);
    await P.rateHealth(db, companyId, { rating: "watch", rationale: "Runway tight until the Series A closes." }, PAT);
    await P.planReserve(db, companyId, { amountUsd: 3e6, rationale: "Pro rata in a Series A next year, if pilots convert." }, PAT);
    await expect(P.decideFollowOn(db, companyId, { decision: "invest", roundName: "Series A Preferred", roundDate: "2026-06-30", rationale: "Pilots converted." }, PAT)).rejects.toThrow(/amount/);
    const f = await P.decideFollowOn(db, companyId, { decision: "invest", roundName: "Series A Preferred", roundDate: "2026-06-30", amountUsd: 1_500_000, preMoneyUsd: 40e6, roundSizeUsd: 10e6, rationale: "Pilots converted; taking our full pro rata." }, PAT);
    expect((await listInvestments(db, { companyId })).map((i) => i.round_kind).sort()).toEqual(["follow_on", "initial"]);
    expect(f.investmentId).toBeTruthy();
    await P.decideFollowOn(db, companyId, { decision: "pass", roundName: "Series A extension", roundDate: "2026-09-30", rationale: "Price too high for our conviction; LPs offered an SPV." }, PAT);
    const o = await P.overview(db, "2026-10-01");
    expect(o.companies[0]).toMatchObject({ health: { rating: "watch" }, reservePlanned: 3e6, invested: 3.5e6 });
    expect(o.reserves).toMatchObject({ budget: 20e6, deployed: 1.5e6, committedRemaining: 1.5e6, unallocated: 17e6 });
    await P.recordRealization(db, companyId, { kind: "sale", occurredOn: "2026-09-01", amountUsd: 7e6, note: "Acquired by a strategic buyer." }, PAT);
    const after = await P.overview(db, "2026-10-01");
    expect(after.companies[0]).toMatchObject({ status: "exited", fairValue: 0, realized: 7e6, moic: 2 });
    expect(after.metrics.dpi).toBe(2);
    const v = await P.companyView(db, companyId, PAT, "2026-10-01");
    expect(v.followOns.map((d) => (d.value as { decision: string }).decision)).toEqual(["pass", "invest"]);
  });

  it("requires a conflict note when the board decides a sale or financing (Trados)", async () => {
    const { db, companyId } = await portfolioFirm();
    const sale = { heldOn: "2026-06-12", ourRole: "director", attendees: "Maya Lindqvist, Pat", resolutions: [{ title: "Approve the sale to a strategic buyer", kind: "sale", outcome: "approved" }] };
    await expect(P.addBoardMeeting(db, companyId, sale, PAT)).rejects.toThrow(/preferred and common/);
    const m = await P.addBoardMeeting(db, companyId, { ...sale, conflictReview: "Independent director and common holders approved separately; fairness opinion obtained." }, PAT);
    expect(m).toMatchObject({ attendees: ["Maya Lindqvist", "Pat"], resolutions: [{ kind: "sale", outcome: "approved" }] });
    await P.addBoardMeeting(db, companyId, { heldOn: "2026-03-10", resolutions: [{ title: "2026 budget", kind: "budget", outcome: "approved" }] }, PAT);
  });

  it("measures help by outcome, and queues intros only as drafts", async () => {
    const { db, companyId } = await portfolioFirm();
    const i = await P.addInitiative(db, companyId, { kind: "customer_intro", title: "Intro to a state DOT bridge program", owner: "pat@northbeam.vc" }, PAT);
    await expect(P.setInitiative(db, i.id, { status: "done" }, PAT)).rejects.toThrow(/outcome/);
    await expect(P.queueIntro(db, i.id, { to: "maya@kestrelrobotics.example", subject: "Intro", body: "Meet the bridge program lead." }, PAT)).rejects.toThrow(/Connect Gmail or Outlook/);
    await P.setInitiative(db, i.id, { status: "done", outcome: "Paid pilot signed for four decks.", valueUsd: 240_000 }, PAT);
    const v = await P.companyView(db, companyId, PAT);
    expect(v.initiatives[0]).toMatchObject({ status: "done", value_usd: 240_000 });
  });
});

describe("firm isolation", () => {
  it("keeps every portfolio table, and a firm's portal links, to their firm", async () => {
    const { root, db, companyId } = await portfolioFirm();
    await P.addContact(db, companyId, { name: "Maya", email: "maya@kestrelrobotics.example", reporting: true }, PAT);
    const link = await P.createPortalLink(db, companyId, PAT, APP);
    await P.requestKpis(db, companyId, { period: "2026-05", dueOn: "2026-06-15" }, PAT, APP);
    const ref = (await portalLinkByToken(root, link.url.split("/portal/")[1]!))!;
    await setPortalOAuth(db, ref.id, { state: "s-iso", provider: "quickbooks", verifier: "v" });
    const o = (await takePortalOAuth(root, "s-iso"))!;
    await P.finishAccountingLink(scopedDb(root, o.firmId), o, { code: "c", realmId: "realm-1", redirectUri: "x" }, { exchange: async () => ({ accessToken: "a", refreshToken: "r" }), companyName: async () => "Kestrel" });
    const m = await P.proposeMark(db, companyId, { method: "cost", asOf: "2026-06-30", rationale: "Recent investment, nothing material has changed." }, PAT);
    await P.reviewMark(db, m.id, { approve: true }, LEE);
    await P.recordRealization(db, companyId, { kind: "distribution", occurredOn: "2026-06-30", amountUsd: 10_000 }, PAT);
    await P.addBoardMeeting(db, companyId, { heldOn: "2026-06-12", resolutions: [] }, PAT);
    await P.addInitiative(db, companyId, { kind: "hiring", title: "VP Engineering search" }, PAT);
    const tables = ["company_contacts", "portal_links", "kpi_requests", "accounting_links", "valuations", "realizations", "board_meetings", "initiatives"];
    for (const t of tables) expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBeGreaterThan(0);
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    for (const t of tables) expect((await other.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    await expect(P.companyView(other, companyId, PAT)).rejects.toThrow(/No such/);
    expect((await P.overview(other)).companies).toEqual([]);
    // A portal link only ever opens its own firm.
    expect(ref.firmId).not.toBe((await other.query<{ id: string }>("select current_firm() as id")).rows[0]!.id);
  });
});

export type { Db };
