import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Db } from "../lib/db.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import { testDb } from "./helpers.js";
import { extractPortfolio, fetchPortfolioPage, portfolioRecord, robotsAllows, siteOf } from "../connectors/portfolio-pages.js";
import { assertPublicUrl, isPrivateAddress } from "../connectors/http.js";
import { currentClaims, findByIdentifier } from "../ledger/repository.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { createFeed, discovered, runFeed } from "../modules/sourcing/index.js";

beforeAll(() => setSecretKeyForTests(randomBytes(32)));

const PAGE = "https://www.foundryworks.example/portfolio";
const publicDns = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    return r ? new Response(r.body, { status: r.status ?? 200, headers: r.headers }) : new Response("nope", { status: 404 });
  };
  return { impl, calls };
}

describe("reading a portfolio page", () => {
  it("lists company homepages and ignores everything else", async () => {
    const found = extractPortfolio(await readFile("tests/fixtures/portfolio-page.html", "utf8"), PAGE);
    expect(found.map((c) => [c.name, c.domain])).toEqual([
      ["Girderline", "girderline.example"], // JSON-LD name wins over the logo
      ["Formwork AI", "formwork.example"],
      ["Weldloop", "weldloop.example"], // aria-label, not "Visit website"
      ["Rebarbot", "rebarbot.example"], // no text anywhere: named from the domain
    ]);
    expect(found[0]?.description).toBe("Drones that inspect bridge steel.");
  });

  it("knows a site from its subdomains", () => {
    expect(siteOf("blog.foundryworks.example")).toBe("foundryworks.example");
    expect(siteOf("www.acme.co.uk")).toBe("acme.co.uk");
  });

  it("reads robots.txt the way crawlers do", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/portfolio\n\nUser-agent: BadBot\nDisallow: /";
    expect(robotsAllows(robots, "/portfolio")).toBe(true);
    expect(robotsAllows(robots, "/private/team")).toBe(false);
    expect(robotsAllows(robots, "/private/portfolio")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/portfolio")).toBe(false);
    expect(robotsAllows("User-agent: vc-os\nDisallow: /portfolio\n\nUser-agent: *\nAllow: /", "/portfolio")).toBe(false);
    expect(robotsAllows("", "/anything")).toBe(true);
  });

  it("respects robots.txt and explains empty pages", async () => {
    const html = await readFile("tests/fixtures/portfolio-page.html", "utf8");
    const blocked = fakeFetch({ "https://www.foundryworks.example/robots.txt": { body: "User-agent: *\nDisallow: /portfolio" }, [PAGE]: { body: html } });
    await expect(fetchPortfolioPage(PAGE, { fetchImpl: blocked.impl, resolve: publicDns })).rejects.toThrow(/robots.txt asks/);
    expect(blocked.calls).not.toContain(PAGE);

    const ok = fakeFetch({ [PAGE]: { body: html } }); // no robots.txt: allowed
    expect((await fetchPortfolioPage(PAGE, { fetchImpl: ok.impl, resolve: publicDns })).companies).toHaveLength(4);

    const js = fakeFetch({ [PAGE]: { body: "<html><body><div id=root></div><script src=app.js></script></body></html>" } });
    await expect(fetchPortfolioPage(PAGE, { fetchImpl: js.impl, resolve: publicDns })).rejects.toThrow(/JavaScript/);
  });

  it("only fetches the public internet, including after redirects", async () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    await expect(assertPublicUrl("http://localhost:8787/api", publicDns)).rejects.toThrow(/public internet/);
    await expect(assertPublicUrl("http://169.254.169.254/latest", publicDns)).rejects.toThrow(/public internet/);
    await expect(assertPublicUrl("https://sneaky.example/", async () => ["10.0.0.5"])).rejects.toThrow(/public internet/);
    await expect(assertPublicUrl("file:///etc/passwd", publicDns)).rejects.toThrow(/http/);
    const redirect = fakeFetch({ [PAGE]: { status: 302, body: "", headers: { location: "http://127.0.0.1/admin" } } });
    await expect(fetchPortfolioPage(PAGE, { fetchImpl: redirect.impl, resolve: publicDns })).rejects.toThrow(/public internet/);
  });
});

describe("portfolio websites as a sourcing feed", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
    await saveProfile(db, await starterProfile("Alpha"), "human:pat");
  });

  it("ties each company to the program or investor that lists it", async () => {
    const site = { orgName: "Foundry Works", orgType: "accelerator" as const, url: PAGE };
    const id = await createFeed(db, { connectorId: "websites", params: { orgName: "Foundry Works", orgType: "accelerator", url: PAGE }, cadence: "weekly" }, "human:pat");
    const companies = extractPortfolio(await readFile("tests/fixtures/portfolio-page.html", "utf8"), PAGE);
    const r = await runFeed(db, id, "human:pat", { discover: async () => companies.map((c) => portfolioRecord(site, c)) });
    expect(r.stats).toMatchObject({ records: 4, newCompanies: 4, errors: 0 });
    const g = await findByIdentifier(db, "domain", "girderline.example");
    const claims = await currentClaims(db, g!.id);
    expect(claims.find((c) => c.predicate === "company.program")).toMatchObject({ value: "Foundry Works", source_type: "third_party" });
    expect(claims.find((c) => c.predicate === "company.program")?.cited_text).toBe("Girderline is listed on Foundry Works's portfolio page.");
    expect((await discovered(db)).map((h) => h.name).sort()).toEqual(["Formwork AI", "Girderline", "Rebarbot", "Weldloop"]);

    // A VC's page records an investor instead.
    const vc = portfolioRecord({ ...site, orgName: "Ironbridge Ventures", orgType: "vc" }, companies[0]!);
    expect(vc.claims?.find((c) => c.predicate === "funding.investor")?.value).toBe("Ironbridge Ventures");
  });

  it("checks the page address when the feed is created", async () => {
    await expect(createFeed(db, { connectorId: "websites", params: { orgName: "X", orgType: "accelerator", url: "not a url" } }, "human:pat")).rejects.toThrow(/full web address/);
    await expect(createFeed(db, { connectorId: "websites", params: { orgName: "X", orgType: "spaceship", url: PAGE } }, "human:pat")).rejects.toThrow(/pick one of the options/);
  });
});
