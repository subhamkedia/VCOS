import type { Db } from "../../lib/db.js";
import { getComplianceProfile, insertMarketingReview, latestScreenings } from "../../ledger/compliance.js";
import { marketingComplete } from "../../engines/compliance.js";

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
export async function assertScreeningCleared(db: Db, dealId: string): Promise<void> {
  const p = await getComplianceProfile(db);
  const s = (await latestScreenings(db)).find((x) => x.deal_id === dealId);
  if (s?.outbound === "prohibited") throw new ComplianceBlocked("The regulatory screening found a prohibited outbound investment (31 CFR Part 850): this deal can't close.");
  if (!p || !p.require_screening) return;
  if (!s) throw new ComplianceBlocked("Run the regulatory screening (outbound investment, CFIUS, export controls) in Compliance before closing.");
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
    if (!m.complete) throw new ComplianceBlocked(`Marketing Rule review: confirm ${m.missing.map((x) => `"${x}"`).join("; ")}.`);
  }
  if (p?.adviser_status === "registered" || provided) await insertMarketingReview(db, { subjectKind: "dataroom_doc", subjectId: doc.id, title: doc.title, answers: answers ?? {} }, by);
}
