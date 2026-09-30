import type { Db } from "../../lib/db.js";
import {
  bankTxns, callItems, calls, distributionItems, distributions, funds, getReport, lpPortalLinks, reports, taxDocs, type FundRow,
} from "../../ledger/lp.js";
import { LP_LABELS } from "../../ledger/labels.js";
import { CONNECTORS } from "../../connectors/registry.js";
import { isReady } from "../connections/index.js";
import { getProfile } from "../firm/profile.js";
import { performance, readLedger, scheduleAt, statements } from "./books.js";
import { calendar } from "./reports.js";
import { dayBefore, fundOr404, LpInvalid, quarterOf, round2, sum, termsOf, today } from "./common.js";

/**
 * LP Reporting: the fund's investors, capital calls and distributions,
 * capital accounts, net returns after fees and carry, and quarterly reports
 * in ILPA formats. The math is engines/fund-accounting.ts; the books come
 * from the ledger (Execution's investments, Portfolio's marks and
 * realizations, and this module's calls, distributions and expenses).
 * Money never moves here and nothing is sent: notices are drafts in the
 * firm's mailbox, approved by a second person first.
 */

export { LpInvalid } from "./common.js";
export { createFund, setTerms, addPartner, editPartner, importPartnersCsv, setTaxDoc, createLpPortalLink, revokeLpPortal, kindFrom } from "./funds.js";
export {
  previewCall, draftCall, approveCall, cancelCall, queueCallNotices, receive, matchReceipt, reconcile, syncBank, importBankCsv,
  previewDistribution, draftDistribution, approveDistribution, markDistributionPaid, cancelDistribution, addExpense, MIN_NOTICE_BUSINESS_DAYS,
} from "./capital.js";
export { snapshot, draftLetter, prepareReport, approveReport, withdrawReport, queueReportNotices, exportCsv, calendar, type ExportKind } from "./reports.js";
export { lpPortalView, lpPortalStatementCsv } from "./portal.js";

/** Every fund with its headline numbers, for the module's landing page. */
export async function overview(db: Db, asOf = today()) {
  const fs = await funds(db);
  const profile = (await getProfile(db))?.profile.fund ?? null;
  const rows = [];
  for (const f of fs) {
    const l = await readLedger(db, f);
    const perf = performance(l, asOf);
    const commitments = sum(l.partners.map((p) => p.commitment_usd));
    const called = sum(l.contributions.filter((c) => c.date <= asOf).map((c) => c.amount));
    const cs = await calls(db, f.id);
    const ds = await distributions(db, f.id);
    const rs = await reports(db, f.id);
    rows.push({
      id: f.id, name: f.name, vintage: f.vintage, inception: f.inception,
      investors: l.partners.filter((p) => p.kind !== "gp").length, commitments: round2(commitments), called: round2(called),
      calledPct: commitments > 0 ? round2((called / commitments) * 100) : 0,
      distributed: perf.net.distributed, nav: perf.nav, net: { tvpi: perf.net.tvpi, dpi: perf.net.dpi, irr: perf.net.irr },
      pending: {
        calls: cs.filter((c) => c.status === "draft").length,
        distributions: ds.filter((d) => d.status === "draft").length,
        reports: rs.filter((r) => r.status === "draft").length,
      },
      lastReport: rs.find((r) => r.status === "approved")?.period ?? null,
    });
  }
  return { asOf, funds: rows, profileFund: profile ? { name: profile.name, exists: fs.some((f) => f.name.toLowerCase() === profile.name.toLowerCase()) } : null };
}

async function sources(db: Db) {
  return Promise.all(CONNECTORS.filter((c) => c.lp).map(async (c) => ({ id: c.id, name: c.name, summary: c.lp!.summary, manual: Boolean(c.manual), ready: c.manual ? true : await isReady(db, c.id) })));
}

/** One fund, everything its pages show. */
export async function fundView(db: Db, fundId: string, asOf = today()) {
  const f: FundRow = await fundOr404(db, fundId);
  const l = await readLedger(db, f);
  const q = quarterOf(asOf);
  const st = statements(l, asOf, q.start, q.yearStart);
  const perf = performance(l, asOf);
  const cs = await calls(db, f.id);
  const items = await callItems(db, { fundId: f.id });
  const ds = await distributions(db, f.id);
  const dItems = await distributionItems(db, { fundId: f.id });
  const txns = await bankTxns(db, f.id);
  const links = await lpPortalLinks(db, f.id);
  const now = Date.now();
  const rs = await reports(db, f.id);
  const year = Number(asOf.slice(0, 4));
  return {
    asOf,
    fund: { ...f, terms: termsOf(f) },
    labels: LP_LABELS,
    summary: {
      commitments: st.total.commitment, called: st.total.contributedToDate, uncalled: st.total.unfunded, distributed: st.total.distributedToDate,
      nav: st.nav, calledPct: st.total.commitment > 0 ? round2((st.total.contributedToDate / st.total.commitment) * 100) : 0,
      receivable: round2(sum(items.filter((i) => cs.find((c) => c.id === i.call_id)?.status === "approved").map((i) => Math.max(0, i.amount_usd - i.received_usd)))),
    },
    performance: perf,
    gpCarry: st.gpCarry,
    investors: l.partners.map((p) => {
      const s = st.statements.find((x) => x.partnerId === p.id)!;
      const link = links.find((x) => x.partner_id === p.id && !x.revoked_at && Date.parse(x.expires_at) > now);
      return {
        ...p, contributed: s.contributedToDate, unfunded: s.unfunded, distributed: s.distributedToDate, balance: s.inception.ending,
        returns: perf.byPartner.find((x) => x.partnerId === p.id) ?? null,
        portal: link ? { expiresAt: link.expires_at, lastUsedAt: link.last_used_at } : null,
      };
    }),
    statements: st,
    calls: cs.map((c) => ({ ...c, items: items.filter((i) => i.call_id === c.id), received: round2(sum(items.filter((i) => i.call_id === c.id).map((i) => i.received_usd))) })),
    distributions: ds.map((d) => ({ ...d, items: dItems.filter((i) => i.distribution_id === d.id) })),
    expenses: l.expenseRows,
    bank: { unmatched: txns.filter((t) => !t.matched_item_id && t.amount_usd > 0), recent: txns.slice(0, 50) },
    schedule: scheduleAt(l.holdings, asOf),
    reports: rs.map(({ snapshot: _s, letter: _l, ...r }) => r),
    // The latest quarter that has ended.
    suggestedPeriod: quarterOf(dayBefore(q.start)).period,
    calendar: [...(await calendar(db, f.id, year - 1)), ...(await calendar(db, f.id, year))].filter((d) => d.due >= `${year - 1}-10-01`).sort((a, b) => a.due.localeCompare(b.due)),
    taxDocuments: await taxDocs(db, f.id),
    sources: await sources(db),
  };
}

/** One report, whole: its snapshot and letter. */
export async function report(db: Db, id: string) {
  const r = await getReport(db, id);
  if (!r) throw new LpInvalid("No such report.");
  return r;
}
