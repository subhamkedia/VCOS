import { requireKey, setting } from "../lib/config.js";
import { monthEnd } from "../engines/kpi.js";
import { requestJson } from "./http.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * A portfolio company's accounting system, connected by its founder from
 * the link the firm sends (no VC OS account needed): QuickBooks Online or
 * Xero. VC OS reads the monthly income statement and balance sheet (read
 * only) and records, for each month: revenue, total expenses (cost of
 * revenue plus operating expenses) and cash in bank. Each figure is a claim
 * citing a line of the report as fetched. Net burn and runway are worked
 * out from these in engines/kpi.ts.
 *
 * QuickBooks: OAuth 2.0 (appcenter.intuit.com/connect/oauth2, scope
 * com.intuit.quickbooks.accounting; tokens at
 * oauth.platform.intuit.com/oauth2/v1/tokens/bearer); reports at
 * /v3/company/{realmId}/reports/ProfitAndLoss and /BalanceSheet with
 * summarize_column_by=Month.
 * Xero: OAuth 2.0 with PKCE (login.xero.com/identity/connect/authorize,
 * tokens at identity.xero.com/connect/token); the organisation from
 * api.xero.com/connections, sent as the Xero-tenant-id header; reports at
 * /api.xro/2.0/Reports/ProfitAndLoss and /BalanceSheet with
 * timeframe=MONTH and periods=11. Apps created from 2 March 2026 must use
 * Xero's granular scopes (accounting.reports.profitandloss.read and
 * accounting.reports.balancesheet.read).
 * Both rotate refresh tokens: every refresh returns a new one to store.
 */

export type AccountingProvider = "quickbooks" | "xero";

export const ACCOUNTING_NAMES: Record<AccountingProvider, string> = { quickbooks: "QuickBooks Online", xero: "Xero" };

export const XERO_SCOPES = ["offline_access", "accounting.reports.profitandloss.read", "accounting.reports.balancesheet.read"] as const;
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"] as const;

