import { asArray, asString, request, requestJson } from "./http.js";
import { accessToken } from "./oauth.js";
import { vttToText } from "./transcripts.js";
import { cleanEmail, dedupePeople, isoOrUndefined, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Zoom cloud recordings through the Zoom REST API (a user-managed OAuth app).
 *
 * Zoom has no transcript endpoint of its own: the transcript is one of the
 * recording's files (file_type TRANSCRIPT, a WebVTT file), downloaded with
 * the user's access token. Participants come from the past-meeting report.
 * Cloud recording with audio transcripts must be on (Pro plan or above).
 *
 * Scopes on the app: cloud_recording:read:list_user_recordings,
 * meeting:read:list_past_participants and user:read:user.
 */

const API = "https://api.zoom.us/v2";

/** Zoom UUIDs that start with "/" or contain "//" must be encoded twice. */
export function zoomUuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

/** Map one recorded meeting, its participants and its transcript text. Pure. */
export function zoomRecord(m: Record<string, unknown>, participants: Record<string, unknown>[], transcriptVtt: string | undefined): MeetingRecord {
  const host = cleanEmail(m.host_email);
  const start = isoOrUndefined(m.start_time);
  const duration = Number(m.duration);
  return {
    source: "zoom",
    externalId: String(m.uuid ?? m.id),
    title: asString(m.topic) ?? "Zoom meeting",
    startedAt: start,
    endedAt: start && Number.isFinite(duration) ? new Date(Date.parse(start) + duration * 60_000).toISOString() : undefined,
    organizer: host ? { email: host } : undefined,
    attendees: dedupePeople([
      ...(host ? [{ email: host, self: true }] : []),
      ...participants.map((p) => ({ name: asString(p.name), email: cleanEmail(p.user_email) })),
    ]),
    joinKey: m.id ? `zoom:${String(m.id).replace(/\s/g, "")}` : undefined,
    url: asString(m.share_url),
    transcript: transcriptVtt ? vttToText(transcriptVtt) || undefined : undefined,
  };
}

/** Recorded meetings with transcripts since `since`. Zoom lists at most 30 days per request, so this walks month by month. */
export async function zoomMeetings(since: Date, opts: { until?: Date; fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const token = await accessToken("zoom", opts.fetchImpl);
  const headers = { Authorization: `Bearer ${token}` };
  const until = opts.until ?? new Date();
  const out: MeetingRecord[] = [];
  for (let from = new Date(since); from < until && out.length < (opts.max ?? 1000); from = new Date(from.getTime() + 30 * 86_400_000)) {
    const to = new Date(Math.min(from.getTime() + 30 * 86_400_000, until.getTime()));
    let next = "";
    do {
      const q = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), page_size: "300" });
      if (next) q.set("next_page_token", next);
      const res = await requestJson<{ meetings?: Record<string, unknown>[]; next_page_token?: string }>("zoom", `${API}/users/me/recordings?${q}`, { headers, fetchImpl: opts.fetchImpl });
      for (const m of res.meetings ?? []) {
        const file = asArray(m.recording_files).find((f) => f.file_type === "TRANSCRIPT" && f.status !== "processing");
        const vtt = file?.download_url
          ? await (await request("zoom", String(file.download_url), { headers, fetchImpl: opts.fetchImpl })).text()
          : undefined;
        const participants = await requestJson<{ participants?: Record<string, unknown>[] }>(
          "zoom", `${API}/past_meetings/${zoomUuidPath(String(m.uuid))}/participants?page_size=300`, { headers, fetchImpl: opts.fetchImpl },
        ).then((r) => r.participants ?? []).catch(() => []);
        out.push(zoomRecord(m, participants, vtt));
      }
      next = res.next_page_token ?? "";
    } while (next);
  }
  return out;
}

export async function zoomCheck(fetchImpl?: FetchLike): Promise<string> {
  const headers = { Authorization: `Bearer ${await accessToken("zoom", fetchImpl)}` };
  const me = await requestJson<{ email?: string }>("zoom", `${API}/users/me`, { headers, fetchImpl });
  return `Connected as ${me.email ?? "a Zoom user"}`;
}
