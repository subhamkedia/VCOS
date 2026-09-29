import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../lib/db.js";
import type { Llm } from "../lib/llm.js";
import { config, type ConfigKey } from "../lib/config.js";
import { testDb } from "./helpers.js";
import { ingest } from "../connectors/ingest.js";
import { HttpError, request } from "../connectors/http.js";
import { accessToken, clearTokenCache } from "../connectors/oauth.js";
import { gmailCreateDraft, gmailSearch, parseGmailMessage } from "../connectors/gmail.js";
import { outlookCreateDraft, parseGraphMessage } from "../connectors/outlook.js";
import { emailToRecord, parseAddress, parseAddressList, type EmailMessage } from "../connectors/email.js";
import { affinityCreateNote, affinityListOrgs, affinityNoteRecord, affinityOrgRecord, parseAffinityOrg } from "../connectors/affinity.js";
import { crunchbaseByDomain, crunchbaseToRecord } from "../connectors/crunchbase.js";
import { pitchbookByDomain } from "../connectors/pitchbook.js";
import { dealroomToRecord } from "../connectors/dealroom.js";
import { driveRecord } from "../connectors/gdrive.js";
import { documentFromFile, documentRecord } from "../connectors/documents.js";
import { CONNECTORS, ENV_NAMES, requiredKeys } from "../connectors/registry.js";
import { createEntity, currentClaims, findByIdentifier } from "../ledger/repository.js";

// All companies, people and ids below are fictional.

type Route = { status?: number; body: string | Uint8Array; headers?: Record<string, string> } | Array<{ status?: number; body: string }>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const seen = new Map<string, number>();
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.startsWith(k));
    if (!key) return new Response(`no route for ${url}`, { status: 404 });
    const r = routes[key]!;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const one = Array.isArray(r) ? r[Math.min(n, r.length - 1)]! : r;
    return new Response(one.body as BodyInit, { status: one.status ?? 200, headers: "headers" in one ? one.headers : undefined });
  };
  return { impl, calls };
}

const OAUTH = {
  "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "g-token", expires_in: 3600 }) },
  "https://login.microsoftonline.com/": { body: JSON.stringify({ access_token: "m-token", expires_in: 3600 }) },
};

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
  clearTokenCache();
  Object.assign(config, {
    googleClientId: "gid", googleClientSecret: "gsecret", googleRefreshToken: "grefresh",
    msClientId: "mid", msClientSecret: "msecret", msRefreshToken: "mrefresh", msTenant: "common",
    affinityApiKey: "aff-key", crunchbaseApiKey: "cb-key", pitchbookApiKey: "pb-key", dealroomApiKey: "dr-key",
  });
});
afterEach(async () => {
  await db.close();
});

