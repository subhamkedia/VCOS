import { requireKey } from "../lib/config.js";
import { monthEnd } from "../engines/kpi.js";
import { pick, requestJson } from "./http.js";
import { predicateForMetric } from "./kpi-names.js";
import { sameCompanyName, type CompanyRef } from "./research.js";
import type { FetchLike, SourceRecord, StructuredClaim } from "./types.js";

/**
 * Portfolio monitoring platforms a firm may already use to collect KPIs
 * from founders. VC OS reads the metrics the firm has there and records
 * them as claims (self-reported: the founder submitted them), so switching
 * to VC OS's own requests doesn't lose history. Read only.
 *
 * Standard Metrics: REST API at api.standardmetrics.io/v1, OAuth2 client
 * credentials from the firm's Developer Settings (docs.standardmetrics.io).
 * Visible: REST API at api.visible.vc with a Bearer token; metrics, then
 * each metric's data points (docs.visible.vc).
 *
 * The paths and field names follow each vendor's public documentation and
 * are kept in one place (STANDARD_METRICS_PATHS, VISIBLE_PATHS). Check them
 * with `pnpm connectors` against a live account before relying on them.
 */

export const STANDARD_METRICS = "https://api.standardmetrics.io";
export const STANDARD_METRICS_PATHS = {
  token: "/o/token/",
  companies: "/v1/companies/",
  metrics: (companyId: string) => `/v1/metrics/?company_id=${encodeURIComponent(companyId)}&page_size=500`,
};

export const VISIBLE = "https://api.visible.vc";
export const VISIBLE_PATHS = {
  profiles: "/portfolio_company_profiles",
  metrics: (profileId: string) => `/metrics?filter[portfolio_company_profile_id]=${encodeURIComponent(profileId)}`,
  dataPoints: (metricId: string) => `/data_points?metric_id=${encodeURIComponent(metricId)}`,
};

/** A vendor list payload: an array, or one under a usual key. */
function list(o: unknown): Record<string, unknown>[] {
  if (Array.isArray(o)) return o as Record<string, unknown>[];
  for (const k of ["results", "data", "items", "companies", "metrics", "data_points", "portfolio_company_profiles"]) {
    const v = pick(o, k);
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

export interface VendorPoint {
  metric: string;
  date: string; // YYYY-MM-DD
  value: number;
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** Standard Metrics metric rows: { category or name, date, value }. */
export function parseStandardMetrics(o: unknown): VendorPoint[] {
  return list(o).flatMap((r) => {
    const metric = str(r.category ?? r.name ?? r.metric);
    const date = str(r.date ?? r.period_end ?? r.as_of).slice(0, 10);
    const value = Number(r.value);
    return metric && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) ? [{ metric, date, value }] : [];
  });
}

/** Visible data points for one metric: { date, value }. */
export function parseVisiblePoints(metric: string, o: unknown): VendorPoint[] {
  return list(o).flatMap((r) => {
    const date = str(r.date ?? r.period).slice(0, 10);
    const value = Number(r.value);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) ? [{ metric, date, value }] : [];
  });
}

/** One evidence record with a line per figure; known metrics become claims, the rest stay as evidence. */
export function platformRecord(source: "standard-metrics" | "visible", company: string, points: VendorPoint[], fetchedAt: string): SourceRecord | null {
  if (!points.length) return null;
  const name = source === "visible" ? "Visible" : "Standard Metrics";
  const lines = [`${name}: metrics reported by ${company}, fetched ${fetchedAt.slice(0, 10)}.`];
  const claims: StructuredClaim[] = [];
  for (const p of [...points].sort((a, b) => a.date.localeCompare(b.date) || a.metric.localeCompare(b.metric))) {
    const line = `${p.metric}, ${p.date}: ${p.value}`;
    lines.push(line);
    const predicate = predicateForMetric(p.metric);
    if (!predicate) continue;
    // Monthly flows are dated to the month's last day, like the books.
    const asOf = /\.monthly$/.test(predicate) ? monthEnd(p.date.slice(0, 7)) : p.date;
    claims.push({ predicate, value: p.value, asOf, citedText: line, confidence: 0.85 });
  }
  return {
    evidence: { kind: "api_record", source, uri: `${source}:${company}:${fetchedAt.slice(0, 10)}`, title: `${name}: ${company}`, content: lines.join("\n"), accessScope: "confidential", occurredAt: fetchedAt },
    claims, sourceType: "self_reported",
  };
}

async function smToken(fetchImpl?: FetchLike): Promise<string> {
  const r = await requestJson<{ access_token?: string }>("standard metrics", `${STANDARD_METRICS}${STANDARD_METRICS_PATHS.token}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${requireKey("standardMetricsClientId")}:${requireKey("standardMetricsClientSecret")}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }), fetchImpl,
  });
  if (!r.access_token) throw new Error("Standard Metrics didn't return an access token: check the client id and secret.");
  return r.access_token;
}

/** Metrics Standard Metrics holds for this company (matched by name or website). */
export async function standardMetricsFor(company: CompanyRef, fetchImpl?: FetchLike): Promise<SourceRecord[]> {
  const token = await smToken(fetchImpl);
  const headers = { Authorization: `Bearer ${token}` };
  const companies = list(await requestJson("standard metrics", `${STANDARD_METRICS}${STANDARD_METRICS_PATHS.companies}`, { headers, fetchImpl }));
  const hit = companies.find((c) => sameCompanyName(company, str(c.name)) || (company.domain && str(c.website ?? c.domain).includes(company.domain)));
  if (!hit) return [];
  const points = parseStandardMetrics(await requestJson("standard metrics", `${STANDARD_METRICS}${STANDARD_METRICS_PATHS.metrics(str(hit.id))}`, { headers, fetchImpl }));
  const rec = platformRecord("standard-metrics", company.name, points, new Date().toISOString());
  return rec ? [rec] : [];
}

/** Metrics Visible holds for this company. */
export async function visibleFor(company: CompanyRef, fetchImpl?: FetchLike): Promise<SourceRecord[]> {
  const headers = { Authorization: `Bearer ${requireKey("visibleApiToken")}` };
  const profiles = list(await requestJson("visible", `${VISIBLE}${VISIBLE_PATHS.profiles}`, { headers, fetchImpl }));
  const hit = profiles.find((p) => sameCompanyName(company, str(p.name)) || (company.domain && str(p.website ?? p.domain).includes(company.domain)));
  if (!hit) return [];
  const metrics = list(await requestJson("visible", `${VISIBLE}${VISIBLE_PATHS.metrics(str(hit.id))}`, { headers, fetchImpl }));
  const points: VendorPoint[] = [];
  for (const m of metrics.slice(0, 40)) {
    points.push(...parseVisiblePoints(str(m.name), await requestJson("visible", `${VISIBLE}${VISIBLE_PATHS.dataPoints(str(m.id))}`, { headers, fetchImpl })));
  }
  const rec = platformRecord("visible", company.name, points, new Date().toISOString());
  return rec ? [rec] : [];
}

export async function standardMetricsCheck(fetchImpl?: FetchLike): Promise<string> {
  await smToken(fetchImpl);
  return "Standard Metrics credentials work.";
}

export async function visibleCheck(fetchImpl?: FetchLike): Promise<string> {
  const n = list(await requestJson("visible", `${VISIBLE}${VISIBLE_PATHS.profiles}`, { headers: { Authorization: `Bearer ${requireKey("visibleApiToken")}` }, fetchImpl })).length;
  return `Visible: ${n} portfolio companies.`;
}
