import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { scopedDb } from "../lib/db.js";
import { config } from "../lib/config.js";
import type { Llm } from "../lib/llm.js";
import { testFirm, testRoot } from "./helpers.js";
import { fakeFetch, json } from "./fake-fetch.js";
import { createFirm } from "../ledger/platform.js";
import { createEntity, currentClaims } from "../ledger/repository.js";
import { clearTokenCache } from "../connectors/oauth.js";
import { joinKeyFromText, meetingText, speakerLines, type MeetingRecord } from "../connectors/meetings.js";
import { googleCalendarMeetings, parseCalendarEvent } from "../connectors/google-calendar.js";
import { meetRecord, participantNames } from "../connectors/google-meet.js";
import { parseGraphEvent, teamsMeetings } from "../connectors/teams.js";
import { zoomMeetings, zoomRecord, zoomUuidPath } from "../connectors/zoom.js";
import { parseGranolaNote } from "../connectors/granola.js";
import { parseFirefliesTranscript } from "../connectors/fireflies.js";
import { assignMeeting, ensureSync, markMeeting, meetings, syncMeetings } from "../modules/meetings/index.js";
import { registrableDomain } from "../modules/meetings/match.js";
import { feeds, runFeed } from "../modules/sourcing/index.js";
import { saveProfile, starterProfile } from "../modules/firm/profile.js";
import { runEval } from "../evals/meeting-matcher/run.js";

// All people, companies and ids below are fictional.

beforeAll(() => testRoot());
beforeEach(() => {
  clearTokenCache();
  Object.assign(config, {
    googleClientId: "gid", googleClientSecret: "gsecret", googleRefreshToken: "grefresh",
    msClientId: "mid", msClientSecret: "msecret", msRefreshToken: "mrefresh", msTenant: "common",
    zoomClientId: "zid", zoomClientSecret: "zsecret", zoomRefreshToken: "zrefresh",
  });
});