describe("http and oauth", () => {
  it("retries rate limits, then gives up on client errors without retrying", async () => {
    const f = fakeFetch({ "https://api.x/ok": [{ status: 429, body: "slow down" }, { body: "{}" }], "https://api.x/missing": { status: 404, body: "nope" } });
    expect((await request("x", "https://api.x/ok", { fetchImpl: f.impl })).status).toBe(200);
    await expect(request("x", "https://api.x/missing", { fetchImpl: f.impl })).rejects.toThrow(HttpError);
    expect(f.calls.filter((c) => c.url.endsWith("missing"))).toHaveLength(1);
  });

  it("trades a refresh token for an access token and caches it", async () => {
    const f = fakeFetch(OAUTH);
    expect(await accessToken("google", f.impl)).toBe("g-token");
    expect(await accessToken("google", f.impl)).toBe("g-token");
    expect(f.calls).toHaveLength(1);
    const body = new URLSearchParams(String(f.calls[0]!.init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("grefresh");
    expect(await accessToken("microsoft", f.impl)).toBe("m-token");
    expect(f.calls[1]!.url).toContain("/common/oauth2/v2.0/token");
  });
});

describe("email", () => {
  const gmailRaw = {
    id: "18f0a", threadId: "18f00", internalDate: String(Date.parse("2026-09-15T14:00:00Z")),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: '"Ines Okafor" <ines@girderline.example>' },
        { name: "To", value: "partner@fund.example, analyst@fund.example" },
        { name: "Subject", value: "Girderline update: September" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Hi both,\nWe signed our third DOT contract. ARR is $1.4M.\nInes") } },
        { mimeType: "text/html", body: { data: b64url("<p>Hi both</p>") } },
        { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "a1" } },
      ],
    },
  };

  it("parses addresses", () => {
    expect(parseAddress('"Ines Okafor" <Ines@Girderline.example>')).toEqual({ name: "Ines Okafor", address: "ines@girderline.example" });
    expect(parseAddressList('a@x.example, "Doe, Jane" <jane@y.example>')).toEqual(["a@x.example", "jane@y.example"]);
  });

  it("maps a Gmail message, preferring the plain-text body", () => {
    const m = parseGmailMessage(gmailRaw);
    expect(m.from).toEqual({ name: "Ines Okafor", address: "ines@girderline.example" });
    expect(m.to).toEqual(["partner@fund.example", "analyst@fund.example"]);
    expect(m.body).toContain("ARR is $1.4M");
    expect(m.date).toBe("2026-09-15T14:00:00.000Z");
  });

  it("searches Gmail with OAuth", async () => {
    const f = fakeFetch({
      ...OAUTH,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?": { body: JSON.stringify({ messages: [{ id: "18f0a" }] }) },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f0a": { body: JSON.stringify(gmailRaw) },
    });
    const mails = await gmailSearch("from:@girderline.example", { fetchImpl: f.impl });
    expect(mails).toHaveLength(1);
    expect(new Headers(f.calls[1]!.init?.headers).get("authorization")).toBe("Bearer g-token");
  });

  it("creates drafts, never sends", async () => {
    const f = fakeFetch({ ...OAUTH, "https://gmail.googleapis.com/gmail/v1/users/me/drafts": { body: '{"id":"r-1"}' }, "https://graph.microsoft.com/v1.0/me/messages": { body: '{"id":"AAMk"}' } });
    expect(await gmailCreateDraft({ to: ["ines@girderline.example"], subject: "Next steps", body: "Thanks Ines." }, f.impl)).toEqual({ id: "r-1" });
    const raw = JSON.parse(String(f.calls[1]!.init?.body)).message.raw as string;
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(decoded).toContain("To: ines@girderline.example");
    expect(decoded).toContain("Subject: Next steps");
    expect(await outlookCreateDraft({ to: ["ines@girderline.example"], subject: "Next steps", body: "Thanks." }, f.impl)).toEqual({ id: "AAMk" });
    expect(f.calls.every((c) => !/\/send\b/.test(c.url))).toBe(true);
  });

  it("maps an Outlook message with an HTML body", () => {
    const m = parseGraphMessage({
      id: "AAMk1", conversationId: "c1", subject: "Intro: Girderline", receivedDateTime: "2026-09-10T09:00:00Z",
      from: { emailAddress: { name: "Scout", address: "scout@angels.example" } },
      toRecipients: [{ emailAddress: { address: "Partner@Fund.example" } }], ccRecipients: [],
      body: { contentType: "html", content: "<html><body><p>Meet Ines, CEO of Girderline.</p><script>x()</script></body></html>" },
    });
    expect(m.to).toEqual(["partner@fund.example"]);
    expect(m.body).toBe("Meet Ines, CEO of Girderline.");
  });

  it("infers the company from a work domain, never from free mail", () => {
    const base: EmailMessage = { provider: "gmail", id: "1", from: { address: "ines@girderline.example" }, to: [], cc: [], subject: "Hi", body: "Hello there" };
    const rec = emailToRecord(base);
    expect(rec.subject).toMatchObject({ name: "Girderline", domain: "girderline.example" });
    expect(rec.evidence.accessScope).toBe("confidential");
    expect(rec.evidence.content.startsWith("From: ines@girderline.example\nTo: \nSubject: Hi\n\nHello there")).toBe(true);
    const personal = emailToRecord({ ...base, from: { address: "ines.okafor@gmail.com" } });
    expect(personal.subject).toBeUndefined();
    expect(personal.extract).toBe(false);
    expect(emailToRecord({ ...base, from: { address: "x@gmail.com" } }, { company: "Girderline" }).subject?.name).toBe("Girderline");
  });

  it("an email from a known company's domain lands on that company, with cited claims", async () => {
    const g = await createEntity(db, { type: "company", name: "Girderline", source: "test", identifiers: [{ kind: "domain", value: "girderline.example" }] });
    const r = await ingest(db, emailToRecord(parseGmailMessage(gmailRaw)), {
      llm: citingLlm([["CLAIM | revenue.arr | 1400000 | 2026-09-15 | self_reported | ", "ARR is $1.4M."]]),
    });
    expect(r.subject?.entity.id).toBe(g.id);
    const arr = await currentClaims(db, g.id, "revenue.arr");
    expect(arr.map((c) => c.value)).toEqual([1_400_000]);
    expect(arr[0]?.cited_text).toBe("ARR is $1.4M.");
  });
});

