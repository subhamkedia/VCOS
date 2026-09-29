import { describe, it, expect, beforeEach } from "vitest";
import { config } from "../lib/config.js";
import { fakeFetch, json, publicDns } from "./fake-fetch.js";
import { companySite, usefulLinks } from "../connectors/company-site.js";
import { companyNews, mentionsCompany, parseArticles } from "../connectors/news.js";
import { companyPatents, parsePatents, patentsRecord } from "../connectors/patents.js";
import { companySbir, parseSbir } from "../connectors/sbir.js";
import { awardsRecord, companyFederalAwards, parseAwards } from "../connectors/usaspending.js";
import { companyJobs, findAtsBoard, parseRoles } from "../connectors/jobs.js";
import { sameCompanyName } from "../connectors/research.js";
import { withCredentials } from "../lib/config.js";

// Fictional companies throughout.
const kestrel = { name: "Kestrel Robotics", domain: "kestrelrobotics.example" };

beforeEach(() => {
  config.patentsviewApiKey = "pv-key";
});

describe("name matching for public records", () => {
  it("counts only the same company, not a namesake", () => {
    expect(sameCompanyName(kestrel, "KESTREL ROBOTICS, INC.")).toBe(true);
    expect(sameCompanyName(kestrel, "Kestrel Robotics LLC")).toBe(true);
    expect(sameCompanyName(kestrel, "Kestrel Aerospace Inc")).toBe(false);
    expect(sameCompanyName({ ...kestrel, aliases: ["Kestrel Autonomy"] }, "Kestrel Autonomy, Inc.")).toBe(true);
  });
});

describe("company website", () => {
  const home = `<html><head><title>Kestrel Robotics</title><meta name="description" content="Autonomous rebar-tying robots for bridge decks."></head><body>
    <nav><a href="/about">About</a><a href="/careers">Careers</a></nav>
    <p>Kestrel builds robots that tie rebar on bridge decks, cutting crew time by half on every pour we have measured so far.</p>
    <a href="/customers">Customers</a><a href="/blog/2024/05/intern-post">Blog</a><a href="https://twitter.com/kestrel">Twitter</a><a href="/deck.pdf">Deck</a></body></html>`;

  it("picks the pages worth reading, shallow ones first", () => {
    expect(usefulLinks(home, "https://kestrelrobotics.example/")).toEqual([
      "https://kestrelrobotics.example/about", "https://kestrelrobotics.example/careers", "https://kestrelrobotics.example/customers",
    ]);
  });

  it("reads the site politely and records what it says as self-reported", async () => {
    const f = fakeFetch({
      "https://kestrelrobotics.example/robots.txt": { body: "User-agent: *\nDisallow: /customers" },
      "https://kestrelrobotics.example/about": { body: "<p>Founded in 2023 in Pittsburgh by Maya Lindqvist and Raj Patel, two former bridge engineers who spent a decade on site.</p>" },
      "https://kestrelrobotics.example/careers": { body: "<p>We're hiring field engineers.</p>" },
      "https://kestrelrobotics.example/customers": { body: "<p>secret</p>" },
      "https://kestrelrobotics.example/": { body: home },
    });
    const recs = await companySite(kestrel, { fetchImpl: f.impl, resolve: publicDns });
    expect(recs.map((r) => r.evidence.uri)).toEqual(["https://kestrelrobotics.example/", "https://kestrelrobotics.example/about"]);
    expect(f.calls.some((c) => c.url.endsWith("/customers"))).toBe(false); // robots.txt said no
    expect(recs[0]!.sourceType).toBe("self_reported");
    expect(recs[0]!.claims).toContainEqual(expect.objectContaining({ predicate: "company.description", value: "Autonomous rebar-tying robots for bridge decks." }));
    expect(recs[0]!.evidence.content).toContain("Site description: Autonomous rebar-tying robots");
    expect(recs.every((r) => r.evidence.accessScope === "public" && r.extract)).toBe(true);
    await expect(companySite({ name: "X" })).rejects.toThrow(/No website/);
  });
});

