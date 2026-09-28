import { htmlToText } from "./web.js";
import { asArray, asString, pick, requestJson } from "./http.js";
import { accessToken, microsoftConfigured } from "./oauth.js";
import type { EmailMessage } from "./email.js";
import type { DraftInput } from "./gmail.js";
import type { FetchLike } from "./types.js";

/**
 * Outlook / Microsoft 365 mail via Microsoft Graph, with OAuth from oauth.ts.
 * Read: search and fetch messages. Write: create a draft (POST /me/messages
 * creates a draft), only from an approved outbox item. No send function.
 */
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const FIELDS = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink";

async function auth(fetchImpl?: FetchLike) {
  return { Authorization: `Bearer ${await accessToken("microsoft", fetchImpl)}` };
}

const addr = (r: Record<string, unknown>) => String(pick(r, "emailAddress.address") ?? "").toLowerCase();

/** Map a Graph message. Pure. */
export function parseGraphMessage(m: Record<string, unknown>): EmailMessage {
  const contentType = String(pick(m, "body.contentType") ?? "text").toLowerCase();
  const content = String(pick(m, "body.content") ?? "");
  return {
    provider: "outlook",
    id: String(m.id),
    threadId: asString(m.conversationId),
    from: { name: asString(pick(m, "from.emailAddress.name")), address: String(pick(m, "from.emailAddress.address") ?? "").toLowerCase() },
    to: asArray(m.toRecipients).map(addr).filter(Boolean),
    cc: asArray(m.ccRecipients).map(addr).filter(Boolean),
    subject: String(m.subject ?? ""),
    date: asString(m.receivedDateTime),
    body: contentType === "html" ? htmlToText(content).text : content.trim(),
    webLink: asString(m.webLink),
  };
}

/** Full-text search across your mailbox. */
export async function outlookSearch(query: string, opts: { max?: number; fetchImpl?: FetchLike } = {}): Promise<EmailMessage[]> {
  const params = new URLSearchParams({ $search: `"${query.replace(/"/g, "")}"`, $top: String(Math.min(opts.max ?? 20, 100)), $select: FIELDS });
  const res = await requestJson<{ value?: Record<string, unknown>[] }>("outlook", `${GRAPH}/messages?${params}`, {
    headers: await auth(opts.fetchImpl), fetchImpl: opts.fetchImpl,
  });
  return (res.value ?? []).map(parseGraphMessage);
}

/** Create a draft in your Outlook Drafts folder. Called only when an outbox item is approved. */
export async function outlookCreateDraft(d: DraftInput, fetchImpl?: FetchLike): Promise<{ id: string }> {
  const to = (xs: string[] = []) => xs.map((address) => ({ emailAddress: { address } }));
  const res = await requestJson<{ id?: string }>("outlook", `${GRAPH}/messages`, {
    method: "POST",
    headers: { ...(await auth(fetchImpl)), "Content-Type": "application/json" },
    body: JSON.stringify({ subject: d.subject, body: { contentType: "Text", content: d.body }, toRecipients: to(d.to), ccRecipients: to(d.cc) }),
    fetchImpl,
  });
  return { id: String(res.id ?? "") };
}

export async function outlookCheck(fetchImpl?: FetchLike): Promise<string> {
  const me = await requestJson<{ mail?: string; userPrincipalName?: string }>("outlook", GRAPH, { headers: await auth(fetchImpl), fetchImpl });
  return `signed in as ${me.mail ?? me.userPrincipalName ?? "unknown"}`;
}

export const outlookConfigured = microsoftConfigured;
