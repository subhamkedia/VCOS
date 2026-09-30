import type { Db } from "../lib/db.js";
import { audit } from "./repository.js";

/**
 * Fundraising and investor relations tables: raises, prospects and their
 * activity, the data room, the DDQ library, subscriptions, closings and
 * equalization, side letters and MFN elections, the LPAC and investor
 * requests. Firm-scoped Db only.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Build "update ... set a = $2, b = $3" from a patch of column: value, skipping undefined. */
function sets(patch: Record<string, unknown>, first = 2): { sql: string; params: unknown[] } {
  const cols = Object.entries(patch).filter(([, v]) => v !== undefined);
  return { sql: cols.map(([k], i) => `${k} = $${i + first}`).join(", "), params: cols.map(([, v]) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v)) };
}

// ---------------------------------------------------------------------------
// Raises
// ---------------------------------------------------------------------------

export interface RaiseRow {
  id: string;
  name: string;
  fund_id: string | null;
  target_usd: number;
  hard_cap_usd: number | null;
  min_commitment_usd: number | null;
  exemption: "3c1" | "3c1_qvcf" | "3c7";
  offering: "506b" | "506c";
  vcoc: boolean;
  equalization_rate_pct: number;
  first_close_target: string | null;
  final_close_deadline: string | null;
  status: "open" | "closed";
  created_by: string;
  created_at: string;
}

const raise = (r: RaiseRow): RaiseRow => ({
  ...r, target_usd: Number(r.target_usd), hard_cap_usd: num(r.hard_cap_usd), min_commitment_usd: num(r.min_commitment_usd), equalization_rate_pct: Number(r.equalization_rate_pct),
  first_close_target: day(r.first_close_target), final_close_deadline: day(r.final_close_deadline), created_at: iso(r.created_at)!,
});

