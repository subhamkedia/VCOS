import { htmlToText } from "./web.js";
import { asArray, asString, pick, requestJson } from "./http.js";
import { accessToken, googleConfigured } from "./oauth.js";
import { parseAddress, parseAddressList, rfc822, type EmailMessage } from "./email.js";
import type { FetchLike } from "./types.js";

/**
 * Gmail via the Gmail REST API, with OAuth from oauth.ts.
 * Read: search and fetch messages. Write: create a draft, and only from an
 * approved outbox item. This module has no send function, by design.
 */
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

async function auth(fetchImpl?: FetchLike) {
  return { Authorization: `Bearer ${await accessToken("google", fetchImpl)}` };
}

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; filename?: string };

/** Walk a MIME tree for the first text/plain body, else text/html converted to text. Attachments are skipped. */
export function gmailBody(payload: Part): string {
  const flat: Part[] = [];
  const walk = (p: Part) => {
    flat.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const bodyOf = (mime: string) => flat.find((p) => p.mimeType === mime && !p.filename && p.body?.data)?.body?.data;
  const plain = bodyOf("text/plain");
  if (plain) return fromB64url(plain).trim();
  const html = bodyOf("text/html");
  return html ? htmlToText(fromB64url(html)).text : "";
}

/** Map a `format=full` Gmail message. Pure. */
export function parseGmailMessage(raw: Record<string, unknown>): EmailMessage {
  const headers = new Map(asArray(pick(raw, "payload.headers")).map((h) => [String(h.name).toLowerCase(), String(h.value ?? "")]));
  const internal = Number(raw.internalDate);
  return {
    provider: "gmail",
    id: String(raw.id),
    threadId: asString(raw.threadId),
    from: parseAddress(headers.get("from") ?? ""),
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    subject: headers.get("subject") ?? "",
    date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : undefined,
    body: gmailBody((raw.payload ?? {}) as Part),
    webLink: `https://mail.google.com/mail/u/0/#all/${String(raw.id)}`,
  };
}

/** Search with Gmail's query syntax, e.g. `from:@acme.com newer_than:30d`. */
export async function gmailSearch(q: string, opts: { max?: number; fetchImpl?: FetchLike } = {}): Promise<EmailMessage[]> {
  const params = new URLSearchParams({ q, maxResults: String(Math.min(opts.max ?? 20, 100)) });
  const list = await requestJson<{ messages?: { id: string }[] }>("gmail", `${GMAIL}/messages?${params}`, {
    headers: await auth(opts.fetchImpl), fetchImpl: opts.fetchImpl,
  });
  const out: EmailMessage[] = [];
  for (const m of list.messages ?? []) {
    const raw = await requestJson<Record<string, unknown>>("gmail", `${GMAIL}/messages/${m.id}?format=full`, {
      headers: await auth(opts.fetchImpl), fetchImpl: opts.fetchImpl,
    });
    out.push(parseGmailMessage(raw));
  }
  return out;
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
}

/** Create a draft in your Gmail. Called only when an outbox item is approved. */
export async function gmailCreateDraft(d: DraftInput, fetchImpl?: FetchLike): Promise<{ id: string }> {
  const res = await requestJson<{ id?: string }>("gmail", `${GMAIL}/drafts`, {
    method: "POST",
    headers: { ...(await auth(fetchImpl)), "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: b64url(rfc822(d)), threadId: d.threadId } }),
    fetchImpl,
  });
  return { id: String(res.id ?? "") };
}

export async function gmailCheck(fetchImpl?: FetchLike): Promise<string> {
  const p = await requestJson<{ emailAddress?: string }>("gmail", `${GMAIL}/profile`, { headers: await auth(fetchImpl), fetchImpl });
  return `signed in as ${p.emailAddress ?? "unknown"}`;
}

export const gmailConfigured = googleConfigured;
