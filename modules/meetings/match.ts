import { FREE_MAIL } from "../../connectors/email.js";
import type { MeetingPerson } from "../../connectors/meetings.js";
import type { MeetingMatch, MeetingStatus } from "../../ledger/meetings.js";
import { normalizeCompanyName, normalizeDomain } from "../../lib/text.js";

/**
 * Which company is a meeting about? Deterministic, so it can be tested and
 * explained.
 *
 * 1. People outside the firm are the signal. Their email domain (or an
 *    address a person already assigned) points at one company.
 * 2. A company named in the title only supports a match or makes a
 *    suggestion. It never matches on its own: "Kestrel" in a title could be
 *    a prep call about a competitor.
 * 3. Anything ambiguous (two companies, an unknown domain, only personal
 *    addresses) goes to a person to decide. A wrong match would file one
 *    founder's words under another company, so the matcher would rather ask.
 *
 * The meeting-matcher eval (evals/meeting-matcher) holds this to zero wrong
 * automatic matches.
 */

export const MATCHER_VERSION = "meeting-matcher@1";

export interface MatchContext {
  /** The firm's own email domains. */
  firmDomains: Set<string>;
  /** Company by website domain. */
  byDomain: Map<string, { id: string; name: string }>;
  /** Company by an address a person assigned before. */
  byEmail: Map<string, { id: string; name: string }>;
  /** Every company name and alias. */
  names: { id: string; name: string; alias: string }[];
}

export interface MatchOutcome {
  status: MeetingStatus;
  companyId: string | null;
  match: MeetingMatch;
}

/** Calendar rooms, groups and notification senders aren't people. */
const NOT_PEOPLE = /(^|\.)(resource\.calendar\.google\.com|group\.calendar\.google\.com|calendar\.google\.com)$|^(noreply|no-reply|notifications?|calendar|mailer-daemon)@/;

const SECOND_LEVEL = new Set(["co", "com", "ac", "org", "net", "gov", "edu", "ltd", "plc"]);

/** "mail.eu.acme.co.uk" -> "acme.co.uk". Pure. */
export function registrableDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1]!;
  const sld = parts[parts.length - 2]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-take).join(".");
}

export const isFreeMail = (domain: string) => FREE_MAIL.has(domain) || /^(gmx|yandex|yahoo|hotmail|outlook|live|proton)\.[a-z.]+$/.test(domain) || domain === "pm.me" || domain === "qq.com" || domain === "163.com";

/** Words that appear in meeting titles and are never a company. */
const TITLE_NOISE = new Set([
  "intro", "introduction", "call", "sync", "meeting", "catch", "up", "chat", "coffee", "lunch", "dinner", "follow", "demo", "pitch",
  "update", "board", "diligence", "partner", "partners", "ic", "weekly", "monthly", "team", "hold", "prep", "review", "and", "the",
  "with", "for", "of", "x", "vs", "zoom", "meet", "teams", "google", "microsoft", "interview", "office", "hours", "check", "in",
]);

const words = (s: string) => normalizeCompanyName(s).split(" ").filter(Boolean);

/** Companies whose name appears as whole words in a title. Pure. */
export function companiesInTitle(title: string, names: MatchContext["names"]): { id: string; name: string }[] {
  const t = ` ${words(title).join(" ")} `;
  const found = new Map<string, string>();
  for (const n of names) {
    const w = words(n.alias);
    if (!w.length || w.every((x) => TITLE_NOISE.has(x))) continue;
    const phrase = w.join(" ");
    // One short word is too easy to hit by accident ("Arc", "Loop").
    if (w.length === 1 && phrase.length < 4) continue;
    if (t.includes(` ${phrase} `)) found.set(n.id, n.name);
  }
  return [...found].map(([id, name]) => ({ id, name }));
}

