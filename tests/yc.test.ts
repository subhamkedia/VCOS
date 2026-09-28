import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  batchCode, batchSlug, fetchLaunchPosts, fetchYcBatch, fetchYcFounders, parseLaunchTitle, parseYcFounders, ycToRecord,
  type YcCompany,
} from "../connectors/yc.js";
import { allocate, buildGateSet, typo } from "../evals/resolver/yc-gate.js";
import { judge } from "../evals/resolver/run.js";

const fx = (f: string) => readFile(`tests/fixtures/${f}`, "utf8");

function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(routes[key]!.body, { status: routes[key]!.status ?? 200 });
  };
  return { impl, calls };
}

describe("yc connector", () => {
  it("names batches both ways", () => {
    expect(batchSlug("W26")).toBe("winter-2026");
    expect(batchSlug("X26")).toBe("spring-2026");
    expect(batchSlug("Summer 2026")).toBe("summer-2026");
    expect(batchCode("Winter 2026")).toBe("W26");
    expect(batchCode("fall-2026")).toBe("F26");
  });

  it("reads a batch from yc-oss and skips records without a name", async () => {
    const f = fakeFetch({ "https://yc-oss.github.io/api/batches/winter-2026.json": { body: await fx("yc-batch.json") } });
    const list = await fetchYcBatch("W26", f.impl);
    expect(list.map((c) => c.slug)).toEqual(["girderline", "formwork-ai", "nomad-welding"]);
    const g = list[0]!;
    expect(g.domain).toBe("girderline.example");
    expect(g.formerNames).toEqual(["Beamwise"]);
    expect(g.location).toBe("Pittsburgh, PA, USA");
    expect(list[1]!.location).toBe("Austin, TX, USA");
    expect(list[2]!.domain).toBeUndefined();
  });

  it("reads founders from a company page", async () => {
    const html = await fx("yc-company-page.html");
    expect(parseYcFounders(html)).toEqual(["Ines Okafor", "Tomasz Wierzba"]);
    // Loose fallback if the embedding changes.
    expect(parseYcFounders('<script>{"founders":[{"full_name":"Ines Okafor"}]}</script>')).toEqual(["Ines Okafor"]);
    const f = fakeFetch({ "https://www.ycombinator.com/companies/girderline": { body: html } });
    expect(await fetchYcFounders("girderline", f.impl)).toHaveLength(2);
  });

  it("parses Launch HN titles and keeps only the requested batch", async () => {
    expect(parseLaunchTitle("Launch HN: Girderline (YC W26) – Drones")).toEqual({ mention: "Girderline", batch: "W26" });
    expect(parseLaunchTitle("Ask HN: anything")).toBeNull();
    const f = fakeFetch({ "https://hn.algolia.com/api/v1/search_by_date": { body: await fx("hn-launch.json") } });
    const posts = await fetchLaunchPosts("W26", f.impl);
    expect(posts.map((p) => p.mention)).toEqual(["Girderline", "Formwork"]);
    expect(posts[0]!.domain).toBe("girderline.example");
    expect(new URL(f.calls[0]!).searchParams.get("query")).toBe('"(YC W26)"');
  });

  it("maps a company to public, third-party evidence", () => {
    const c: YcCompany = {
      slug: "girderline", name: "Girderline", formerNames: [], website: "https://girderline.example", domain: "girderline.example",
      location: "Pittsburgh, PA, USA", oneLiner: "Bridge inspection drones.", batch: "Winter 2026", teamSize: 6, industries: ["Construction"],
      founders: ["Ines Okafor"], url: "https://www.ycombinator.com/companies/girderline",
    };
    const rec = ycToRecord(c, "2026-09-28T00:00:00Z");
    expect(rec.evidence.accessScope).toBe("public");
    expect(rec.evidence.title).toContain("W26");
    expect(rec.claims?.map((x) => x.predicate).sort()).toEqual(
      ["company.description", "company.hq_location", "company.website", "team.founder", "team.headcount"],
    );
    expect(rec.claims?.find((x) => x.predicate === "team.founder")?.asOf).toBeUndefined();
  });
});

