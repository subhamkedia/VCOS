import "dotenv/config";
import { readFile } from "node:fs/promises";
import { connect, migrate, scopedDb } from "../lib/db.js";
import { replayLlm } from "../lib/replay-llm.js";
import { addMembership, createFirm, subscriptionByToken, upsertUser } from "../ledger/platform.js";
import { recordDecision } from "../ledger/repository.js";
import { ingest } from "../connectors/ingest.js";
import { harmonicToRecord } from "../connectors/harmonic.js";
import { formDToRecord } from "../connectors/edgar.js";
import { htmlToText } from "../connectors/web.js";
import { transcriptFromFile } from "../connectors/transcripts.js";
import { ycToRecord, type YcCompany } from "../connectors/yc.js";
import { extractPortfolio, portfolioRecord } from "../connectors/portfolio-pages.js";
import { enable } from "../modules/connections/index.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { createFeed, runFeed } from "../modules/sourcing/index.js";
import { queue } from "../modules/outbox/index.js";
import { ensureSync, syncMeetings } from "../modules/meetings/index.js";
import { addNote, decide, draftMemoFor, gather, recordRound, setItem, startDeal, updateDealInfo } from "../modules/diligence/index.js";
import {
  advanceIc, castVote, importCapTableCsv, recordWireInstructions, saveCapTable, saveTermSheet, scheduleIc, screenSanctions, setTermStatus,
  startClosing, updateItem, verifyWire,
} from "../modules/execution/index.js";
import { updateDeal } from "../ledger/diligence.js";
import { monthEnd } from "../engines/kpi.js";
import { insertInvestment } from "../ledger/execution.js";
import * as portfolio from "../modules/portfolio/index.js";
import * as lp from "../modules/lp/index.js";
import * as fr from "../modules/fundraising/index.js";
import * as compliance from "../modules/compliance/index.js";
import { parseArgs, run } from "./common.js";

/**
 * pnpm seed:demo --email you@example.com
 *
 * Creates a workspace called "Demo Fund (fictional data)" with you as admin:
 * a thesis, two sourcing feeds, a dozen fictional companies scored against
 * the thesis, one company with full cited sources and a contradiction, and a
 * draft waiting for approval. Every company and person in it is made up.
 */

const co = (slug: string, name: string, oneLiner: string, location: string, founders: string[]): YcCompany => ({
  slug, name, oneLiner, location, founders, formerNames: [], website: `https://${slug}.example`, domain: `${slug}.example`,
  batch: "Winter 2026", industries: [], url: `https://demo.invalid/companies/${slug}`,
});

const DEMO_BATCH: YcCompany[] = [
  co("girderline", "Girderline", "Autonomous drones that inspect bridge steel and file the report for state DOTs", "Pittsburgh, PA, USA", ["Ines Okafor", "Tomasz Wierzba"]),
  co("formwork-ai", "Formwork AI", "Preconstruction estimating software that reads drawings and prices concrete work", "Austin, TX, USA", ["Dana Ruiz"]),
  co("weldloop", "Weldloop", "Machine vision that inspects every weld on a factory line in real time", "Detroit, MI, USA", ["Arjun Mehta", "Clara Holm"]),
  co("hvacsense", "HVACSense", "Predictive maintenance for commercial HVAC fleets in office buildings", "Toronto, ON, Canada", ["Mei Tanaka"]),
  co("rebarbot", "Rebarbot", "Humanoid robot arms that tie rebar on high-rise jobsites", "Berlin, Germany", ["Lukas Brandt", "Sofia Rossi"]),
  co("sitegrid", "SiteGrid", "Field software that turns jobsite photos into daily progress reports", "Denver, CO, USA", ["Omar Haddad"]),
  co("coldchain-iq", "Coldchain IQ", "Industrial IoT sensors for refrigerated warehouses", "Rotterdam, Netherlands", ["Eva de Wit"]),
  co("petpal", "PetPal", "A social network for dog owners", "Lagos, Nigeria", ["Tunde Bello"]),
  co("ledgerly", "Ledgerly", "Bookkeeping for freelancers", "Singapore", ["Wei Lin"]),
  co("stackmind", "Stackmind", "An AI coding assistant for data teams", "San Francisco, CA, USA", ["Priya Nair"]),
];

