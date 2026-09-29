import { asArray, asString, pick, requestJson } from "./http.js";
import { requireKey } from "../lib/config.js";
import { cleanEmail, dedupePeople, isoOrUndefined, joinKeyFromText, speakerLines, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Fireflies.ai transcripts through its GraphQL API (api.fireflies.ai/graphql,
 * Bearer API key). One query returns each meeting's attendees with emails,
 * the speaker-labelled sentences and the summary. At most 50 per page.
 */

const API = "https://api.fireflies.ai/graphql";

const QUERY = `query Transcripts($fromDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
    id title date duration organizer_email meeting_link transcript_url participants
    meeting_attendees { displayName email name }
    summary { overview short_summary action_items }
    sentences { speaker_name text }
  }
}`;

/** Map one transcript. Pure. */
export function parseFirefliesTranscript(t: Record<string, unknown>): MeetingRecord {
  const organizer = cleanEmail(t.organizer_email);
  const start = isoOrUndefined(t.date);
  const minutes = Number(t.duration);
  const summary = [asString(pick(t, "summary.overview")) ?? asString(pick(t, "summary.short_summary")), asString(pick(t, "summary.action_items"))]
    .filter(Boolean).join("\n\nAction items:\n");
  return {
    source: "fireflies",
    externalId: String(t.id),
    title: asString(t.title) ?? "Fireflies meeting",
    startedAt: start,
    endedAt: start && Number.isFinite(minutes) ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : undefined,
    organizer: organizer ? { email: organizer } : undefined,
    attendees: dedupePeople([
      ...asArray(t.meeting_attendees).map((a) => ({ name: asString(a.displayName) ?? asString(a.name), email: cleanEmail(a.email) })),
      ...(Array.isArray(t.participants) ? t.participants : []).map((p) => ({ email: cleanEmail(p) })),
    ]),
    joinKey: joinKeyFromText(asString(t.meeting_link)),
    url: asString(t.transcript_url),
    transcript: speakerLines(asArray(t.sentences).map((s) => ({ speaker: asString(s.speaker_name), text: asString(s.text) }))) || undefined,
    notes: summary || undefined,
  };
}

export async function firefliesMeetings(since: Date, opts: { fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const out: MeetingRecord[] = [];
  for (let skip = 0; skip < (opts.max ?? 500); skip += 50) {
    const res = await requestJson<{ data?: { transcripts?: Record<string, unknown>[] }; errors?: { message: string }[] }>("fireflies", API, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireKey("firefliesApiKey")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { fromDate: since.toISOString(), limit: 50, skip } }),
      fetchImpl: opts.fetchImpl,
    });
    if (res.errors?.length) throw new Error(`fireflies: ${res.errors.map((e) => e.message).join("; ")}`);
    const page = res.data?.transcripts ?? [];
    out.push(...page.map(parseFirefliesTranscript));
    if (page.length < 50) break;
  }
  return out;
}

export async function firefliesCheck(fetchImpl?: FetchLike): Promise<string> {
  const res = await requestJson<{ data?: { user?: { email?: string } }; errors?: { message: string }[] }>("fireflies", API, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireKey("firefliesApiKey")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ user { email } }" }),
    fetchImpl,
  });
  if (res.errors?.length) throw new Error(`fireflies: ${res.errors[0]!.message}`);
  return `Connected as ${res.data?.user?.email ?? "a Fireflies user"}`;
}
