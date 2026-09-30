import type { Db } from "../../lib/db.js";
import type { LpPortalRef } from "../../ledger/platform.js";
import { callItems, calls, distributionItems, distributions, getFund, getPartner, getReport, reports, taxDocs } from "../../ledger/lp.js";
import { LP_LABELS } from "../../ledger/labels.js";
import { getProfile } from "../firm/profile.js";
import { exportCsv, type Snapshot } from "./reports.js";
import { LpInvalid } from "./common.js";

/**
 * What an investor sees from its private link: the fund's approved
 * quarterly reports with its own capital account statement, its capital
 * call and distribution notices, and its tax documents. Never another
 * investor's account or name, never a draft, and never the firm's internal
 * notes. Numbers come from approved reports, so an investor only ever sees
 * figures two people at the firm signed off.
 */

async function who(db: Db, ref: LpPortalRef) {
  const p = await getPartner(db, ref.partnerId);
  if (!p) throw new LpInvalid("No such link: it may have expired. Ask the fund for a new one.");
  const f = (await getFund(db, p.fund_id))!;
  return { p, f };
}

/** The parts of a report an investor may see: fund-level figures and its own statement, nothing about other investors. */
function forInvestor(r: { id: string; period: string; as_of: string; approved_at: string | null; letter: unknown; snapshot: unknown }, partnerId: string) {
  const s = r.snapshot as Snapshot;
  const mine = s.statements.find((x) => x.partnerId === partnerId) ?? null;
  const returns = s.performance.byPartner.find((x) => x.partnerId === partnerId) ?? null;
  return {
    id: r.id, period: r.period, asOf: r.as_of, approvedAt: r.approved_at,
    letter: r.letter,
    fund: { name: s.fund.name, vintage: s.fund.vintage, termsText: s.fund.termsText },
    summary: s.summary,
    performance: { net: s.performance.net, gross: s.performance.gross, marketingNote: s.performance.marketingNote },
    schedule: s.schedule,
    feesExpenses: s.feesExpenses,
    statement: mine,
    returns,
    notes: s.notes,
  };
}

export async function lpPortalView(db: Db, ref: LpPortalRef) {
  const { p, f } = await who(db, ref);
  const firm = (await getProfile(db))?.profile.firm.name ?? f.name;
  const approvedCalls = new Map((await calls(db, f.id)).filter((c) => c.status === "approved").map((c) => [c.id, c]));
  const myCalls = (await callItems(db, { fundId: f.id })).filter((i) => i.partner_id === p.id && approvedCalls.has(i.call_id)).map((i) => {
    const c = approvedCalls.get(i.call_id)!;
    return { number: c.number, noticeDate: c.notice_date, dueDate: c.due_date, purpose: c.purpose, investment: i.investment_usd, fee: i.fee_usd, expense: i.expense_usd, amount: i.amount_usd, received: i.received_usd, receivedOn: i.received_on };
  }).sort((a, b) => b.number - a.number);
  const out = new Map((await distributions(db, f.id)).filter((d) => d.status === "approved" || d.status === "paid").map((d) => [d.id, d]));
  const myDists = (await distributionItems(db, { fundId: f.id })).filter((i) => i.partner_id === p.id && out.has(i.distribution_id)).map((i) => {
    const d = out.get(i.distribution_id)!;
    return { number: d.number, paidOn: d.paid_on, kind: LP_LABELS.distributionKinds[d.kind], company: d.company_name ?? null, status: LP_LABELS.distributionStatus[d.status], gross: i.gross_usd, carry: i.carry_usd, net: i.net_usd };
  }).sort((a, b) => b.number - a.number);
  const approved = await reports(db, f.id, { status: "approved" });
  return {
    firm,
    investor: { name: p.name, commitment: p.commitment_usd, admittedOn: p.admitted_on },
    fund: { name: f.name, vintage: f.vintage, currency: f.currency },
    reports: approved.map((r) => forInvestor(r, p.id)),
    calls: myCalls,
    distributions: myDists,
    taxDocuments: (await taxDocs(db, f.id)).filter((t) => t.partner_id === p.id).map((t) => ({ year: t.tax_year, kind: LP_LABELS.taxDocKinds[t.kind], status: LP_LABELS.taxDocStatus[t.status], deliveredOn: t.delivered_on })),
  };
}

/** The investor's own capital account statement from an approved report, as CSV. */
export async function lpPortalStatementCsv(db: Db, ref: LpPortalRef, reportId: string) {
  const { p, f } = await who(db, ref);
  const r = await getReport(db, reportId);
  if (!r || r.fund_id !== f.id || r.status !== "approved") throw new LpInvalid("No such report.");
  return exportCsv(r, "capital-accounts", p.id);
}