run(async () => {
  const { str } = parseArgs();
  const email = str("email");
  if (!email) throw new Error("Usage: pnpm seed:demo --email you@example.com");
  const root = await connect();
  await migrate(root);

  const firm = await createFirm(root, { name: "Demo Fund (fictional data)", createdBy: "seed-demo" });
  const user = await upsertUser(root, { email });
  await addMembership(root, firm.id, user.id, "admin");
  const db = scopedDb(root, firm.id);
  const by = `human:${user.email}`;

  const base = await starterProfile("Demo Fund");
  await saveProfile(db, base, by);
  await saveProfile(db, {
    ...base,
    firm: {
      ...base.firm, legalName: "Demo Fund Management LLC", type: "micro_vc", website: "demofund.example", hq: "Pittsburgh, PA",
      emailDomains: [email.split("@")[1]!.toLowerCase()],
      offices: ["Austin, TX"], foundedYear: 2021, aumUsd: 85_000_000, fundsRaised: 2, teamSize: 9, investmentTeamSize: 5,
      description: "A fictional seed fund backing physical AI for the built world.",
    },
    fund: {
      ...base.fund, name: "Demo Fund", number: "II", legalForm: "Delaware LP", domicile: "Delaware, US", currency: "USD", vintage: 2026,
      targetSizeUsd: 60_000_000, hardCapUsd: 75_000_000, committedUsd: 42_000_000, firstCloseDate: "2026-03-31", finalCloseDate: "2027-03-31",
      gpCommitmentPct: 2, investmentPeriodYears: 4, termYears: 10, extensionYears: 2, managementFeePct: 2, feeStepDownPct: 1.5,
      feeBasisAfterPeriod: "invested", fundExpensesPct: 1, recyclingPct: 10, carryPct: 20, hurdlePct: 8, waterfall: "european",
      reservesPct: 45, targetInvestments: 25, avgInitialCheckUsd: 1_000_000, maxConcentrationPct: 10, followOnStrategy: "super_pro_rata",
      lpTypes: ["Institutional (pensions, endowments)", "Family offices", "High-net-worth individuals"], icMembers: 3, icApproval: "majority",
    },
    mandate: {
      ...base.mandate, followOnCheckUsd: { min: 500_000, max: 4_000_000 }, targetOwnershipPct: { min: 8, max: 15 }, leadPreference: "lead",
      boardSeat: "preferred", businessModels: ["Hardware plus software", "B2B software"], customerTypes: ["Enterprise", "Government and public sector"],
      traction: "pre_revenue", maxCompanyAgeYears: 5, impact: "esg_screened",
      thesis: "Software and robotics that make building, making and maintaining physical things faster and safer.",
    },
  }, by);

  await enable(db, "yc", by);
  await enable(db, "sec-edgar", by);
  const ycFeed = await createFeed(db, { connectorId: "yc", name: "YC W26 (demo data)", params: { batches: ["W26"] }, cadence: "weekly" }, by);
  await createFeed(db, { connectorId: "sec-edgar", name: "Form D: construction and robotics", params: { keywords: ["robotics", "construction software"], lookbackDays: 14 }, cadence: "daily" }, by)
    .catch(() => console.log("Skipped the Form D feed: set SEC_USER_AGENT to enable it."));
  const r = await runFeed(db, ycFeed, "seed-demo", { discover: async () => DEMO_BATCH.map((c) => ycToRecord(c, new Date().toISOString())) });
  console.log(`Feed run: ${r.stats.records} companies, ${r.stats.strongFits} strong fits`);

  // A portfolio website (the fictional accelerator page from the tests).
  await enable(db, "websites", by);
  const site = { orgName: "Foundry Works (demo)", orgType: "accelerator" as const, url: "https://www.foundryworks.example/portfolio" };
  const siteFeed = await createFeed(db, { connectorId: "websites", name: "Foundry Works portfolio (demo data)", params: site, cadence: "weekly" }, by);
  const page = extractPortfolio(await readFile("tests/fixtures/portfolio-page.html", "utf8"), site.url);
  await runFeed(db, siteFeed, "seed-demo", { discover: async () => page.map((c) => portfolioRecord(site, c)) });

  // One company with every kind of source, as in `pnpm demo`.
  const fx = (f: string) => readFile(`tests/fixtures/${f}`, "utf8");
  const llm = replayLlm({
    "We closed September": [
      ["CLAIM | revenue.arr | 4100000 | 2026-09-30 | self_reported | ", "We closed September at $4.1M ARR."],
      ["CLAIM | team.headcount | 34 |  | self_reported | ", "We're 34 people now."],
    ],
    "Kestrel Robotics today announced": [
      ["CLAIM | funding.round.amount | 9000000 | 2026-06-10 | third_party | ", "Kestrel Robotics today announced a $9 million Series A led by Ironbridge Ventures."],
      ["CLAIM | funding.round.stage | series_a | 2026-06-10 | third_party | ", "Kestrel Robotics today announced a $9 million Series A led by Ironbridge Ventures."],
      ["CLAIM | team.headcount | 18 | 2026-06-10 | third_party | ", "The company employs 18 people."],
    ],
  });
  await ingest(db, harmonicToRecord(JSON.parse(await fx("harmonic-company.json")), "2026-09-20T00:00:00Z"));
  await ingest(db, formDToRecord(await fx("formd.xml"), { cik: "0001999001", adsh: "0001999001-26-000002", fileDate: "2026-06-15" }));
  const { title, text } = htmlToText(await fx("press.html"));
  await ingest(db, { evidence: { kind: "web_page", source: "web", uri: "https://buildweekly.example/kestrel", title: title ?? "press", content: text, accessScope: "public", occurredAt: "2026-06-10" }, subject: { type: "company", name: "Kestrel Robotics", source: "web" }, extract: true }, { llm });
  const call = await ingest(db, await transcriptFromFile("tests/fixtures/call.vtt", { company: "Kestrel", companyDomain: "kestrelrobotics.com", date: "2026-10-02" }), { llm });
  const kestrel = call.subject!.entity.id;
  const pet = (await ingest(db, ycToRecord(DEMO_BATCH[7]!))).subject!.entity.id;
  await recordDecision(db, { entityId: pet, kind: "pass", actor: by, reasonCode: "thesis_fit", rationale: "Consumer social, outside the mandate." });

  await queue(db, "gmail_draft", {
    to: ["maya@kestrelrobotics.example"],
    subject: "Following up on our call",
    body: "Hi Maya,\n\nThanks for the time on Thursday. Could you share the September board deck and the headcount plan? Harmonic shows 21 people as of September 20; you mentioned 34, and we'd like to reconcile the two before our partner meeting.\n\nBest,\nDemo Fund",
  }, { summary: "Follow-up to Kestrel Robotics after the founder call", proposedBy: "agent:diligence@0.1", entityId: kestrel });

  // Meetings: a calendar invite and its Zoom recording (joined through the link), one for a person to place, one internal.
  const calSync = (await ensureSync(db, "google-calendar", by))!;
  const zoomSync = (await ensureSync(db, "zoom", by))!;
  const at = (d: string) => `2026-${d}:00.000Z`;
  await syncMeetings(db, calSync, "seed-demo", {
    now: new Date("2026-10-20T00:00:00Z"),
    list: async () => [
      { source: "google-calendar", externalId: "demo-ev-1", title: "Demo Fund <> Kestrel Robotics", startedAt: at("10-02T17:00"), joinKey: "zoom:81234567890",
        attendees: [{ email, self: true }, { email: "maya@kestrelrobotics.com", name: "Maya Lindqvist" }, { email: "raj@kestrelrobotics.com", name: "Raj Patel" }] },
      { source: "google-calendar", externalId: "demo-ev-2", title: "Intro: Brightforge (via Foundry Works)", startedAt: at("10-14T15:00"),
        attendees: [{ email, self: true }, { email: "ceo@brightforge.example", name: "Ana Brightwell" }] },
      { source: "google-calendar", externalId: "demo-ev-3", title: "Monday partner meeting", startedAt: at("10-19T14:00"),
        attendees: [{ email, self: true }, { email: `partner@${email.split("@")[1]}`, name: "Lee" }] },
    ],
  });
  await syncMeetings(db, zoomSync, "seed-demo", {
    now: new Date("2026-10-20T00:00:00Z"),
    list: async () => [{
      source: "zoom", externalId: "demo-zoom-1", title: "Zoom meeting", startedAt: at("10-02T17:01"), joinKey: "zoom:81234567890",
      attendees: [{ name: "Maya Lindqvist" }, { name: "Raj Patel" }],
      transcript: "Maya Lindqvist: We have two paid pilots with state DOTs and a third starting in November.\nRaj Patel: Each robot ties about 1,200 intersections an hour on a flat deck.",
    }],
  });

  // Diligence on Kestrel: research from sources with no keys (demo data), the round, calls, a memo.
  const deal = await startDeal(db, { companyId: kestrel }, by);
  const demoSite = { name: "Kestrel Robotics", domain: "kestrelrobotics.com" };
  await (await gather(db, deal.id, by, {
    only: ["company-site", "uspto", "sbir", "harmonic", "pitchbook"],
    run: {
      "company-site": async () => [{
        evidence: { kind: "web_page", source: "company-site", uri: "https://kestrelrobotics.com/ (demo)", title: "Kestrel Robotics (demo page)", accessScope: "public",
          content: "Site description: Autonomous rebar-tying robots for bridge decks.\n\nKestrel builds robots that tie rebar on bridge decks. We're hiring field engineers in Pittsburgh." },
        subject: { type: "company", ...demoSite, source: "company-site" }, sourceType: "self_reported",
        claims: [{ predicate: "company.description", value: "Autonomous rebar-tying robots for bridge decks.", citedText: "Autonomous rebar-tying robots for bridge decks." }],
      }],
      uspto: async () => [{
        evidence: { kind: "api_record", source: "uspto", uri: "patentsview:assignee:Kestrel Robotics (demo)", title: "USPTO patents (demo data)", accessScope: "public",
          content: "Granted US patents assigned to Kestrel Robotics (demo data):\nUS 11999001: Rebar tying end effector (granted 2025-06-03)" },
        sourceType: "primary", claims: [{ predicate: "ip.patent", value: "US 11999001: Rebar tying end effector", asOf: "2025-06-03", citedText: "US 11999001: Rebar tying end effector" }],
      }],
      sbir: async () => [{
        evidence: { kind: "api_record", source: "sbir", uri: "sbir:firm:Kestrel Robotics (demo)", title: "SBIR awards (demo data)", accessScope: "public",
          content: "SBIR and STTR awards to Kestrel Robotics (demo data):\nDepartment of Transportation SBIR Phase I: Autonomous rebar placement, $199,500, 2025" },
        sourceType: "primary", claims: [{ predicate: "grant.award", value: "Department of Transportation SBIR Phase I: Autonomous rebar placement, $199,500, 2025", asOf: "2025-12", citedText: "Department of Transportation SBIR Phase I: Autonomous rebar placement, $199,500, 2025" }],
      }],
    },
  })).done;
  await recordRound(db, deal.id, { raiseUsd: 12_000_000, preMoneyUsd: 48_000_000, stage: "series_a", leadInvestor: "Ironbridge Ventures", source: "founder", date: "2026-10-02" }, by);
  await updateDealInfo(db, deal.id, { ourCheckUsd: 1_500_000 }, by);
  await addNote(db, deal.id, { kind: "reference", title: "Reference: Maya's former manager (demo)", with: "VP Engineering, a robotics company", date: "2026-10-08", text: "Worked with Maya for four years. Ships hardware on time, hires strong field engineers, can be optimistic on pilot timelines." }, by);
  await addNote(db, deal.id, { kind: "customer_call", title: "Customer call: state DOT pilot lead (demo)", with: "Bridge program manager", date: "2026-10-10", text: "Pilot is paid, two decks so far. They want crew-hour savings proven over a full season before a production contract." }, by);
  await setItem(db, deal.id, "legal.corporate", { status: "done" }, by);
  await draftMemoFor(db, deal.id, {}, by);

  // Investment Execution. A second partner (fictional) so IC votes and wire approvals have two people.
  const lee = await upsertUser(root, { email: `lee.partner@${email.split("@")[1]}`, name: "Lee Park (demo)" });
  await addMembership(root, firm.id, lee.id, "partner");
  const LEE = `human:${lee.email}`;
  // An analyst (fictional), to see the app as the deal team sees it: no approvals, no decisions.
  const ana = await upsertUser(root, { email: `ana.analyst@${email.split("@")[1]}`, name: "Ana Ruiz (demo)" });
  await addMembership(root, firm.id, ana.id, "analyst");
  const priced = (over: object) => ({
    security: "preferred", seriesName: "Series A Preferred", preMoneyUsd: 48_000_000, raiseUsd: 12_000_000, ourAllocationUsd: 1_500_000, leadInvestor: "Ironbridge Ventures",
    poolTopUpPostPct: 10, noShopDays: 30, board: { size: 5, investorSeats: 2, commonSeats: 2, independentSeats: 1, ours: "observer" }, ...over,
  });
  const capCsv = "Stakeholder,Share Class,Shares\nMaya Lindqvist,Common,4000000\nRaj Patel,Common,3000000\nSeed investors,Series Seed Preferred,1500000\nEmployees,Options outstanding,500000\nAvailable pool,Unissued pool,1000000\nTotal,,10000000\n";
  // Kestrel goes to IC: two term sheet versions, the cap table with a SAFE, and Lee's independent vote in; yours is waiting.
  await decide(db, deal.id, { kind: "advance", rationale: "Two paid DOT pilots and a strong field team; the round is competitive." }, by);
  await saveTermSheet(db, deal.id, { terms: priced({ liquidation: { multiple: 1, participation: "full", seniority: "senior" }, noShopDays: 60 }), status: "proposed", note: "Lead's first draft" }, by);
  await saveTermSheet(db, deal.id, { terms: priced({ oispRepresentation: true, managementRightsLetter: true }), status: "negotiating", note: "Company's markup: non-participating, pari passu, 30-day no-shop" }, by);
  await importCapTableCsv(db, deal.id, { name: "kestrel-cap-table.csv", text: capCsv }, by, {
    safes: [{ holder: "Angel SAFE holders", amount: 1_000_000, kind: "post", cap: 20_000_000 }],
    seriesTerms: [{ name: "Series Seed Preferred", issuePrice: 1.2, multiple: 1, participating: false, seniority: 2 }],
  });
  const kic = await scheduleIc(db, deal.id, { members: [user.email, lee.email!], chair: user.email }, by);
  await castVote(db, kic.id, { vote: "yes", conviction: 4, note: "Pilot data is strong; deck-count ramp is the risk." }, LEE);

  // Girderline is approved and closing: a signed seed round, most documents in, the wire confirmed by phone and waiting for two approvals.
  const g = await startDeal(db, { company: { name: "Girderline", domain: "girderline.example" } }, by);
  await decide(db, g.id, { kind: "advance", rationale: "Inspection data moat with three state DOTs." }, by);
  const gts = await saveTermSheet(db, g.id, { terms: priced({ seriesName: "Seed Preferred", preMoneyUsd: 14_000_000, raiseUsd: 4_000_000, ourAllocationUsd: 1_000_000, leadInvestor: "Demo Fund", board: { size: 3, investorSeats: 1, commonSeats: 2, ours: "seat" }, managementRightsLetter: true }), status: "negotiating" }, by);
  await saveCapTable(db, g.id, { holdings: [
    { holder: "Ines Okafor", className: "Common", shares: 5_000_000, kind: "common" }, { holder: "Tomasz Wierzba", className: "Common", shares: 3_500_000, kind: "common" },
    { holder: "Option pool", className: "Unissued pool", shares: 1_500_000, kind: "pool" },
  ], safes: [{ holder: "Pre-seed SAFE", amount: 750_000, kind: "post", cap: 10_000_000 }] }, by);
  const gic = await scheduleIc(db, g.id, { members: [user.email, lee.email!], chair: user.email }, by);
  await castVote(db, gic.id, { vote: "yes", conviction: 5, note: "Best inspection data set we've seen." }, by);
  await castVote(db, gic.id, { vote: "yes", conviction: 3, note: "Sales cycle with DOTs is long." }, LEE);
  await advanceIc(db, gic.id, {}, by);
  await advanceIc(db, gic.id, {}, by);
  await castVote(db, gic.id, { vote: "yes", conviction: 5 }, by);
  await castVote(db, gic.id, { vote: "yes", conviction: 4 }, LEE);
  await advanceIc(db, gic.id, { notes: "Approved; Lee to join the board call with the DOT program lead." }, by);
  await setTermStatus(db, g.id, gts.version, "signed", by);
  await startClosing(db, g.id, by);
  await screenSanctions(db, g.id, by, { lists: async () => ({ entries: [], fetchedAt: new Date().toISOString() }) }).catch(() => undefined);
  for (const key of ["counsel_engaged", "confirmatory_diligence", "spa", "charter", "ira", "voting_agreement", "rofr_cosale", "board_consent", "stockholder_consent", "kyc", "conflicts", "management_rights_letter"]) {
    await updateItem(db, g.id, key, { status: ["spa", "charter", "ira", "voting_agreement", "rofr_cosale", "board_consent", "stockholder_consent", "management_rights_letter"].includes(key) ? "signed" : "done" }, by).catch(() => undefined);
  }
  await updateItem(db, g.id, "charter_filed", { status: "requested", owner: LEE, dueDate: "2026-10-20", note: "Company counsel filing with Delaware" }, by);
  const wire = await recordWireInstructions(db, g.id, { amountUsd: 1_000_000, beneficiary: "Girderline, Inc.", bankName: "First Demo Bank", accountLast4: "4821" }, LEE);
  await verifyWire(db, wire.id, { numberSource: "Ines's mobile, saved from our first meeting in March", confirmed: true }, LEE);

  // Portfolio (all fictional): earlier investments from this fund's first year, with a year of numbers.
  const closed = async (name: string, domain: string, inv: { date: string; amount: number; shares: number; ownership: number; series: string; board: string }) => {
    const d = await startDeal(db, { company: { name, domain } }, by);
    await updateDeal(db, d.id, { stage: "closed" }, by);
    const companyId = (await db.query<{ company_id: string }>("select company_id from deals where id = $1", [d.id])).rows[0]!.company_id;
    await insertInvestment(db, {
      dealId: d.id, companyId, fundName: "Demo Fund II", security: "preferred", seriesName: inv.series, closeDate: inv.date, amountUsd: inv.amount,
      shares: inv.shares, pricePerShare: inv.amount / inv.shares, ownershipFdPct: inv.ownership, boardRole: inv.board, rights: {},
    }, by);
    return companyId;
  };
  const lastMonths = (n: number) => {
    const out: string[] = [];
    const d = new Date();
    for (let i = n; i >= 1; i--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    return out;
  };
  const year = lastMonths(12);
  // Weldloop: growing, twenty months of runway, a spreadsheet of monthly KPIs with the plan.
  const weld = await closed("Weldloop", "weldloop.example", { date: "2025-04-15", amount: 1_200_000, shares: 1_500_000, ownership: 12, series: "Seed Preferred", board: "seat" });
  const rows = year.map((m, i) => {
    const revenue = Math.round(60_000 * Math.pow(1.07, i));
    return `${m},${revenue},${260_000 + i * 4_000},${4_900_000 - i * 150_000},${revenue * 12},${22 + i},${Math.round(65_000 * Math.pow(1.065, i))},${250_000 + i * 3_000},${14 + i * 3}`;
  });
  await portfolio.importKpiCsv(db, weld, { name: "weldloop-kpis.csv", text: `Month,Revenue,Expenses,Cash,ARR,Headcount,Plan revenue,Plan burn,Units deployed\n${rows.join("\n")}\n` }, by).catch(() => undefined);
  await portfolio.addContact(db, weld, { name: "Arjun Mehta", email: "arjun@weldloop.example", role: "CEO", reporting: true }, by);
  await portfolio.rateHealth(db, weld, { rating: "on_track", rationale: "Growing 7% a month with 20 months of runway; hitting plan." }, by);
  await portfolio.planReserve(db, weld, { amountUsd: 2_500_000, rationale: "Pro rata plus in a Series A in about a year, if two more auto plants convert." }, by);
  const wm = await portfolio.proposeMark(db, weld, { method: "revenue_multiple", asOf: monthEnd(year[year.length - 1]!), multiple: 6, discountPct: 20, rationale: "Comparable industrial vision companies near 6x ARR; 20% off for stage and liquidity." }, LEE).catch(() => null);
  if (wm) await portfolio.reviewMark(db, wm.id, { approve: true }, by).catch(() => undefined);
  await portfolio.addBoardMeeting(db, weld, { heldOn: `${year[year.length - 2]}-20`, ourRole: "director", attendees: "Arjun Mehta, Clara Holm, Lee Park", resolutions: [{ title: "Approve the 2026 operating plan", kind: "budget", outcome: "approved" }, { title: "Option grants for three field engineers", kind: "option_grants", outcome: "approved" }], notes: "Pipeline strong in Tier 1 auto suppliers; hiring a VP Sales is the top priority." }, by);
  const hire = await portfolio.addInitiative(db, weld, { kind: "hiring", title: "VP Sales search", owner: "lee.partner", detail: "Three candidates from our network in industrial automation." }, by);
  await portfolio.setInitiative(db, hire.id, { status: "in_progress" }, by);
  const intro = await portfolio.addInitiative(db, weld, { kind: "customer_intro", title: "Intro to a Tier 1 auto supplier's quality lead" }, by);
  await portfolio.setInitiative(db, intro.id, { status: "done", outcome: "Paid pilot on two weld lines signed.", valueUsd: 180_000 }, by);

  // Formwork AI: missing plan and short on cash.
  const form = await closed("Formwork AI", "formwork-ai.example", { date: "2025-07-01", amount: 1_000_000, shares: 1_250_000, ownership: 10, series: "Seed Preferred", board: "observer" });
  for (const [i, m] of year.slice(-4).entries()) {
    await portfolio.recordKpis(db, form, { period: m, values: { "revenue.monthly": 40_000 + i * 1_000, "burn.monthly": 210_000 + i * 5_000, "cash.balance": 1_400_000 - i * 215_000, "plan.revenue.monthly": 60_000 + i * 5_000, "plan.burn.monthly": 180_000, "team.headcount": 18 - (i > 2 ? 3 : 0) } }, by).catch(() => undefined);
  }
  await portfolio.addContact(db, form, { name: "Dana Ruiz", email: "dana@formwork-ai.example", role: "CEO", reporting: true }, by);
  const fm = await portfolio.proposeMark(db, form, { method: "milestone", asOf: monthEnd(year[year.length - 1]!), adjustmentPct: -40, rationale: "Revenue a third behind plan and under six months of cash; bridge terms not yet agreed." }, LEE).catch(() => null);
  void fm; // left for the partner to review
  await portfolio.addInitiative(db, form, { kind: "fundraising", title: "Bridge round: line up insiders and two new leads", owner: "lee.partner" }, by);

  // SiteGrid: sold. Coldchain IQ: written off.
  const siteGrid = await closed("SiteGrid", "sitegrid.example", { date: "2024-02-01", amount: 750_000, shares: 1_000_000, ownership: 9, series: "Seed Preferred", board: "none" });
  // SiteGrid's sale ran as an exit process: the fund consented, and the closing left escrows, an earnout and some of the buyer's shares.
  const sgSale = `${year[year.length - 3]}-15`;
  const sgExit = await portfolio.startExit(db, siteGrid, { kind: "acquisition", counterparty: "Buildstack", equityValueUsd: 40_000_000, ourExpectedUsd: 3_500_000 }, LEE);
  await portfolio.addBid(db, sgExit.id, { bidder: "Buildstack", kind: "loi", valueUsd: 40_000_000, consideration: "83% cash, 17% Buildstack stock; 10% escrow for 15 months; earnout on 2026 ARR", receivedOn: `${year[year.length - 5]}-02` }, LEE);
  await portfolio.consentToExit(db, sgExit.id, { choice: "approve", rationale: "4.7x our cost in under three years, above our mark; the banker's process drew two bids and this was the higher." }, by);
  await portfolio.closeExit(db, sgExit.id, {
    closedOn: sgSale, totalUsd: 3_500_000, stockUsd: 600_000, stockTicker: "BSTK", stockShares: 30_000, stockExchange: "Nasdaq", stockSharesOutstanding: 120_000_000, stockLockupDays: 90,
    escrowPct: 10, escrowMonths: 15, adjustmentEscrowPct: 1, adjustmentMonths: 2,
    earnouts: [{ description: "SiteGrid ARR above $12M in 2026", maxUsd: 1_000_000, probabilityPct: 30, dueOn: `${Number(year[year.length - 1]!.slice(0, 4)) + 1}-03-31` }],
  }, by);
  const sgAdj = (await portfolio.companyExits(db, siteGrid)).receivables.find((r) => r.kind === "adjustment_escrow");
  if (sgAdj) await portfolio.settleReceivable(db, sgAdj.id, { amountUsd: sgAdj.amount_usd, on: `${year[year.length - 1]}-10` }, LEE);
  const bstk: { date: string; close: number; volume: number }[] = [];
  for (let i = 30; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    bstk.push({ date: d.toISOString().slice(0, 10), close: Math.round((20 + (30 - i) * 0.12 + Math.sin(i) * 0.4) * 100) / 100, volume: 800_000 + i * 5_000 });
  }
  await portfolio.recordPrices(db, "BSTK", { prices: bstk }, LEE);
  // Weldloop: an exit plan. Formwork AI: an acqui-hire offer waiting for the fund's decision.
  await portfolio.saveExitPlanFor(db, weld, { path: "acquisition", targetYear: Number(year[0]!.slice(0, 4)) + 3, lowUsd: 6_000_000, baseUsd: 14_000_000, highUsd: 30_000_000, probabilityPct: 35, buyers: "Lincoln Electric-style incumbents, Cognex-style vision companies", readiness: { cap_table: true, ip: true, valuation_409a: true } }, LEE);
  await portfolio.reviewQsbs(db, weld, (await portfolio.companyExits(db, weld)).qsbs[0]!.investmentId, { checks: { c_corp: true, original_issue: true, gross_assets: true, active_business: true, no_redemptions: true, company_rep: true } }, LEE);
  const fwExit = await portfolio.startExit(db, form, { kind: "acquisition", counterparty: "Trussworks", ourExpectedUsd: 450_000, note: "Acqui-hire for the vision team; the alternative is a bridge the insiders are lukewarm on." }, LEE);
  await portfolio.addBid(db, fwExit.id, { bidder: "Trussworks", kind: "ioi", valueUsd: 5_000_000, consideration: "Cash, with retention for the team" }, LEE);
  const cold = await closed("Coldchain IQ", "coldchain-iq.example", { date: "2024-05-15", amount: 500_000, shares: 800_000, ownership: 7, series: "Pre-seed SAFE", board: "none" });
  await portfolio.recordRealization(db, cold, { kind: "write_off", occurredOn: `${year[year.length - 6]}-15`, note: "Wound down after the pilot customer went bankrupt." }, by);
  const portal = await portfolio.createPortalLink(db, weld, by, process.env.APP_URL ?? "http://localhost:8787");

  // LP Reporting (all fictional): the fund, its investors, two years of calls, receipts from a bank statement,
  // expenses, a distribution from the SiteGrid sale, an approved report, and work left for you to approve.
  const fund = await lp.createFund(db, { name: "Demo Fund II", inception: "2024-01-15", vintage: 2024, investmentPeriodYears: 4 }, LEE);
  const lps: [string, string, number, string][] = [
    ["Allegheny Teachers' Pension Plan", "pension", 15_000_000, "privatemarkets@alleghenytpp.example"],
    ["Three Rivers Foundation", "endowment_foundation", 8_000_000, "investments@threerivers.example"],
    ["Riverside Fund of Funds III", "fund_of_funds", 7_000_000, "ops@riversidefof.example"],
    ["Halvorsen Family Office", "family_office", 6_000_000, "cio@halvorsen.example"],
    ["Keystone Insurance Mutual", "insurance", 5_000_000, "alts@keystonemutual.example"],
    ["Dr. Maya Chen", "individual", 160_000, "maya.chen@mail.example"],
    ["Demo Fund II GP, LLC", "gp", 840_000, ""],
  ];
  for (const [name, kind, commitmentUsd, emails] of lps) await lp.addPartner(db, fund.id, { name, kind, commitmentUsd, emails, kycVerifiedOn: "2024-01-10", taxStatus: kind === "pension" || kind === "endowment_foundation" ? "tax_exempt" : "taxable" }, by);
  const c1 = (await lp.draftCall(db, fund.id, { noticeDate: "2024-01-19", dueDate: "2024-02-09", investmentsUsd: 1_250_000, expensesUsd: 150_000, fee: { from: "2024-01-15", to: "2024-12-31" }, purpose: "SiteGrid and Coldchain IQ; organizational costs" }, by)).call;
  await lp.approveCall(db, c1.id, LEE);
  const c2 = (await lp.draftCall(db, fund.id, { noticeDate: "2025-03-17", dueDate: "2025-04-07", investmentsUsd: 2_200_000, expensesUsd: 60_000, fee: { from: "2025-01-01", to: "2025-12-31" }, purpose: "Weldloop and Formwork AI seed rounds" }, by)).call;
  await lp.approveCall(db, c2.id, LEE);
  const view = await lp.fundView(db, fund.id);
  const statement = ["Date,Description,Credit,Debit,Reference"];
  for (const c of view.calls.filter((x) => x.status === "approved")) {
    for (const i of c.items) {
      if (c.number === 2 && i.partner_name === "Halvorsen Family Office") continue; // still outstanding
      statement.push(`${c.due_date},WIRE IN ${i.partner_name!.toUpperCase().replace(/,/g, "")},${i.amount_usd},,FED-${c.number}-${i.id.slice(0, 8)}`);
    }
  }
  statement.push("2025-04-09,WIRE IN HALVORSEN FO,50000.00,,FED-PARTIAL-1"); // a partial payment for a person to match
  await lp.importBankCsv(db, fund.id, { name: "demo-bank-statement.csv", text: statement.join("\n") }, by);
  const expense = (incurredOn: string, amountUsd: number, category: string, description: string, extra: Record<string, unknown> = {}) => lp.addExpense(db, fund.id, { incurredOn, amountUsd, category, description, ...extra }, by);
  await expense("2024-02-01", 118_000, "organizational", "Fund formation: LPA, subscription documents, filings");
  await expense("2024-12-15", 42_000, "audit_tax", "2024 audit and tax returns");
  await expense("2025-03-31", 9_500, "fund_admin", "Fund administrator, Q1 2025");
  await expense("2025-06-30", 9_500, "fund_admin", "Fund administrator, Q2 2025");
  await expense("2025-12-15", 44_000, "audit_tax", "2025 audit and tax returns");
  await expense("2025-11-01", 14_000, "insurance", "Fund D&O and E&O insurance");
  await expense("2026-01-20", 6_000, "other", "GP staff time preparing the annual meeting", { relatedParty: true });
  await expense("2026-02-10", 12_000, "other", "Board fees from Weldloop to the GP", { feeOffset: true });
  const saleMonth = year[year.length - 3]!;
  const dist = await lp.draftDistribution(db, fund.id, { paidOn: `${saleMonth}-25`, grossUsd: 2_400_000, companyId: siteGrid, purpose: "Proceeds from the sale of SiteGrid" }, by);
  await lp.approveDistribution(db, dist.distribution.id, LEE);
  await lp.markDistributionPaid(db, dist.distribution.id, LEE);
  const lpIds = (await lp.fundView(db, fund.id)).investors.filter((i) => i.kind !== "gp");
  for (const p of lpIds.slice(0, 4)) await lp.setTaxDoc(db, fund.id, { partnerId: p.id, taxYear: 2025, kind: "k1", status: "delivered", deliveredOn: "2026-03-12" }, by);
  const q1 = await lp.prepareReport(db, fund.id, { period: "2026-Q1", commentary: "Weldloop signed paid pilots with two Tier 1 auto suppliers. Formwork AI is behind plan, and we are working with its founders on a bridge." }, LEE);
  await lp.approveReport(db, q1.id, by);
  // Waiting for you: a call and the Q2 report, both prepared by Lee.
  await lp.draftCall(db, fund.id, { noticeDate: "2026-10-01", dueDate: "2026-10-16", investmentsUsd: 1_000_000, fee: { from: "2026-01-01", to: "2026-06-30" }, purpose: "Girderline seed round; first-half 2026 management fee" }, LEE);
  await lp.prepareReport(db, fund.id, { period: "2026-Q2" }, LEE);
  const investorLink = await lp.createLpPortalLink(db, lpIds[0]!.id, by, process.env.APP_URL ?? "http://localhost:8787");

  // Fundraising & IR (all fictional): Fund III in market, with a pipeline, a reviewed data room, DDQ answers,
  // subscriptions at each step, and a first closing prepared by Lee for you to approve. The LPAC sits on Fund II.
  const APP = process.env.APP_URL ?? "http://localhost:8787";
  const raise = await fr.createRaise(db, { name: "Demo Fund III", targetUsd: 75_000_000, hardCapUsd: 90_000_000, minCommitmentUsd: 250_000, finalCloseDeadline: "2027-12-31" }, by);
  const prospect = async (name: string, kind: string, o: Record<string, unknown>) => fr.addProspect(db, raise.id, { name, kind, ...o }, LEE);
  const allegheny = await prospect("Allegheny Teachers' Pension Plan", "pension", { contactName: "Dana Okafor", emails: "privatemarkets@alleghenytpp.example", askUsd: 15_000_000, source: "Existing LP", owner: "partner" });
  const threeRivers = await prospect("Three Rivers Foundation", "endowment_foundation", { contactName: "Sam Lee", emails: "investments@threerivers.example", askUsd: 8_000_000, source: "Existing LP" });
  const cascade = await prospect("Cascade State Retirement System", "pension", { contactName: "Priya Raman", emails: "pe@cascaderetire.example", askUsd: 20_000_000, source: "Placement intro", nextStep: "Send track record and references", nextStepOn: "2026-09-20" });
  const ironbridge = await prospect("Ironbridge Family Office", "family_office", { contactName: "Marta Kovacs", emails: "cio@ironbridgefo.example", askUsd: 5_000_000, source: "Weldloop's CEO" });
  const meridian = await prospect("Meridian Fund of Funds IV", "fund_of_funds", { contactName: "Tom Arnold", emails: "ops@meridianfof.example", askUsd: 10_000_000, nextStep: "Onsite with their IC", nextStepOn: "2026-10-14" });
  const keystone = await prospect("Keystone Insurance Mutual", "insurance", { emails: "alts@keystonemutual.example", askUsd: 5_000_000, source: "Existing LP" });
  await prospect("Lakeshore University Endowment", "endowment_foundation", { askUsd: 10_000_000, nextStep: "First call", nextStepOn: "2026-10-07" });
  await prospect("Northgate Industrial Corp.", "corporate", { askUsd: 5_000_000, source: "Portfolio customer" });
  const halvorsen = await prospect("Halvorsen Family Office", "family_office", { askUsd: 4_000_000, source: "Existing LP" });
  await fr.editProspect(db, allegheny.id, { stage: "committed", committedUsd: 15_000_000 }, LEE);
  await fr.editProspect(db, threeRivers.id, { stage: "committed", committedUsd: 8_000_000 }, LEE);
  await fr.editProspect(db, keystone.id, { stage: "soft_circle", softCircleUsd: 5_000_000 }, LEE);
  await fr.editProspect(db, cascade.id, { stage: "diligence" }, LEE);
  await fr.editProspect(db, meridian.id, { stage: "meeting" }, LEE);
  await fr.editProspect(db, ironbridge.id, { stage: "contacted" }, LEE);
  await fr.editProspect(db, halvorsen.id, { stage: "declined", declineReason: "Paused new venture commitments until 2027" }, LEE);
  await fr.logActivity(db, cascade.id, { kind: "meeting", summary: "Two hours with their private markets team; asked for loss ratios by vintage and the reserves policy." }, LEE);
  await fr.logActivity(db, meridian.id, { kind: "call", summary: "Intro call. Fund IV is 60% deployed and wants emerging managers in industrial tech." }, LEE);
  // A tiny, valid PDF for the demo documents.
  const pdf = (title: string) => {
    const text = `BT /F1 18 Tf 72 720 Td (${title.replace(/[()\\]/g, "")}) Tj 0 -28 Td /F1 11 Tf (Fictional demo document.) Tj ET`;
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  };
  const upload = async (title: string, category: string) => {
    const d = await fr.uploadDoc(db, raise.id, { name: `${title}.pdf`, bytes: pdf(title) }, { title, category }, LEE);
    // Marketing material is approved with the Marketing Rule checklist confirmed, so the review is on record.
    await fr.approveDoc(db, d.id, by, Object.fromEntries(compliance.MARKETING_CHECKLIST.map((c) => [c.key, true])));
    return d;
  };
  await upload("Demo Fund III presentation", "deck");
  await upload("Demo Fund III track record", "track_record");
  await upload("Limited partnership agreement", "lpa");
  await upload("Subscription agreement", "subscription");
  await fr.uploadDoc(db, raise.id, { name: "Fund II 2025 audited financials.pdf", bytes: pdf("Fund II 2025 audited financials") }, { title: "Fund II 2025 audited financials", category: "financials" }, LEE); // waiting for your review
  await fr.shareDataRoom(db, cascade.id, { draftEmail: false }, LEE, APP);
  await fr.shareDataRoom(db, meridian.id, { draftEmail: false }, LEE, APP);
  await fr.draftFromRecords(db, LEE);
  for (const key of ["firm.overview", "terms.economics", "valuation.policy", "reporting.lp"]) await fr.approveDdqAnswer(db, key, by).catch(() => undefined);
  const clean = { lists: async () => ({ entries: [], fetchedAt: new Date().toISOString() }) };
  // The demo's pension is a state (governmental) plan, so it isn't an ERISA benefit plan investor.
  const onboard = async (prospectId: string, name: string, kind: string, amount: number, basis: string, finish: boolean) => {
    const inv = await fr.inviteSubscriber(db, raise.id, { prospectId, investorName: name, kind, commitmentUsd: amount }, LEE, APP);
    const ref = (await subscriptionByToken(root, inv.url.split("/subscribe/")[1]!))!;
    await fr.subscriptionSubmit(db, ref, {
      legalName: name, commitmentUsd: amount, accreditedBasis: basis, taxForm: "w9", jurisdiction: "US, Pennsylvania", noticeEmails: inv.subscription.emails.join(","),
      noOwnerOver25: true, benefitPlan: false, accurate: true, signedName: "Authorized Signatory", sourceOfFunds: "Plan assets",
    });
    if (!finish) return inv.subscription.id;
    await fr.screenSubscriber(db, inv.subscription.id, LEE, clean);
    await fr.reviewSubscription(db, inv.subscription.id, { kycStatus: "cleared", signedOn: "2026-09-15" }, LEE);
    await fr.decideSubscription(db, inv.subscription.id, { accept: true }, by);
    return inv.subscription.id;
  };
  const subA = await onboard(allegheny.id, "Allegheny Teachers' Pension Plan", "pension", 15_000_000, "plan", true);
  const subT = await onboard(threeRivers.id, "Three Rivers Foundation", "endowment_foundation", 8_000_000, "entity_assets", true);
  await onboard(keystone.id, "Keystone Insurance Mutual", "insurance", 5_000_000, "institution", false); // submitted: waiting for review
  await fr.addTerm(db, subA, { category: "mfn", text: "Most favored nation rights, per the fund's MFN provisions." }, by);
  await fr.addTerm(db, subA, { category: "lpac_seat", text: "A seat on the LP advisory committee." }, by);
  await fr.addTerm(db, subT, { category: "reporting", text: "Quarterly ESG data for each portfolio company." }, by);
  await fr.addTerm(db, subT, { category: "confidentiality", text: "Disclosure permitted under state public records law." }, by);
  await fr.draftClosing(db, raise.id, { closingDate: "2026-09-30", subscriptionIds: [subA, subT], note: "First closing" }, LEE);
  const fund2 = (await lp.overview(db)).funds[0]!;
  const f2 = await lp.fundView(db, fund2.id);
  for (const p of f2.investors.filter((i) => i.kind !== "gp").slice(0, 3)) await fr.addLpacMember(db, fund2.id, { partnerId: p.id, representative: `${p.name.split(" ")[0]} delegate`, since: "2024-03-01" }, by);
  const members = (await fr.lpacView(db, fund2.id)).members;
  const { consent } = await fr.requestConsent(db, fund2.id, { kind: "conflict", topic: "Fund III investing alongside Fund II in Weldloop's Series A", detail: "Fund III would invest $2M in Weldloop's Series A, in which Fund II takes its pro rata. The round is led and priced by an independent investor, both funds invest on the same terms, and neither fund's investment supports the other's valuation." }, by);
  await fr.castVote(db, consent.id, { memberId: members[0]!.id, vote: "approve" }, LEE);
  await fr.logRequest(db, { fundId: fund2.id, fromName: "Keystone Insurance Mutual", category: "tax", subject: "Estimated 2026 taxable income for our planning", receivedOn: "2026-09-10" }, LEE);
  await fr.logRequest(db, { fundId: fund2.id, fromName: "Three Rivers Foundation", category: "reporting", subject: "Portfolio company headcount by gender for our DEI report", receivedOn: "2026-09-25" }, LEE);

  // Compliance (all fictional): a registered adviser. Girderline is in closing without its regulatory screening, so the
  // close waits for it; Lee's pre-clearance, contribution and over-limit gift wait for you; the records show conflicts.
  await compliance.setProfile(db, { adviserStatus: "registered", ccoEmail: user.email, fiscalYearEnd: "12-31", requireScreening: true, giftLimitUsd: 250 }, by);
  await compliance.recordFiling(db, { form: "form_adv", obligationKey: "adv_2025", filedOn: "2026-03-24", reference: "IARD annual updating amendment" }, by);
  await compliance.recordFiling(db, { form: "form_d", subject: "Demo Fund II", filedOn: "2024-02-12", reference: "0000000000-24-000001", note: "Fictional accession number" }, by);
  await compliance.addRestricted(db, { name: "Brightline Robotics", ticker: "BRTL", reason: "A public acquirer in confidential talks with a portfolio company" }, by);
  await compliance.fileReport(db, LEE, { kind: "holding", period: "2026", items: [{ security: "Vanguard Total Stock Market ETF", ticker: "VTI", quantity: 120 }, { security: "Brightline Robotics", ticker: "BRTL", quantity: 50 }] });
  await compliance.fileReport(db, LEE, { kind: "no_activity", period: "2026-Q2" });
  await compliance.requestPreclearance(db, LEE, { kind: "ipo", security: "Northgate Grid Systems", ticker: "NGGS", amountUsd: 10_000, reason: "Directed share program through a friend at the company" });
  await compliance.requestContribution(db, LEE, { recipient: "Jordan Avery", office: "Pennsylvania State Treasurer", jurisdiction: "Pennsylvania", election: "2026 general", amountUsd: 500, canVote: true, influencesGovernmentInvestor: true, contributeOn: "2026-10-15" });
  await compliance.logGift(db, LEE, { direction: "received", kind: "entertainment", counterparty: "Harbor Placement Partners", description: "Dinner and a hockey game", valueUsd: 420, occurredOn: "2026-09-18" });
  await compliance.logGift(db, by, { direction: "given", kind: "gift", counterparty: "Weldloop team", description: "Books for the offsite", valueUsd: 120, occurredOn: "2026-08-02" });
  await compliance.detectConflicts(db, by);
  await compliance.attest(db, LEE, { policy: "code_of_ethics" });

  console.log(`\nSeeded "${firm.name}" for ${user.email}.`);
  console.log(`Founder portal for Weldloop (as the founder sees it): ${portal.url}`);
  console.log(`Investor portal for ${lpIds[0]!.name} (as the LP sees it): ${investorLink.url}`);
  console.log(`Also on the team: ${lee.email} (partner) and ${ana.email} (analyst); sign in as either to see the app by role.`);
  console.log("Start the app with `pnpm web` and sign in with that email; the sign-in link is printed in the server log.");
  await root.close();
});
