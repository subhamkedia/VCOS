import type { Db } from "../../lib/db.js";
import { getComplianceProfile, insertMarketingReview, latestScreenings } from "../../ledger/compliance.js";
import { MARKETING_CHECKLIST, marketingComplete } from "../../engines/compliance.js";

/**
 * The compliance checks other modules call. Kept apart from the rest of
 * the compliance module so Execution and Fundraising can use them without
 * import cycles.
 */

export class ComplianceBlocked extends Error {}

/**
 * Before a deal closes: once the firm has a compliance profile that asks
 * for it, the deal needs a regulatory screening, and a prohibited outbound
 * transaction can't close at all.
 */
export async function screeningStatus(db: Db, dealId: string) {
  const p = await getComplianceProfile(db);
  const s = (await latestScreenings(db)).find((x) => x.deal_id === dealId) ?? null;
  const blocked = s?.outbound === "prohibited"
    ? "The regulatory screening found a prohibited outbound investment (31 CFR Part 850): this deal can't close."
    : !s && p?.require_screening ? "Run the regulatory screening (outbound investment, CFIUS, export controls) in Compliance before closing." : null;
  return { required: Boolean(p?.require_screening), screening: s ? { outbound: s.outbound, cfius: s.cfius, exportControl: s.export_control, screenedAt: s.created_at } : null, blocked };
}

export async function assertScreeningCleared(db: Db, dealId: string): Promise<void> {
  const st = await screeningStatus(db, dealId);
  if (st.blocked) throw new ComplianceBlocked(st.blocked);
}

/**
 * Before investors see a marketing document: a registered adviser confirms
 * the Marketing Rule checklist, and the review is kept. An exempt reporting
 * adviser isn't bound by the rule, but a checklist it fills in is kept too.
 */
export async function marketingGate(db: Db, doc: { id: string; title: string; marketing: boolean }, answers: Record<string, unknown> | undefined, by: string): Promise<void> {
  if (!doc.marketing) return;
  const p = await getComplianceProfile(db);
  const provided = answers && Object.keys(answers).length > 0;
  if (p?.adviser_status === "registered") {
    const m = marketingComplete(answers ?? {});
    if (!m.complete) throw new ComplianceBlocked(`Marketing Rule review: ${m.missing.length} of ${MARKETING_CHECKLIST.length} checks aren't confirmed. A registered adviser confirms each one before investors see marketing material.`);
  }
  if (p?.adviser_status === "registered" || provided) await insertMarketingReview(db, { subjectKind: "dataroom_doc", subjectId: doc.id, title: doc.title, answers: answers ?? {} }, by);
}
