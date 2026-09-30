import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Compliance tables, and the read queries the obligations calendar and the
 * conflicts check need from other modules' tables. Firm-scoped Db only.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface ComplianceProfile {
  adviser_status: "registered" | "era" | "state" | "none";
  cco_email: string | null;
  fiscal_year_end: string;
  require_screening: boolean;
  gift_limit_usd: number;
  updated_by: string | null;
  updated_at: string | null;
}

export async function getComplianceProfile(db: Db): Promise<ComplianceProfile | null> {
  const r = (await db.query<ComplianceProfile>("select adviser_status, cco_email, fiscal_year_end, require_screening, gift_limit_usd, updated_by, updated_at from compliance_profiles")).rows[0];
  return r ? { ...r, gift_limit_usd: Number(r.gift_limit_usd), updated_at: iso(r.updated_at) } : null;
}

export async function saveComplianceProfile(db: Db, p: Omit<ComplianceProfile, "updated_by" | "updated_at">, by: string): Promise<void> {
  await db.query(
    `insert into compliance_profiles(adviser_status, cco_email, fiscal_year_end, require_screening, gift_limit_usd, updated_by) values ($1,$2,$3,$4,$5,$6)
     on conflict (firm_id) do update set adviser_status = excluded.adviser_status, cco_email = excluded.cco_email, fiscal_year_end = excluded.fiscal_year_end,
       require_screening = excluded.require_screening, gift_limit_usd = excluded.gift_limit_usd, updated_by = excluded.updated_by, updated_at = now()`,
    [p.adviser_status, p.cco_email, p.fiscal_year_end, p.require_screening, p.gift_limit_usd, by],
  );
  await audit(db, by, "compliance.profile", undefined, { status: p.adviser_status });
}

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

export interface FilingRow { id: string; form: string; obligation_key: string | null; subject: string | null; filed_on: string; reference: string | null; note: string | null; created_by: string }

export async function insertFiling(db: Db, f: { form: string; obligationKey: string | null; subject: string | null; filedOn: string; reference: string | null; note: string | null }, by: string): Promise<FilingRow> {
  const { rows } = await db.query<FilingRow>(
    "insert into filings(form, obligation_key, subject, filed_on, reference, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, form, obligation_key, subject, filed_on, reference, note, created_by",
    [f.form, f.obligationKey, f.subject, f.filedOn, f.reference, f.note, by],
  );
  await audit(db, by, "compliance.filing", rows[0]!.id, { form: f.form, key: f.obligationKey });
  return { ...rows[0]!, filed_on: day(rows[0]!.filed_on)! };
}

export async function filings(db: Db): Promise<FilingRow[]> {
  const { rows } = await db.query<FilingRow>("select id, form, obligation_key, subject, filed_on, reference, note, created_by from filings order by filed_on desc, created_at desc");
  return rows.map((r) => ({ ...r, filed_on: day(r.filed_on)! }));
}

// ---------------------------------------------------------------------------
// Screenings
// ---------------------------------------------------------------------------

export interface ScreeningRow {
  id: string; deal_id: string; company_id: string; company_name?: string; answers: Record<string, unknown>; outbound: "not_covered" | "notifiable" | "prohibited";
  cfius: "none" | "review" | "declaration_likely"; export_control: "none" | "ear" | "itar"; reasons: string[]; counsel_note: string | null; screened_by: string; created_at: string;
}

export async function insertScreening(db: Db, s: Omit<ScreeningRow, "id" | "created_at" | "screened_by" | "company_name">, by: string): Promise<ScreeningRow> {
  const { rows } = await db.query<ScreeningRow>(
    "insert into screenings(deal_id, company_id, answers, outbound, cfius, export_control, reasons, counsel_note, screened_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *",
    [s.deal_id, s.company_id, JSON.stringify(s.answers), s.outbound, s.cfius, s.export_control, JSON.stringify(s.reasons), s.counsel_note, by],
  );
  await audit(db, by, "compliance.screening", s.deal_id, { outbound: s.outbound, cfius: s.cfius, export: s.export_control });
  return { ...rows[0]!, created_at: iso(rows[0]!.created_at)! };
}

