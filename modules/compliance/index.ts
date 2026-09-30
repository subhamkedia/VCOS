import type { Db } from "../../lib/db.js";
import {
  admissions, attestations, conflicts, decideRequest, dealsInClosing, filings, firstSales, getComplianceProfile, getRequest, insertAttestation, insertConflict, insertFiling,
  insertReport, insertRequest, insertRestricted, insertScreening, latestScreenings, marketingReviews, removeRestricted, reports, requests, restricted, saveComplianceProfile,
  updateConflict, type ComplianceProfile, type RequestTable,
} from "../../ledger/compliance.js";
import { listInvestments } from "../../ledger/execution.js";
import { getDeal } from "../../ledger/diligence.js";
import { expenses, funds } from "../../ledger/lp.js";
import { consents } from "../../ledger/fundraising.js";
import { currentClaims, getEntity } from "../../ledger/repository.js";
import { COMPLIANCE_LABELS } from "../../ledger/labels.js";
import { cfius, MARKETING_CHECKLIST, obligations, outbound, payToPlay, type CfiusAnswers, type Facts, type OutboundAnswers } from "../../engines/compliance.js";
import { searchFormD, type FormDHit } from "../../connectors/edgar.js";
import { overview as lpOverview } from "../lp/index.js";
import { publicHoldings } from "../../ledger/exits.js";

/**
 * Compliance, as a layer every module shares. It knows the adviser's
 * regulatory status and builds the year's obligations from what the other
 * modules record (Fundraising's closings and investors' states for Form D
 * and state notices, Execution's closed deals for outbound notices,
 * LP Reporting's funds for Form PF). It screens deals before they close
 * (Execution calls it), reviews marketing before investors see it
 * (Fundraising calls it), and runs the code of ethics, pay-to-play, gifts,
 * conflicts and attestations. It flags and records; the CCO and counsel
 * decide.
 */

export class ComplianceInvalid extends Error {}
export { ComplianceBlocked, assertScreeningCleared, marketingGate } from "./gate.js";
export { MARKETING_CHECKLIST };

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const money = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(String(v).replace(/[^0-9.]/g, "")));

const DEFAULTS: ComplianceProfile = { adviser_status: "era", cco_email: null, fiscal_year_end: "12-31", require_screening: true, gift_limit_usd: 250, updated_by: null, updated_at: null };

export async function profile(db: Db): Promise<ComplianceProfile & { configured: boolean }> {
  const p = await getComplianceProfile(db);
  return { ...(p ?? DEFAULTS), configured: Boolean(p) };
}

export async function setProfile(db: Db, input: Record<string, unknown>, by: string) {
  const status = String(input.adviserStatus ?? "era");
  if (!(status in COMPLIANCE_LABELS.adviserStatus)) throw new ComplianceInvalid("Pick the adviser's regulatory status.");
  const fye = String(input.fiscalYearEnd ?? "12-31");
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(fye)) throw new ComplianceInvalid("Enter the fiscal year end as MM-DD.");
  const cco = text(input.ccoEmail);
  if (cco && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cco)) throw new ComplianceInvalid("Check the CCO's email.");
  await saveComplianceProfile(db, {
    adviser_status: status as ComplianceProfile["adviser_status"], cco_email: cco, fiscal_year_end: fye,
    require_screening: input.requireScreening !== false, gift_limit_usd: money(input.giftLimitUsd) ?? 250,
  }, by);
}

// ---------------------------------------------------------------------------
// Obligations and filings
// ---------------------------------------------------------------------------

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL",
  georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "puerto rico": "PR", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CODES = new Set(Object.values(STATES));

/** "US, Pennsylvania", "US-PA", "Pennsylvania" or "PA" → "PA"; anything non-US → null. */
export function usState(j: string | null): string | null {
  if (!j) return null;
  const parts = j.split(/[,\-–/]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && !/^(us|usa|united states)$/i.test(parts[0]!)) return null;
  const last = parts[parts.length - 1]!;
  if (CODES.has(last.toUpperCase())) return last.toUpperCase();
  return STATES[last.toLowerCase()] ?? null;
}

