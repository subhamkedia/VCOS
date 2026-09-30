import type { Db } from "../../lib/db.js";
import { calls, distributions, getReport, insertReport, partners, reports, setReportStatus, taxDocs, type ReportRow } from "../../ledger/lp.js";
import { currentClaims, SHAREABLE_SCOPES } from "../../ledger/repository.js";
import { LP_LABELS, predicateLabel, sourceTypeLabel } from "../../ledger/labels.js";
import { reportingCalendar } from "../../engines/fund-accounting.js";
import { checkMemo, numbersIn, valuesFrom, type Citable, type MemoDoc, type MemoSentence } from "../diligence/memo-check.js";
import { say, shortMoney } from "../diligence/memo.js";
import { getProfile } from "../firm/profile.js";
import { isReady } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { performance, readLedger, scheduleAt, statements, type Ledger, type Statement, type StatementColumn } from "./books.js";
import { createLpPortalLink } from "./funds.js";
import { fundOr404, longDate, LpInvalid, periodBounds, quarterOf, round2, sum, termsOf, today } from "./common.js";

/**
 * Quarterly reports to investors, following the ILPA Reporting Template
 * (v2.0: capital account statement for the quarter, year and inception to
 * date; management fees, offsets and partnership expenses by category;
 * carried interest paid and accrued) and the ILPA Performance Template
 * (net returns beside gross, and the dated cash flows behind them).
 *
 * A report is a snapshot: the numbers as of the quarter end, computed in
 * code, and a letter whose every factual sentence cites either those
 * numbers or a public claim about a portfolio company (filtered to
 * shareable scopes in SQL). The GP's own commentary is labeled as such, and
 * any figure in it must match the books. One person prepares a report and
 * a different person approves it; an approved report is final and can only
 * be withdrawn and replaced by a new version.
 */

const HIGHLIGHTS = [
  "funding.round.amount", "funding.round.stage", "funding.investor", "funding.total_raised", "team.headcount", "customers.named", "contract.government",
  "grant.award", "compliance.certification", "product.stage", "pilot.status", "ip.patent_count",
];

const pct = (x: number | null) => (x === null ? null : `${(x * 100).toFixed(1)}%`);
const mult = (x: number | null) => (x === null ? null : `${x.toFixed(2)}x`);

function feesAndExpenses(l: Ledger, from: string, to: string) {
  const inRange = (d: string) => d >= from && d <= to;
  return {
    feesNet: round2(sum(l.fees.filter((f) => inRange(f.date)).map((f) => f.amount))),
    expenses: Object.fromEntries(Object.keys(LP_LABELS.expenseCategories).map((k) => [
      k, round2(sum(l.expenseRows.filter((e) => !e.fee_offset && e.category === k && inRange(e.incurred_on)).map((e) => e.amount_usd))),
    ])),
    carryPaid: round2(sum(l.carryPaid.filter((c) => inRange(c.date)).map((c) => c.amount))),
  };
}

