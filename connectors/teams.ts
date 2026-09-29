import { asArray, asString, pick, request, requestJson } from "./http.js";
import { accessToken } from "./oauth.js";
import { vttToText } from "./transcripts.js";
import { cleanEmail, dedupePeople, isoOrUndefined, joinKeyFromText, type MeetingRecord } from "./meetings.js";
import type { FetchLike } from "./types.js";

/**
 * Outlook Calendar and Microsoft Teams through Microsoft Graph.
 *
 * The calendar view gives every meeting with its attendees. For Teams
 * meetings, the join link finds the online meeting and its transcripts
 * (WebVTT). Graph returns transcripts only for meetings the connected
 * person organized, and only when transcription was on; other meetings
 * come through with attendees and no transcript.
 *
 * Delegated permissions: Calendars.Read, OnlineMeetings.Read and
 * OnlineMeetingTranscript.Read.All (the last needs a tenant admin's consent).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Map one Graph calendar event. Pure. Returns null for events that aren't meetings with other people. */
export function parseGraphEvent(e: Record<string, unknown>, selfEmail?: string): MeetingRecord | null {
  if (e.isCancelled === true) return null;
  if (pick(e, "responseStatus.response") === "declined") return null;
  const self = selfEmail?.toLowerCase();
  const organizerEmail = cleanEmail(pick(e, "organizer.emailAddress.address"));
  const people = dedupePeople([
    ...(organizerEmail ? [{ email: organizerEmail, name: asString(pick(e, "organizer.emailAddress.name")), self: organizerEmail === self }] : []),
    ...asArray(e.attendees)
      .filter((a) => a.type !== "resource")
      .map((a) => {
        const email = cleanEmail(pick(a, "emailAddress.address"));
        return { email, name: asString(pick(a, "emailAddress.name")), self: Boolean(email && email === self) };
      }),
  ]);
  if (people.filter((p) => !p.self).length === 0) return null;
  const joinUrl = asString(pick(e, "onlineMeeting.joinUrl"));
  return {
    source: "microsoft-teams",
    externalId: String(e.id),
    title: asString(e.subject) ?? "(no title)",
    startedAt: isoOrUndefined(utc(pick(e, "start.dateTime"))),
    endedAt: isoOrUndefined(utc(pick(e, "end.dateTime"))),
    organizer: organizerEmail ? { email: organizerEmail, name: asString(pick(e, "organizer.emailAddress.name")) } : undefined,
    attendees: people,
    joinKey: joinKeyFromText(joinUrl) ?? joinKeyFromText(asString(pick(e, "location.displayName"))) ?? joinKeyFromText(asString(e.bodyPreview)),
    url: asString(e.webLink),
  };
}

// The calendar view is requested in UTC; Graph omits the zone suffix.
const utc = (v: unknown) => (typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v}Z` : v);

async function transcriptFor(joinUrl: string, headers: Record<string, string>, fetchImpl?: FetchLike): Promise<string | undefined> {
  const filter = encodeURIComponent(`JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`);
  const meetings = await requestJson<{ value?: Record<string, unknown>[] }>("microsoft graph", `${GRAPH}/me/onlineMeetings?$filter=${filter}`, { headers, fetchImpl });
  const meetingId = asString(meetings.value?.[0]?.id);
  if (!meetingId) return undefined;
  const list = await requestJson<{ value?: Record<string, unknown>[] }>("microsoft graph", `${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`, { headers, fetchImpl });
  const texts: string[] = [];
  for (const t of list.value ?? []) {
    const res = await request("microsoft graph", `${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(String(t.id))}/content?$format=text/vtt`, { headers, fetchImpl });
    const text = vttToText(await res.text());
    if (text) texts.push(text);
  }
  return texts.join("\n\n") || undefined;
}

/** Meetings from the connected account's calendar, with Teams transcripts where Graph has them. */
export async function teamsMeetings(since: Date, opts: { until?: Date; fetchImpl?: FetchLike; max?: number } = {}): Promise<MeetingRecord[]> {
  const headers = { Authorization: `Bearer ${await accessToken("microsoft", opts.fetchImpl)}`, Prefer: 'outlook.timezone="UTC"' };
  const me = await requestJson<{ userPrincipalName?: string; mail?: string }>("microsoft graph", `${GRAPH}/me?$select=userPrincipalName,mail`, { headers, fetchImpl: opts.fetchImpl });
  const self = me.mail ?? me.userPrincipalName;
  const select = "subject,start,end,attendees,organizer,onlineMeeting,isOnlineMeeting,isCancelled,responseStatus,location,bodyPreview,webLink";
  let next: string | undefined =
    `${GRAPH}/me/calendarView?startDateTime=${since.toISOString()}&endDateTime=${(opts.until ?? new Date()).toISOString()}&$select=${select}&$top=100&$orderby=start/dateTime`;
  const out: MeetingRecord[] = [];
  while (next && out.length < (opts.max ?? 2000)) {
    const res: { value?: Record<string, unknown>[]; "@odata.nextLink"?: string } = await requestJson("microsoft graph", next, { headers, fetchImpl: opts.fetchImpl });
    for (const e of res.value ?? []) {
      const m = parseGraphEvent(e, self);
      if (!m) continue;
      const joinUrl = asString(pick(e, "onlineMeeting.joinUrl"));
      if (joinUrl && m.joinKey?.startsWith("teams:")) {
        // Not the organizer, or no transcript: keep the meeting without one.
        m.transcript = await transcriptFor(joinUrl, headers, opts.fetchImpl).catch(() => undefined);
      }
      out.push(m);
    }
    next = res["@odata.nextLink"];
  }
  return out;
}

export async function teamsCheck(fetchImpl?: FetchLike): Promise<string> {
  const week = new Date(Date.now() - 7 * 86_400_000);
  const ms = await teamsMeetings(week, { fetchImpl, max: 200 });
  return `${ms.length} meetings in the last 7 days, ${ms.filter((m) => m.transcript).length} with transcripts`;
}
