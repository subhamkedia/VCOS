import { asArray, asString, pick, requestJson } from "./http.js";
import { accessToken } from "./oauth.js";
import { cleanEmail, dedupePeople, isoOrUndefined, joinKeyFromText, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Google Calendar: the invites. They carry what recorders often don't, the
 * attendees' email addresses, which is how a meeting is matched to a
 * company. Read-only (calendar.events.readonly).
 *
 * Only meetings with at least one other person are kept, and ones the
 * account declined or that were cancelled are skipped.
 */

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Map one Calendar API event. Pure. Returns null for events that aren't meetings with other people. */
export function parseCalendarEvent(e: Record<string, unknown>): MeetingRecord | null {
  if (e.status === "cancelled") return null;
  const attendees = asArray(e.attendees);
  const me = attendees.find((a) => a.self === true);
  if (me?.responseStatus === "declined") return null;
  const people = dedupePeople(
    attendees
      .filter((a) => a.resource !== true)
      .map((a) => ({ name: asString(a.displayName), email: cleanEmail(a.email), self: a.self === true })),
  );
  if (people.filter((p) => !p.self).length === 0) return null;
  const entry = asArray(pick(e, "conferenceData.entryPoints")).find((x) => x.entryPointType === "video");
  const conferenceId = asString(pick(e, "conferenceData.conferenceId"));
  const solution = asString(pick(e, "conferenceData.conferenceSolution.key.type"));
  const joinKey =
    (solution === "hangoutsMeet" && conferenceId ? `meet:${conferenceId.toLowerCase()}` : undefined) ??
    joinKeyFromText(asString(entry?.uri)) ?? joinKeyFromText(asString(e.hangoutLink)) ??
    joinKeyFromText(asString(e.location)) ?? joinKeyFromText(asString(e.description));
  const organizerEmail = cleanEmail(pick(e, "organizer.email"));
  return {
    source: "google-calendar",
    externalId: String(e.id),
    title: asString(e.summary) ?? "(no title)",
    startedAt: isoOrUndefined(pick(e, "start.dateTime") ?? pick(e, "start.date")),
    endedAt: isoOrUndefined(pick(e, "end.dateTime") ?? pick(e, "end.date")),
    organizer: organizerEmail ? { email: organizerEmail, name: asString(pick(e, "organizer.displayName")) } : undefined,
    attendees: people,
    joinKey,
    url: asString(e.htmlLink),
  };
}

/** Meetings from the connected account's primary calendar between `since` and `until` (default now). */
export async function googleCalendarMeetings(since: Date, opts: { until?: Date; fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const headers = { Authorization: `Bearer ${await accessToken("google", opts.fetchImpl)}` };
  const out: MeetingRecord[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      timeMin: since.toISOString(), timeMax: (opts.until ?? new Date()).toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await requestJson<{ items?: Record<string, unknown>[]; nextPageToken?: string }>("google calendar", `${API}?${q}`, { headers, fetchImpl: opts.fetchImpl });
    for (const e of res.items ?? []) {
      const m = parseCalendarEvent(e);
      if (m) out.push(m);
    }
    pageToken = res.nextPageToken;
  } while (pageToken && out.length < (opts.max ?? 2000));
  return out;
}

export async function googleCalendarCheck(fetchImpl?: FetchLike): Promise<string> {
  const week = new Date(Date.now() - 7 * 86_400_000);
  return `${(await googleCalendarMeetings(week, { fetchImpl, max: 250 })).length} meetings with other people in the last 7 days`;
}