/** The numbers for a quarter: everything a report states, computed from the ledger. */
export async function snapshot(db: Db, fundId: string, period: string) {
  const f = await fundOr404(db, fundId);
  const b = periodBounds(period);
  const asOf = b.end;
  const l = await readLedger(db, f);
  const st = statements(l, asOf, b.start, b.yearStart);
  const perf = performance(l, asOf);
  const cs = await calls(db, fundId);
  const inQuarter = (d: string) => d >= b.start && d <= asOf;
  const approvedCalls = cs.filter((c) => c.status === "approved");
  const dists = (await distributions(db, fundId)).filter((d) => d.status === "paid");
  const terms = termsOf(f);
  const q = feesAndExpenses(l, b.start, asOf);
  const y = feesAndExpenses(l, b.yearStart, asOf);
  const itd = feesAndExpenses(l, "0000-01-01", asOf);
  // Fees and their offsets count when a call charges them (by its due date).
  const called = (from: string) => approvedCalls.filter((c) => c.due_date >= from && c.due_date <= asOf);
  const feeGross = (from: string) => round2(sum(called(from).map((c) => Number((c.fee_detail as { gross?: number }).gross ?? c.fees_usd))));
  const feeOffsets = (from: string) => round2(sum(called(from).map((c) => Number(c.fee_detail.offsets ?? 0))));
  const offsetsReceived = round2(sum(l.expenseRows.filter((e) => e.fee_offset && e.incurred_on <= asOf).map((e) => e.amount_usd)));
  const commitments = sum(l.partners.map((p) => p.commitment_usd));
  const paidIn = st.total.contributedToDate;
  return {
    fund: {
      id: f.id, name: f.name, vintage: f.vintage, currency: f.currency, inception: f.inception, terms,
      termsText: [
        `Management fee ${terms.managementFeePct}% a year on commitments through ${longDate(terms.investmentPeriodEnd)}, then ${terms.feeStepDownPct ?? terms.managementFeePct}% on ${LP_LABELS.feeBasis[terms.feeBasisAfterPeriod]!.toLowerCase()}.`,
        `Carried interest ${terms.carryPct}%${terms.hurdlePct ? ` over a ${terms.hurdlePct}% preferred return with a ${terms.catchUpPct}% catch-up` : ", no preferred return"}. Waterfall: ${LP_LABELS.waterfalls[terms.waterfall]}${terms.escrowPct ? `, ${terms.escrowPct}% of carry held in escrow` : ""}.`,
      ],
    },
    period, asOf, periodStart: b.start, yearStart: b.yearStart,
    summary: {
      investors: l.partners.filter((p) => p.kind !== "gp").length,
      commitments: round2(commitments),
      gpCommitment: round2(sum(l.partners.filter((p) => p.kind === "gp").map((p) => p.commitment_usd))),
      called: round2(paidIn), calledPct: commitments > 0 ? round2((paidIn / commitments) * 100) : 0, uncalled: st.total.unfunded,
      distributed: st.total.distributedToDate, nav: st.nav, companies: scheduleAt(l.holdings, asOf).length,
    },
    performance: { net: perf.net, gross: perf.gross, marketingNote: perf.marketingNote, cashFlows: perf.cashFlows, byPartner: perf.byPartner },
    schedule: scheduleAt(l.holdings, asOf),
    activity: {
      calls: approvedCalls.filter((c) => inQuarter(c.due_date)).map((c) => ({ number: c.number, noticeDate: c.notice_date, dueDate: c.due_date, investments: c.investments_usd, fees: c.fees_usd, expenses: c.expenses_usd, total: round2(c.investments_usd + c.fees_usd + c.expenses_usd), purpose: c.purpose })),
      distributions: dists.filter((d) => inQuarter(d.paid_on)).map((d) => ({ number: d.number, paidOn: d.paid_on, gross: d.gross_usd, carry: d.carry_usd, net: round2(d.gross_usd - d.carry_usd), kind: d.kind, company: d.company_name ?? null })),
    },
    feesExpenses: {
      managementFees: {
        quarter: { gross: feeGross(b.start), offsets: feeOffsets(b.start), net: q.feesNet },
        year: { gross: feeGross(b.yearStart), offsets: feeOffsets(b.yearStart), net: y.feesNet },
        inception: { gross: feeGross("0000-01-01"), offsets: feeOffsets("0000-01-01"), net: itd.feesNet },
        /** Portfolio company fees received by the GP that will reduce the next fee call. */
        offsetsUnapplied: round2(Math.max(0, offsetsReceived - feeOffsets("0000-01-01"))),
      },
      expenses: Object.keys(LP_LABELS.expenseCategories).map((k) => ({ category: k, label: LP_LABELS.expenseCategories[k]!, quarter: q.expenses[k]!, year: y.expenses[k]!, inception: itd.expenses[k]! })),
      relatedParty: l.expenseRows.filter((e) => e.related_party && e.incurred_on <= asOf && e.incurred_on >= b.yearStart).map((e) => ({ date: e.incurred_on, description: e.description, amount: e.amount_usd, category: LP_LABELS.expenseCategories[e.category] ?? e.category })),
      carry: {
        paidQuarter: q.carryPaid, paidYear: y.carryPaid, paidInception: itd.carryPaid,
        escrowInception: round2(sum(l.carryPaid.filter((c) => c.date <= asOf).map((c) => c.escrow))),
        entitled: st.gpCarry.entitled, accrued: st.gpCarry.accrued, clawbackExposure: st.gpCarry.clawbackExposure,
      },
    },
    statements: st.statements,
    total: st.total,
    notes: [
      "Capital accounts share investment gains and partnership expenses by commitment; management fees and carried interest fall on fee-paying investors only.",
      "Accrued carried interest is what a sale of every holding at its reported fair value would pay the general partner; it is not paid until distributions reach it.",
      "Fair values are the latest marks approved by two people under the firm's valuation policy; investments without one are held at cost.",
      perf.gross.basis,
    ],
  };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

// ---------------------------------------------------------------------------
// The letter
// ---------------------------------------------------------------------------

interface Calc { id: string; text: string; label: string }

function calcsFor(s: Snapshot): Calc[] {
  const out: Calc[] = [];
  const m = shortMoney;
  out.push({ id: "calc:summary", label: "Commitments, capital called and distributed, NAV", text: `As of ${longDate(s.asOf)}, investors have committed ${m(s.summary.commitments)} to ${s.fund.name}; ${m(s.summary.called)} (${s.summary.calledPct.toFixed(1)}%) has been called and ${m(s.summary.distributed)} distributed. Net asset value is ${m(s.summary.nav)}.` });
  const n = s.performance.net;
  out.push({ id: "calc:net", label: "Net returns to investors", text: n.tvpi === null ? "No capital has been called yet, so there are no returns to report." : `Net to fee-paying investors since inception: TVPI ${mult(n.tvpi)}, DPI ${mult(n.dpi)}${n.irr === null ? "; IRR is not yet meaningful" : `, IRR ${pct(n.irr)}`}.` });
  const g = s.performance.gross;
  if (g.invested > 0) out.push({ id: "calc:gross", label: "Gross returns on the portfolio", text: `Gross, on ${m(g.invested)} invested in ${s.summary.companies} ${s.summary.companies === 1 ? "company" : "companies"}: multiple ${mult(g.moic)}${g.irr === null ? "" : `, IRR ${pct(g.irr)}`}. Gross returns are before management fees, expenses and carried interest.` });
  const a = s.activity;
  const called = sum(a.calls.map((c) => c.total));
  const dist = sum(a.distributions.map((d) => d.net));
  out.push({
    id: "calc:activity", label: "Capital calls and distributions this quarter",
    text: !a.calls.length && !a.distributions.length ? "The fund made no capital calls or distributions this quarter."
      : !a.calls.length ? `This quarter the fund made no capital calls and distributed ${m(dist)} to investors${a.distributions.length > 1 ? ` in ${a.distributions.length} distributions` : ""}.`
      : `This quarter the fund called ${m(called)}${a.calls.length > 1 ? ` in ${a.calls.length} calls` : ""}${a.distributions.length ? ` and distributed ${m(dist)} to investors` : " and made no distributions"}.`,
  });
  const fe = s.feesExpenses;
  const exp = sum(fe.expenses.map((e) => e.quarter));
  out.push({ id: "calc:fees", label: "Management fees, offsets and expenses", text: `Management fees charged this quarter: ${m(fe.managementFees.quarter.net)}${fe.managementFees.quarter.offsets ? `, after ${m(fe.managementFees.quarter.offsets)} of fee offsets` : ""}. Partnership expenses: ${m(exp)}.${fe.managementFees.offsetsUnapplied ? ` Fees of ${m(fe.managementFees.offsetsUnapplied)} the general partner received from portfolio companies will reduce the next management fee.` : ""}` });
  out.push({ id: "calc:carry", label: "Carried interest paid and accrued", text: fe.carry.paidInception || fe.carry.accrued ? `Carried interest: ${m(fe.carry.paidInception)} paid since inception and ${m(Math.max(0, fe.carry.accrued))} accrued at the quarter's values.${fe.carry.clawbackExposure ? ` At those values the general partner would return ${m(fe.carry.clawbackExposure)} under the clawback.` : ""}` : "No carried interest has been paid or accrued." });
  for (const r of s.schedule) {
    out.push({
      id: `calc:inv:${r.companyId}`, label: `Schedule of investments: ${r.company}`,
      text: r.status === "exited"
        ? `${r.company}: exited; ${m(r.cost)} invested returned ${m(r.realized)}${r.moic === null ? "" : ` (${mult(r.moic)})`}.`
        : `${r.company}: ${m(r.cost)} invested, held at ${m(r.fairValue)}${r.realized ? ` with ${m(r.realized)} realized` : ""}${r.moic === null ? "" : ` (${mult(r.moic)})`}; ${r.basis.toLowerCase()}.`,
    });
  }
  return out;
}

const splitSentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((x) => x.trim()).filter(Boolean);

/** Draft the letter from the snapshot, public claims and the GP's commentary, and check every sentence. */
export async function draftLetter(db: Db, s: Snapshot, commentary: string | null) {
  const calcs = calcsFor(s);
  const allowed = new Map<string, Citable>();
  const sources: Record<string, { label: string; detail: string }> = {};
  for (const c of calcs) {
    allowed.set(c.id, { id: c.id, label: c.label, values: numbersIn(c.text).map((x) => x.value), dates: [s.asOf] });
    sources[c.id] = { label: c.label, detail: `the fund's books, calculated in code as of ${s.asOf}` };
  }
  const fact = (text: string, cites: string[]): MemoSentence => ({ text, cites, kind: "fact" });
  const byId = new Map(calcs.map((c) => [c.id, c]));
  const highlights: MemoSentence[] = [];
  const yearAgo = `${Number(s.asOf.slice(0, 4)) - 1}${s.asOf.slice(4)}`;
  for (const r of s.schedule.filter((x) => x.status === "held")) {
    // Shareable scopes only, filtered in SQL: nothing confidential reaches a letter.
    const claims = (await currentClaims(db, r.companyId, { predicates: HIGHLIGHTS, scopes: SHAREABLE_SCOPES }))
      .filter((c) => c.as_of && c.as_of <= s.asOf && c.as_of > yearAgo && c.source_type !== "inference");
    for (const c of claims.slice(-3)) {
      allowed.set(c.id, { id: c.id, label: predicateLabel(c.predicate), values: valuesFrom(c.value), dates: [c.as_of!] });
      sources[c.id] = { label: `${r.company}: ${predicateLabel(c.predicate)}`, detail: `${sourceTypeLabel(c.source_type)}, public, as of ${c.as_of}` };
      highlights.push(fact(`${r.company}: ${predicateLabel(c.predicate).toLowerCase()} ${say(c)} (as of ${c.as_of}).`, [c.id]));
    }
  }
  const doc: MemoDoc = {
    title: `${s.fund.name}: report for ${s.period.replace("-", " ")}`,
    sections: [
      { id: "summary", heading: "The fund", sentences: ["calc:summary", "calc:net", "calc:gross"].filter((id) => byId.has(id)).map((id) => fact(byId.get(id)!.text, [id])) },
      { id: "activity", heading: "Capital activity", sentences: ["calc:activity", "calc:fees", "calc:carry"].map((id) => fact(byId.get(id)!.text, [id])) },
      { id: "portfolio", heading: "Portfolio", sentences: [...calcs.filter((c) => c.id.startsWith("calc:inv:")).map((c) => fact(c.text, [c.id])), ...highlights] },
    ].filter((x) => x.sentences.length),
  };
  const checked = checkMemo(doc, allowed);
  if (!checked.result.ok) throw new Error(`The letter failed its citation check: ${checked.result.rejected.map((r) => r.reason).join(" ")}`);
  // The GP's commentary is opinion, labeled as such; any number or date in it must match the books or a cited public claim.
  const views: MemoSentence[] = [];
  if (commentary?.trim()) {
    const probe = checkMemo({ title: "", sections: [{ id: "c", heading: "Commentary", sentences: splitSentences(commentary).map((text) => ({ text, cites: [...allowed.keys()], kind: "view" as const })) }] }, allowed);
    if (probe.result.rejected.length) {
      throw new LpInvalid(`The commentary states something the books don't: ${probe.result.rejected.map((r) => `"${r.text}" (${r.reason})`).join(" ")} Take the figure out, or correct it to match the report.`);
    }
    views.push(...splitSentences(commentary).map((text) => ({ text, cites: [], kind: "view" as const })));
  }
  const sections = [...checked.doc.sections, ...(views.length ? [{ id: "commentary", heading: "From the general partner", sentences: views }] : [])];
  return { title: doc.title, sections, sources, check: checked.result };
}

export type Letter = Awaited<ReturnType<typeof draftLetter>>;

// ---------------------------------------------------------------------------
// Preparing and approving
// ---------------------------------------------------------------------------

export async function prepareReport(db: Db, fundId: string, input: { period?: unknown; commentary?: unknown }, by: string): Promise<ReportRow> {
  const period = typeof input.period === "string" ? input.period : quarterOf(today()).period;
  const b = periodBounds(period);
  if (b.end > today()) throw new LpInvalid("That quarter hasn't ended yet.");
  const commentary = typeof input.commentary === "string" && input.commentary.trim() ? input.commentary.trim() : null;
  const s = await snapshot(db, fundId, period);
  const letter = await draftLetter(db, s, commentary);
  return insertReport(db, { fundId, period, asOf: s.asOf, snapshot: s, letter, commentary }, by);
}

export async function approveReport(db: Db, id: string, by: string) {
  const r = await getReport(db, id);
  if (!r) throw new LpInvalid("No such report.");
  if (r.status !== "draft") throw new LpInvalid(`This report is already ${LP_LABELS.reportStatus[r.status]!.toLowerCase()}.`);
  if (r.prepared_by === by) throw new LpInvalid("Someone other than the person who prepared the report approves it.");
  const live = (await reports(db, r.fund_id, { status: "approved" })).find((x) => x.period === r.period);
  if (live) throw new LpInvalid(`Version ${live.version} of this quarter's report is already approved. Withdraw it first if this one replaces it.`);
  const newer = (await reports(db, r.fund_id)).find((x) => x.period === r.period && x.version > r.version && x.status !== "withdrawn");
  if (newer) throw new LpInvalid(`There's a newer draft (version ${newer.version}) of this quarter's report.`);
  await setReportStatus(db, id, "approved", by);
}

export async function withdrawReport(db: Db, id: string, by: string) {
  const r = await getReport(db, id);
  if (!r) throw new LpInvalid("No such report.");
  if (r.status === "withdrawn") throw new LpInvalid("This report is already withdrawn.");
  await setReportStatus(db, id, "withdrawn", by);
}

/** Tell each investor its report is ready: a private link, drafted into the firm's mailbox for a person to send. */
export async function queueReportNotices(db: Db, id: string, by: string, appUrl: string) {
  const r = await getReport(db, id);
  if (!r) throw new LpInvalid("No such report.");
  if (r.status !== "approved") throw new LpInvalid("Only an approved report goes to investors.");
  const f = await fundOr404(db, r.fund_id);
  const firm = (await getProfile(db))?.profile.firm.name ?? f.name;
  const channel = (await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null;
  if (!channel) throw new LpInvalid("Connect Gmail or Outlook so the notices can be drafted in your mailbox.");
  const quarter = r.period.replace("-", " ");
  let queued = 0;
  const noEmail: string[] = [];
  for (const p of (await partners(db, f.id)).filter((x) => x.kind !== "gp")) {
    if (!p.emails.length) { noEmail.push(p.name); continue; }
    const link = await createLpPortalLink(db, p.id, by, appUrl);
    const body = [
      `Dear ${p.name},`, "",
      `${f.name}'s report for ${quarter} is ready, with your capital account statement. It's at this private link, valid for 90 days:`, "",
      link.url, "",
      "The link is for you alone; please don't forward it. We'll never ask for bank details or a payment through it.", "",
      "With thanks,", firm,
    ].join("\n");
    await queue(db, channel, { to: p.emails, subject: `${f.name}: ${quarter} report`, body }, { summary: `${quarter} report notice: ${p.name}`, proposedBy: by });
    queued++;
  }
  return { channel, queued, noEmail };
}

// ---------------------------------------------------------------------------
// Exports (CSV, laid out after the ILPA templates)
// ---------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const LINES: [keyof StatementColumn, string, number][] = [
  ["beginning", "Beginning balance", 1], ["contributions", "Capital contributions", 1], ["distributions", "Distributions", -1],
  ["managementFees", "Management fees (net of offsets)", -1], ["expenses", "Partnership expenses", -1], ["realizedGain", "Realized gain (loss)", 1],
  ["unrealizedGain", "Change in unrealized gain (loss)", 1], ["carriedInterest", "Carried interest allocated", -1], ["ending", "Ending balance", 1],
];

export function statementRows(st: Pick<Statement, "quarter" | "year" | "inception" | "commitment" | "unfunded" | "contributedToDate">): unknown[][] {
  return [
    ...LINES.map(([k, label, sign]) => [label, round2(sign * st.quarter[k]), round2(sign * st.year[k]), round2(sign * st.inception[k])]),
    ["Commitment", "", "", st.commitment], ["Contributed to date", "", "", st.contributedToDate], ["Unfunded commitment", "", "", st.unfunded],
  ];
}

export type ExportKind = "capital-accounts" | "fees-expenses" | "performance" | "investments";

export function exportCsv(r: ReportRow, kind: ExportKind, onlyPartner?: string): { filename: string; text: string } {
  const s = r.snapshot as unknown as Snapshot;
  const base = `${s.fund.name.replace(/[^A-Za-z0-9]+/g, "-")}-${r.period}`;
  switch (kind) {
    case "capital-accounts": {
      const rows: unknown[][] = [["Investor", "Line", "Quarter", "Year to date", "Inception to date"]];
      const list = s.statements.filter((x) => !onlyPartner || x.partnerId === onlyPartner);
      for (const st of list) for (const row of statementRows(st)) rows.push([st.name, ...row]);
      if (!onlyPartner) for (const row of statementRows(s.total)) rows.push(["All partners", ...row]);
      return { filename: `${base}-capital-accounts.csv`, text: csv(rows) };
    }
    case "fees-expenses": {
      const fe = s.feesExpenses;
      const rows: unknown[][] = [["Line", "Quarter", "Year to date", "Inception to date"]];
      rows.push(["Management fees (gross)", fe.managementFees.quarter.gross, fe.managementFees.year.gross, fe.managementFees.inception.gross]);
      rows.push(["Fee offsets", -fe.managementFees.quarter.offsets, -fe.managementFees.year.offsets, -fe.managementFees.inception.offsets]);
      rows.push(["Management fees (net)", fe.managementFees.quarter.net, fe.managementFees.year.net, fe.managementFees.inception.net]);
      rows.push(["Fee offsets received, not yet applied", "", "", fe.managementFees.offsetsUnapplied]);
      for (const e of fe.expenses) rows.push([e.label, e.quarter, e.year, e.inception]);
      rows.push(["Carried interest paid", fe.carry.paidQuarter, fe.carry.paidYear, fe.carry.paidInception]);
      rows.push(["Carried interest accrued (unpaid)", "", "", fe.carry.accrued]);
      rows.push(["Carried interest held in escrow", "", "", fe.carry.escrowInception]);
      for (const x of fe.relatedParty) rows.push([`Related party: ${x.description} (${x.date})`, "", x.amount, ""]);
      return { filename: `${base}-fees-expenses.csv`, text: csv(rows) };
    }
    case "performance": {
      const rows: unknown[][] = [["Date", "Type", "Amount"]];
      for (const c of s.performance.cashFlows) rows.push([c.date, c.type === "nav" ? "Net asset value" : c.type === "contribution" ? "Contribution" : "Distribution", c.amount]);
      const n = s.performance.net;
      rows.push([], ["Net IRR", n.irr === null ? "" : round2(n.irr * 100) + "%", ""], ["Net TVPI", n.tvpi === null ? "" : n.tvpi.toFixed(2), ""], ["Net DPI", n.dpi === null ? "" : n.dpi.toFixed(2), ""]);
      const g = s.performance.gross;
      rows.push(["Gross IRR", g.irr === null ? "" : round2(g.irr * 100) + "%", ""], ["Gross multiple", g.moic === null ? "" : g.moic.toFixed(2), ""], [s.performance.marketingNote, "", ""]);
      return { filename: `${base}-performance.csv`, text: csv(rows) };
    }
    case "investments": {
      const rows: unknown[][] = [["Company", "First invested", "Cost", "Realized", "Fair value", "Total value", "Multiple", "Status", "Valuation basis", "Mark date"]];
      for (const x of s.schedule) rows.push([x.company, x.firstInvested, x.cost, x.realized, x.fairValue, x.totalValue, x.moic === null ? "" : x.moic.toFixed(2), x.status === "held" ? "Held" : "Exited", x.basis, x.markDate ?? ""]);
      return { filename: `${base}-schedule-of-investments.csv`, text: csv(rows) };
    }
  }
}

// ---------------------------------------------------------------------------
// The reporting calendar
// ---------------------------------------------------------------------------

/** The year's deadlines, with what's done: quarterly reports from approved reports, K-1s from their tracking. */
export async function calendar(db: Db, fundId: string, year: number) {
  await fundOr404(db, fundId);
  const approved = new Set((await reports(db, fundId, { status: "approved" })).map((r) => r.period));
  const lps = (await partners(db, fundId)).filter((p) => p.kind !== "gp");
  const k1 = (await taxDocs(db, fundId, year)).filter((t) => t.kind === "k1" && t.status === "delivered");
  const now = today();
  return reportingCalendar(year).map((d) => {
    const q = /^q([1-4])_/.exec(d.key);
    const done = q ? approved.has(`${year}-Q${q[1]}`) : d.key.startsWith("k1_") ? lps.length > 0 && lps.every((p) => k1.some((t) => t.partner_id === p.id)) : null;
    const progress = d.key.startsWith("k1_") ? `${k1.length} of ${lps.length} delivered` : null;
    return { ...d, done, progress, state: done ? "done" : d.due < now ? (done === null ? "past" : "overdue") : "upcoming" };
  });
}