/** The latest screening per deal. */
export async function latestScreenings(db: Db): Promise<ScreeningRow[]> {
  const { rows } = await db.query<ScreeningRow>(
    `select distinct on (s.deal_id) s.*, e.name as company_name from screenings s join entities e on e.id = s.company_id order by s.deal_id, s.created_at desc`,
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Code of ethics
// ---------------------------------------------------------------------------

export interface RestrictedRow { id: string; company_id: string | null; name: string; ticker: string | null; reason: string; added_on: string; added_by: string; removed_on: string | null }

export async function insertRestricted(db: Db, r: { companyId: string | null; name: string; ticker: string | null; reason: string; addedOn: string }, by: string): Promise<void> {
  await db.query("insert into restricted_list(company_id, name, ticker, reason, added_on, added_by) values ($1,$2,$3,$4,$5,$6)", [r.companyId, r.name, r.ticker, r.reason, r.addedOn, by]);
  await audit(db, by, "compliance.restricted.add", r.companyId ?? undefined, { name: r.name });
}

export async function removeRestricted(db: Db, id: string, on: string, by: string): Promise<void> {
  const { rows } = await db.query("update restricted_list set removed_on = $2, removed_by = $3 where id = $1 and removed_on is null returning id", [id, on, by]);
  if (!rows[0]) throw new Error("No such entry on the restricted list.");
  await audit(db, by, "compliance.restricted.remove", id, {});
}

export async function restricted(db: Db, opts: { current?: boolean } = {}): Promise<RestrictedRow[]> {
  const { rows } = await db.query<RestrictedRow>(`select id, company_id, name, ticker, reason, added_on, added_by, removed_on from restricted_list ${opts.current ? "where removed_on is null" : ""} order by name`);
  return rows.map((r) => ({ ...r, added_on: day(r.added_on)!, removed_on: day(r.removed_on) }));
}

export interface ReportRow { id: string; person: string; kind: "holding" | "transaction" | "no_activity"; security: string | null; ticker: string | null; action: string | null; quantity: number | null; traded_on: string | null; account: string | null; period: string; created_at: string }

export async function insertReport(db: Db, r: Omit<ReportRow, "id" | "created_at">): Promise<void> {
  await db.query(
    "insert into personal_reports(person, kind, security, ticker, action, quantity, traded_on, account, period) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [r.person, r.kind, r.security, r.ticker, r.action, r.quantity, r.traded_on, r.account, r.period],
  );
  await audit(db, r.person, `compliance.report.${r.kind}`, undefined, { period: r.period });
}

export async function reports(db: Db, opts: { person?: string } = {}): Promise<ReportRow[]> {
  const { rows } = await db.query<ReportRow>(`select * from personal_reports ${opts.person ? "where person = $1" : ""} order by created_at desc limit 1000`, opts.person ? [opts.person] : []);
  return rows.map((r) => ({ ...r, quantity: num(r.quantity), traded_on: day(r.traded_on), created_at: iso(r.created_at)! }));
}

export interface RequestRow { id: string; person: string; status: "pending" | "logged" | "approved" | "denied"; decided_by: string | null; decided_at: string | null; note: string | null; created_at: string; [k: string]: unknown }

/** Pre-clearances, political contributions and gifts share the decide pattern. */
export type RequestTable = "preclearances" | "political_contributions" | "gifts";

export async function insertRequest(db: Db, table: RequestTable, row: Record<string, unknown>, by: string): Promise<RequestRow> {
  const cols = Object.keys(row);
  const { rows } = await db.query<RequestRow>(
    `insert into ${table}(${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    cols.map((c) => (row[c] !== null && typeof row[c] === "object" ? JSON.stringify(row[c]) : row[c])),
  );
  await audit(db, by, `compliance.${table}.request`, rows[0]!.id, {});
  return rows[0]!;
}

export async function getRequest(db: Db, table: RequestTable, id: string): Promise<RequestRow | null> {
  return (await db.query<RequestRow>(`select * from ${table} where id = $1`, [id])).rows[0] ?? null;
}

export async function decideRequest(db: Db, table: RequestTable, id: string, status: "approved" | "denied", note: string | null, by: string): Promise<void> {
  const pending = table === "gifts" ? "'logged'" : "'pending'";
  const { rows } = await db.query(`update ${table} set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1 and status = ${pending} returning id`, [id, status, by, note]);
  if (!rows[0]) throw new Error("This request is already decided.");
  await audit(db, by, `compliance.${table}.${status}`, id, {});
}

export async function requests(db: Db, table: RequestTable, opts: { person?: string } = {}): Promise<RequestRow[]> {
  const { rows } = await db.query<RequestRow>(`select * from ${table} ${opts.person ? "where person = $1" : ""} order by created_at desc limit 500`, opts.person ? [opts.person] : []);
  return rows.map((r) => {
    const out: RequestRow = { ...r, decided_at: iso(r.decided_at), created_at: iso(r.created_at)! };
    for (const k of ["amount_usd", "value_usd"]) if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
    for (const k of ["contribute_on", "occurred_on"]) if (out[k] instanceof Date) out[k] = day(out[k]);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Conflicts, attestations, marketing reviews
// ---------------------------------------------------------------------------

export interface ConflictRow {
  id: string; kind: string; title: string; detail: string; mitigation: string | null; status: "open" | "mitigated" | "closed"; fund_id: string | null; company_id: string | null;
  lpac_consent_id: string | null; detect_key: string | null; created_by: string; created_at: string; closed_by: string | null; closed_at: string | null;
}

export async function insertConflict(db: Db, c: { kind: string; title: string; detail: string; mitigation?: string | null; fundId?: string | null; companyId?: string | null; lpacConsentId?: string | null; detectKey?: string | null }, by: string): Promise<boolean> {
  const { rows } = await db.query(
    `insert into conflicts(kind, title, detail, mitigation, fund_id, company_id, lpac_consent_id, detect_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (firm_id, detect_key) where detect_key is not null do nothing returning id`,
    [c.kind, c.title, c.detail, c.mitigation ?? null, c.fundId ?? null, c.companyId ?? null, c.lpacConsentId ?? null, c.detectKey ?? null, by],
  );
  if (rows[0]) await audit(db, by, "compliance.conflict", (rows[0] as { id: string }).id, { kind: c.kind });
  return rows.length > 0;
}

export async function updateConflict(db: Db, id: string, p: { mitigation?: string | null; status?: string; lpacConsentId?: string | null }, by: string): Promise<void> {
  const { rows } = await db.query(
    `update conflicts set mitigation = coalesce($2, mitigation), status = coalesce($3, status), lpac_consent_id = coalesce($4, lpac_consent_id),
            closed_by = case when $3 = 'closed' then $5 else closed_by end, closed_at = case when $3 = 'closed' then now() else closed_at end where id = $1 returning id`,
    [id, p.mitigation ?? null, p.status ?? null, p.lpacConsentId ?? null, by],
  );
  if (!rows[0]) throw new Error("No such conflict.");
  await audit(db, by, "compliance.conflict.update", id, { status: p.status });
}

export async function conflicts(db: Db): Promise<ConflictRow[]> {
  const { rows } = await db.query<ConflictRow>("select * from conflicts order by (status = 'open') desc, created_at desc");
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)!, closed_at: iso(r.closed_at) }));
}

export async function insertAttestation(db: Db, a: { person: string; policy: string; year: number; on: string }): Promise<boolean> {
  const { rows } = await db.query("insert into attestations(person, policy, year, attested_on) values ($1,$2,$3,$4) on conflict do nothing returning id", [a.person, a.policy, a.year, a.on]);
  if (rows[0]) await audit(db, a.person, "compliance.attestation", undefined, { policy: a.policy, year: a.year });
  return rows.length > 0;
}

export async function attestations(db: Db, year: number): Promise<{ person: string; policy: string; attested_on: string }[]> {
  const { rows } = await db.query<{ person: string; policy: string; attested_on: string }>("select person, policy, attested_on from attestations where year = $1", [year]);
  return rows.map((r) => ({ ...r, attested_on: day(r.attested_on)! }));
}

export async function insertMarketingReview(db: Db, m: { subjectKind: string; subjectId: string | null; title: string; answers: Record<string, unknown> }, by: string): Promise<void> {
  await db.query("insert into marketing_reviews(subject_kind, subject_id, title, answers, reviewer) values ($1,$2,$3,$4,$5)", [m.subjectKind, m.subjectId, m.title, JSON.stringify(m.answers), by]);
  await audit(db, by, "compliance.marketing_review", m.subjectId ?? undefined, { title: m.title });
}

export async function marketingReviews(db: Db): Promise<{ id: string; subject_kind: string; title: string; reviewer: string; created_at: string }[]> {
  const { rows } = await db.query<{ id: string; subject_kind: string; title: string; reviewer: string; created_at: string }>("select id, subject_kind, title, reviewer, created_at from marketing_reviews order by created_at desc limit 200");
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Facts from other modules, for the calendar and the conflicts check
// ---------------------------------------------------------------------------

/** Each raise's first approved closing (the first sale) and whether it's still offering. */
/**
 * Each raise's date of first sale, for Form D: the day the first investor
 * was irrevocably committed (SEC Form D instructions), taken as when the
 * firm accepted a signed subscription; else the first approved closing.
 */
export async function firstSales(db: Db): Promise<{ fund: string; date: string; stillOffering: boolean }[]> {
  const { rows } = await db.query<{ name: string; first_sale: string; status: string }>(
    `select r.name, r.status, least(
        (select min(greatest(s.signed_on, s.decided_at::date)) from subscriptions s where s.raise_id = r.id and s.status in ('accepted', 'admitted') and s.decided_at is not null),
        (select min(c.closing_date) from closings c where c.raise_id = r.id and c.status = 'approved')
      ) as first_sale
       from raises r`,
  );
  return rows.filter((r) => r.first_sale).map((r) => ({ fund: r.name, date: day(r.first_sale)!, stillOffering: r.status === "open" }));
}

/** Admitted investors' jurisdictions with the date each was admitted, for state notice filings. */
export async function admissions(db: Db): Promise<{ fund: string; jurisdiction: string | null; date: string }[]> {
  const { rows } = await db.query<{ name: string; jurisdiction: string | null; closing_date: string }>(
    `select r.name, s.jurisdiction, c.closing_date from subscriptions s join closings c on c.id = s.closing_id and c.status = 'approved' join raises r on r.id = s.raise_id where s.status = 'admitted'`,
  );
  return rows.map((r) => ({ fund: r.name, jurisdiction: r.jurisdiction, date: day(r.closing_date)! }));
}

/** Deals in closing, for the screening queue. */
export async function dealsInClosing(db: Db): Promise<{ id: string; company_id: string; company_name: string }[]> {
  const { rows } = await db.query<{ id: string; company_id: string; company_name: string }>(
    "select d.id, d.company_id, e.name as company_name from deals d join entities e on e.id = d.company_id where d.stage = 'closing' order by e.name",
  );
  return rows;
}
