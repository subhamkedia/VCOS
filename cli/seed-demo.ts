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

  console.log(`\nSeeded "${firm.name}" for ${user.email}.`);
  console.log("Start the app with `pnpm web` and sign in with that email; the sign-in link is printed in the server log.");
  await root.close();
});