describe("affinity", () => {
  it("maps organizations and notes as internal evidence with an affinity id", () => {
    const o = parseAffinityOrg({ id: 7001, name: "Girderline", domain: "girderline.example", domains: ["girderline.example", "www.girderline.io"] })!;
    expect(o.domains).toEqual(["girderline.example", "girderline.io"]);
    const rec = affinityOrgRecord(o, "2026-09-28T00:00:00Z");
    expect(rec.evidence.accessScope).toBe("internal");
    expect(rec.subject?.externalIds).toEqual([{ kind: "affinity", value: "7001" }]);
    const note = affinityNoteRecord({ id: 9, content: "Met Ines. 40 bridges a month.", organizationIds: [7001] }, o);
    expect(note.extract).toBe(true);
    expect(note.evidence.kind).toBe("note");
  });

  it("pages through a list with basic auth", async () => {
    const page = (token: string | null, id: number) => JSON.stringify({ list_entries: [{ entity_type: 1, entity: { id, name: `Org ${id}` } }, { entity_type: 0, entity: { id: 1, first_name: "A" } }], next_page_token: token });
    const f = fakeFetch({ "https://api.affinity.co/lists/12/list-entries": [{ body: page("p2", 1) }, { body: page(null, 2) }] });
    const orgs = await affinityListOrgs(12, f.impl);
    expect(orgs.map((o) => o.name)).toEqual(["Org 1", "Org 2"]);
    expect(f.calls[1]!.url).toContain("page_token=p2");
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe(`Basic ${Buffer.from(":aff-key").toString("base64")}`);
  });

  it("writes a note only through the function the outbox calls", async () => {
    const f = fakeFetch({ "https://api.affinity.co/notes": { body: '{"id": 55}' } });
    expect(await affinityCreateNote(7001, "IC passed.", f.impl)).toEqual({ id: "55" });
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ organization_ids: [7001], content: "IC passed." });
  });
});

describe("data vendors", () => {
  const cbEntity = {
    properties: {
      identifier: { value: "Girderline", permalink: "girderline" },
      short_description: "Bridge inspection drones", website_url: "https://www.girderline.example",
      location_identifiers: [{ value: "Pittsburgh", location_type: "city" }, { value: "Pennsylvania", location_type: "region" }, { value: "United States", location_type: "country" }],
      founded_on: { value: "2025-01-01" }, funding_total: { value_usd: 3_500_000 }, last_funding_type: "seed", last_funding_at: "2026-04-01",
      founder_identifiers: [{ value: "Ines Okafor" }], investor_identifiers: [{ value: "Keystone Capital" }], num_employees_enum: "c_00011_00050",
    },
  };

  it("maps Crunchbase as vendor-scoped third-party claims", async () => {
    const rec = crunchbaseToRecord(cbEntity, "2026-09-28T00:00:00Z");
    expect(rec.evidence.accessScope).toBe("vendor");
    expect(rec.subject).toMatchObject({ domain: "girderline.example", location: "Pittsburgh, Pennsylvania, United States", founders: ["Ines Okafor"] });
    const preds = rec.claims!.map((c) => c.predicate);
    expect(preds).toContain("funding.round.stage");
    expect(preds).not.toContain("team.headcount"); // a range is not a headcount
    const f = fakeFetch({
      "https://api.crunchbase.com/api/v4/searches/organizations": { body: JSON.stringify({ entities: [{ properties: { identifier: { permalink: "girderline" }, website_url: "https://girderline.example" } }] }) },
      "https://api.crunchbase.com/api/v4/entities/organizations/girderline": { body: JSON.stringify(cbEntity) },
    });
    expect((await crunchbaseByDomain("girderline.example", f.impl)).subject?.name).toBe("Girderline");
    expect(new Headers(f.calls[0]!.init?.headers).get("x-cb-user-key")).toBe("cb-key");
  });

  it("maps PitchBook and keeps non-USD money out of claims", async () => {
    const f = fakeFetch({
      "https://api.pitchbook.com/companies/search": { body: JSON.stringify({ items: [{ companyId: "512345-67" }] }) },
      "https://api.pitchbook.com/companies/512345-67/bio": { body: JSON.stringify({ companyName: "Girderline", website: "girderline.example", yearFounded: 2025, employees: 14, hqLocation: { city: "Pittsburgh", state: "PA", country: "United States" } }) },
      "https://api.pitchbook.com/companies/512345-67/most-recent-deal": { body: JSON.stringify({ dealDate: "2026-04-01", dealType: "Seed Round", dealSize: { amount: 3_000_000, currency: "EUR" }, postValuation: { amount: 15_000_000, currency: "USD" } }) },
      "https://api.pitchbook.com/companies/512345-67/active-investors": { body: JSON.stringify({ investors: [{ investorName: "Keystone Capital" }] }) },
    });
    const rec = await pitchbookByDomain("girderline.example", f.impl);
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe("PB-Token pb-key");
    expect(rec.subject?.externalIds).toEqual([{ kind: "pitchbook", value: "512345-67" }]);
    const byPred = new Map(rec.claims!.map((c) => [c.predicate, c]));
    expect(byPred.get("funding.round.amount")).toBeUndefined(); // EUR
    expect(byPred.get("funding.round.post_money")?.value).toBe(15_000_000);
    expect(byPred.get("funding.round.stage")?.value).toBe("seed");
    expect(byPred.get("team.headcount")?.value).toBe(14);
  });

  it("maps Dealroom", () => {
    const rec = dealroomToRecord({ id: 99, name: "Girderline", tagline: "Bridge drones", website_url: "https://girderline.example", hq_locations: [{ city: { name: "Pittsburgh" }, country: { name: "United States" } }], launch_year: 2025, founders: { items: [{ name: "Ines Okafor" }] } });
    expect(rec.subject).toMatchObject({ name: "Girderline", location: "Pittsburgh, United States", externalIds: [{ kind: "dealroom", value: "99" }] });
    expect(rec.evidence.accessScope).toBe("vendor");
  });

  it("a vendor record resolves to the company already in the ledger", async () => {
    const g = await createEntity(db, { type: "company", name: "Girderline", source: "test", identifiers: [{ kind: "domain", value: "girderline.example" }] });
    const r = await ingest(db, crunchbaseToRecord(cbEntity));
    expect(r.subject?.entity.id).toBe(g.id);
    expect((await findByIdentifier(db, "crunchbase", "girderline"))?.id).toBe(g.id);
  });
});

