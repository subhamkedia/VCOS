import { normalizeDomain } from "../lib/text.js";
import { asArray, asString, pick, requestJson } from "./http.js";
import { politeGet, type PoliteOptions } from "./polite.js";
import { today, type CompanyRef } from "./research.js";
import type { SourceRecord } from "./types.js";

/**
 * Open roles from the company's applicant tracking system. The board is
 * found through the company's own website (a link to Greenhouse, Lever or
 * Ashby), never by guessing a slug, so another company's board can't be
 * mistaken for this one's. All three publish job boards through public,
 * unauthenticated APIs. Hiring plans are the company's own statement:
 * self-reported.
 */

export type Ats = "greenhouse" | "lever" | "ashby";

/** The first ATS board linked from a page. Pure. */
export function findAtsBoard(html: string): { ats: Ats; slug: string } | null {
  const patterns: [Ats, RegExp][] = [
    ["greenhouse", /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i],
    ["lever", /https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/i],
    ["ashby", /https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
  ];
  for (const [ats, re] of patterns) {
    const m = html.match(re);
    if (m && !/^(embed|jobs|api)$/i.test(m[1]!)) return { ats, slug: decodeURIComponent(m[1]!) };
  }
  return null;
}

export interface Role {
  title: string;
  team?: string;
  location?: string;
}

/** Normalize each ATS's job list. Pure. */
export function parseRoles(ats: Ats, json: unknown): Role[] {
  const rows =
    ats === "greenhouse" ? asArray((json as { jobs?: unknown }).jobs)
    : ats === "lever" ? asArray(json)
    : asArray((json as { jobs?: unknown }).jobs);
  return rows.flatMap((j) => {
    const title = asString(j.title) ?? asString(j.text);
    if (!title) return [];
    const team = ats === "greenhouse" ? asString(pick(j, "departments.0.name")) : ats === "lever" ? asString(pick(j, "categories.team")) : asString(j.department) ?? asString(j.team);
    const location = ats === "greenhouse" ? asString(pick(j, "location.name")) : ats === "lever" ? asString(pick(j, "categories.location")) : asString(j.location);
    return [{ title, team, location }];
  });
}

const BOARD_API: Record<Ats, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
};

/** Pure. */
export function rolesRecord(company: CompanyRef, board: { ats: Ats; slug: string }, roles: Role[]): SourceRecord {
  const lines = roles.map((r) => `- ${r.title}${r.team ? ` (${r.team})` : ""}${r.location ? `, ${r.location}` : ""}`);
  const countLine = `${roles.length} open roles on ${company.name}'s ${board.ats} job board as of ${today()}.`;
  return {
    evidence: {
      kind: "web_page", source: "jobs", uri: BOARD_API[board.ats](board.slug), title: `${company.name} open roles (${board.ats})`,
      content: `${countLine}\n${lines.join("\n")}`, accessScope: "public", occurredAt: new Date().toISOString(),
    },
    subject: { type: "company", name: company.name, domain: company.domain, source: "jobs" },
    sourceType: "self_reported",
    claims: [{ predicate: "team.open_roles", value: roles.length, asOf: today(), citedText: countLine, confidence: 0.9 }],
  };
}

export async function companyJobs(company: CompanyRef, opts: PoliteOptions = {}): Promise<SourceRecord[]> {
  if (!company.domain) throw new Error(`No website on record for ${company.name}.`);
  const site = `https://${normalizeDomain(company.domain)}`;
  const shared = { ...opts, robotsCache: opts.robotsCache ?? new Map() };
  let board: ReturnType<typeof findAtsBoard> = null;
  for (const path of ["/", "/careers", "/jobs", "/company/careers"]) {
    try {
      board = findAtsBoard(await (await politeGet(site + path, shared)).text());
    } catch {
      continue;
    }
    if (board) break;
  }
  if (!board) return [];
  const roles = parseRoles(board.ats, await requestJson(board.ats, BOARD_API[board.ats](board.slug), { fetchImpl: opts.fetchImpl }));
  return [rolesRecord(company, board, roles)];
}
