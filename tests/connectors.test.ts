import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import { config } from "../lib/config.js";
import { testDb } from "./helpers.js";
import { ingest } from "../connectors/ingest.js";
import { harmonicToRecord, harmonicEnrichByDomain, mapStage } from "../connectors/harmonic.js";
import { parseFormD, formDToRecord, searchFormD, formDUrl } from "../connectors/edgar.js";
import { htmlToText, fetchWebPage } from "../connectors/web.js";
import { vttToText, transcriptFromFile } from "../connectors/transcripts.js";
import { currentClaims, findByIdentifier, openContradictions } from "../ledger/repository.js";

const fx = (f: string) => readFile(`tests/fixtures/${f}`, "utf8");

function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]!;
    return new Response(r.body, { status: r.status ?? 200 });
  };
  return { impl, calls };
}

/** Fake Claude that cites whatever quotes it's given, at their real offsets in the document it receives. */
function citingLlm(lines: [string, string][]): Llm {
  return {
    async create(params) {
      const doc = ((params.messages[0]!.content as Anthropic.ContentBlockParam[])[0] as Anthropic.DocumentBlockParam).source as { data: string };
      const content = lines.flatMap(([header, quote]) => {
        const start = doc.data.indexOf(quote);
        return [
          { type: "text", text: header, citations: null },
          { type: "text", text: quote, citations: start < 0 ? null : [{ type: "char_location", cited_text: quote, document_index: 0, document_title: "t", start_char_index: start, end_char_index: start + quote.length, file_id: null }] },
          { type: "text", text: "\n", citations: null },
        ];
      });
      return { id: "m", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content } as unknown as Anthropic.Message;
    },
  };
}

let db: Db;
beforeEach(async () => {
  db = await testDb();
  config.secUserAgent = "VC OS tests test@example.com";
  config.harmonicApiKey = "test-key";
});
afterEach(async () => {
  await db.close();
});

describe("harmonic", () => {
  it("maps a company payload to a subject and third-party claims", async () => {
    const rec = harmonicToRecord(JSON.parse(await fx("harmonic-company.json")), "2026-09-20T00:00:00Z");
    expect(rec.subject?.domain).toBe("kestrelrobotics.com");
    expect(rec.subject?.linkedin).toBe("company/kestrel-robotics");
    expect(rec.subject?.founders).toEqual(["Maya Lindqvist", "Tomás Ferreira"]);
    expect(rec.evidence.accessScope).toBe("vendor");
    const byPred = Object.fromEntries(rec.claims!.map((c) => [c.predicate, c]));
    expect(byPred["team.headcount"]?.value).toBe(21);
    expect(byPred["funding.round.stage"]?.value).toBe("series_a");
    expect(byPred["funding.round.amount"]?.asOf).toBe("2026-06-10");
    expect(rec.claims!.filter((c) => c.predicate === "funding.investor").map((c) => c.value)).toEqual(["Ironbridge Ventures", "Keystone Capital"]);
    expect(mapStage("PRE_SEED")).toBe("pre_seed");
    expect(mapStage("Series D")).toBe("series_d_plus");
  });

  it("calls the enrichment endpoint with the api key", async () => {
    const { impl, calls } = fakeFetch({ "https://api.harmonic.ai/companies": { body: await fx("harmonic-company.json") } });
    const rec = await harmonicEnrichByDomain("https://www.kestrelrobotics.com", impl);
    expect(rec.subject?.name).toBe("Kestrel Robotics");
    expect(calls[0]?.url).toContain("website_domain=kestrelrobotics.com");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).apikey).toBe("test-key");
  });
});