const QBO_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const XERO_TOKEN = "https://identity.xero.com/connect/token";
const qboBase = () => (setting("quickbooksEnvironment") === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com");

export function accountingConfigured(p: AccountingProvider): boolean {
  return p === "quickbooks"
    ? Boolean(setting("quickbooksClientId") && setting("quickbooksClientSecret"))
    : Boolean(setting("xeroClientId") && setting("xeroClientSecret"));
}

const basic = (p: AccountingProvider) => {
  const id = requireKey(p === "quickbooks" ? "quickbooksClientId" : "xeroClientId");
  const secret = requireKey(p === "quickbooks" ? "quickbooksClientSecret" : "xeroClientSecret");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
};

/** Where to send the founder's browser to connect the books. */
export function accountingAuthorizeUrl(p: AccountingProvider, o: { state: string; redirectUri: string; challenge: string }): string {
  if (p === "quickbooks") {
    const q = new URLSearchParams({ client_id: requireKey("quickbooksClientId"), response_type: "code", scope: QUICKBOOKS_SCOPES.join(" "), redirect_uri: o.redirectUri, state: o.state });
    return `https://appcenter.intuit.com/connect/oauth2?${q}`;
  }
  const q = new URLSearchParams({
    response_type: "code", client_id: requireKey("xeroClientId"), redirect_uri: o.redirectUri, scope: XERO_SCOPES.join(" "), state: o.state,
    code_challenge: o.challenge, code_challenge_method: "S256",
  });
  return `https://login.xero.com/identity/connect/authorize?${q}`;
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

export async function accountingExchangeCode(p: AccountingProvider, o: { code: string; redirectUri: string; verifier: string }, fetchImpl?: FetchLike): Promise<{ accessToken: string; refreshToken: string }> {
  const fields: Record<string, string> = { grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri };
  if (p === "xero") fields.code_verifier = o.verifier;
  const r = await requestJson<TokenResponse>(`${p} oauth`, p === "quickbooks" ? QBO_TOKEN : XERO_TOKEN, {
    method: "POST", headers: { Authorization: basic(p), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields), fetchImpl,
  });
  if (!r.access_token || !r.refresh_token) throw new Error(`${ACCOUNTING_NAMES[p]} didn't return tokens.`);
  return { accessToken: r.access_token, refreshToken: r.refresh_token };
}

/** A fresh access token. Both providers rotate the refresh token: store the one returned. */
export async function accountingRefresh(p: AccountingProvider, refreshToken: string, fetchImpl?: FetchLike): Promise<{ accessToken: string; refreshToken: string }> {
  const r = await requestJson<TokenResponse>(`${p} oauth`, p === "quickbooks" ? QBO_TOKEN : XERO_TOKEN, {
    method: "POST", headers: { Authorization: basic(p), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), fetchImpl,
  });
  if (!r.access_token) throw new Error(`${ACCOUNTING_NAMES[p]}: the connection was revoked or expired. Ask the founder to connect again.`);
  return { accessToken: r.access_token, refreshToken: r.refresh_token ?? refreshToken };
}

/** Xero: the organisation(s) the founder granted. */
export async function xeroTenants(accessToken: string, fetchImpl?: FetchLike): Promise<{ id: string; name: string }[]> {
  const rows = await requestJson<{ tenantId?: string; tenantType?: string; tenantName?: string }[]>("xero", "https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, fetchImpl,
  });
  return (rows ?? []).filter((r) => r.tenantId && (r.tenantType ?? "ORGANISATION") === "ORGANISATION").map((r) => ({ id: r.tenantId!, name: r.tenantName ?? r.tenantId! }));
}

/** QuickBooks: the company's name, for the link's label. */
export async function quickbooksCompanyName(realmId: string, accessToken: string, fetchImpl?: FetchLike): Promise<string | null> {
  try {
    const r = await requestJson<{ CompanyInfo?: { CompanyName?: string } }>("quickbooks", `${qboBase()}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=75`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, fetchImpl,
    });
    return r.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reports -> months
// ---------------------------------------------------------------------------

export interface MonthFigures {
  month: string; // YYYY-MM
  revenue?: number;
  expenses?: number;
  cash?: number;
}

const toNum = (v: unknown) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

type QboColData = { value?: string };
type QboRow = { type?: string; group?: string; Header?: { ColData?: QboColData[] }; Rows?: { Row?: QboRow[] }; Summary?: { ColData?: QboColData[] }; ColData?: QboColData[] };
type QboReport = { Columns?: { Column?: { ColType?: string; MetaData?: { Name?: string; Value?: string }[] }[] }; Rows?: { Row?: QboRow[] } };

/** Month of each money column (skips the account column and the total). */
function qboMonths(r: QboReport): (string | null)[] {
  return (r.Columns?.Column ?? []).map((c) => {
    const start = c.MetaData?.find((m) => m.Name === "StartDate")?.Value;
    const end = c.MetaData?.find((m) => m.Name === "EndDate")?.Value;
    if (c.ColType !== "Money" || !start || !end || start.slice(0, 7) !== end.slice(0, 7)) return null;
    return start.slice(0, 7);
  });
}

function qboGroup(rows: QboRow[] | undefined, group: string): QboRow | undefined {
  for (const r of rows ?? []) {
    if (r.group === group) return r;
    const inner = qboGroup(r.Rows?.Row, group);
    if (inner) return inner;
  }
  return undefined;
}

/** Monthly revenue and expenses from a QuickBooks ProfitAndLoss report summarized by month. */
export function parseQuickbooksPnl(r: QboReport): MonthFigures[] {
  const months = qboMonths(r);
  const sum = (g: string) => qboGroup(r.Rows?.Row, g)?.Summary?.ColData ?? [];
  const income = sum("Income");
  const cogs = sum("COGS");
  const expenses = sum("Expenses");
  const out: MonthFigures[] = [];
  months.forEach((m, i) => {
    if (!m) return;
    const rev = toNum(income[i]?.value);
    const exp = [toNum(cogs[i]?.value), toNum(expenses[i]?.value)];
    out.push({ month: m, revenue: rev, expenses: exp.some((x) => x !== undefined) ? (exp[0] ?? 0) + (exp[1] ?? 0) : undefined });
  });
  return out;
}

/** Month-end cash in bank from a QuickBooks BalanceSheet summarized by month. */
export function parseQuickbooksBalance(r: QboReport): MonthFigures[] {
  const months = qboMonths(r);
  const bank = qboGroup(r.Rows?.Row, "BankAccounts")?.Summary?.ColData ?? [];
  return months.flatMap((m, i) => (m && toNum(bank[i]?.value) !== undefined ? [{ month: m, cash: toNum(bank[i]?.value) }] : []));
}

type XeroCell = { Value?: string };
type XeroRow = { RowType?: string; Title?: string; Cells?: XeroCell[]; Rows?: XeroRow[] };
type XeroReport = { Reports?: { Rows?: XeroRow[] }[] };

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** "30 Jun 2026" -> "2026-06". */
function xeroMonth(v: string | undefined): string | null {
  const m = v?.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  const mm = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}` : null;
}

function xeroRows(r: XeroReport): { header: (string | null)[]; rows: XeroRow[] } {
  const rows = r.Reports?.[0]?.Rows ?? [];
  const header = (rows.find((x) => x.RowType === "Header")?.Cells ?? []).map((c) => xeroMonth(c.Value));
  return { header, rows };
}

/** A summary row whose first cell matches, anywhere in the report. */
function xeroSummary(rows: XeroRow[], label: RegExp): XeroCell[] | undefined {
  for (const r of rows) {
    if ((r.RowType === "SummaryRow" || r.RowType === "Row") && r.Cells && label.test(r.Cells[0]?.Value ?? "")) return r.Cells;
    const inner = r.Rows ? xeroSummary(r.Rows, label) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Monthly revenue and expenses from Xero's ProfitAndLoss with timeframe=MONTH. */
export function parseXeroPnl(r: XeroReport): MonthFigures[] {
  const { header, rows } = xeroRows(r);
  const income = xeroSummary(rows, /^total (trading )?(income|revenue)$/i) ?? [];
  const cos = xeroSummary(rows, /^total cost of (sales|goods sold)$/i) ?? [];
  const opex = xeroSummary(rows, /^total (operating )?expenses$/i) ?? [];
  return header.flatMap((m, i) => {
    if (!m) return [];
    const exp = [toNum(cos[i]?.Value), toNum(opex[i]?.Value)];
    return [{ month: m, revenue: toNum(income[i]?.Value), expenses: exp.some((x) => x !== undefined) ? (exp[0] ?? 0) + (exp[1] ?? 0) : undefined }];
  });
}

/** Month-end cash in bank from Xero's BalanceSheet with timeframe=MONTH. */
export function parseXeroBalance(r: XeroReport): MonthFigures[] {
  const { header, rows } = xeroRows(r);
  const bank = xeroSummary(rows, /^total (bank|cash and cash equivalents)$/i) ?? [];
  return header.flatMap((m, i) => (m && toNum(bank[i]?.Value) !== undefined ? [{ month: m, cash: toNum(bank[i]?.Value) }] : []));
}

export function mergeMonths(...lists: MonthFigures[][]): MonthFigures[] {
  const by = new Map<string, MonthFigures>();
  for (const l of lists) for (const f of l) by.set(f.month, { ...by.get(f.month), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), month: f.month });
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One evidence record per sync: the figures as text, one line each, so every
 * claim cites the exact line it came from. The books are the company's
 * system of record: source type primary.
 */
export function accountingRecord(p: AccountingProvider, months: MonthFigures[], o: { companyName: string; externalId: string; fetchedAt: string }): SourceRecord | null {
  const done = months.filter((m) => m.month < o.fetchedAt.slice(0, 7)); // only closed months
  if (!done.length) return null;
  const lines: string[] = [`${ACCOUNTING_NAMES[p]} reports for ${o.companyName}, fetched ${o.fetchedAt.slice(0, 10)}. Accrual basis; expenses = cost of revenue + operating expenses; cash = bank accounts at month end.`];
  const claims: StructuredClaim[] = [];
  for (const m of done) {
    const at = monthEnd(m.month);
    const add = (predicate: string, label: string, v: number | undefined) => {
      if (v === undefined || v < 0) return;
      const line = `${label}, ${m.month}: ${money(v)}`;
      lines.push(line);
      claims.push({ predicate, value: Math.round(v * 100) / 100, asOf: at, citedText: line, confidence: 0.95 });
    };
    add("revenue.monthly", "Revenue", m.revenue);
    add("expenses.monthly", "Total expenses", m.expenses);
    add("cash.balance", "Cash in bank", m.cash);
  }
  return {
    evidence: {
      kind: "api_record", source: p, uri: `${p}:${o.externalId}:${done[done.length - 1]!.month}:${o.fetchedAt.slice(0, 10)}`,
      title: `${ACCOUNTING_NAMES[p]}: monthly figures to ${done[done.length - 1]!.month}`, content: lines.join("\n"), accessScope: "confidential",
      occurredAt: o.fetchedAt, metadata: { provider: p, externalId: o.externalId },
    },
    claims, sourceType: "primary",
  };
}

const range = (months: number, today: Date) => {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)); // last day of last month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

/** The last twelve closed months from QuickBooks. */
export async function quickbooksMonths(realmId: string, accessToken: string, today = new Date(), fetchImpl?: FetchLike): Promise<MonthFigures[]> {
  const { start, end } = range(12, today);
  const get = (report: string) => requestJson<QboReport>("quickbooks", `${qboBase()}/v3/company/${encodeURIComponent(realmId)}/reports/${report}?${new URLSearchParams({
    start_date: start, end_date: end, summarize_column_by: "Month", accounting_method: "Accrual", minorversion: "75",
  })}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, fetchImpl });
  return mergeMonths(parseQuickbooksPnl(await get("ProfitAndLoss")), parseQuickbooksBalance(await get("BalanceSheet")));
}

/** The last twelve closed months from Xero (the latest month plus 11 comparison periods). */
export async function xeroMonths(tenantId: string, accessToken: string, today = new Date(), fetchImpl?: FetchLike): Promise<MonthFigures[]> {
  const { end } = range(12, today);
  const headers = { Authorization: `Bearer ${accessToken}`, "Xero-tenant-id": tenantId, Accept: "application/json" };
  const pnl = await requestJson<XeroReport>("xero", `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?${new URLSearchParams({
    fromDate: `${end.slice(0, 7)}-01`, toDate: end, periods: "11", timeframe: "MONTH",
  })}`, { headers, fetchImpl });
  const bs = await requestJson<XeroReport>("xero", `https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?${new URLSearchParams({ date: end, periods: "11", timeframe: "MONTH" })}`, { headers, fetchImpl });
  return mergeMonths(parseXeroPnl(pnl), parseXeroBalance(bs));
}

export async function accountingCheck(): Promise<string> {
  const q = accountingConfigured("quickbooks") ? "QuickBooks app configured" : "QuickBooks app not configured";
  const x = accountingConfigured("xero") ? "Xero app configured" : "Xero app not configured";
  return `${q}; ${x}. Founders connect their own books from the portal link.`;
}