describe("news", () => {
  it("keeps articles about this company, not a namesake", async () => {
    expect(parseArticles({ articles: [{ url: "https://news.example/a", title: "Kestrel Robotics raises $12M", seendate: "20260912T140000Z", domain: "news.example" }] }))
      .toEqual([{ url: "https://news.example/a", title: "Kestrel Robotics raises $12M", outlet: "news.example", seenAt: "2026-09-12T14:00:00Z" }]);
    expect(mentionsCompany({ name: "Kestrel" }, "Kestrel the bird of prey")).toBe(false);
    expect(mentionsCompany({ name: "Kestrel", domain: "kestrel.example" }, "Kestrel (kestrel.example) raised")).toBe(true);
    const f = fakeFetch({
      "https://api.gdeltproject.org/": json({ articles: [
        { url: "https://news.example/a", title: "Kestrel Robotics raises $12M Series A", seendate: "20260912T140000Z", domain: "news.example" },
        { url: "https://news.example/b", title: "Birdwatching: the kestrel returns", seendate: "20260910T140000Z", domain: "news.example" },
      ] }),
      "https://news.example/robots.txt": { status: 404, body: "" },
      "https://news.example/a": { body: `<p>${"Kestrel Robotics, the Pittsburgh maker of rebar-tying robots, raised $12M led by Summit. ".repeat(4)}</p>` },
      "https://news.example/b": { body: "<p>The kestrel is a small falcon.</p>" },
    });
    const recs = await companyNews(kestrel, { fetchImpl: f.impl, resolve: publicDns });
    expect(recs.map((r) => r.evidence.uri)).toEqual(["https://news.example/a"]);
    expect(recs[0]!.evidence.metadata).toMatchObject({ headlineOnly: false });
    expect(new URL(f.calls[0]!.url).searchParams.get("query")).toBe('"Kestrel Robotics"');
  });
});

describe("patents, SBIR and federal awards", () => {
  it("records granted patents assigned to the company as primary claims", async () => {
    const payload = { patents: [
      { patent_id: "11999001", patent_title: "Rebar tying end effector", patent_date: "2025-06-03", assignees: [{ assignee_organization: "Kestrel Robotics, Inc." }] },
      { patent_id: "11888002", patent_title: "Bird feeder", patent_date: "2024-01-09", assignees: [{ assignee_organization: "Kestrel Outdoor Co" }] },
    ] };
    const rec = patentsRecord(kestrel, parsePatents(payload))!;
    expect(rec.sourceType).toBe("primary");
    expect(rec.claims).toHaveLength(1);
    expect(rec.claims![0]).toMatchObject({ predicate: "ip.patent", value: "US 11999001: Rebar tying end effector", asOf: "2025-06-03" });
    expect(rec.evidence.content).toContain(rec.claims![0]!.citedText!);
    const f = fakeFetch({ "https://search.patentsview.org/": json(payload) });
    await withCredentials({}, async () => {
      const recs = await companyPatents(kestrel, { fetchImpl: f.impl });
      expect(recs).toHaveLength(1);
    });
    expect((f.calls[0]!.init?.headers as Record<string, string>)["X-Api-Key"]).toBe("pv-key");
    expect(JSON.parse(String(f.calls[0]!.init?.body)).q).toEqual({ _or: [{ _text_phrase: { "assignees.assignee_organization": "Kestrel Robotics" } }] });
  });

  it("records SBIR awards matched by name or by the company's own website", async () => {
    const awards = [
      { firm: "KESTREL ROBOTICS INC", award_title: "Autonomous rebar placement", agency: "Department of Transportation", phase: "Phase I", program: "SBIR", award_year: "2025", award_amount: 199500, company_url: "https://kestrelrobotics.example", city: "Pittsburgh", state: "PA" },
      { firm: "Kestrel Systems LLC", award_title: "Radar", agency: "DOD", award_year: "2019", award_amount: 1000000, company_url: "kestrelsystems.example" },
    ];
    const f = fakeFetch({ "https://api.www.sbir.gov/": json(awards) });
    const [rec] = await companySbir(kestrel, { fetchImpl: f.impl });
    expect(rec!.claims!.filter((c) => c.predicate === "grant.award").map((c) => c.value)).toEqual(["Department of Transportation SBIR Phase I: Autonomous rebar placement, $199,500, 2025"]);
    expect(rec!.claims).toContainEqual(expect.objectContaining({ predicate: "company.hq_location", value: "Pittsburgh, PA" }));
    expect(parseSbir({ results: awards })).toHaveLength(2);
  });

  it("separates federal contracts from grants", async () => {
    const f = fakeFetch({
      "https://api.usaspending.gov/": [
        json({ results: [{ "Award ID": "693JJ3", "Recipient Name": "KESTREL ROBOTICS, INC.", "Award Amount": 750000, "Awarding Agency": "Department of Transportation", "Awarding Sub Agency": "Federal Highway Administration", "Start Date": "2026-02-01", Description: "BRIDGE DECK AUTOMATION PILOT" }] }),
        json({ results: [{ "Award ID": "G1", "Recipient Name": "Kestrel Robotics", "Award Amount": 50000, "Awarding Agency": "National Science Foundation", "Start Date": "2024-07-01", Description: "SBIR PHASE I" }] }),
      ],
    });
    const [rec] = await companyFederalAwards(kestrel, { fetchImpl: f.impl });
    expect(rec!.claims!.map((c) => c.predicate)).toEqual(["contract.government", "grant.award"]);
    expect(rec!.claims![0]!.value).toBe("Federal Highway Administration: BRIDGE DECK AUTOMATION PILOT, $750,000 obligated, 2026");
    const bodies = f.calls.map((c) => JSON.parse(String(c.init?.body)).filters.award_type_codes);
    expect(bodies).toEqual([["A", "B", "C", "D"], ["02", "03", "04", "05"]]);
    expect(awardsRecord(kestrel, parseAwards({ results: [{ "Award ID": "x", "Recipient Name": "Kestrel Aerospace" }] }, "contract"))).toBeNull();
  });
});

