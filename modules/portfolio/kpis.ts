import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { decrypt, encrypt } from "../../lib/secrets.js";
import { parseCsv } from "../../lib/csv.js";
import { predicateLabel } from "../../ledger/labels.js";
import { audit } from "../../ledger/repository.js";
import { accountingLinks, accountingSecret, kpiRequests, updateAccountingLink, updateKpiRequest } from "../../ledger/portfolio.js";
import { monthEnd } from "../../engines/kpi.js";
import { ingest } from "../../connectors/ingest.js";
import { CONNECTORS, type ResearchTarget } from "../../connectors/registry.js";
import { predicateForMetric, REPORTABLE_METRICS } from "../../connectors/kpi-names.js";
import {
  accountingRecord, accountingRefresh, quickbooksMonths, xeroMonths, type AccountingProvider, type MonthFigures,
} from "../../connectors/accounting.js";
import type { SourceRecord, StructuredClaim } from "../../connectors/types.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { researchTarget } from "../diligence/gather.js";
import { holding, isMonth, PortfolioInvalid } from "./common.js";

/**
 * Getting a portfolio company's numbers into the ledger, every way a firm
 * does it: the founder's accounting system (the best source: the books),
 * the founder portal and KPI requests, the firm entering numbers from a
 * board deck or an email, a spreadsheet, the monitoring platform the firm
 * already uses (Standard Metrics, Visible), and founder update emails
 * (read by the extractor when a model is configured). Every figure is a
 * claim citing where it came from; when two sources give the same month,
 * the books win (engines/kpi.ts).
 */

const reportable = new Set<string>(REPORTABLE_METRICS);

const valueText = (predicate: string, v: number) =>
  /gross_margin|nrr|uptime/.test(predicate) ? `${v}%` : /headcount|count|units/.test(predicate) ? String(v) : `$${v.toLocaleString("en-US")}`;

/**
 * Numbers for one month, from the firm (read off a board deck, an email) or
 * from the founder in the portal. Stored as a note that lists each figure,
 * so every claim cites its line.
 */
export async function recordKpis(
  db: Db,
  companyId: string,
  input: { period: unknown; values: unknown; note?: unknown },
  by: string,
  via: "entered" | "portal" = "entered",
): Promise<{ evidenceId: string; claims: number; rejected: { predicate: string; reason: string }[] }> {
  const h = await holding(db, companyId);
  if (!isMonth(input.period)) throw new PortfolioInvalid("Pick the month (YYYY-MM).");
  if (input.period > new Date().toISOString().slice(0, 7)) throw new PortfolioInvalid("That month hasn't happened yet: report plans as plan figures in the current month.");
  const values = (input.values && typeof input.values === "object" ? input.values : {}) as Record<string, unknown>;
  const figures: [string, number][] = [];
  for (const [predicate, raw] of Object.entries(values)) {
    if (raw === "" || raw === null || raw === undefined) continue;
    if (!reportable.has(predicate)) throw new PortfolioInvalid(`${predicate} isn't a metric companies report here.`);
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,%\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw new PortfolioInvalid(`${predicateLabel(predicate)}: enter a number, zero or more.`);
    if (/gross_margin|nrr|uptime/.test(predicate) && n > 1000) throw new PortfolioInvalid(`${predicateLabel(predicate)} looks wrong: enter a percent.`);
    figures.push([predicate, n]);
  }
  if (!figures.length) throw new PortfolioInvalid("Enter at least one number.");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 5000) : "";
  const who = via === "portal" ? "the founder, in the VC OS portal" : by.replace(/^human:/, "");
  const lines = [`${h.name}: figures for ${input.period}, reported by ${who}.`];
  const claims: StructuredClaim[] = [];
  const asOf = monthEnd(input.period);
  for (const [predicate, n] of figures) {
    const line = `${predicateLabel(predicate)}, ${input.period}: ${valueText(predicate, n)}`;
    lines.push(line);
    claims.push({ predicate, value: n, asOf, citedText: line, confidence: via === "portal" ? 0.9 : 0.85 });
  }
  if (note) lines.push("", `Notes: ${note}`);
  const rec: SourceRecord = {
    evidence: {
      kind: "note", source: via === "portal" ? "founder-portal" : "kpi-entry", uri: `kpis:${companyId}:${input.period}:${Date.now()}`,
      title: `${h.name} KPIs, ${input.period}`, content: lines.join("\n"), accessScope: "confidential", occurredAt: new Date().toISOString(),
      metadata: { companyId, period: input.period, via },
    },
    claims, sourceType: "self_reported",
  };
  const out = await ingest(db, rec, { subjectId: companyId });
  // The request for this month, if there was one, is answered.
  const open = (await kpiRequests(db, { companyId, status: "open" })).find((r) => r.period === input.period);
  if (open) await updateKpiRequest(db, open.id, { status: "received", evidenceId: out.evidence.id }, by);
  return { evidenceId: out.evidence.id, claims: out.structuredClaims, rejected: out.structuredRejected };
}

