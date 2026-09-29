import "dotenv/config";
import { readFile } from "node:fs/promises";
import { connect, migrate, scopedDb } from "../lib/db.js";
import { replayLlm } from "../lib/replay-llm.js";
import { addMembership, createFirm, upsertUser } from "../ledger/platform.js";
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

  console.log(`\nSeeded "${firm.name}" for ${user.email}.`);
  console.log("Start the app with `pnpm web` and sign in with that email; the sign-in link is printed in the server log.");
  await root.close();
});