/** Listed holdings from Portfolio's exits: 5% or more for Schedule 13G, and insiders (a director, or over 10%) for Form 3. */
async function listedFacts(db: Db): Promise<Facts["publicHoldings"]> {
  const out: Facts["publicHoldings"] = [];
  for (const h of await publicHoldings(db)) {
    const pct = h.shares_outstanding ? (h.shares / h.shares_outstanding) * 100 : 0;
    if (pct >= 5 || h.affiliate) out.push({ company: `${h.company_name ?? "Company"} (${h.ticker})`, crossed: h.listed_on, pct, insider: h.affiliate || pct > 10 });
  }
  return out;
}

async function facts(db: Db, p: ComplianceProfile, extra: Partial<Facts> = {}): Promise<Facts> {
  const lp = await lpOverview(db);
  const aum = lp.funds.reduce((a, f) => a + f.nav + Math.max(0, f.commitments - f.called), 0);
  const stateFirst = new Map<string, { fund: string; state: string; date: string }>();
  for (const a of await admissions(db)) {
    const st = usState(a.jurisdiction);
    if (!st) continue;
    const k = `${a.fund}|${st}`;
    const prev = stateFirst.get(k);
    if (!prev || a.date < prev.date) stateFirst.set(k, { fund: a.fund, state: st, date: a.date });
  }
  const invs = await listInvestments(db);
  const outboundNotifiable = (await latestScreenings(db)).filter((s) => s.outbound === "notifiable").flatMap((s) => {
    const i = invs.filter((x) => x.deal_id === s.deal_id).sort((a, b) => a.close_date.localeCompare(b.close_date))[0];
    return i ? [{ company: s.company_name ?? "Company", closed: i.close_date }] : [];
  });
  return {
    status: p.adviser_status, fiscalYearEnd: p.fiscal_year_end, privateFundAumUsd: aum, firstSales: await firstSales(db), stateSales: [...stateFirst.values()],
    outboundNotifiable, publicHoldings: await listedFacts(db), ...extra,
  };
}

/**
 * The last twelve months' open items and what's due over the next year and
 * a bit, each marked done, overdue or upcoming. A recorded filing closes an
 * obligation; the code of ethics reports close once every access person on
 * the team has filed for the period, and until then the item says who hasn't.
 */
const OFFERING_FORMS = new Set(["form_d", "blue_sky"]);

export async function calendar(db: Db, opts: { extra?: Partial<Facts>; team?: string[] } = {}) {
  const p = await profile(db);
  const f = await facts(db, p, opts.extra);
  const y = Number(today().slice(0, 4));
  const done = new Map((await filings(db)).filter((x) => x.obligation_key).map((x) => [x.obligation_key!, x]));
  const now = today();
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const yearAhead = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
  const team = opts.team ?? [];
  const filed = new Map<string, Set<string>>();
  if (team.length) for (const r of await reports(db)) filed.set(r.period, (filed.get(r.period) ?? new Set()).add(r.person));
  const owing = (key: string): string[] | null => {
    if (!team.length) return null;
    const m = /^txn_q(\d)_(\d{4})$/.exec(key) ?? /^holdings_(\d{4})$/.exec(key);
    if (!m) return null;
    const period = m.length === 3 ? `${m[2]}-Q${m[1]}` : m[1]!;
    return team.filter((person) => !filed.get(period)?.has(person));
  };
  return [...obligations(f, y - 1), ...obligations(f, y), ...obligations(f, y + 1)]
    .filter((o, i, all) => all.findIndex((x) => x.key === o.key) === i)
    .map((o) => {
      const filing = done.get(o.key) ?? null;
      const missing = owing(o.key);
      const complete = Boolean(filing) || (missing !== null && missing.length === 0);
      return { ...o, filing, waitingOn: missing && missing.length ? missing : null, state: complete ? "done" : o.due < now ? "overdue" : "upcoming" };
    })
    // An offering's own filings stay until filed, however late; the firm-wide cycle shows the last year
    // and the year ahead (further out is noise until it comes closer).
    .filter((o) => (o.state === "done" ? o.due >= `${y - 1}-10-01` : o.due >= yearAgo || (o.state === "overdue" && OFFERING_FORMS.has(o.form))))
    .filter((o) => o.due <= yearAhead);
}