describe("meeting connectors", () => {
  it("finds the conference behind Zoom, Meet and Teams links", () => {
    expect(joinKeyFromText("Join: https://us02web.zoom.us/j/81234567890?pwd=abc")).toBe("zoom:81234567890");
    expect(joinKeyFromText("https://meet.google.com/abc-defg-hij")).toBe("meet:abc-defg-hij");
    expect(joinKeyFromText("https://teams.microsoft.com/l/meetup-join/19%3ameeting_NTg0%40thread.v2/0?context=x")).toBe("teams:19:meeting_NTg0@thread.v2");
    expect(joinKeyFromText("no link here")).toBeUndefined();
    expect(speakerLines([{ speaker: "Maya", text: "We have" }, { speaker: "Maya", text: "34 people." }, { speaker: "Pat", text: "Great." }])).toBe("Maya: We have 34 people.\nPat: Great.");
  });

  it("reads Google Calendar invites: attendees, the Meet code, and skips what isn't a meeting", () => {
    const e = {
      id: "ev1", status: "confirmed", summary: "Northbeam <> Kestrel", htmlLink: "https://calendar.google.com/x",
      start: { dateTime: "2026-09-10T15:00:00Z" }, end: { dateTime: "2026-09-10T15:45:00Z" },
      organizer: { email: "pat@northbeam.vc" },
      attendees: [
        { email: "pat@northbeam.vc", self: true, responseStatus: "accepted" },
        { email: "Maya@KestrelRobotics.com", displayName: "Maya Lindqvist" },
        { email: "c_188@resource.calendar.google.com", resource: true },
      ],
      conferenceData: { conferenceId: "abc-defg-hij", conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
    };
    const m = parseCalendarEvent(e)!;
    expect(m.joinKey).toBe("meet:abc-defg-hij");
    expect(m.attendees).toEqual([{ email: "pat@northbeam.vc", self: true }, { email: "maya@kestrelrobotics.com", name: "Maya Lindqvist" }]);
    expect(m.startedAt).toBe("2026-09-10T15:00:00.000Z");
    expect(parseCalendarEvent({ ...e, status: "cancelled" })).toBeNull();
    expect(parseCalendarEvent({ ...e, attendees: [{ email: "pat@northbeam.vc", self: true, responseStatus: "declined" }, { email: "x@y.example" }] })).toBeNull();
    expect(parseCalendarEvent({ ...e, attendees: [{ email: "pat@northbeam.vc", self: true }] })).toBeNull(); // focus time
    // A Zoom link in the location.
    expect(parseCalendarEvent({ ...e, conferenceData: undefined, location: "https://zoom.us/j/81234567890" })!.joinKey).toBe("zoom:81234567890");
  });

  it("pages through the calendar with the firm's token", async () => {
    const f = fakeFetch({
      "https://oauth2.googleapis.com/token": json({ access_token: "g-token", expires_in: 3600 }),
      "https://www.googleapis.com/calendar/v3/calendars/primary/events": [
        json({ items: [{ id: "a", summary: "One", start: { dateTime: "2026-09-01T10:00:00Z" }, attendees: [{ email: "me@northbeam.vc", self: true }, { email: "x@acme.example" }] }], nextPageToken: "p2" }),
        json({ items: [{ id: "b", summary: "Two", start: { dateTime: "2026-09-02T10:00:00Z" }, attendees: [{ email: "me@northbeam.vc", self: true }, { email: "y@acme.example" }] }] }),
      ],
    });
    const ms = await googleCalendarMeetings(new Date("2026-08-01"), { fetchImpl: f.impl, until: new Date("2026-09-30") });
    expect(ms.map((m) => m.title)).toEqual(["One", "Two"]);
    expect(f.calls[1]!.url).toContain("singleEvents=true");
    expect(f.calls[2]!.url).toContain("pageToken=p2");
    expect((f.calls[1]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer g-token");
  });

  it("builds Meet transcripts with speaker names", () => {
    const names = participantNames([{ name: "conferenceRecords/c1/participants/p1", signedinUser: { displayName: "Maya Lindqvist" } }, { name: "conferenceRecords/c1/participants/p2", anonymousUser: { displayName: "Guest" } }]);
    const m = meetRecord({ name: "conferenceRecords/c1", startTime: "2026-09-10T15:00:00Z" }, "abc-defg-hij", names, [
      { participant: "conferenceRecords/c1/participants/p1", text: "We're at 34 people." },
      { participant: "conferenceRecords/c1/participants/p2", text: "Thanks." },
    ]);
    expect(m.joinKey).toBe("meet:abc-defg-hij");
    expect(m.transcript).toBe("Maya Lindqvist: We're at 34 people.\nGuest: Thanks.");
  });

  it("reads Outlook events and Teams transcripts through Graph", async () => {
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NTg0%40thread.v2/0";
    const f = fakeFetch({
      "https://login.microsoftonline.com/": json({ access_token: "m-token", expires_in: 3600, refresh_token: "mrefresh" }),
      "https://graph.microsoft.com/v1.0/me?": json({ mail: "pat@northbeam.vc" }),
      "https://graph.microsoft.com/v1.0/me/calendarView": json({
        value: [
          { id: "e1", subject: "Girderline diligence", start: { dateTime: "2026-09-12T14:00:00.0000000" }, end: { dateTime: "2026-09-12T15:00:00.0000000" },
            organizer: { emailAddress: { address: "pat@northbeam.vc", name: "Pat" } },
            attendees: [{ type: "required", emailAddress: { address: "ines@girderline.io", name: "Ines Okafor" } }, { type: "resource", emailAddress: { address: "room@northbeam.vc" } }],
            isOnlineMeeting: true, onlineMeeting: { joinUrl } },
          { id: "e2", subject: "Cancelled", isCancelled: true, attendees: [] },
        ],
      }),
      "https://graph.microsoft.com/v1.0/me/onlineMeetings?": json({ value: [{ id: "om1" }] }),
      "https://graph.microsoft.com/v1.0/me/onlineMeetings/om1/transcripts/t1/content": { body: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ines Okafor>We have 12 sites live.</v>\n" },
      "https://graph.microsoft.com/v1.0/me/onlineMeetings/om1/transcripts": json({ value: [{ id: "t1" }] }),
    });
    const ms = await teamsMeetings(new Date("2026-09-01"), { fetchImpl: f.impl, until: new Date("2026-09-30") });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.startedAt).toBe("2026-09-12T14:00:00.000Z");
    expect(ms[0]!.joinKey).toBe("teams:19:meeting_NTg0@thread.v2");
    expect(ms[0]!.transcript).toBe("Ines Okafor: We have 12 sites live.");
    expect(ms[0]!.attendees.map((a) => a.email)).toEqual(["pat@northbeam.vc", "ines@girderline.io"]);
    expect(f.calls.find((c) => c.url.includes("onlineMeetings?"))!.url).toContain(encodeURIComponent(`JoinWebUrl eq '${joinUrl}'`));
    expect(parseGraphEvent({ id: "x", subject: "Declined", responseStatus: { response: "declined" }, attendees: [{ emailAddress: { address: "a@b.example" } }] })).toBeNull();
  });

  it("downloads Zoom transcripts with the user's token and encodes awkward UUIDs twice", async () => {
    expect(zoomUuidPath("abc==")).toBe("abc%3D%3D");
    expect(zoomUuidPath("/ab//c==")).toBe(encodeURIComponent(encodeURIComponent("/ab//c==")));
    const f = fakeFetch({
      "https://zoom.us/oauth/token": json({ access_token: "z-token", expires_in: 3600, refresh_token: "zrefresh-2" }),
      "https://api.zoom.us/v2/users/me/recordings": json({
        meetings: [{ uuid: "u1==", id: 81234567890, topic: "Kestrel follow-up", start_time: "2026-09-15T16:00:00Z", duration: 30, host_email: "pat@northbeam.vc",
          recording_files: [{ file_type: "MP4", download_url: "https://zoom.us/rec/download/v" }, { file_type: "TRANSCRIPT", download_url: "https://zoom.us/rec/download/t" }] }],
      }),
      "https://zoom.us/rec/download/t": { body: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nMaya Lindqvist: Two paid pilots now.\n" },
      "https://api.zoom.us/v2/past_meetings/": json({ participants: [{ name: "Maya Lindqvist", user_email: "maya@kestrelrobotics.com" }] }),
    });
    const [m] = await zoomMeetings(new Date("2026-09-01"), { fetchImpl: f.impl, until: new Date("2026-09-20") });
    expect(m!.transcript).toBe("Maya Lindqvist: Two paid pilots now.");
    expect(m!.joinKey).toBe("zoom:81234567890");
    expect(m!.endedAt).toBe("2026-09-15T16:30:00.000Z");
    expect(m!.attendees.map((a) => a.email)).toEqual(["pat@northbeam.vc", "maya@kestrelrobotics.com"]);
    const token = f.calls.find((c) => c.url === "https://zoom.us/oauth/token")!;
    expect((token.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("zid:zsecret").toString("base64")}`);
    expect((f.calls.find((c) => c.url.endsWith("/download/t"))!.init?.headers as Record<string, string>).Authorization).toBe("Bearer z-token");
    // Zoom rotated the refresh token: outside a firm (the CLI) it's used for the rest of the process.
    expect(config.zoomRefreshToken).toBe("zrefresh-2");
    expect(zoomRecord({ uuid: "x", topic: "t" }, [], undefined).transcript).toBeUndefined();
  });

  it("maps Granola notes and Fireflies transcripts", () => {
    const g = parseGranolaNote({
      id: "not_1d3t", title: "Kestrel intro", created_at: "2026-09-03T17:00:00Z", owner: { name: "Pat Chen", email: "pat@northbeam.vc" },
      attendees: [{ name: "Maya Lindqvist", email: "maya@kestrelrobotics.com" }],
      calendar_event: { event_title: "Kestrel intro", scheduled_start_time: "2026-09-03T17:00:00Z", organiser: "pat@northbeam.vc" },
      summary_markdown: "- 34 people\n- Two paid pilots",
      transcript: [{ speaker: { source: "speaker" }, text: "We're 34 people." }, { speaker: { source: "microphone" }, text: "Great." }],
    });
    expect(g.transcript).toBe("Them: We're 34 people.\nPat Chen: Great.");
    expect(g.attendees.find((a) => a.self)?.email).toBe("pat@northbeam.vc");
    expect(meetingText(g)).toContain("Notes from Granola:\n- 34 people");
    const ff = parseFirefliesTranscript({
      id: "ff1", title: "Girderline sync", date: 1757692800000, duration: 45, organizer_email: "pat@northbeam.vc", meeting_link: "https://meet.google.com/abc-defg-hij",
      meeting_attendees: [{ displayName: "Ines Okafor", email: "ines@girderline.io" }], sentences: [{ speaker_name: "Ines Okafor", text: "12 sites." }],
      summary: { overview: "Deployment update." },
    });
    expect(ff.joinKey).toBe("meet:abc-defg-hij");
    expect(ff.attendees[0]!.email).toBe("ines@girderline.io");
    expect(ff.notes).toBe("Deployment update.");
  });
});

// ---------------------------------------------------------------------------
// Matching and the Meetings workflow
// ---------------------------------------------------------------------------

const NONE_LLM: Llm & { calls: number } = {
  calls: 0,
  async create() {
    this.calls++;
    return { id: "m", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "NONE", citations: null }] } as unknown as Anthropic.Message;
  },
};

async function firmWithCompanies() {
  const { root, db, firm } = await testFirm("Northbeam");
  const p = await starterProfile("Northbeam");
  await saveProfile(db, { ...p, firm: { ...p.firm, emailDomains: ["northbeam.vc"] } }, "human:pat@northbeam.vc");
  const kestrel = await createEntity(db, { type: "company", name: "Kestrel Robotics", source: "test", identifiers: [{ kind: "domain", value: "kestrelrobotics.com" }] });
  const girder = await createEntity(db, { type: "company", name: "Girderline", source: "test", identifiers: [{ kind: "domain", value: "girderline.io" }] });
  return { root, db, firm, kestrel, girder };
}

const invite = (over: Partial<MeetingRecord> = {}): MeetingRecord => ({
  source: "google-calendar", externalId: "ev1", title: "Northbeam <> Kestrel", startedAt: "2026-09-15T16:00:00.000Z",
  attendees: [{ email: "pat@northbeam.vc", self: true }, { email: "maya@kestrelrobotics.com", name: "Maya Lindqvist" }],
  joinKey: "zoom:81234567890", ...over,
});
const recording = (over: Partial<MeetingRecord> = {}): MeetingRecord => ({
  source: "zoom", externalId: "u1==", title: "Zoom meeting", startedAt: "2026-09-15T16:02:00.000Z",
  attendees: [{ name: "Maya Lindqvist" }, { name: "Pat Chen" }], joinKey: "zoom:81234567890",
  transcript: "Maya Lindqvist: We're 34 people and have two paid pilots.", ...over,
});

describe("meetings workflow", () => {
  it("syncs a connected tool on its own schedule, separately from sourcing feeds", async () => {
    const { db } = await firmWithCompanies();
    const feedId = (await ensureSync(db, "zoom", "human:pat@northbeam.vc"))!;
    expect(await ensureSync(db, "zoom", "human:pat@northbeam.vc")).toBe(feedId); // once
    expect(await ensureSync(db, "harmonic", "x")).toBeNull();
    expect((await feeds(db)).map((f) => f.id)).not.toContain(feedId);
    expect((await feeds(db, { includeMeetings: true })).map((f) => f.id)).toContain(feedId);
  });

  it("matches by attendee domain, and a recording joins its invite through the conference link", async () => {
    const { db, kestrel } = await firmWithCompanies();
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    const zoom = (await ensureSync(db, "zoom", "t"))!;
    NONE_LLM.calls = 0;
    const a = await syncMeetings(db, cal, "t", { list: async () => [invite()], llm: NONE_LLM });
    expect(a.stats).toMatchObject({ new: 1, matched: 1, needsReview: 0 });
    // The recording has names only, no emails: it's matched through the invite.
    const b = await syncMeetings(db, zoom, "t", { list: async () => [recording()], llm: NONE_LLM });
    expect(b.stats).toMatchObject({ new: 1, matched: 1, withWords: 1, extracted: 1 });
    expect(NONE_LLM.calls).toBe(1);
    const rows = await meetings(db, { companyId: kestrel.id });
    expect(rows).toHaveLength(2);
    const rec = rows.find((r) => r.source === "zoom")!;
    expect(rec.match).toMatchObject({ method: "same_conference" });
    expect(rec.has_words).toBe(true);
    expect(rec.extracted).toBe(true);
    // Syncing again changes nothing.
    const again = await syncMeetings(db, zoom, "t", { list: async () => [recording()], llm: NONE_LLM });
    expect(again.stats).toMatchObject({ meetings: 1, new: 0 });
  });

  it("a recording that arrives first waits, then follows its invite", async () => {
    const { db, kestrel } = await firmWithCompanies();
    const zoom = (await ensureSync(db, "zoom", "t"))!;
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    await syncMeetings(db, zoom, "t", { list: async () => [recording()] });
    expect((await meetings(db, { status: "needs_review" }))).toHaveLength(1);
    await syncMeetings(db, cal, "t", { list: async () => [invite()] });
    expect(await meetings(db, { status: "needs_review" })).toHaveLength(0);
    expect(await meetings(db, { companyId: kestrel.id })).toHaveLength(2);
  });

  it("asks a person when unsure, remembers the answer, and matches the next call itself", async () => {
    const { db, girder } = await firmWithCompanies();
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    const personal = invite({ externalId: "ev2", title: "Coffee", joinKey: undefined, attendees: [{ email: "pat@northbeam.vc", self: true }, { email: "ines.okafor@gmail.com", name: "Ines" }] });
    await syncMeetings(db, cal, "t", { list: async () => [personal] });
    const [waiting] = await meetings(db, { status: "needs_review" });
    expect(waiting!.match).toMatchObject({ method: "unknown" });
    const done = await assignMeeting(db, waiting!.id, { companyId: girder.id }, "human:pat@northbeam.vc");
    expect(done).toMatchObject({ status: "matched", company_id: girder.id, matched_by: "human:pat@northbeam.vc" });
    // The same personal address next month: matched without asking.
    const next = await syncMeetings(db, cal, "t", { list: async () => [{ ...personal, externalId: "ev3", startedAt: "2026-10-15T16:00:00Z" }] });
    expect(next.stats.matched).toBe(1);
    const [again] = (await meetings(db, { companyId: girder.id })).filter((m) => m.external_id === "ev3");
    expect(again!.match).toMatchObject({ method: "known_contact" });
  });

  it("creates a company from a new domain, and keeps partner meetings out", async () => {
    const { db } = await firmWithCompanies();
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    await syncMeetings(db, cal, "t", {
      list: async () => [
        invite({ externalId: "new", title: "Intro: Brightforge", joinKey: undefined, attendees: [{ email: "pat@northbeam.vc", self: true }, { email: "ceo@brightforge.example" }] }),
        invite({ externalId: "int", title: "Partner meeting", joinKey: undefined, attendees: [{ email: "pat@northbeam.vc", self: true }, { email: "lee@northbeam.vc" }] }),
      ],
    });
    expect((await meetings(db, { status: "internal" })).map((m) => m.external_id)).toEqual(["int"]);
    const [pending] = await meetings(db, { status: "needs_review" });
    expect(pending!.match).toMatchObject({ newDomain: "brightforge.example" });
    const m = await assignMeeting(db, pending!.id, { newCompany: { name: "Brightforge", domain: "brightforge.example" } }, "human:pat@northbeam.vc");
    expect(m.company_name).toBe("Brightforge");
    await expect(assignMeeting(db, pending!.id, { newCompany: { name: "X", domain: "gmail.com" } }, "human:p")).rejects.toThrow(/personal email/);
    const ignored = await markMeeting(db, pending!.id, "ignored", "human:pat@northbeam.vc");
    expect(ignored).toMatchObject({ status: "ignored", company_id: null });
  });

  it("runs through the scheduler's feed runner too", async () => {
    const { db } = await firmWithCompanies();
    const zoomFeed = (await ensureSync(db, "zoom", "t"))!;
    // No Zoom connection: the run fails cleanly and says why.
    const r = await runFeed(db, zoomFeed, "scheduler");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/zoomRefreshToken|Connect it/);
  });

  it("keeps each firm's meetings to itself", async () => {
    const { root, db } = await firmWithCompanies();
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    await syncMeetings(db, cal, "t", { list: async () => [invite()] });
    const other = scopedDb(root, (await createFirm(root, { name: "Other Fund" })).id);
    expect(await meetings(other)).toEqual([]);
    expect((await other.query<{ n: number }>("select count(*)::int as n from meetings")).rows[0]!.n).toBe(0);
    expect((await other.query<{ n: number }>("select count(*)::int as n from meeting_contacts")).rows[0]!.n).toBe(0);
  });

  it("stores the words as confidential evidence, never public", async () => {
    const { db, kestrel } = await firmWithCompanies();
    const zoom = (await ensureSync(db, "zoom", "t"))!;
    const cal = (await ensureSync(db, "google-calendar", "t"))!;
    await syncMeetings(db, cal, "t", { list: async () => [invite()] });
    await syncMeetings(db, zoom, "t", { list: async () => [recording()] });
    const { rows } = await db.query<{ access_scope: string; kind: string }>("select access_scope, kind from evidence where source = 'zoom'");
    expect(rows).toEqual([{ access_scope: "confidential", kind: "transcript" }]);
    expect(await currentClaims(db, kestrel.id)).toEqual([]); // no Claude: stored, not extracted
  });
});

describe("meeting matcher eval", () => {
  it("passes the gate: no wrong automatic matches, at least 95% right", () => {
    const r = runEval();
    expect(r.cases).toBeGreaterThanOrEqual(20);
    expect(r.wrongAutoMatches).toBe(0);
    expect(r.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(registrableDomain("mail.eu.acme.co.uk")).toBe("acme.co.uk");
  });
});