describe("yc gate builder", () => {
  // Fictional companies: two batches of 30 and 10, plus a pool with look-alikes.
  const mk = (i: number, batch: string, extra: Partial<YcCompany> = {}): YcCompany => ({
    slug: `co-${batch.slice(0, 1)}${i}`, name: `Tessellate${String.fromCharCode(97 + (i % 26))}${i} Robotics`, formerNames: [],
    website: `https://co${batch.slice(0, 1)}${i}.example`, domain: `co${batch.slice(0, 1)}${i}.example`, location: "Denver, CO, USA",
    batch, industries: [], founders: [`Founder ${i}`, `Cofounder ${i}`], url: "", ...extra,
  });
  const companies = [
    ...Array.from({ length: 30 }, (_, i) => mk(i, "Winter 2026")),
    ...Array.from({ length: 10 }, (_, i) => mk(i, "Spring 2026")),
    mk(99, "Winter 2026", { domain: "shared.example", website: "https://shared.example" }),
    mk(98, "Winter 2026", { domain: "shared.example", website: "https://shared.example" }),
  ];

  it("allocates in proportion to batch size", () => {
    expect([...allocate(new Map([["a", 30], ["b", 10]]), 20)]).toEqual([["a", 15], ["b", 5]]);
    expect([...allocate(new Map([["a", 3], ["b", 1]]), 10)]).toEqual([["a", 3], ["b", 1]]);
  });

  it("makes a plausible typo or none", () => {
    expect(typo("Girderline")).toBe("Girdreline");
    expect(typo("AB")).toBeNull();
  });

  it("draws a reproducible, stratified set with held-out companies", () => {
    const a = buildGateSet({ companies, size: 20, seed: "t" });
    const b = buildGateSet({ companies, size: 20, seed: "t" });
    expect(a.cases).toEqual(b.cases);
    expect(a.selected).toHaveLength(20);
    expect(a.selected.filter((c) => c.batch === "Spring 2026")).toHaveLength(5);
    // Companies sharing a domain are ambiguous at the source and left out.
    expect(a.selected.some((c) => c.domain === "shared.example")).toBe(false);
    expect(a.entities).toHaveLength(16);
    const news = a.cases.filter((c) => c.kind === "new_company");
    expect(news).toHaveLength(4);
    expect(news.every((c) => c.expected === "NEW")).toBe(true);
    const keys = new Set(a.entities.map((e) => e.key));
    for (const c of a.cases) if (c.expected !== "NEW") expect(keys.has(c.expected)).toBe(true);
    expect(new Set(a.cases.map((c) => c.kind))).toEqual(new Set(["website", "legal_name", "founder_intro", "typo", "new_company"]));
    expect(buildGateSet({ companies, size: 20, seed: "other" }).selected.map((c) => c.slug)).not.toEqual(a.selected.map((c) => c.slug));
  });

  it("adds real mentions: Launch HN names, former names and look-alikes", () => {
    const g = mk(1, "Winter 2026", { slug: "girderline", name: "Girderline", domain: "girderline.example", website: "https://girderline.example", formerNames: ["Beamwise"] });
    const launches = [{ mention: "Girderline Inc", batch: "W26", title: "Launch HN: Girderline Inc (YC W26)", domain: "girderline.example", hnId: "1", postedAt: "" }];
    const pool = [mk(7, "Summer 2019", { slug: "girderlines", name: "Girderlines", domain: "girderlines.example", website: "https://girderlines.example" })];
    const out = buildGateSet({ companies: [g], launches, pool, size: 1, knownShare: 1 });
    expect(out.cases.find((c) => c.kind === "launch_hn")).toMatchObject({ name: "Girderline Inc", expected: "girderline", acceptReview: true });
    expect(out.cases.find((c) => c.kind === "former_name")).toMatchObject({ name: "Beamwise", expected: "girderline" });
    expect(out.cases.find((c) => c.kind === "lookalike")).toMatchObject({ name: "Girderlines", expected: "NEW" });
  });

  it("is judged by the same rules as the synthetic set", () => {
    expect(judge({ name: "x", expected: "NEW" }, "match", "girderline")).toBe("false_merge");
    expect(judge({ name: "x", expected: "girderline", acceptReview: true }, "review", "girderline")).toBe("correct");
  });
});