export async function recordFiling(db: Db, input: Record<string, unknown>, by: string) {
  const form = String(input.form ?? "");
  if (!(form in COMPLIANCE_LABELS.forms)) throw new ComplianceInvalid("Pick the form.");
  if (!isDay(input.filedOn)) throw new ComplianceInvalid("Enter the date it was filed.");
  return insertFiling(db, { form, obligationKey: text(input.obligationKey), subject: text(input.subject), filedOn: input.filedOn, reference: text(input.reference), note: text(input.note) }, by);
}

/** Look a fund's Form D up on EDGAR, to confirm it was filed and get the accession number. */
export async function findFormD(fundName: string, deps: { search?: (q: string) => Promise<FormDHit[]> } = {}) {
  const name = fundName.trim();
  if (!name) throw new ComplianceInvalid("Enter the fund's name as filed.");
  const hits = await (deps.search ?? ((q: string) => searchFormD(q)))(name);
  return hits.slice(0, 10).map((h) => ({ name: h.name, cik: h.cik, accession: h.adsh, filedOn: h.fileDate, url: `https://www.sec.gov/Archives/edgar/data/${Number(h.cik)}/${h.adsh.replace(/-/g, "")}/` }));
}

// ---------------------------------------------------------------------------
// Regulatory screening of deals
// ---------------------------------------------------------------------------

export async function screenDeal(db: Db, dealId: string, input: Record<string, unknown>, by: string) {
  const deal = await getDeal(db, dealId);
  if (!deal) throw new ComplianceInvalid("No such deal.");
  const ob = (input.outbound ?? {}) as Partial<OutboundAnswers>;
  const cf = (input.cfius ?? {}) as Partial<CfiusAnswers>;
  const sector = ["semiconductors", "quantum", "ai", "none"].includes(String(ob.sector)) ? (ob.sector as OutboundAnswers["sector"]) : "none";
  const o = outbound({ countryOfConcern: ob.countryOfConcern === true, sector, semisAdvanced: ob.semisAdvanced === true, aiProhibited: ob.aiProhibited === true, aiNotifiable: ob.aiNotifiable === true, excepted: ob.excepted === true });
  const exportControl = ["none", "ear", "itar"].includes(String(input.exportControl)) ? (input.exportControl as "none" | "ear" | "itar") : "none";
  const c = cfius({ criticalTechnology: cf.criticalTechnology === true || exportControl !== "none", infrastructureOrData: cf.infrastructureOrData === true, foreignRights: cf.foreignRights === true, restrictedCountry: cf.restrictedCountry === true });
  const note = text(input.counselNote);
  if (c.result !== "none" && !note) throw new ComplianceInvalid("CFIUS may apply: record counsel's view (who, and what they advised).");
  const reasons = [o.reason, c.reason, exportControl === "itar" ? "ITAR: the company's defense articles or services need State Department authorization for foreign persons, including employees (deemed exports)." : exportControl === "ear" ? "EAR-controlled items: check licenses for foreign-national employees (deemed exports) and foreign customers." : "No export-controlled items reported."];
  // The answers are kept: a notifiable transaction's Treasury filing needs them.
  return insertScreening(db, { deal_id: dealId, company_id: deal.company_id, answers: { outbound: ob, cfius: cf, exportControl }, outbound: o.result, cfius: c.result, export_control: exportControl, reasons, counsel_note: note }, by);
}

// ---------------------------------------------------------------------------
// Code of ethics
// ---------------------------------------------------------------------------

/** Companies where the firm may hold material nonpublic information and whose securities trade: board seats, and portfolio companies that have gone public. */
export async function restrictedSuggestions(db: Db) {
  const listed = new Set((await restricted(db, { current: true })).map((r) => r.company_id));
  const invs = await listInvestments(db);
  const out: { companyId: string; name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const h of await publicHoldings(db)) {
    if (seen.has(h.company_id) || listed.has(h.company_id)) continue;
    out.push({ companyId: h.company_id, name: h.company_name ?? h.ticker, reason: `Listed as ${h.ticker}${h.affiliate ? "; we're an affiliate (a board seat or control)" : ""}: we may hold inside information` });
    seen.add(h.company_id);
  }
  for (const i of invs) {
    if (seen.has(i.company_id) || listed.has(i.company_id)) continue;
    const status = (await currentClaims(db, i.company_id, { predicates: ["company.status"] })).pop();
    if (status?.value === "ipo") { out.push({ companyId: i.company_id, name: i.company_name ?? "Company", reason: "Public portfolio company" }); seen.add(i.company_id); }
    else if (i.board_role === "seat" || i.board_role === "observer") { out.push({ companyId: i.company_id, name: i.company_name ?? "Company", reason: `We hold a board ${i.board_role === "seat" ? "seat" : "observer seat"}: watch for a listing or a public acquirer` }); seen.add(i.company_id); }
  }
  return out;
}

