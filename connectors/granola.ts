import { asArray, asString, pick, requestJson } from "./http.js";
import { requireKey } from "../lib/config.js";
import { cleanEmail, dedupePeople, isoOrUndefined, joinKeyFromText, speakerLines, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Granola meeting notes through Granola's public REST API
 * (public-api.granola.ai/v1, API keys start with "grn_", Business and
 * Enterprise plans). A listing returns note ids; each note brings its
 * attendees, calendar event, AI summary and, with include=transcript, the
 * transcript. Granola only returns notes that have a summary and a
 * transcript. Rate limit: 5 requests a second sustained.
 *
 * Field names follow Granola's API reference; run `pnpm connectors --check`
 * once with a real key before relying on it.
 */

const API = "https://public-api.granola.ai/v1";

const headers = () => ({ Authorization: `Bearer ${requireKey("granolaApiKey")}` });

/** Map one full note. Pure. */
export function parseGranolaNote(n: Record<string, unknown>): MeetingRecord {
  const cal = (n.calendar_event ?? {}) as Record<string, unknown>;
  const ownerEmail = cleanEmail(pick(n, "owner.email"));
  const people = dedupePeople([
    ...(ownerEmail ? [{ email: ownerEmail, name: asString(pick(n, "owner.name")), self: true }] : []),
    ...asArray(n.attendees).map((a) => ({ name: asString(a.name), email: cleanEmail(a.email) })),
    ...asArray(cal.invitees).map((a) => ({ name: asString(a.name), email: cleanEmail(a.email) })),
  ]);
  const organiser = cleanEmail(pick(cal, "organiser.email") ?? cal.organiser ?? pick(cal, "organizer.email"));
  const segments = asArray(n.transcript).map((t) => {
    const source = asString(pick(t, "speaker.source")) ?? asString(t.source);
    const name = asString(pick(t, "speaker.name")) ?? (source === "microphone" ? asString(pick(n, "owner.name")) ?? "Me" : "Them");
    return { speaker: name, text: asString(t.text) };
  });
  return {
    source: "granola",
    externalId: String(n.id),
    title: asString(n.title) ?? asString(cal.event_title) ?? "Granola note",
    startedAt: isoOrUndefined(cal.scheduled_start_time ?? n.created_at),
    endedAt: isoOrUndefined(cal.scheduled_end_time),
    organizer: organiser ? { email: organiser } : undefined,
    attendees: people,
    joinKey: joinKeyFromText(asString(cal.conferencing_url) ?? asString(cal.location) ?? asString(cal.description)),
    url: asString(n.web_url) ?? asString(n.url),
    transcript: speakerLines(segments) || undefined,
    notes: asString(n.summary_markdown) ?? asString(n.summary_text) ?? asString(n.summary),
  };
}

/** Notes created since `since`, each fetched in full with its transcript. */
export async function granolaMeetings(since: Date, opts: { fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ created_after: since.toISOString(), page_size: "30" });
    if (cursor) q.set("cursor", cursor);
    const res = await requestJson<{ notes?: Record<string, unknown>[]; hasMore?: boolean; cursor?: string | null }>("granola", `${API}/notes?${q}`, { headers: headers(), fetchImpl: opts.fetchImpl });
    ids.push(...(res.notes ?? []).map((n) => String(n.id)));
    cursor = res.hasMore ? (res.cursor ?? undefined) : undefined;
  } while (cursor && ids.length < (opts.max ?? 500));
  const out: MeetingRecord[] = [];
  for (const id of ids) {
    const note = await requestJson<Record<string, unknown>>("granola", `${API}/notes/${encodeURIComponent(id)}?include=transcript`, { headers: headers(), fetchImpl: opts.fetchImpl });
    out.push(parseGranolaNote(note));
  }
  return out;
}

/** One note, for the CLI: `pnpm ingest granola <note id>`. */
export async function granolaNote(id: string, fetchImpl?: FetchLike): Promise<MeetingRecord> {
  return parseGranolaNote(await requestJson<Record<string, unknown>>("granola", `${API}/notes/${encodeURIComponent(id)}?include=transcript`, { headers: headers(), fetchImpl }));
}

export async function granolaCheck(fetchImpl?: FetchLike): Promise<string> {
  const res = await requestJson<{ notes?: unknown[] }>("granola", `${API}/notes?page_size=1`, { headers: headers(), fetchImpl });
  return `Granola API reachable (${res.notes?.length ? "notes found" : "no notes yet"})`;
}
