import { requireKey } from "../lib/config.js";
import { asArray, asString, requestJson } from "./http.js";
import { sameCompanyName, today, type CompanyRef } from "./research.js";
import type { FetchLike, SourceRecord } from "./types.js";

/**
 * Granted US patents from the USPTO's PatentsView PatentSearch API
 * (search.patentsview.org, free key in the X-Api-Key header). Patents are
 * looked up by assignee organization and kept only when the assignee is the
 * same company name, so a namesake's patents don't land on this company.
 * A patent grant is a primary source.
 */

const API = "https://search.patentsview.org/api/v1/patent/";

export interface Patent {
  id: string;
  title: string;
  date?: string;
  assignees: string[];
}

/** Parse the patent endpoint's response. Pure. */
export function parsePatents(json: unknown): Patent[] {
  return asArray((json as { patents?: unknown })?.patents).flatMap((p) => {
    const id = asString(p.patent_id) ?? asString(p.patent_number);
    const title = asString(p.patent_title);
    if (!id || !title) return [];
    return [{ id, title, date: asString(p.patent_date), assignees: asArray(p.assignees).map((a) => asString(a.assignee_organization) ?? "").filter(Boolean) }];
  });
}

/** One evidence record listing the company's patents, one claim per patent. Pure. */
export function patentsRecord(company: CompanyRef, patents: Patent[], fetchedAt = new Date().toISOString()): SourceRecord | null {
  const mine = patents.filter((p) => p.assignees.some((a) => sameCompanyName(company, a)));
  if (!mine.length) return null;
  const lines = mine.map((p) => `US ${p.id}: ${p.title} (granted ${p.date ?? "date unknown"}; assignee ${p.assignees.join(", ")})`);
  return {
    evidence: {
      kind: "api_record", source: "uspto", uri: `patentsview:assignee:${company.name}`, title: `USPTO patents assigned to ${company.name}`,
      content: `Granted US patents assigned to ${company.name}, from USPTO PatentsView as of ${today()}:\n${lines.join("\n")}`,
      accessScope: "public", occurredAt: fetchedAt,
    },
    subject: { type: "company", name: company.name, domain: company.domain, source: "uspto" },
    sourceType: "primary",
    claims: mine.map((p, i) => ({ predicate: "ip.patent", value: `US ${p.id}: ${p.title}`, asOf: p.date, citedText: lines[i], confidence: 0.95 })),
  };
}

export async function companyPatents(company: CompanyRef, opts: { fetchImpl?: FetchLike } = {}): Promise<SourceRecord[]> {
  const names = [company.name, ...(company.aliases ?? [])];
  const body = {
    q: { _or: names.map((n) => ({ _text_phrase: { "assignees.assignee_organization": n } })) },
    f: ["patent_id", "patent_title", "patent_date", "assignees.assignee_organization"],
    o: { size: 100 },
    s: [{ patent_date: "desc" }],
  };
  const json = await requestJson("patentsview", API, {
    method: "POST", headers: { "X-Api-Key": requireKey("patentsviewApiKey"), "Content-Type": "application/json" }, body: JSON.stringify(body), fetchImpl: opts.fetchImpl,
  });
  const rec = patentsRecord(company, parsePatents(json));
  return rec ? [rec] : [];
}