export async function addRestricted(db: Db, input: Record<string, unknown>, by: string) {
  const companyId = text(input.companyId);
  const name = text(input.name) ?? (companyId ? (await getEntity(db, companyId))?.name ?? null : null);
  if (!name) throw new ComplianceInvalid("Name the company or security.");
  const reason = text(input.reason);
  if (!reason) throw new ComplianceInvalid("Say why it's restricted (for example, a board seat or confidential deal information).");
  await insertRestricted(db, { companyId, name, ticker: text(input.ticker)?.toUpperCase() ?? null, reason, addedOn: isDay(input.addedOn) ? input.addedOn : today() }, by);
}

export async function dropRestricted(db: Db, id: string, by: string) {
  await removeRestricted(db, id, today(), by);
}

const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

/** A person's holdings report (initial or annual) or quarterly transactions, or a statement of no reportable activity. */
export async function fileReport(db: Db, person: string, input: { kind?: unknown; period?: unknown; items?: unknown }) {
  const kind = String(input.kind ?? "");
  if (!["holding", "transaction", "no_activity"].includes(kind)) throw new ComplianceInvalid("Pick the kind of report.");
  const period = text(input.period) ?? (kind === "holding" ? today().slice(0, 4) : quarterOf(today()));
  if (kind === "no_activity") {
    await insertReport(db, { person, kind, security: null, ticker: null, action: null, quantity: null, traded_on: null, account: null, period });
    return { filed: 1 };
  }
  const items = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : [];
  if (!items.length) throw new ComplianceInvalid("Add at least one security, or report no activity.");
  for (const it of items) {
    const security = text(it.security);
    if (!security) throw new ComplianceInvalid("Each line needs the security's name.");
    if (kind === "transaction" && !isDay(it.tradedOn)) throw new ComplianceInvalid(`Enter the trade date for ${security}.`);
    const action = ["buy", "sell", "hold", "other"].includes(String(it.action)) ? String(it.action) : kind === "holding" ? "hold" : "other";
    await insertReport(db, { person, kind: kind as "holding" | "transaction", security, ticker: text(it.ticker)?.toUpperCase() ?? null, action, quantity: money(it.quantity), traded_on: isDay(it.tradedOn) ? it.tradedOn : null, account: text(it.account), period });
  }
  return { filed: items.length };
}

const matches = (name: string, ticker: string | null, r: { name: string; ticker: string | null }) =>
  (ticker && r.ticker && ticker.toUpperCase() === r.ticker.toUpperCase()) || r.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(r.name.toLowerCase());

/** Ask to buy a listed security, an IPO or a private placement. Rule 204A-1 requires approval for IPOs and private placements. */
export async function requestPreclearance(db: Db, person: string, input: Record<string, unknown>) {
  const kind = String(input.kind ?? "");
  if (!(kind in COMPLIANCE_LABELS.preclearanceKinds)) throw new ComplianceInvalid("Pick what you want to buy.");
  const security = text(input.security);
  if (!security) throw new ComplianceInvalid("Name the security.");
  const ticker = text(input.ticker);
  const hit = (await restricted(db, { current: true })).some((r) => matches(security, ticker, r));
  return insertRequest(db, "preclearances", { person, kind, security, ticker: ticker?.toUpperCase() ?? null, amount_usd: money(input.amountUsd), reason: text(input.reason), restricted_hit: hit }, person);
}

async function decide(db: Db, table: RequestTable, id: string, input: { approve?: unknown; note?: unknown }, by: string) {
  const r = await getRequest(db, table, id);
  if (!r) throw new ComplianceInvalid("No such request.");
  if (r.person === by) throw new ComplianceInvalid("Someone other than the person who asked decides.");
  const note = text(input.note);
  if (input.approve === true && table === "preclearances" && r.restricted_hit && !note) throw new ComplianceInvalid("This security is on the restricted list: say why it's approved anyway.");
  if (input.approve !== true && !note) throw new ComplianceInvalid("Say why it's denied.");
  await decideRequest(db, table, id, input.approve === true ? "approved" : "denied", note, by);
}

