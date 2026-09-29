import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm } from "./helpers.js";
import { createFirm } from "../ledger/platform.js";
import { ycToRecord, type YcCompany } from "../connectors/yc.js";
import { crunchbaseToRecord } from "../connectors/crunchbase.js";
import { connectWithKeys, enable } from "../modules/connections/index.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { cleanParams, createFeed, discovered, feeds, nextRunAt, runDueFeeds, runFeed, runs, updateFeed, FeedInvalid } from "../modules/sourcing/index.js";

beforeAll(() => setSecretKeyForTests(randomBytes(32)));

// Fictional YC-style companies.
const co = (slug: string, name: string, oneLiner: string, location: string): YcCompany => ({
  slug, name, oneLiner, location, formerNames: [], website: `https://${slug}.example`, domain: `${slug}.example`,
  batch: "Winter 2026", industries: [], founders: [`${name} Founder`], url: `https://www.ycombinator.com/companies/${slug}`,
});
const batch = [
  co("girderline", "Girderline", "Autonomous drones that inspect bridge steel", "Pittsburgh, PA, USA"),
  co("formwork", "Formwork AI", "Construction scheduling software for general contractors", "Austin, TX, USA"),
  co("petpal", "PetPal", "A social network for dog owners", "Lagos, Nigeria"),
];

let root: Db;
let db: Db;
beforeEach(async () => {
  const t = await testFirm("Alpha Ventures");
  root = t.root;
  db = t.db;
  await saveProfile(db, await starterProfile("Alpha Ventures"), "human:pat");
});

const fakeDiscover = (list: YcCompany[]) => async () => list.map((c) => ycToRecord(c, "2026-09-29T00:00:00Z"));