describe("documents", () => {
  it("reads a PDF deck and keeps a DocSend link as its source", async () => {
    const rec = await documentFromFile("tests/fixtures/deck.pdf", { company: "Girderline", url: "https://docsend.com/view/abc123" });
    expect(rec.evidence).toMatchObject({ kind: "deck", source: "docsend", uri: "https://docsend.com/view/abc123", accessScope: "confidential" });
    expect(rec.evidence.content).toContain("ARR: $1.2M as of August 2026.");
    expect((await documentFromFile("tests/fixtures/deck.pdf", { company: "Girderline" })).evidence.source).toBe("document");
    expect(() => documentRecord({ text: "[page 1]\n", fileName: "scan.pdf", source: "document", uri: "x", company: "G" })).toThrow(/OCR/);
  });

  it("exports a Google Slides deck from Drive as text", async () => {
    const f = fakeFetch({
      ...OAUTH,
      "https://www.googleapis.com/drive/v3/files/f1?": { body: JSON.stringify({ id: "f1", name: "Girderline pitch", mimeType: "application/vnd.google-apps.presentation", modifiedTime: "2026-09-01T00:00:00Z", webViewLink: "https://docs.google.com/presentation/d/f1" }) },
      "https://www.googleapis.com/drive/v3/files/f1/export": { body: "Girderline\nWe inspect 40 bridges a month and have 3 DOT contracts." },
    });
    const rec = await driveRecord("f1", { company: "Girderline", fetchImpl: f.impl });
    expect(rec.evidence).toMatchObject({ kind: "deck", source: "gdrive", uri: "https://docs.google.com/presentation/d/f1" });
    expect(rec.evidence.content).toContain("3 DOT contracts");
  });
});

describe("registry", () => {
  it("has no code path that sends email or messages", async () => {
    const { readdir } = await import("node:fs/promises");
    for (const f of (await readdir("connectors")).filter((f) => f.endsWith(".ts"))) {
      const src = await readFile(`connectors/${f}`, "utf8");
      expect(src, f).not.toMatch(/\/send(Mail)?\b|messages\/send|drafts\/send|whatsapp|imessage/i);
    }
  });

  it("documents every key each connector needs in .env.example", async () => {
    const example = await readFile(".env.example", "utf8");
    const keys = new Set(CONNECTORS.flatMap((c) => requiredKeys(c)));
    for (const k of keys) expect(example).toContain(`${ENV_NAMES[k as ConfigKey]}=`);
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length);
  });
});
