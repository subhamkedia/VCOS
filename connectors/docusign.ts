import { asArray, asString, requestJson } from "./http.js";
import { accessToken, docusignServer } from "./oauth.js";
import type { FetchLike } from "./types.js";

/**
 * DocuSign eSignature REST API (v2.1), with OAuth from oauth.ts.
 *
 * Read: envelope statuses, so the closing checklist knows when the SPA,
 * charter consents or side letter are signed. Write: a *draft* envelope
 * (status "created"), and only from an approved outbox item. A person
 * reviews and sends it from DocuSign. This module never sets an envelope
 * to "sent" and has no send function, by design (principle 3).
 */

type Account = { accountId: string; baseUri: string };
const accounts = new Map<string, Account>();

/** The account and API host for the connected user (from /oauth/userinfo; cached per token). */
async function account(token: string, fetchImpl?: FetchLike): Promise<Account> {
  const hit = accounts.get(token);
  if (hit) return hit;
  const u = await requestJson<{ accounts?: { account_id: string; is_default?: boolean; base_uri: string }[] }>("docusign", `${docusignServer()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` }, fetchImpl,
  });
  const a = (u.accounts ?? []).find((x) => x.is_default) ?? u.accounts?.[0];
  if (!a) throw new Error("This DocuSign user has no eSignature account.");
  const out = { accountId: a.account_id, baseUri: `${a.base_uri.replace(/\/$/, "")}/restapi/v2.1/accounts/${a.account_id}` };
  accounts.set(token, out);
  return out;
}

export interface Envelope {
  envelopeId: string;
  status: string;
  subject: string | null;
  completedAt: string | null;
  statusChangedAt: string | null;
}

export function parseEnvelopes(json: unknown): Envelope[] {
  return asArray((json as { envelopes?: unknown })?.envelopes).map((e) => ({
    envelopeId: String(e.envelopeId), status: String(e.status ?? "unknown"), subject: asString(e.emailSubject) ?? null,
    completedAt: asString(e.completedDateTime) ?? null, statusChangedAt: asString(e.statusChangedDateTime) ?? null,
  }));
}

/** DocuSign status -> closing checklist status. */
export function closingStatusFor(docusignStatus: string): "requested" | "signed" | "red_flag" | "open" {
  switch (docusignStatus.toLowerCase()) {
    case "completed": return "signed";
    case "sent": case "delivered": case "signed": return "requested";
    case "declined": case "voided": return "red_flag";
    default: return "open";
  }
}

/** Statuses of specific envelopes. */
export async function docusignEnvelopes(ids: string[], fetchImpl?: FetchLike): Promise<Envelope[]> {
  if (!ids.length) return [];
  const token = await accessToken("docusign", fetchImpl);
  const a = await account(token, fetchImpl);
  const q = new URLSearchParams({ envelope_ids: ids.join(",") });
  return parseEnvelopes(await requestJson("docusign", `${a.baseUri}/envelopes?${q}`, { headers: { Authorization: `Bearer ${token}` }, fetchImpl }));
}

/**
 * A draft envelope (status "created"): documents and signers set up, not
 * sent. Called only by the outbox after a person approves the item.
 */
export async function docusignCreateDraft(
  d: { subject: string; documents: { name: string; base64: string }[]; signers: { name: string; email: string }[] },
  fetchImpl?: FetchLike,
): Promise<{ id: string }> {
  const token = await accessToken("docusign", fetchImpl);
  const a = await account(token, fetchImpl);
  const body = {
    emailSubject: d.subject,
    documents: d.documents.map((doc, i) => ({ documentId: String(i + 1), name: doc.name, fileExtension: doc.name.split(".").pop() ?? "pdf", documentBase64: doc.base64 })),
    recipients: { signers: d.signers.map((s, i) => ({ name: s.name, email: s.email, recipientId: String(i + 1), routingOrder: String(i + 1) })) },
    status: "created",
  };
  const res = await requestJson<{ envelopeId?: string }>("docusign", `${a.baseUri}/envelopes`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), fetchImpl,
  });
  if (!res.envelopeId) throw new Error("DocuSign did not return an envelope id.");
  return { id: res.envelopeId };
}

export async function docusignCheck(fetchImpl?: FetchLike): Promise<string> {
  const token = await accessToken("docusign", fetchImpl);
  const a = await account(token, fetchImpl);
  return `Connected to DocuSign account ${a.accountId}`;
}