describe("feeds", () => {
  it("validates params against the connector's spec", () => {
    const specs = [
      { name: "batches", label: "Batches", kind: "list" as const, required: true },
      { name: "founders", label: "Founders", kind: "boolean" as const, default: true },
      { name: "limit", label: "Limit", kind: "number" as const },
    ];
    expect(cleanParams(specs, { batches: "W26, X26", limit: "5" })).toEqual({ batches: ["W26", "X26"], founders: true, limit: 5 });
    expect(() => cleanParams(specs, { batches: " " })).toThrow(/Batches is required/);
  });

  it("schedules by cadence", () => {
    const t = new Date("2026-09-29T10:00:00Z");
    expect(nextRunAt("hourly", t)?.toISOString()).toBe("2026-09-29T11:00:00.000Z");
    expect(nextRunAt("weekly", t)?.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    expect(nextRunAt("manual", t)).toBeNull();
  });

  it("needs a connected source, and one that can source", async () => {
    await expect(createFeed(db, { connectorId: "affinity", params: { listId: 1 } }, "human:pat")).rejects.toThrow(/Connect Affinity first/);
    await expect(createFeed(db, { connectorId: "gdrive" }, "human:pat")).rejects.toThrow(FeedInvalid);
    await expect(createFeed(db, { connectorId: "yc", params: {} }, "human:pat")).rejects.toThrow(/Batches is required/);
  });
});

describe("running a feed", () => {
  it("ingests companies, scores them against the thesis, and records the run", async () => {
    const id = await createFeed(db, { connectorId: "yc", params: { batches: "W26" }, cadence: "weekly" }, "human:pat");
    const r = await runFeed(db, id, "human:pat", { discover: fakeDiscover(batch) });
    expect(r.ok).toBe(true);
    expect(r.stats).toMatchObject({ records: 3, newCompanies: 3, knownCompanies: 0, errors: 0 });
    const hits = await discovered(db);
    // Best fit first: the two in-thesis companies tie (88: stage unknown is half credit), the pet app comes last.
    expect(hits.map((h) => h.name).slice(0, 2).sort()).toEqual(["Formwork AI", "Girderline"]);
    expect(hits[2]?.name).toBe("PetPal");
    expect(hits.find((h) => h.name === "Girderline")).toMatchObject({ fit_verdict: "strong", fit_score: 88, thesis_version: 1, is_new: true });
    expect(hits.find((h) => h.name === "PetPal")?.fit_verdict).toBe("weak");
    expect((await runs(db, id))[0]).toMatchObject({ status: "done", triggered_by: "human:pat" });
    const [feed] = await feeds(db);
    expect(new Date(String(feed!.next_run_at)).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // A second run finds the same companies: nothing new.
    const again = await runFeed(db, id, "scheduler", { discover: fakeDiscover(batch) });
    expect(again.stats).toMatchObject({ newCompanies: 0, knownCompanies: 3, unchanged: 3 });
  });

  it("keeps going past a bad record and says what went wrong", async () => {
    const id = await createFeed(db, { connectorId: "yc", params: { batches: "W26" } }, "human:pat");
    const broken = ycToRecord(batch[0]!);
    broken.claims = [{ predicate: "not.a.predicate", value: 1 }];
    const r = await runFeed(db, id, "human:pat", {
      discover: async () => [{ ...ycToRecord(batch[1]!), subject: { ...ycToRecord(batch[1]!).subject!, type: "martian" as never } }, ycToRecord(batch[2]!)],
    });
    expect(r.stats.records).toBe(2);
    expect(r.stats.errors).toBe(1);
    expect(r.stats.errorSamples[0]).toBeTruthy();
    const failed = await runFeed(db, id, "human:pat", { discover: async () => { throw new Error("yc-oss 503"); } });
    expect(failed).toMatchObject({ ok: false, error: "yc-oss 503" });
    expect((await runs(db, id))[0]).toMatchObject({ status: "failed", error: "yc-oss 503" });
  });

  it("enriches companies other feeds found, with the firm's own vendor key", async () => {
    const yc = await createFeed(db, { connectorId: "yc", params: { batches: "W26" } }, "human:pat");
    await runFeed(db, yc, "human:pat", { discover: fakeDiscover(batch.slice(0, 1)) });
    await connectWithKeys(db, "crunchbase", { crunchbaseApiKey: "cb-alpha" }, "human:pat").catch(() => undefined);
    const cb = await createFeed(db, { connectorId: "crunchbase" }, "human:pat");
    const seen: string[] = [];
    const r = await runFeed(db, cb, "human:pat", {
      enrich: async (_f, domain) => {
        seen.push(domain);
        return crunchbaseToRecord({ properties: { identifier: { value: "Girderline", permalink: "girderline" }, website_url: `https://${domain}`, last_funding_type: "seed", last_funding_at: "2026-05-01" } });
      },
    });
    expect(seen).toEqual(["girderline.example"]);
    expect(r.stats).toMatchObject({ records: 1, knownCompanies: 1, newCompanies: 0 });
  });

  it("pauses and resumes", async () => {
    const id = await createFeed(db, { connectorId: "yc", params: { batches: "W26" }, cadence: "daily" }, "human:pat");
    await updateFeed(db, id, { enabled: false });
    expect((await feeds(db))[0]).toMatchObject({ enabled: false, next_run_at: null });
    await updateFeed(db, id, { enabled: true, cadence: "weekly" });
    expect((await feeds(db))[0]).toMatchObject({ enabled: true, cadence: "weekly" });
  });
});

describe("the scheduler", () => {
  it("runs due feeds for every firm, each inside its own firm", async () => {
    const other = scopedDb(root, (await createFirm(root, { name: "Beta Capital" })).id);
    await saveProfile(other, await starterProfile("Beta Capital"), "human:sam");
    await enable(db, "yc", "human:pat");
    const fa = await createFeed(db, { connectorId: "yc", params: { batches: "W26" }, cadence: "daily" }, "human:pat");
    const fb = await createFeed(other, { connectorId: "yc", params: { batches: "S26" }, cadence: "daily" }, "human:sam");
    await createFeed(db, { connectorId: "yc", params: { batches: "X26" }, cadence: "manual" }, "human:pat");

    const perFeed: Record<string, YcCompany[]> = { [fa]: batch.slice(0, 1), [fb]: batch.slice(1, 2) };
    const results = await runDueFeeds(root, () => ({ discover: async (f) => perFeed[f.id]!.map((c) => ycToRecord(c)) }), new Date(Date.now() + 1000));
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect((await discovered(db)).map((h) => h.name)).toEqual(["Girderline"]);
    expect((await discovered(other)).map((h) => h.name)).toEqual(["Formwork AI"]);
    // Nothing is due again until the next cadence tick.
    expect(await runDueFeeds(root, () => ({}), new Date(Date.now() + 1000))).toEqual([]);
  });
});
