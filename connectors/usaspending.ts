import { asArray, asNumber, asString, requestJson } from "./http.js";
import { sameCompanyName, today, usd, type CompanyRef } from "./research.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Federal contracts and grants from USAspending.gov (API v2, no key).
 * Contracts and grants are separate award-type groups and can't be mixed in
 * one request, so this makes two. Kept only when the recipient is the same
 * company name. Amounts are obligations, not money paid out.
 */

const API = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const FIELDS = ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Awarding Sub Agency", "Start Date", "Description"];
const GROUPS = { contract: ["A", "B", "C", "D"], grant: ["02", "03", "04", "05"] } as const;

export interface FederalAward {
  kind: "contract" | "grant";
  id: string;
  recipient: string;
  amount?: number;
  agency?: string;
  subAgency?: string;
  start?: string;
  description?: string;
}

export function parseAwards(json: unknown, kind: FederalAward["kind"]): FederalAward[] {
  return asArray((json as { results?: unknown })?.results).flatMap((r) => {
    const id = asString(r["Award ID"]);
    const recipient = asString(r["Recipient Name"]);
    if (!id || !recipient) return [];
    return [{
      kind, id, recipient, amount: asNumber(r["Award Amount"]), agency: asString(r["Awarding Agency"]), subAgency: asString(r["Awarding Sub Agency"]),
      start: asString(r["Start Date"]), description: asString(r["Description"]),
    }];
  });
}

/** Pure. */
export function awardsRecord(company: CompanyRef, awards: FederalAward[]): SourceRecord | null {
  const mine = awards.filter((a) => sameCompanyName(company, a.recipient));
  if (!mine.length) return null;
  const line = (a: FederalAward) =>
    `${a.subAgency ?? a.agency ?? "Federal agency"}: ${(a.description ?? a.id).slice(0, 160)}${a.amount ? `, ${usd(a.amount)} obligated` : ""}${a.start ? `, ${a.start.slice(0, 4)}` : ""}`;
  const lines = mine.map(line);
  const claims: StructuredClaim[] = mine.map((a, i) => ({
    predicate: a.kind === "contract" ? "contract.government" : "grant.award", value: lines[i]!, asOf: a.start?.slice(0, 10), citedText: lines[i], confidence: 0.95,
  }));
  return {
    evidence: {
      kind: "api_record", source: "usaspending", uri: `usaspending:recipient:${mine[0]!.recipient}`, title: `Federal awards to ${mine[0]!.recipient}`,
      content: `Federal contracts and grants to ${mine[0]!.recipient}, from USAspending.gov as of ${today()}:\n${lines.join("\n")}`,
      accessScope: "public", occurredAt: new Date().toISOString(),
    },
    subject: { type: "company", name: company.name, domain: company.domain, source: "usaspending" },
    sourceType: "primary",
    claims,
  };
}

export async function companyFederalAwards(company: CompanyRef, opts: { fetchImpl?: FetchLike } = {}): Promise<SourceRecord[]> {
  const all: FederalAward[] = [];
  for (const [kind, codes] of Object.entries(GROUPS) as [FederalAward["kind"], readonly string[]][]) {
    const body = {
      filters: { recipient_search_text: [company.name], award_type_codes: codes, time_period: [{ start_date: "2008-10-01", end_date: today() }] },
      fields: FIELDS, limit: 50, page: 1, sort: "Award Amount", order: "desc",
    };
    all.push(...parseAwards(await requestJson("usaspending", API, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), fetchImpl: opts.fetchImpl,
    }), kind));
  }
  const rec = awardsRecord(company, all);
  return rec ? [rec] : [];
}