export const decidePreclearance = (db: Db, id: string, input: { approve?: unknown; note?: unknown }, by: string) => decide(db, "preclearances", id, input, by);

// ---------------------------------------------------------------------------
// Pay to play and gifts
// ---------------------------------------------------------------------------

/** Pre-clear a political contribution. Rule 206(4)-5 applies to registered and exempt reporting advisers (the SEC proposed rescinding it in September 2026; it applies until it's rescinded). */
export async function requestContribution(db: Db, person: string, input: Record<string, unknown>) {
  const recipient = text(input.recipient);
  const office = text(input.office);
  const jurisdiction = text(input.jurisdiction);
  const election = text(input.election);
  if (!recipient || !office || !jurisdiction || !election) throw new ComplianceInvalid("Say who it's for, the office, the state or city, and which election (primary and general are separate).");
  const amount = money(input.amountUsd);
  if (!amount || amount <= 0) throw new ComplianceInvalid("Enter the amount.");
  if (!isDay(input.contributeOn)) throw new ComplianceInvalid("Enter the date you plan to give.");
  const prior = (await requests(db, "political_contributions", { person })).filter((c) => c.status !== "denied" && c.recipient === recipient && c.election === election).reduce((a, c) => a + Number(c.amount_usd), 0);
  const res = payToPlay({ amountUsd: amount, priorSameElectionUsd: prior, canVote: input.canVote === true, influencesGovernmentInvestor: input.influencesGovernmentInvestor !== false });
  const row = await insertRequest(db, "political_contributions", {
    person, recipient, office, jurisdiction, election, amount_usd: amount, can_vote: input.canVote === true, influences_gov: input.influencesGovernmentInvestor !== false,
    contribute_on: input.contributeOn, result: res,
  }, person);
  return { request: row, result: res };
}

export const decideContribution = (db: Db, id: string, input: { approve?: unknown; note?: unknown }, by: string) => decide(db, "political_contributions", id, input, by);

export async function logGift(db: Db, person: string, input: Record<string, unknown>) {
  const direction = input.direction === "given" ? "given" : "received";
  const kind = input.kind === "entertainment" ? "entertainment" : "gift";
  const counterparty = text(input.counterparty);
  const description = text(input.description);
  if (!counterparty || !description) throw new ComplianceInvalid("Say who it's with and what it was.");
  const value = money(input.valueUsd);
  if (value === null || value < 0) throw new ComplianceInvalid("Enter the value (an estimate is fine).");
  const p = await profile(db);
  const over = value > p.gift_limit_usd;
  const row = await insertRequest(db, "gifts", { person, direction, kind, counterparty, description, value_usd: value, occurred_on: isDay(input.occurredOn) ? input.occurredOn : today(), over_limit: over }, person);
  return { gift: row, overLimit: over, limit: p.gift_limit_usd };
}

export const decideGift = (db: Db, id: string, input: { approve?: unknown; note?: unknown }, by: string) => decide(db, "gifts", id, input, by);

// ---------------------------------------------------------------------------
// Conflicts and attestations
// ---------------------------------------------------------------------------

/** Find conflicts the records already show: a company held by more than one fund, related-party charges, LPAC conflict consents. */
export async function detectConflicts(db: Db, by: string) {
  let added = 0;
  const byCompany = new Map<string, { name: string; funds: Set<string> }>();
  for (const i of await listInvestments(db)) {
    const e = byCompany.get(i.company_id) ?? { name: i.company_name ?? "Company", funds: new Set<string>() };
    e.funds.add(i.fund_name);
    byCompany.set(i.company_id, e);
  }
  for (const [companyId, e] of byCompany) {
    if (e.funds.size < 2) continue;
    if (await insertConflict(db, { kind: "cross_fund", title: `${e.name} is held by ${[...e.funds].join(" and ")}`, detail: "Investing from more than one fund in the same company can favor one fund's investors over the other's (price, seniority, follow-on rights). Most LPAs require LPAC consent.", companyId, detectKey: `cross_fund:${companyId}:${[...e.funds].sort().join("|")}` }, by)) added++;
  }
  for (const f of await funds(db)) {
    const rp = (await expenses(db, f.id)).filter((x) => x.related_party);
    if (rp.length && await insertConflict(db, { kind: "related_party", title: `Related-party charges to ${f.name}`, detail: `${rp.length} charge${rp.length === 1 ? "" : "s"} from the GP or an affiliate: ${rp.map((x) => x.description).slice(0, 3).join("; ")}. Disclose them to investors and check the LPA allows them.`, fundId: f.id, detectKey: `related_party:${f.id}:${rp.length}` }, by)) added++;
    for (const c of (await consents(db, f.id)).filter((x) => x.kind === "conflict")) {
      if (await insertConflict(db, { kind: "cross_fund", title: c.topic, detail: c.detail, fundId: f.id, lpacConsentId: c.id, mitigation: c.status === "approved" ? "Approved by the LPAC." : null, detectKey: `lpac:${c.id}` }, by)) added++;
    }
  }
  return { added };
}