/**
 * A spreadsheet export: one row per month ("Month" column, then a column per
 * metric), or one row per figure ("Metric", "Month", "Value"). Column names
 * are matched to metrics (MRR, Cash, Burn, Headcount...); unknown ones are
 * kept in the file but not recorded as figures.
 */
export async function importKpiCsv(db: Db, companyId: string, file: { name: string; text: string }, by: string) {
  const h = await holding(db, companyId);
  const rows = parseCsv(file.text).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) throw new PortfolioInvalid("The file has no data rows.");
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const monthOf = (v: string): string | null => {
    const s = v.trim();
    const iso = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
    const us = s.match(/^(\d{1,2})\/(\d{4})$/);
    const month = iso ? `${iso[1]}-${iso[2]!.padStart(2, "0")}` : us ? `${us[2]}-${us[1]!.padStart(2, "0")}` : null;
    return month && isMonth(month) ? month : null;
  };
  const num = (v: string) => {
    const n = Number(v.replace(/[$,%\s]/g, ""));
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const claims: StructuredClaim[] = [];
  const unknown = new Set<string>();
  const lines = text(file.text);
  const metricCol = header.findIndex((c) => ["metric", "kpi", "name"].includes(c));
  const monthCol = header.findIndex((c) => ["month", "period", "date"].includes(c));
  if (monthCol < 0) throw new PortfolioInvalid("Add a Month column (YYYY-MM).");
  rows.slice(1).forEach((r, i) => {
    const line = lines[i + 1] ?? "";
    const month = monthOf(r[monthCol] ?? "");
    if (!month) return;
    const push = (name: string, raw: string) => {
      const predicate = predicateForMetric(name);
      const n = num(raw);
      if (!predicate) { if (name.trim()) unknown.add(name.trim()); return; }
      if (n === null || n < 0) return;
      claims.push({ predicate, value: n, asOf: monthEnd(month), citedText: line.trim() || undefined, confidence: 0.85 });
    };
    if (metricCol >= 0) {
      const valueCol = header.findIndex((c) => c === "value" || c === "amount");
      if (valueCol >= 0) push(r[metricCol] ?? "", r[valueCol] ?? "");
    } else {
      header.forEach((col, j) => { if (j !== monthCol) push(rows[0]![j] ?? col, r[j] ?? ""); });
    }
  });
  if (!claims.length) throw new PortfolioInvalid(`No figures recognized. Name columns like Revenue, MRR, ARR, Cash, Burn, Expenses, Headcount, Customers.`);
  const out = await ingest(db, {
    evidence: { kind: "document", source: "kpi-file", uri: `file:${file.name}:${Date.now()}`, title: `${h.name} KPIs: ${file.name}`, content: file.text.slice(0, 500_000), accessScope: "confidential", occurredAt: new Date().toISOString(), metadata: { companyId } },
    claims, sourceType: "self_reported",
  }, { subjectId: companyId });
  return { evidenceId: out.evidence.id, claims: out.structuredClaims, rejected: out.structuredRejected.length, ignoredColumns: [...unknown] };
}

