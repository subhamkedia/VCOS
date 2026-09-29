import { asArray, asString, pick, requestJson } from "./http.js";
import { accessToken } from "./oauth.js";
import { dedupePeople, isoOrUndefined, speakerLines, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Google Meet transcripts through the Meet REST API (meetings.space.readonly).
 *
 * conferenceRecords → the space's meeting code (so the transcript joins its
 * Calendar invite) → transcripts → entries, with speaker names from the
 * participants list. Meet keeps transcript entries for 30 days after the
 * call, so the sync runs at least daily. Transcription must be turned on in
 * the meeting.
 */

const API = "https://meet.googleapis.com/v2";

async function pages<T>(url: string, key: string, headers: Record<string, string>, fetchImpl?: FetchLike, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const u = new URL(url);
    u.searchParams.set("pageSize", "100");
    if (token) u.searchParams.set("pageToken", token);
    const res = await requestJson<Record<string, unknown>>("google meet", u.toString(), { headers, fetchImpl });
    out.push(...((res[key] as T[] | undefined) ?? []));
    token = asString(res.nextPageToken);
  } while (token && out.length < max);
  return out;
}

/** Participant resource name → display name. Pure. */
export function participantNames(participants: Record<string, unknown>[]): Map<string, string> {
  return new Map(
    participants.map((p) => [
      String(p.name),
      asString(pick(p, "signedinUser.displayName")) ?? asString(pick(p, "anonymousUser.displayName")) ?? asString(pick(p, "phoneUser.displayName")) ?? "Participant",
    ]),
  );
}

/** Build the meeting from one conference record's pieces. Pure. */
export function meetRecord(
  record: Record<string, unknown>,
  meetingCode: string | undefined,
  names: Map<string, string>,
  entries: Record<string, unknown>[],
): MeetingRecord {
  const transcript = speakerLines(entries.map((e) => ({ speaker: names.get(String(e.participant)) ?? "Participant", text: asString(e.text) })));
  return {
    source: "google-meet",
    externalId: String(record.name),
    title: meetingCode ? `Google Meet ${meetingCode}` : "Google Meet call",
    startedAt: isoOrUndefined(record.startTime),
    endedAt: isoOrUndefined(record.endTime),
    attendees: dedupePeople([...names.values()].map((name) => ({ name }))),
    joinKey: meetingCode ? `meet:${meetingCode.toLowerCase()}` : undefined,
    transcript: transcript || undefined,
  };
}

/** Meet calls with a transcript, started since `since`. */
export async function googleMeetTranscripts(since: Date, opts: { fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const headers = { Authorization: `Bearer ${await accessToken("google", opts.fetchImpl)}` };
  const records = await pages<Record<string, unknown>>(
    `${API}/conferenceRecords?filter=${encodeURIComponent(`start_time>="${since.toISOString()}"`)}`, "conferenceRecords", headers, opts.fetchImpl, opts.max ?? 200,
  );
  const out: MeetingRecord[] = [];
  for (const r of records) {
    const transcripts = await pages<Record<string, unknown>>(`${API}/${r.name}/transcripts`, "transcripts", headers, opts.fetchImpl);
    if (!transcripts.length) continue;
    const space = asString(r.space);
    const code = space
      ? asString((await requestJson<Record<string, unknown>>("google meet", `${API}/${space}`, { headers, fetchImpl: opts.fetchImpl }).catch(() => ({} as Record<string, unknown>))).meetingCode)
      : undefined;
    const names = participantNames(await pages<Record<string, unknown>>(`${API}/${r.name}/participants`, "participants", headers, opts.fetchImpl));
    const entries: Record<string, unknown>[] = [];
    for (const t of transcripts) entries.push(...(await pages<Record<string, unknown>>(`${API}/${t.name}/entries`, "transcriptEntries", headers, opts.fetchImpl, 20_000)));
    const m = meetRecord(r, code, names, asArray(entries));
    if (m.transcript) out.push(m);
  }
  return out;
}

export async function googleMeetCheck(fetchImpl?: FetchLike): Promise<string> {
  const headers = { Authorization: `Bearer ${await accessToken("google", fetchImpl)}` };
  const res = await requestJson<{ conferenceRecords?: unknown[] }>("google meet", `${API}/conferenceRecords?pageSize=10`, { headers, fetchImpl });
  return `${res.conferenceRecords?.length ?? 0} recent Meet calls visible`;
}