export function matchMeeting(m: { title: string; attendees: MeetingPerson[]; organizer?: MeetingPerson }, ctx: MatchContext): MatchOutcome {
  const people = [...m.attendees, ...(m.organizer ? [m.organizer] : [])];
  const reasons: string[] = [];
  const firm = new Set([...ctx.firmDomains].map(registrableDomain));
  const external: { email: string; domain: string; name?: string }[] = [];
  let internalCount = 0;
  for (const p of people) {
    const email = p.email?.toLowerCase();
    if (!email || NOT_PEOPLE.test(email)) continue;
    const domain = normalizeDomain(email);
    if (!domain) continue;
    if (p.self || firm.has(registrableDomain(domain))) {
      internalCount++;
      continue;
    }
    if (!external.some((x) => x.email === email)) external.push({ email, domain, name: p.name });
  }
  const inTitle = companiesInTitle(m.title, ctx.names);

  // Who points where.
  const votes = new Map<string, { name: string; why: string[] }>();
  const vote = (c: { id: string; name: string }, why: string) => {
    const v = votes.get(c.id) ?? { name: c.name, why: [] };
    if (!v.why.includes(why)) v.why.push(why);
    votes.set(c.id, v);
  };
  const unknownDomains = new Set<string>();
  for (const x of external) {
    const known = ctx.byEmail.get(x.email);
    if (known) {
      vote(known, `${x.email} was assigned to ${known.name} before`);
      continue;
    }
    if (isFreeMail(x.domain)) continue;
    const reg = registrableDomain(x.domain);
    const byDomain = ctx.byDomain.get(x.domain) ?? ctx.byDomain.get(reg);
    if (byDomain) vote(byDomain, `${x.email} is at ${reg}, ${byDomain.name}'s domain`);
    else unknownDomains.add(reg);
  }

  const candidates = (extra: { id: string; name: string; why: string }[] = []) => {
    const out = [...votes].map(([entityId, v]) => ({ entityId, name: v.name, why: v.why.join("; ") }));
    for (const e of extra) if (!out.some((o) => o.entityId === e.id)) out.push({ entityId: e.id, name: e.name, why: e.why });
    return out;
  };
  const titleCands = inTitle.map((c) => ({ ...c, why: `"${c.name}" is in the title` }));

  if (!external.length) {
    const unknownPeople = people.filter((p) => !p.email && !p.self && p.name);
    if (internalCount > 0 && unknownPeople.length === 0) {
      // Only the firm's own people: a partner meeting or prep, not a founder call.
      return {
        status: "internal", companyId: null,
        match: { method: "internal", confidence: 0.9, reasons: ["Everyone invited is from your firm."], candidates: candidates(titleCands) },
      };
    }
    reasons.push("No attendee email addresses to go on.");
    if (inTitle.length) reasons.push(`The title names ${inTitle.map((c) => c.name).join(", ")}.`);
    return { status: "needs_review", companyId: null, match: { method: "none", confidence: 0, reasons, candidates: candidates(titleCands) } };
  }

  if (votes.size === 1) {
    const [id, v] = [...votes][0]!;
    const otherInTitle = inTitle.filter((c) => c.id !== id);
    if (otherInTitle.length) {
      reasons.push(...v.why, `But the title names ${otherInTitle.map((c) => c.name).join(", ")}.`);
      return { status: "needs_review", companyId: null, match: { method: "conflict", confidence: 0.5, reasons, candidates: candidates(titleCands) } };
    }
    const titleAgrees = inTitle.some((c) => c.id === id);
    reasons.push(...v.why);
    if (unknownDomains.size) {
      reasons.push(`Also invited: people at ${[...unknownDomains].join(", ")}, not in your ledger.`);
      // The call may be about the company nobody has recorded yet (a portfolio
      // founder sitting in on a new founder's pitch). Only the title settles it.
      if (!titleAgrees) {
        const newDomain = unknownDomains.size === 1 ? [...unknownDomains][0] : undefined;
        return { status: "needs_review", companyId: null, match: { method: "partial", confidence: 0.6, reasons, candidates: candidates(titleCands), newDomain } };
      }
    }
    if (titleAgrees) reasons.push(`The title names ${v.name} too.`);
    const byContact = v.why.every((w) => w.includes("assigned to"));
    return {
      status: "matched", companyId: id,
      match: { method: byContact ? "known_contact" : "email_domain", confidence: titleAgrees ? 0.98 : 0.93, reasons, candidates: candidates() },
    };
  }

  if (votes.size > 1) {
    const named = [...votes.keys()].filter((id) => inTitle.some((c) => c.id === id));
    reasons.push(`People from ${votes.size} companies in your ledger were invited.`);
    return { status: "needs_review", companyId: null, match: { method: "several", confidence: named.length === 1 ? 0.6 : 0.3, reasons, candidates: candidates(titleCands) } };
  }

  // No company in the ledger matches anyone invited.
  const newDomain = unknownDomains.size === 1 ? [...unknownDomains][0] : undefined;
  if (newDomain) reasons.push(`Invited people are at ${newDomain}, which isn't in your ledger yet.`);
  else if (unknownDomains.size > 1) reasons.push(`Invited people are at ${[...unknownDomains].join(", ")}.`);
  else reasons.push("Everyone outside the firm used a personal email address.");
  if (inTitle.length) reasons.push(`The title names ${inTitle.map((c) => c.name).join(", ")}.`);
  return {
    status: "needs_review", companyId: null,
    match: { method: inTitle.length ? "title" : "unknown", confidence: inTitle.length === 1 ? 0.5 : 0.2, reasons, candidates: candidates(titleCands), newDomain },
  };
}
