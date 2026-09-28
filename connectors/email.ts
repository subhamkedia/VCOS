import { normalizeDomain } from "../lib/text.js";
import type { SourceRecord } from "./types.js";

/**
 * One email, whichever provider it came from. Gmail and Outlook map into
 * this; everything downstream (evidence, subject, extraction) is shared.
 *
 * Email is read-only in VC OS. The only write is a draft in your own
 * mailbox, created after you approve it in the outbox. There is no send path.
 */
export interface EmailMessage {
  provider: "gmail" | "outlook";
  id: string;
  threadId?: string;
  from: { name?: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  date?: string;
  body: string;
  webLink?: string;
}

/** Senders at these domains are people, not companies: never infer a company from them. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "fastmail.com", "hey.com", "gmx.com", "zoho.com", "yandex.com",
]);

/** "Maya Lindqvist <maya@kestrelrobotics.com>" -> { name, address }. */
export function parseAddress(raw: string): { name?: string; address: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || undefined, address: m[2]!.trim().toLowerCase() };
  return { address: raw.trim().toLowerCase() };
}

export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => parseAddress(a).address).filter((a) => a.includes("@"));
}

export function senderDomain(m: EmailMessage): string | null {
  const d = normalizeDomain(m.from.address.split("@")[1] ?? "");
  return d && !FREE_MAIL.has(d) ? d : null;
}

/** Plain-text rendering stored as the evidence content. Headers first, so citations can point at them. */
export function emailText(m: EmailMessage): string {
  return [
    `From: ${m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address}`,
    `To: ${m.to.join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.join(", ")}` : "",
    `Subject: ${m.subject}`,
    m.date ? `Date: ${m.date}` : "",
    "",
    m.body.trim(),
  ].filter((l, i) => l !== "" || i === 5).join("\n");
}

const titleCase = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_, sep: string, c: string) => (sep ? " " : "") + c.toUpperCase());

/**
 * An email as confidential evidence. The subject company is the one you name,
 * or else the sender's company domain (never a free-mail domain). Returns a
 * record with no subject when neither is known: stored, not extracted.
 */
export function emailToRecord(m: EmailMessage, opts: { company?: string; companyDomain?: string } = {}): SourceRecord {
  const domain = opts.companyDomain ?? senderDomain(m) ?? undefined;
  const name = opts.company ?? (domain ? titleCase(domain.split(".")[0]!) : undefined);
  return {
    evidence: {
      kind: "email",
      source: m.provider,
      uri: m.webLink ?? `${m.provider}:message:${m.id}`,
      title: m.subject || "(no subject)",
      content: emailText(m),
      occurredAt: m.date,
      accessScope: "confidential",
      metadata: { messageId: m.id, threadId: m.threadId, from: m.from.address },
    },
    subject: name ? { type: "company", name, domain, source: m.provider } : undefined,
    extract: Boolean(name),
  };
}

/** RFC 822 message for a draft. Plain text only. */
export function rfc822(d: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string }): string {
  const headers = [
    `To: ${d.to.join(", ")}`,
    d.cc?.length ? `Cc: ${d.cc.join(", ")}` : "",
    `Subject: ${d.subject.replace(/[\r\n]+/g, " ")}`,
    d.inReplyTo ? `In-Reply-To: ${d.inReplyTo}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  return `${headers.join("\r\n")}\r\n\r\n${d.body.replace(/\r?\n/g, "\r\n")}`;
}