// The raw lines of a CSV, for citations (parseCsv loses the original text).
function text(t: string): string[] {
  return t.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  id: string;
  name: string;
  status: "ok" | "empty" | "skipped" | "failed";
  claims: number;
  detail?: string;
}

export interface SyncDeps {
  llm?: Llm;
  /** For tests: replace a source's network call. */
  run?: Record<string, (t: ResearchTarget) => Promise<SourceRecord[]>>;
  accounting?: (p: AccountingProvider, externalId: string, refreshToken: string) => Promise<{ months: MonthFigures[]; refreshToken: string }>;
  now?: Date;
}

async function fetchBooks(p: AccountingProvider, externalId: string, refreshToken: string, now: Date) {
  const t = await accountingRefresh(p, refreshToken);
  const months = p === "quickbooks" ? await quickbooksMonths(externalId, t.accessToken, now) : await xeroMonths(externalId, t.accessToken, now);
  return { months, refreshToken: t.refreshToken };
}

/**
 * Refresh one company's numbers from everything connected: its books (each
 * accounting link the founder made), the firm's monitoring platform, and
 * founder updates in the firm's mailbox. Each source runs with the firm's
 * own credentials; a refresh token the provider rotates is saved at once.
 */
export async function syncCompany(db: Db, companyId: string, by: string, deps: SyncDeps = {}): Promise<SyncResult[]> {
  const h = await holding(db, companyId);
  const now = deps.now ?? new Date();
  const out: SyncResult[] = [];
  for (const l of await accountingLinks(db, companyId)) {
    if (l.status === "revoked") continue;
    const name = l.provider === "quickbooks" ? "QuickBooks Online" : "Xero";
    try {
      const s = await accountingSecret(db, l.id);
      if (!s) continue;
      const res = await (deps.accounting ?? ((p, id, rt) => fetchBooks(p, id, rt, now)))(l.provider, l.external_id, decrypt(s.secret));
      await updateAccountingLink(db, l.id, { secret: encrypt(res.refreshToken) });
      const rec = accountingRecord(l.provider, res.months, { companyName: h.name, externalId: l.external_id, fetchedAt: now.toISOString() });
      const r = rec ? await ingest(db, rec, { subjectId: companyId }) : null;
      await updateAccountingLink(db, l.id, { synced: true, error: null, status: "active" });
      out.push({ id: l.provider, name, status: r && r.structuredClaims ? "ok" : "empty", claims: r?.structuredClaims ?? 0, detail: r?.duplicate ? "No new figures." : undefined });
    } catch (err) {
      const msg = (err as Error).message;
      await updateAccountingLink(db, l.id, { error: msg });
      out.push({ id: l.provider, name, status: "failed", claims: 0, detail: msg });
    }
  }
  const target = await researchTarget(db, companyId);
  for (const c of CONNECTORS.filter((x) => x.portfolio && !x.portfolio.perCompany)) {
    const run = deps.run?.[c.id] ?? c.portfolio!.run;
    if (!run) continue;
    if (!deps.run?.[c.id] && !(await isReady(db, c.id))) {
      out.push({ id: c.id, name: c.name, status: "skipped", claims: 0, detail: "Not connected." });
      continue;
    }
    if (c.portfolio!.needsDomain && !target.domain) {
      out.push({ id: c.id, name: c.name, status: "skipped", claims: 0, detail: "Needs the company's website domain." });
      continue;
    }
    try {
      const recs = (await (deps.run?.[c.id] ? run(target) : withFirmCredentials(db, [c.id], () => run(target)))).slice(0, 40);
      let claims = 0;
      for (const rec of recs) claims += (await ingest(db, rec, { llm: deps.llm, subjectId: companyId })).structuredClaims;
      out.push({ id: c.id, name: c.name, status: recs.length ? "ok" : "empty", claims, detail: recs.length ? `${recs.length} ${recs.length === 1 ? "item" : "items"}` : undefined });
    } catch (err) {
      out.push({ id: c.id, name: c.name, status: "failed", claims: 0, detail: (err as Error).message });
    }
  }
  await audit(db, by, "portfolio.sync", companyId, { sources: out.map((r) => `${r.id}:${r.status}`) });
  return out;
}