describe("edgar", () => {
  it("parses a Form D", async () => {
    const d = parseFormD(await fx("formd.xml"));
    expect(d.issuerName).toBe("KESTREL ROBOTICS, INC.");
    expect(d.totalAmountSold).toBe(8_750_000);
    expect(d.dateOfFirstSale).toBe("2026-06-02");
    expect(d.yearOfInc).toBe(2023);
    expect(d.relatedPersons).toHaveLength(2);
  });

  it("searches full text and builds the filing URL", async () => {
    const { impl, calls } = fakeFetch({ "https://efts.sec.gov/": { body: await fx("formd-search.json") } });
    const hits = await searchFormD("kestrel robotics", { from: "2026-06-01", fetchImpl: impl });
    expect(hits[0]).toMatchObject({ cik: "0001999001", name: "Kestrel Robotics, Inc.", fileDate: "2026-06-15" });
    expect((calls[0]?.init?.headers as Record<string, string>)["User-Agent"]).toMatch(/@/);
    expect(formDUrl(hits[0]!.cik, hits[0]!.adsh)).toBe("https://www.sec.gov/Archives/edgar/data/1999001/000199900126000002/primary_doc.xml");
  });
});

describe("web and transcripts", () => {
  it("turns HTML into readable text without scripts or chrome", async () => {
    const { title, text } = htmlToText(await fx("press.html"));
    expect(title).toBe("Kestrel Robotics raises $9M Series A & expands | Build Weekly");
    expect(text).toContain("PITTSBURGH — Kestrel Robotics today announced a $9 million Series A");
    expect(text).toContain("- Founded 2023");
    expect(text).not.toMatch(/track\(|Home \| News|© Build Weekly/);
  });

  it("never takes the company's domain from a third-party page URL", async () => {
    const { impl } = fakeFetch({ "https://buildweekly.example/": { body: await fx("press.html") } });
    const rec = await fetchWebPage("https://buildweekly.example/kestrel", { company: "Kestrel Robotics", fetchImpl: impl });
    expect(rec.subject?.domain).toBeUndefined();
    expect(rec.evidence.accessScope).toBe("public");
  });

  it("reads VTT transcripts into speaker lines", async () => {
    expect(vttToText(await fx("call.vtt"))).toBe(
      "Investor: Where are you on revenue?\nMaya: We closed September at $4.1M ARR.\nMaya: We're 34 people now.",
    );
  });
});

describe("end to end: three sources, one company, one contradiction", () => {
  it("resolves Harmonic, SEC and a call transcript to the same entity and flags the headcount gap", async () => {
    // 1. Harmonic creates the company.
    const h = await ingest(db, harmonicToRecord(JSON.parse(await fx("harmonic-company.json")), "2026-09-20T00:00:00Z"));
    expect(h.subject?.created).toBe(true);
    const id = h.subject!.entity.id;
    expect(h.structuredClaims).toBeGreaterThanOrEqual(10);

    // 2. Form D resolves to it by name + city and adds a primary-source round amount within tolerance.
    const f = await ingest(db, formDToRecord(await fx("formd.xml"), { cik: "0001999001", adsh: "0001999001-26-000002", fileDate: "2026-06-15" }));
    expect(f.subject?.entity.id).toBe(id);
    expect(f.subject?.resolution.decision).toBe("match");
    expect((await findByIdentifier(db, "cik", "1999001"))?.id).toBe(id);
    expect(f.contradictions).toHaveLength(0); // $8.75M sold vs $9M announced: within 10%

    // 3. A call transcript, matched by domain, says 34 people. Harmonic said 21.
    const t = await ingest(
      db,
      await transcriptFromFile("tests/fixtures/call.vtt", { company: "Kestrel", companyDomain: "kestrelrobotics.com", date: "2026-10-02" }),
      {
        llm: citingLlm([
          ["CLAIM | revenue.arr | 4100000 | 2026-09-30 | self_reported | ", "We closed September at $4.1M ARR."],
          ["CLAIM | team.headcount | 34 |  | self_reported | ", "We're 34 people now."],
        ]),
      },
    );
    expect(t.subject?.entity.id).toBe(id);
    expect(t.extraction?.claimIds).toHaveLength(2);
    const open = await openContradictions(db, id);
    expect(open).toHaveLength(1);
    expect(open[0]?.detail).toMatch(/Team headcount: 21 \(third party\) vs 34 \(self-reported\)/);

    // Re-ingesting the same Harmonic payload is a no-op.
    const again = await ingest(db, harmonicToRecord(JSON.parse(await fx("harmonic-company.json")), "2026-09-20T00:00:00Z"));
    expect(again.duplicate).toBe(true);
    expect((await currentClaims(db, id, "team.headcount")).length).toBe(2);
  });
});