export async function insertRaise(db: Db, r: Omit<RaiseRow, "id" | "status" | "created_by" | "created_at">, by: string): Promise<RaiseRow> {
  const { rows } = await db.query<RaiseRow>(
    `insert into raises(name, fund_id, target_usd, hard_cap_usd, min_commitment_usd, exemption, offering, vcoc, equalization_rate_pct, first_close_target, final_close_deadline, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [r.name, r.fund_id, r.target_usd, r.hard_cap_usd, r.min_commitment_usd, r.exemption, r.offering, r.vcoc, r.equalization_rate_pct, r.first_close_target, r.final_close_deadline, by],
  );
  await audit(db, by, "fundraising.raise.create", rows[0]!.id, { name: r.name });
  return raise(rows[0]!);
}

export async function updateRaise(db: Db, id: string, patch: Partial<Omit<RaiseRow, "id" | "created_by" | "created_at">>, by: string): Promise<void> {
  const s = sets(patch);
  if (!s.params.length) return;
  const { rows } = await db.query(`update raises set ${s.sql}, updated_at = now() where id = $1 returning id`, [id, ...s.params]);
  if (!rows[0]) throw new Error("No such raise.");
  await audit(db, by, "fundraising.raise.update", id, { fields: Object.keys(patch) });
}

export async function raises(db: Db): Promise<RaiseRow[]> {
  return (await db.query<RaiseRow>("select * from raises order by created_at desc")).rows.map(raise);
}

export async function getRaise(db: Db, id: string): Promise<RaiseRow | null> {
  const r = (await db.query<RaiseRow>("select * from raises where id = $1", [id])).rows[0];
  return r ? raise(r) : null;
}

// ---------------------------------------------------------------------------
// Prospects and activity
// ---------------------------------------------------------------------------

export interface ProspectRow {
  id: string;
  raise_id: string;
  name: string;
  kind: string;
  contact_name: string | null;
  emails: string[];
  jurisdiction: string | null;
  stage: "identified" | "contacted" | "meeting" | "diligence" | "soft_circle" | "committed" | "closed" | "declined";
  probability: number | null;
  ask_usd: number | null;
  soft_circle_usd: number | null;
  committed_usd: number | null;
  source: string | null;
  owner: string | null;
  next_step: string | null;
  next_step_on: string | null;
  decline_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const prospect = (r: ProspectRow): ProspectRow => ({
  ...r, probability: num(r.probability), ask_usd: num(r.ask_usd), soft_circle_usd: num(r.soft_circle_usd), committed_usd: num(r.committed_usd),
  next_step_on: day(r.next_step_on), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
});

export type ProspectInput = Partial<Omit<ProspectRow, "id" | "raise_id" | "created_by" | "created_at" | "updated_at">>;

export async function insertProspect(db: Db, raiseId: string, p: ProspectInput & { name: string; kind: string }, by: string): Promise<ProspectRow> {
  const { rows } = await db.query<ProspectRow>(
    `insert into prospects(raise_id, name, kind, contact_name, emails, jurisdiction, stage, probability, ask_usd, soft_circle_usd, committed_usd, source, owner, next_step, next_step_on, created_by)
     values ($1,$2,$3,$4,$5,$6,coalesce($7,'identified'),$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [raiseId, p.name, p.kind, p.contact_name ?? null, p.emails ?? [], p.jurisdiction ?? null, p.stage ?? null, p.probability ?? null, p.ask_usd ?? null, p.soft_circle_usd ?? null,
      p.committed_usd ?? null, p.source ?? null, p.owner ?? null, p.next_step ?? null, p.next_step_on ?? null, by],
  );
  await audit(db, by, "fundraising.prospect.add", rows[0]!.id, { raise: raiseId });
  return prospect(rows[0]!);
}

export async function updateProspect(db: Db, id: string, patch: ProspectInput, by: string): Promise<void> {
  const s = sets(patch as Record<string, unknown>);
  if (!s.params.length) return;
  const { rows } = await db.query(`update prospects set ${s.sql}, updated_at = now() where id = $1 returning id`, [id, ...s.params]);
  if (!rows[0]) throw new Error("No such prospect.");
  await audit(db, by, "fundraising.prospect.update", id, { fields: Object.keys(patch) });
}

export async function prospects(db: Db, raiseId: string): Promise<ProspectRow[]> {
  return (await db.query<ProspectRow>("select * from prospects where raise_id = $1 order by name", [raiseId])).rows.map(prospect);
}

export async function getProspect(db: Db, id: string): Promise<ProspectRow | null> {
  const r = (await db.query<ProspectRow>("select * from prospects where id = $1", [id])).rows[0];
  return r ? prospect(r) : null;
}

export interface ActivityRow { id: string; prospect_id: string; occurred_on: string; kind: string; summary: string; actor: string; created_at: string }

export async function insertActivity(db: Db, a: { prospectId: string; occurredOn: string; kind: string; summary: string }, actor: string): Promise<void> {
  await db.query("insert into prospect_activities(prospect_id, occurred_on, kind, summary, actor) values ($1,$2,$3,$4,$5)", [a.prospectId, a.occurredOn, a.kind, a.summary, actor]);
}

export async function activities(db: Db, opts: { prospectId?: string; raiseId?: string }): Promise<ActivityRow[]> {
  const { rows } = await db.query<ActivityRow>(
    `select a.* from prospect_activities a join prospects p on p.id = a.prospect_id
      where ${opts.prospectId ? "a.prospect_id = $1" : "p.raise_id = $1"} order by a.occurred_on desc, a.created_at desc limit 500`,
    [opts.prospectId ?? opts.raiseId],
  );
  return rows.map((r) => ({ ...r, occurred_on: day(r.occurred_on)!, created_at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// Data room
// ---------------------------------------------------------------------------

export interface DocRow {
  id: string;
  raise_id: string;
  title: string;
  category: string;
  version: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  marketing: boolean;
  status: "draft" | "approved" | "archived";
  uploaded_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

const DOC_COLS = "id, raise_id, title, category, version, file_name, mime_type, size_bytes, sha256, marketing, status, uploaded_by, approved_by, approved_at, created_at";
const doc = (r: DocRow): DocRow => ({ ...r, approved_at: iso(r.approved_at), created_at: iso(r.created_at)! });

export async function insertDoc(db: Db, d: { raiseId: string; title: string; category: string; fileName: string; mimeType: string; content: Uint8Array; sha256: string; marketing: boolean }, by: string): Promise<DocRow> {
  const { rows } = await db.query<DocRow>(
    `insert into dataroom_docs(raise_id, title, category, version, file_name, mime_type, size_bytes, content, sha256, marketing, uploaded_by)
     values ($1,$2,$3,(select coalesce(max(version), 0) + 1 from dataroom_docs where raise_id = $1 and title = $2),$4,$5,$6,$7,$8,$9,$10) returning ${DOC_COLS}`,
    [d.raiseId, d.title, d.category, d.fileName, d.mimeType, d.content.byteLength, d.content, d.sha256, d.marketing, by],
  );
  await audit(db, by, "fundraising.doc.upload", rows[0]!.id, { title: d.title, version: rows[0]!.version });
  return doc(rows[0]!);
}

export async function docs(db: Db, raiseId: string): Promise<DocRow[]> {
  return (await db.query<DocRow>(`select ${DOC_COLS} from dataroom_docs where raise_id = $1 order by category, title, version desc`, [raiseId])).rows.map(doc);
}

export async function getDoc(db: Db, id: string): Promise<(DocRow & { content: Uint8Array }) | null> {
  const r = (await db.query<DocRow & { content: Uint8Array }>(`select ${DOC_COLS}, content from dataroom_docs where id = $1`, [id])).rows[0];
  return r ? { ...doc(r), content: r.content } : null;
}

export async function setDocStatus(db: Db, id: string, status: "approved" | "archived", by: string): Promise<void> {
  const { rows } = await db.query(
    `update dataroom_docs set status = $2, approved_by = case when $2 = 'approved' then $3 else approved_by end, approved_at = case when $2 = 'approved' then now() else approved_at end
      where id = $1 returning id`,
    [id, status, by],
  );
  if (!rows[0]) throw new Error("No such document.");
  await audit(db, by, `fundraising.doc.${status}`, id, {});
}

export interface LinkRow { id: string; prospect_id: string; expires_at: string; revoked_at: string | null; acknowledged_at: string | null; last_used_at: string | null; created_at: string }
const link = (r: LinkRow): LinkRow => ({ ...r, expires_at: iso(r.expires_at)!, revoked_at: iso(r.revoked_at), acknowledged_at: iso(r.acknowledged_at), last_used_at: iso(r.last_used_at), created_at: iso(r.created_at)! });

export async function insertLink(db: Db, prospectId: string, tokenHash: string, days: number, by: string): Promise<LinkRow> {
  const { rows } = await db.query<LinkRow>(
    "insert into dataroom_links(prospect_id, token_hash, expires_at, created_by) values ($1,$2, now() + ($3 || ' days')::interval, $4) returning id, prospect_id, expires_at, revoked_at, acknowledged_at, last_used_at, created_at",
    [prospectId, tokenHash, String(days), by],
  );
  await audit(db, by, "fundraising.dataroom.link", prospectId, { link: rows[0]!.id });
  return link(rows[0]!);
}

export async function links(db: Db, raiseId: string): Promise<LinkRow[]> {
  const { rows } = await db.query<LinkRow>(
    `select l.id, l.prospect_id, l.expires_at, l.revoked_at, l.acknowledged_at, l.last_used_at, l.created_at from dataroom_links l join prospects p on p.id = l.prospect_id
      where p.raise_id = $1 order by l.created_at desc`,
    [raiseId],
  );
  return rows.map(link);
}

export async function revokeLinks(db: Db, prospectId: string, by: string): Promise<number> {
  const { rows } = await db.query("update dataroom_links set revoked_at = now() where prospect_id = $1 and revoked_at is null returning id", [prospectId]);
  await audit(db, by, "fundraising.dataroom.revoke", prospectId, { links: rows.length });
  return rows.length;
}

export async function acknowledgeLink(db: Db, linkId: string): Promise<void> {
  await db.query("update dataroom_links set acknowledged_at = coalesce(acknowledged_at, now()) where id = $1", [linkId]);
}

export async function insertView(db: Db, linkId: string, docId: string, action: "view" | "download"): Promise<void> {
  await db.query("insert into dataroom_views(link_id, doc_id, action) values ($1,$2,$3)", [linkId, docId, action]);
}

export interface ViewRow { prospect_id: string; doc_id: string; title: string; action: string; viewed_at: string }

export async function views(db: Db, raiseId: string): Promise<ViewRow[]> {
  const { rows } = await db.query<ViewRow>(
    `select l.prospect_id, v.doc_id, d.title, v.action, v.viewed_at from dataroom_views v join dataroom_links l on l.id = v.link_id join dataroom_docs d on d.id = v.doc_id
      where d.raise_id = $1 order by v.viewed_at desc limit 1000`,
    [raiseId],
  );
  return rows.map((r) => ({ ...r, viewed_at: iso(r.viewed_at)! }));
}

// ---------------------------------------------------------------------------
// DDQ answers
// ---------------------------------------------------------------------------

export interface AnswerRow { id: string; question_key: string; answer: string; sources: string[]; status: "draft" | "approved"; updated_by: string; updated_at: string; approved_by: string | null; approved_at: string | null }
const answer = (r: AnswerRow): AnswerRow => ({ ...r, updated_at: iso(r.updated_at)!, approved_at: iso(r.approved_at) });

/** Save an answer; any change goes back to draft for a second person to approve. */
export async function upsertAnswer(db: Db, key: string, text: string, sources: string[], by: string): Promise<void> {
  await db.query(
    `insert into ddq_answers(question_key, answer, sources, updated_by) values ($1,$2,$3,$4)
     on conflict (firm_id, question_key) do update set answer = excluded.answer, sources = excluded.sources, updated_by = excluded.updated_by, updated_at = now(),
       status = 'draft', approved_by = null, approved_at = null`,
    [key, text, JSON.stringify(sources), by],
  );
  await audit(db, by, "fundraising.ddq.answer", undefined, { question: key });
}

export async function approveAnswer(db: Db, key: string, by: string): Promise<void> {
  const { rows } = await db.query("update ddq_answers set status = 'approved', approved_by = $2, approved_at = now() where question_key = $1 and status = 'draft' returning id", [key, by]);
  if (!rows[0]) throw new Error("No draft answer to approve.");
  await audit(db, by, "fundraising.ddq.approve", undefined, { question: key });
}

export async function answers(db: Db): Promise<AnswerRow[]> {
  return (await db.query<AnswerRow>("select id, question_key, answer, sources, status, updated_by, updated_at, approved_by, approved_at from ddq_answers order by question_key")).rows.map(answer);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  id: string;
  raise_id: string;
  prospect_id: string | null;
  investor_name: string;
  kind: string;
  natural_person: boolean;
  commitment_usd: number | null;
  status: "invited" | "submitted" | "accepted" | "rejected" | "withdrawn" | "admitted";
  questionnaire: Record<string, unknown>;
  accredited: boolean;
  accredited_basis: string | null;
  qualified_purchaser: boolean;
  qp_basis: string | null;
  knowledgeable_employee: boolean;
  benefit_plan: boolean;
  pooled_vehicle: boolean;
  verification: "self_certified" | "minimum_investment" | "third_party_letter" | "documents_reviewed" | "platform" | null;
  minimum_investment_reps: boolean;
  tax_form: string | null;
  jurisdiction: string | null;
  emails: string[];
  beneficial_owners: { name: string; pct: number }[];
  kyc_status: "pending" | "cleared" | "flagged";
  kyc_note: string | null;
  kyc_by: string | null;
  sanctions: { checkedAt: string; names: string[]; hits: { name: string; match: string; score: number }[] } | null;
  signed_on: string | null;
  closing_id: string | null;
  partner_id: string | null;
  token_expires_at: string | null;
  token_revoked_at: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  rejected_reason: string | null;
  created_by: string;
  created_at: string;
}

const SUB_COLS = `id, raise_id, prospect_id, investor_name, kind, natural_person, commitment_usd, status, questionnaire, accredited, accredited_basis, qualified_purchaser, qp_basis,
  knowledgeable_employee, benefit_plan, pooled_vehicle, verification, minimum_investment_reps, tax_form, jurisdiction, emails, beneficial_owners, kyc_status, kyc_note, kyc_by,
  sanctions, signed_on, closing_id, partner_id, token_expires_at, token_revoked_at, submitted_at, decided_by, decided_at, rejected_reason, created_by, created_at`;
const sub = (r: SubscriptionRow): SubscriptionRow => ({
  ...r, commitment_usd: num(r.commitment_usd), signed_on: day(r.signed_on), token_expires_at: iso(r.token_expires_at), token_revoked_at: iso(r.token_revoked_at),
  submitted_at: iso(r.submitted_at), decided_at: iso(r.decided_at), created_at: iso(r.created_at)!,
});

export async function insertSubscription(db: Db, s: { raiseId: string; prospectId: string | null; investorName: string; kind: string; naturalPerson: boolean; commitmentUsd: number | null; emails: string[]; tokenHash: string | null; days: number }, by: string): Promise<SubscriptionRow> {
  const { rows } = await db.query<SubscriptionRow>(
    `insert into subscriptions(raise_id, prospect_id, investor_name, kind, natural_person, commitment_usd, emails, token_hash, token_expires_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $8::text is null then null else now() + ($9 || ' days')::interval end, $10) returning ${SUB_COLS}`,
    [s.raiseId, s.prospectId, s.investorName, s.kind, s.naturalPerson, s.commitmentUsd, s.emails, s.tokenHash, String(s.days), by],
  );
  await audit(db, by, "fundraising.subscription.invite", rows[0]!.id, { investor: s.investorName });
  return sub(rows[0]!);
}

export async function updateSubscription(db: Db, id: string, patch: Record<string, unknown>, by: string, action = "fundraising.subscription.update"): Promise<void> {
  const s = sets(patch);
  if (!s.params.length) return;
  const { rows } = await db.query(`update subscriptions set ${s.sql} where id = $1 returning id`, [id, ...s.params]);
  if (!rows[0]) throw new Error("No such subscription.");
  await audit(db, by, action, id, { fields: Object.keys(patch) });
}

export async function subscriptions(db: Db, raiseId: string): Promise<SubscriptionRow[]> {
  return (await db.query<SubscriptionRow>(`select ${SUB_COLS} from subscriptions where raise_id = $1 order by created_at`, [raiseId])).rows.map(sub);
}

export async function getSubscription(db: Db, id: string): Promise<SubscriptionRow | null> {
  const r = (await db.query<SubscriptionRow>(`select ${SUB_COLS} from subscriptions where id = $1`, [id])).rows[0];
  return r ? sub(r) : null;
}

// ---------------------------------------------------------------------------
// Closings and equalization
// ---------------------------------------------------------------------------

export interface ClosingRow { id: string; raise_id: string; number: number; closing_date: string; status: "draft" | "approved" | "cancelled"; note: string | null; created_by: string; approved_by: string | null; approved_at: string | null; created_at: string }
const closing = (r: ClosingRow): ClosingRow => ({ ...r, closing_date: day(r.closing_date)!, approved_at: iso(r.approved_at), created_at: iso(r.created_at)! });

export async function insertClosing(db: Db, c: { raiseId: string; closingDate: string; note: string | null; subscriptionIds: string[] }, by: string): Promise<ClosingRow> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<ClosingRow>(
      `insert into closings(raise_id, number, closing_date, note, created_by) values ($1, (select coalesce(max(number), 0) + 1 from closings where raise_id = $1), $2, $3, $4) returning *`,
      [c.raiseId, c.closingDate, c.note, by],
    );
    await tx.query("update subscriptions set closing_id = $1 where id = any($2::uuid[]) and raise_id = $3", [rows[0]!.id, c.subscriptionIds, c.raiseId]);
    await audit(tx, by, "fundraising.closing.draft", rows[0]!.id, { number: rows[0]!.number, investors: c.subscriptionIds.length });
    return closing(rows[0]!);
  });
}

export async function closings(db: Db, raiseId: string): Promise<ClosingRow[]> {
  return (await db.query<ClosingRow>("select * from closings where raise_id = $1 order by number", [raiseId])).rows.map(closing);
}

export async function getClosing(db: Db, id: string): Promise<ClosingRow | null> {
  const r = (await db.query<ClosingRow>("select * from closings where id = $1", [id])).rows[0];
  return r ? closing(r) : null;
}

export async function setClosingStatus(db: Db, id: string, status: "approved" | "cancelled", by: string, tx?: Db): Promise<void> {
  const d = tx ?? db;
  const { rows } = await d.query(
    `update closings set status = $2, approved_by = case when $2 = 'approved' then $3 else approved_by end, approved_at = case when $2 = 'approved' then now() else approved_at end
      where id = $1 and status = 'draft' returning id`,
    [id, status, by],
  );
  if (!rows[0]) throw new Error("This closing isn't a draft any more.");
  if (status === "cancelled") await d.query("update subscriptions set closing_id = null where closing_id = $1", [id]);
  await audit(d, by, `fundraising.closing.${status}`, id, {});
}

export interface EqualizationRow { id: string; closing_id: string; partner_id: string; partner_name?: string; capital_usd: number; fee_usd: number; interest_usd: number; due_on: string; detail: string[]; settled_on: string | null }

export async function insertEqualization(tx: Db, closingId: string, items: { partnerId: string; capital: number; fee: number; interest: number; dueOn: string; detail: string[] }[]): Promise<void> {
  for (const i of items) {
    await tx.query(
      "insert into equalization_items(closing_id, partner_id, capital_usd, fee_usd, interest_usd, due_on, detail) values ($1,$2,$3,$4,$5,$6,$7)",
      [closingId, i.partnerId, i.capital, i.fee, i.interest, i.dueOn, JSON.stringify(i.detail)],
    );
  }
}

/** Equalization items of approved closings, for a fund's books. */
export async function equalizationFor(db: Db, fundId: string): Promise<(EqualizationRow & { closing_date: string })[]> {
  const { rows } = await db.query<EqualizationRow & { closing_date: string }>(
    `select e.*, c.closing_date, p.name as partner_name from equalization_items e join closings c on c.id = e.closing_id join raises r on r.id = c.raise_id
       join fund_partners p on p.id = e.partner_id
      where r.fund_id = $1 and c.status = 'approved' order by c.number, p.name`,
    [fundId],
  );
  return rows.map((r) => ({ ...r, capital_usd: Number(r.capital_usd), fee_usd: Number(r.fee_usd), interest_usd: Number(r.interest_usd), due_on: day(r.due_on)!, settled_on: day(r.settled_on), closing_date: day(r.closing_date)! }));
}

export async function equalizationItems(db: Db, closingId: string): Promise<EqualizationRow[]> {
  const { rows } = await db.query<EqualizationRow>(
    "select e.*, p.name as partner_name from equalization_items e join fund_partners p on p.id = e.partner_id where e.closing_id = $1 order by p.name", [closingId],
  );
  return rows.map((r) => ({ ...r, capital_usd: Number(r.capital_usd), fee_usd: Number(r.fee_usd), interest_usd: Number(r.interest_usd), due_on: day(r.due_on)!, settled_on: day(r.settled_on) }));
}

export async function settleEqualization(db: Db, id: string, on: string, by: string): Promise<void> {
  const { rows } = await db.query("update equalization_items set settled_on = $2 where id = $1 returning id", [id, on]);
  if (!rows[0]) throw new Error("No such equalization line.");
  await audit(db, by, "fundraising.equalization.settled", id, { on });
}

// ---------------------------------------------------------------------------
// Side letters and MFN
// ---------------------------------------------------------------------------

export interface TermRow { id: string; raise_id: string; subscription_id: string; investor_name?: string; category: string; text: string; electable: boolean; granted_on: string; elected_from: string | null; created_by: string }

export async function insertTerm(db: Db, t: { raiseId: string; subscriptionId: string; category: string; text: string; electable: boolean; grantedOn: string; electedFrom?: string | null }, by: string): Promise<TermRow> {
  const { rows } = await db.query<TermRow>(
    "insert into side_letter_terms(raise_id, subscription_id, category, text, electable, granted_on, elected_from, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
    [t.raiseId, t.subscriptionId, t.category, t.text, t.electable, t.grantedOn, t.electedFrom ?? null, by],
  );
  await audit(db, by, "fundraising.side_letter.term", t.subscriptionId, { category: t.category, elected: Boolean(t.electedFrom) });
  return { ...rows[0]!, granted_on: day(rows[0]!.granted_on)! };
}

export async function terms(db: Db, raiseId: string): Promise<TermRow[]> {
  const { rows } = await db.query<TermRow>(
    "select t.*, s.investor_name from side_letter_terms t join subscriptions s on s.id = t.subscription_id where t.raise_id = $1 order by s.investor_name, t.category", [raiseId],
  );
  return rows.map((r) => ({ ...r, granted_on: day(r.granted_on)! }));
}

export interface ElectionRow { id: string; subscription_id: string; term_id: string; status: "offered" | "elected" | "declined"; window_ends: string; decided_on: string | null }

export async function insertElection(db: Db, e: { raiseId: string; subscriptionId: string; termId: string; windowEnds: string }): Promise<boolean> {
  const { rows } = await db.query(
    "insert into mfn_elections(raise_id, subscription_id, term_id, window_ends) values ($1,$2,$3,$4) on conflict (subscription_id, term_id) do nothing returning id",
    [e.raiseId, e.subscriptionId, e.termId, e.windowEnds],
  );
  return rows.length > 0;
}

export async function elections(db: Db, raiseId: string): Promise<ElectionRow[]> {
  const { rows } = await db.query<ElectionRow>("select id, subscription_id, term_id, status, window_ends, decided_on from mfn_elections where raise_id = $1 order by created_at", [raiseId]);
  return rows.map((r) => ({ ...r, window_ends: day(r.window_ends)!, decided_on: day(r.decided_on) }));
}

export async function decideElection(db: Db, id: string, status: "elected" | "declined", on: string, by: string): Promise<ElectionRow> {
  const { rows } = await db.query<ElectionRow>(
    "update mfn_elections set status = $2, decided_on = $3, recorded_by = $4 where id = $1 and status = 'offered' returning id, subscription_id, term_id, status, window_ends, decided_on",
    [id, status, on, by],
  );
  if (!rows[0]) throw new Error("This election is already decided.");
  await audit(db, by, `fundraising.mfn.${status}`, id, {});
  return { ...rows[0], window_ends: day(rows[0].window_ends)!, decided_on: day(rows[0].decided_on) };
}

// ---------------------------------------------------------------------------
// LPAC and investor requests
// ---------------------------------------------------------------------------

export interface MemberRow { id: string; fund_id: string; partner_id: string; partner_name?: string; representative: string; email: string | null; since: string; until: string | null }

export async function insertMember(db: Db, m: { fundId: string; partnerId: string; representative: string; email: string | null; since: string }, by: string): Promise<void> {
  await db.query("insert into lpac_members(fund_id, partner_id, representative, email, since, created_by) values ($1,$2,$3,$4,$5,$6)", [m.fundId, m.partnerId, m.representative, m.email, m.since, by]);
  await audit(db, by, "ir.lpac.member", m.fundId, { partner: m.partnerId });
}

export async function endMember(db: Db, id: string, until: string, by: string): Promise<void> {
  await db.query("update lpac_members set until = $2 where id = $1", [id, until]);
  await audit(db, by, "ir.lpac.member_end", id, { until });
}

export async function members(db: Db, fundId: string): Promise<MemberRow[]> {
  const { rows } = await db.query<MemberRow>(
    "select m.id, m.fund_id, m.partner_id, p.name as partner_name, m.representative, m.email, m.since, m.until from lpac_members m join fund_partners p on p.id = m.partner_id where m.fund_id = $1 order by m.since",
    [fundId],
  );
  return rows.map((r) => ({ ...r, since: day(r.since)!, until: day(r.until) }));
}

export interface ConsentRow { id: string; fund_id: string; kind: string; topic: string; detail: string; requested_on: string; due_on: string | null; status: "open" | "approved" | "declined" | "withdrawn"; decided_on: string | null; created_by: string; decided_by: string | null }
export interface VoteRow { id: string; consent_id: string; member_id: string; vote: "approve" | "decline" | "abstain"; voted_on: string; note: string | null }

export async function insertConsent(db: Db, c: { fundId: string; kind: string; topic: string; detail: string; requestedOn: string; dueOn: string | null }, by: string): Promise<ConsentRow> {
  const { rows } = await db.query<ConsentRow>(
    "insert into lpac_consents(fund_id, kind, topic, detail, requested_on, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *",
    [c.fundId, c.kind, c.topic, c.detail, c.requestedOn, c.dueOn, by],
  );
  await audit(db, by, "ir.lpac.consent", rows[0]!.id, { kind: c.kind });
  return { ...rows[0]!, requested_on: day(rows[0]!.requested_on)!, due_on: day(rows[0]!.due_on), decided_on: day(rows[0]!.decided_on) };
}

export async function consents(db: Db, fundId: string): Promise<ConsentRow[]> {
  const { rows } = await db.query<ConsentRow>("select * from lpac_consents where fund_id = $1 order by requested_on desc", [fundId]);
  return rows.map((r) => ({ ...r, requested_on: day(r.requested_on)!, due_on: day(r.due_on), decided_on: day(r.decided_on) }));
}

export async function getConsent(db: Db, id: string): Promise<ConsentRow | null> {
  const r = (await db.query<ConsentRow>("select * from lpac_consents where id = $1", [id])).rows[0];
  return r ? { ...r, requested_on: day(r.requested_on)!, due_on: day(r.due_on), decided_on: day(r.decided_on) } : null;
}

export async function recordVote(db: Db, v: { consentId: string; memberId: string; vote: string; votedOn: string; note: string | null }, by: string): Promise<void> {
  await db.query(
    `insert into lpac_votes(consent_id, member_id, vote, voted_on, note, recorded_by) values ($1,$2,$3,$4,$5,$6)
     on conflict (consent_id, member_id) do update set vote = excluded.vote, voted_on = excluded.voted_on, note = excluded.note, recorded_by = excluded.recorded_by`,
    [v.consentId, v.memberId, v.vote, v.votedOn, v.note, by],
  );
  await audit(db, by, "ir.lpac.vote", v.consentId, { member: v.memberId, vote: v.vote });
}

export async function votes(db: Db, fundId: string): Promise<VoteRow[]> {
  const { rows } = await db.query<VoteRow>(
    "select v.id, v.consent_id, v.member_id, v.vote, v.voted_on, v.note from lpac_votes v join lpac_consents c on c.id = v.consent_id where c.fund_id = $1", [fundId],
  );
  return rows.map((r) => ({ ...r, voted_on: day(r.voted_on)! }));
}

export async function decideConsent(db: Db, id: string, status: "approved" | "declined" | "withdrawn", on: string, by: string): Promise<void> {
  const { rows } = await db.query("update lpac_consents set status = $2, decided_on = $3, decided_by = $4 where id = $1 and status = 'open' returning id", [id, status, on, by]);
  if (!rows[0]) throw new Error("This consent is already decided.");
  await audit(db, by, `ir.lpac.${status}`, id, {});
}

export interface RequestRow {
  id: string; fund_id: string | null; partner_id: string | null; prospect_id: string | null; from_name: string; category: string; subject: string; detail: string | null;
  received_on: string; due_on: string | null; status: "open" | "answered" | "closed"; answer: string | null; answered_by: string | null; answered_on: string | null; created_by: string;
}
const request = (r: RequestRow): RequestRow => ({ ...r, received_on: day(r.received_on)!, due_on: day(r.due_on), answered_on: day(r.answered_on) });

export async function insertRequest(db: Db, r: { fundId: string | null; partnerId: string | null; prospectId: string | null; fromName: string; category: string; subject: string; detail: string | null; receivedOn: string; dueOn: string | null }, by: string): Promise<RequestRow> {
  const { rows } = await db.query<RequestRow>(
    "insert into investor_requests(fund_id, partner_id, prospect_id, from_name, category, subject, detail, received_on, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",
    [r.fundId, r.partnerId, r.prospectId, r.fromName, r.category, r.subject, r.detail, r.receivedOn, r.dueOn, by],
  );
  await audit(db, by, "ir.request", rows[0]!.id, { category: r.category });
  return request(rows[0]!);
}

export async function answerRequest(db: Db, id: string, a: { answer: string; status: "answered" | "closed"; on: string }, by: string): Promise<void> {
  const { rows } = await db.query("update investor_requests set answer = $2, status = $3, answered_on = $4, answered_by = $5 where id = $1 returning id", [id, a.answer, a.status, a.on, by]);
  if (!rows[0]) throw new Error("No such request.");
  await audit(db, by, `ir.request.${a.status}`, id, {});
}

export async function requests(db: Db): Promise<RequestRow[]> {
  return (await db.query<RequestRow>("select * from investor_requests order by (status = 'open') desc, coalesce(due_on, received_on) asc limit 500")).rows.map(request);
}