describe("job boards", () => {
  it("finds the board through the company's own site, never by guessing", async () => {
    expect(findAtsBoard('<a href="https://boards.greenhouse.io/kestrelrobotics">Jobs</a>')).toEqual({ ats: "greenhouse", slug: "kestrelrobotics" });
    expect(findAtsBoard('<a href="https://jobs.lever.co/kestrel-robotics/abc">Role</a>')).toEqual({ ats: "lever", slug: "kestrel-robotics" });
    expect(findAtsBoard('<a href="https://jobs.ashbyhq.com/Kestrel">Role</a>')).toEqual({ ats: "ashby", slug: "Kestrel" });
    expect(findAtsBoard("<p>No jobs</p>")).toBeNull();
    expect(parseRoles("lever", [{ text: "Field engineer", categories: { team: "Ops", location: "Pittsburgh" } }])).toEqual([{ title: "Field engineer", team: "Ops", location: "Pittsburgh" }]);
    const f = fakeFetch({
      "https://kestrelrobotics.example/robots.txt": { status: 404, body: "" },
      "https://kestrelrobotics.example/careers": { body: '<a href="https://boards.greenhouse.io/kestrelrobotics">Open roles</a>' },
      "https://kestrelrobotics.example/": { body: "<p>Home</p>" },
      "https://boards-api.greenhouse.io/v1/boards/kestrelrobotics/jobs": json({ jobs: [{ title: "Controls engineer", departments: [{ name: "Engineering" }], location: { name: "Pittsburgh" } }, { title: "Field technician" }] }),
    });
    const [rec] = await companyJobs(kestrel, { fetchImpl: f.impl, resolve: publicDns });
    expect(rec!.claims![0]).toMatchObject({ predicate: "team.open_roles", value: 2 });
    expect(rec!.sourceType).toBe("self_reported");
    expect(rec!.evidence.content).toContain("- Controls engineer (Engineering), Pittsburgh");
  });
});

describe("as-of dates", () => {
  it("accepts month-only and year-only dates as the end of that period, and refuses non-dates", async () => {
    const { normalizeAsOf } = await import("../ledger/repository.js");
    expect(normalizeAsOf("2025-12")).toBe("2025-12-31");
    expect(normalizeAsOf("2024-02")).toBe("2024-02-29");
    expect(normalizeAsOf("2025")).toBe("2025-12-31");
    expect(normalizeAsOf("2026-09-01")).toBe("2026-09-01");
    expect(normalizeAsOf(undefined)).toBeNull();
    expect(() => normalizeAsOf("2025-13")).toThrow(/real month/);
    expect(() => normalizeAsOf("last spring")).toThrow(/isn't a date/);
  });

  it("stores an SBIR award dated by year", async () => {
    const { testDb } = await import("./helpers.js");
    const { ingest } = await import("../connectors/ingest.js");
    const { currentClaims } = await import("../ledger/repository.js");
    const { sbirRecord } = await import("../connectors/sbir.js");
    const db = await testDb();
    const rec = sbirRecord(kestrel, [{ firm: "Kestrel Robotics Inc", title: "Rebar placement", agency: "DOT", year: "2025", amount: 199500 }])!;
    const out = await ingest(db, rec);
    expect(out.structuredRejected).toEqual([]);
    const [award] = await currentClaims(db, out.subject!.entity.id, "grant.award");
    expect(award!.as_of).toBe("2025-12-31");
  });
});