export async function addConflict(db: Db, input: Record<string, unknown>, by: string) {
  const kind = String(input.kind ?? "other");
  if (!(kind in COMPLIANCE_LABELS.conflictKinds)) throw new ComplianceInvalid("Pick the kind of conflict.");
  const title = text(input.title);
  const detail = text(input.detail);
  if (!title || !detail) throw new ComplianceInvalid("Describe the conflict: who's on each side, and what could go wrong.");
  await insertConflict(db, { kind, title, detail, mitigation: text(input.mitigation), fundId: text(input.fundId), companyId: text(input.companyId) }, by);
}

export async function resolveConflict(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const status = input.status === undefined ? undefined : String(input.status);
  if (status && !(status in COMPLIANCE_LABELS.conflictStatus)) throw new ComplianceInvalid("Pick the status.");
  const mitigation = text(input.mitigation);
  if ((status === "mitigated" || status === "closed") && !mitigation && !(await conflicts(db)).find((c) => c.id === id)?.mitigation) throw new ComplianceInvalid("Say how it's mitigated: disclosure, LPAC consent, recusal, or a change to the deal.");
  await updateConflict(db, id, { mitigation, status }, by);
}

export async function attest(db: Db, person: string, input: { policy?: unknown; year?: unknown }) {
  const policy = String(input.policy ?? "");
  if (!(policy in COMPLIANCE_LABELS.policies)) throw new ComplianceInvalid("Pick the policy.");
  const year = Number(input.year ?? today().slice(0, 4));
  return { recorded: await insertAttestation(db, { person, policy, year, on: today() }) };
}

// ---------------------------------------------------------------------------
// Everything, for the Compliance page
// ---------------------------------------------------------------------------

/**
 * Personal trading, contributions and gifts are private: a reviewer (a
 * partner acting as CCO) sees everyone's; anyone else sees only their own.
 */
export async function overview(db: Db, ctx: { person: string; team: string[]; reviewer: boolean }) {
  const p = await profile(db);
  const year = Number(today().slice(0, 4));
  const screenings = await latestScreenings(db);
  const inClosing = await dealsInClosing(db);
  const att = await attestations(db, year);
  const policies = p.adviser_status === "registered" ? ["code_of_ethics", "compliance_manual", "insider_trading"] : ["code_of_ethics", "insider_trading"];
  const mine = ctx.reviewer ? {} : { person: ctx.person };
  return {
    profile: p,
    labels: COMPLIANCE_LABELS,
    marketingChecklist: MARKETING_CHECKLIST,
    calendar: await calendar(db, { team: ctx.team }),
    filings: await filings(db),
    screenings,
    needsScreening: inClosing.filter((d) => !screenings.some((s) => s.deal_id === d.id)),
    restricted: await restricted(db),
    restrictedSuggestions: await restrictedSuggestions(db),
    reviewer: ctx.reviewer,
    person: ctx.person,
    reports: await reports(db, mine),
    preclearances: await requests(db, "preclearances", mine),
    contributions: await requests(db, "political_contributions", mine),
    gifts: await requests(db, "gifts", mine),
    conflicts: await conflicts(db),
    attestations: { year, policies, done: att, missing: (ctx.reviewer ? ctx.team : [ctx.person]).flatMap((person) => policies.filter((pol) => !att.some((a) => a.person === person && a.policy === pol)).map((pol) => ({ person, policy: pol }))) },
    marketingReviews: await marketingReviews(db),
  };
}
