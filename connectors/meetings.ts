import type { EvidenceInput } from "../ledger/repository.js";
import type { SourceRecord } from "./types.js";

/**
 * What every meeting source produces: who was there, when, and the
 * transcript or notes if the tool keeps them. Calendar sources give the
 * invite (attendees, no words); recorders and notetakers give the words and
 * sometimes no attendee emails. `joinKey` ties the two together: the same
 * Zoom, Meet or Teams link appears on the invite and on the recording.
 *
 * Connectors never decide which company a meeting is about. They report
 * what the tool says; modules/meetings matches it to a company.
 */

export interface MeetingPerson {
  name?: string;
  email?: string;
  /** The person whose account the meeting came from. */
  self?: boolean;
}

export interface MeetingRecord {
  /** Connector id: "google-calendar", "zoom", "granola"... */
  source: string;
  /** The tool's id for this meeting (or this occurrence of a recurring one). */
  externalId: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  organizer?: MeetingPerson;
  attendees: MeetingPerson[];
  /** "zoom:81234567890", "meet:abc-defg-hij", "teams:19:meeting_…@thread.v2". */
  joinKey?: string;
  /** A link back to the meeting in the tool. */
  url?: string;
  /** Speaker-labelled text: "Name: words" per line. */
  transcript?: string;
  /** The tool's own notes or summary. */
  notes?: string;
}

/**
 * The conference behind a join link, wherever it appears (location,
 * description, conference data). Returns the first one found.
 */
export function joinKeyFromText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const zoom = text.match(/https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|w|my|s)\/(\d{9,11})/i);
  if (zoom) return `zoom:${zoom[1]}`;
  const meet = text.match(/https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
  if (meet) return `meet:${meet[1]!.toLowerCase()}`;
  const teams = text.match(/https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/([^/\s"'<>?]+)/i);
  if (teams) {
    try {
      return `teams:${decodeURIComponent(decodeURIComponent(teams[1]!))}`;
    } catch {
      return `teams:${teams[1]}`;
    }
  }
  return undefined;
}

/** Lower-cased, trimmed email, or undefined for anything that isn't one. */
export function cleanEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const e = v.trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : undefined;
}

/** One entry per person: merges by email, then by name, keeping the richest record. */
export function dedupePeople(people: MeetingPerson[]): MeetingPerson[] {
  const out: MeetingPerson[] = [];
  for (const p of people) {
    const email = cleanEmail(p.email);
    const name = p.name?.trim() || undefined;
    if (!email && !name) continue;
    const same = out.find((o) => (email && o.email === email) || (!email && !o.email && name && o.name?.toLowerCase() === name.toLowerCase()));
    if (same) {
      same.name ??= name;
      same.self ||= p.self;
      continue;
    }
    out.push({ name, email, ...(p.self ? { self: true } : {}) });
  }
  return out;
}

/** Transcript segments as "Speaker: text" lines, merging consecutive lines from one speaker. */
export function speakerLines(segments: { speaker?: string; text?: string }[]): string {
  const lines: string[] = [];
  let last: string | undefined;
  for (const s of segments) {
    const text = s.text?.trim();
    if (!text) continue;
    const speaker = s.speaker?.trim() || "Speaker";
    if (speaker === last) lines[lines.length - 1] += ` ${text}`;
    else lines.push(`${speaker}: ${text}`);
    last = speaker;
  }
  return lines.join("\n");
}

export const isoOrUndefined = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** The text VC OS keeps from a meeting: the tool's notes, then the transcript. Null when there are no words. */
export function meetingText(m: MeetingRecord): string | null {
  const parts: string[] = [];
  if (m.notes?.trim()) parts.push(`Notes from ${sourceName(m.source)}:\n${m.notes.trim()}`);
  if (m.transcript?.trim()) parts.push(`Transcript:\n${m.transcript.trim()}`);
  return parts.length ? parts.join("\n\n") : null;
}

const SOURCE_NAMES: Record<string, string> = {
  "google-calendar": "Google Calendar", "google-meet": "Google Meet", "microsoft-teams": "Microsoft Teams",
  zoom: "Zoom", granola: "Granola", fireflies: "Fireflies",
};
const sourceName = (id: string) => SOURCE_NAMES[id] ?? id;

/** Evidence for a meeting's words. Confidential: a founder call is never public. */
export function meetingEvidence(m: MeetingRecord): EvidenceInput | null {
  const content = meetingText(m);
  if (!content) return null;
  return {
    kind: "transcript",
    source: m.source,
    uri: `${m.source}:meeting:${m.externalId}`,
    title: m.title,
    content,
    occurredAt: m.startedAt,
    accessScope: "confidential",
    metadata: { attendees: m.attendees.map((a) => a.name ?? a.email ?? "").filter(Boolean), joinKey: m.joinKey ?? null, url: m.url ?? null },
  };
}

/** For the CLI: one meeting about a company you name. */
export function meetingSourceRecord(m: MeetingRecord, company: { name: string; domain?: string }): SourceRecord {
  const evidence = meetingEvidence(m);
  if (!evidence) throw new Error(`${m.title} has no notes or transcript.`);
  return { evidence, subject: { type: "company", name: company.name, domain: company.domain, source: m.source }, extract: true };
}
