import type { Db } from "../../lib/db.js";
import { predicateLabel } from "../../ledger/labels.js";
import { entityIdentifiers } from "../../ledger/repository.js";
import {
  accountingLinks, boardMeetings, contacts, decisionsOf, initiatives, kpiRequests, latestMarks, portalLinks, realizations, valuations,
  type DecisionRow, type RealizationRow, type ValuationRow,
} from "../../ledger/portfolio.js";
import { buildSeries, DEFAULT_RULES, METRIC_PREDICATE, netBurn, signals, suggestedHealth, summarize, type Health, type Metric } from "../../engines/kpi.js";
import { portfolioMetrics, reserves, type Position } from "../../engines/fund-metrics.js";
import { METHOD_LABELS } from "../../engines/valuation.js";
import { CONNECTORS } from "../../connectors/registry.js";
import { REPORTABLE_METRICS } from "../../connectors/kpi-names.js";
import { accountingConfigured } from "../../connectors/accounting.js";
import { getProfile } from "../firm/profile.js";
import { isReady } from "../connections/index.js";
import { holding, holdings, kpiClaims, today, type Holding } from "./common.js";
import { CONFLICT_KINDS, HEALTH_LABELS, INITIATIVE_KINDS, RESOLUTION_KINDS } from "./work.js";
import { holdingValue, valueInputs } from "./value.js";

/**
 * Portfolio Management and Value Creation: every company the fund holds,
 * its numbers and early warnings, the firm's health rating, fair value
 * marks, reserves and follow-ons, board meetings, and the help the firm
 * gives. Performance is gross, on invested capital; LP (net) returns are
 * LP Reporting's.
 *
 * Starts from the investment records Investment Execution writes.
 */

export { PortfolioInvalid } from "./common.js";
export { recordKpis, importKpiCsv, syncCompany } from "./kpis.js";
export { createPortalLink, revokePortal, requestKpis, cancelRequest, portalView, portalSubmit, startAccountingLink, finishAccountingLink } from "./portal.js";
export { proposeMark, reviewMark } from "./marks.js";
export {
  saveExitPlanFor, startExit, updateExitProcess, addBid, consentToExit, previewClose, closeExit, settleReceivable, reviseReceivable, addPublicHolding, editPublicHolding,
  recordPrices, sellPublic, previewInKind, distributeInKind, distributeProceeds, reviewQsbs, companyExits, liquidityOverview, fundLifeView, setFundLife, extendFund,
  setWindDownStep, startContinuation, recordElection, finishContinuation,
} from "./exits.js";
export {
  rateHealth, planReserve, decideFollowOn, recordRealization, addBoardMeeting, addInitiative, setInitiative, queueIntro, addContact, deleteContact, HEALTH_LABELS,
} from "./work.js";

const latestBy = (rows: DecisionRow[]) => {
  const m = new Map<string, DecisionRow>();
  for (const r of rows) if (!m.has(r.entity_id)) m.set(r.entity_id, r); // newest first
  return m;
};

function position(h: Holding, fv: number, real: RealizationRow[]): Position {
  return {
    company: h.name,
    invested: h.investments.map((i) => ({ date: i.close_date, amount: i.amount_usd })),
    realized: real.filter((r) => r.amount_usd > 0).map((r) => ({ date: r.occurred_on, amount: r.amount_usd })),
    fairValue: fv,
  };
}

async function fundInputs(db: Db) {
  const profile = (await getProfile(db))?.profile;
  const size = profile?.fund.committedUsd ?? profile?.fund.targetSizeUsd ?? 0;
  return { size, reservesPct: profile?.fund.reservesPct ?? 0, name: profile?.fund.name ?? "Fund" };
}

export async function overview(db: Db, asOf = today()) {
  const hs = await holdings(db);
  const marks = await latestMarks(db);
  const health = latestBy(await decisionsOf(db, ["health_rating"]));
  const plans = latestBy(await decisionsOf(db, ["reserve_plan"]));
  const allReal = await realizations(db);
  const inputs = await valueInputs(db);
  const rows = [];
  const positions: Position[] = [];
  for (const h of hs) {
    const real = allReal.filter((r) => r.company_id === h.companyId);
    const fv = holdingValue(h, marks.get(h.companyId), real, inputs);
    positions.push(position(h, fv.value, real));
    const sum = summarize(buildSeries(await kpiClaims(db, h.companyId)), asOf);
    const sig = fv.basis === "exited" || fv.basis === "public" ? [] : signals(sum);
    const rating = health.get(h.companyId);
    const invested = h.investments.reduce((a, i) => a + i.amount_usd, 0);
    const realized = real.reduce((a, r) => a + r.amount_usd, 0);
    rows.push({
      companyId: h.companyId, name: h.name, dealId: h.dealId,
      firstInvested: h.investments[0]!.close_date, invested, realized, fairValue: fv.value, valueBasis: fv.basis, pendingUsd: fv.pendingUsd, publicUsd: fv.publicUsd,
      moic: invested > 0 ? (realized + fv.value) / invested : null,
      ownershipPct: [...h.investments].reverse().find((i) => i.ownership_fd_pct !== null)?.ownership_fd_pct ?? null,
      boardRole: h.investments[0]!.board_role,
      status: fv.basis === "exited" ? "exited" : fv.basis === "public" ? "public" : "active",
      health: rating ? { rating: (rating.value as { rating: Health }).rating, by: rating.actor, at: rating.created_at } : null,
      suggested: suggestedHealth(sig),
      signals: sig.map((s) => ({ key: s.key, severity: s.severity, title: s.title })),
      runwayMonths: sum.runwayMonths === Infinity ? null : sum.runwayMonths,
      notBurning: sum.runwayMonths === Infinity,
      cash: sum.cash?.value ?? null,
      revenue: sum.revenue?.value ?? null,
      revenueMoM: sum.revenueMoM,
      arr: sum.arr?.value ?? null,
      latestMonth: sum.latestMonth,
      mark: marks.get(h.companyId) ? { value: marks.get(h.companyId)!.fair_value_usd, asOf: marks.get(h.companyId)!.as_of, method: METHOD_LABELS[marks.get(h.companyId)!.method as keyof typeof METHOD_LABELS] } : null,
      reservePlanned: plans.get(h.companyId) ? Number((plans.get(h.companyId)!.value as { amountUsd: number }).amountUsd) : null,
    });
  }
  const fund = await fundInputs(db);
  const res = reserves({
    fundSizeUsd: fund.size, reservesPct: fund.reservesPct,
    followOns: hs.flatMap((h) => h.investments.filter((i) => i.round_kind === "follow_on").map((i) => ({ company: h.name, amount: i.amount_usd }))),
    planned: hs.flatMap((h) => (plans.get(h.companyId) ? [{ company: h.name, amount: Number((plans.get(h.companyId)!.value as { amountUsd: number }).amountUsd) }] : [])),
  });
  const pending = await valuations(db, { status: "proposed" });
  const open = await kpiRequests(db, { status: "open" });
  return {
    asOf,
    fund: { name: fund.name, sizeUsd: fund.size, reservesPct: fund.reservesPct },
    metrics: portfolioMetrics(positions, asOf),
    reserves: res,
    companies: rows,
    counts: {
      companies: rows.length,
      atRisk: rows.filter((r) => (r.health?.rating ?? r.suggested) === "at_risk" && r.status === "active").length,
      watch: rows.filter((r) => (r.health?.rating ?? r.suggested) === "watch" && r.status === "active").length,
      marksToReview: pending.length,
      openRequests: open.length,
      overdueRequests: open.filter((r) => r.due_on < asOf).length,
    },
    healthLabels: HEALTH_LABELS,
  };
}

export async function companyView(db: Db, companyId: string, viewer: string, asOf = today()) {
  const h = await holding(db, companyId);
  const claims = await kpiClaims(db, companyId);
  const series = buildSeries(claims);
  const sum = summarize(series, asOf);
  const real = await realizations(db, companyId);
  const marks = await valuations(db, { companyId });
  const approved = marks.find((m) => m.status === "approved");
  const fv = holdingValue(h, approved, real, await valueInputs(db));
  const sig = fv.basis === "exited" || fv.basis === "public" ? [] : signals(sum);
  const cites = Object.fromEntries(claims.map((c) => [c.id, { evidenceId: c.evidence_id, citedText: c.cited_text, sourceType: c.source_type }]));
  const decisions = await decisionsOf(db, ["health_rating", "reserve_plan", "follow_on"], companyId);
  const sources = [];
  for (const c of CONNECTORS.filter((x) => x.portfolio)) {
    const ready = c.portfolio!.perCompany ? accountingConfigured(c.id as "quickbooks" | "xero") : await isReady(db, c.id);
    sources.push({ id: c.id, name: c.name, summary: c.portfolio!.summary, perCompany: Boolean(c.portfolio!.perCompany), ready });
  }
  const domain = (await entityIdentifiers(db, companyId, "domain"))[0]?.value ?? null;
  return {
    company: { id: companyId, name: h.name, domain, dealId: h.dealId },
    viewer,
    investments: h.investments,
    position: portfolioMetrics([position(h, fv.value, real)], asOf).positions[0] ?? null,
    valueBasis: fv.basis,
    value: fv,
    series: Object.fromEntries((Object.keys(METRIC_PREDICATE) as Metric[]).filter((m) => series[m]?.length).map((m) => [m, series[m]])),
    metricLabels: Object.fromEntries((Object.entries(METRIC_PREDICATE) as [Metric, string][]).map(([m, p]) => [m, predicateLabel(p)])),
    burn: netBurn(series),
    summary: { ...sum, runwayMonths: sum.runwayMonths === Infinity ? null : sum.runwayMonths, notBurning: sum.runwayMonths === Infinity },
    signals: sig,
    suggested: suggestedHealth(sig),
    rules: DEFAULT_RULES,
    cites,
    health: decisions.filter((d) => d.kind === "health_rating"),
    reservePlans: decisions.filter((d) => d.kind === "reserve_plan"),
    followOns: decisions.filter((d) => d.kind === "follow_on"),
    marks,
    methods: METHOD_LABELS,
    realizations: real,
    board: await boardMeetings(db, companyId),
    initiatives: await initiatives(db, companyId),
    contacts: await contacts(db, companyId),
    requests: await kpiRequests(db, { companyId }),
    accounting: await accountingLinks(db, companyId),
    portalLinks: (await portalLinks(db, companyId)).map((l) => ({ id: l.id, createdAt: l.created_at, expiresAt: l.expires_at, revokedAt: l.revoked_at, lastUsedAt: l.last_used_at, createdBy: l.created_by })),
    sources,
    options: {
      reportable: REPORTABLE_METRICS.map((id) => ({ id, label: predicateLabel(id) })),
      initiativeKinds: INITIATIVE_KINDS,
      resolutionKinds: RESOLUTION_KINDS,
      conflictKinds: CONFLICT_KINDS,
      healthLabels: HEALTH_LABELS,
    },
  };
}

/** Everything across the portfolio for the work queues: marks to review, requests, board meetings, initiatives. */
export async function workQueues(db: Db) {
  return {
    marksToReview: await valuations(db, { status: "proposed" }),
    requests: await kpiRequests(db, { status: "open" }),
    board: (await boardMeetings(db)).slice(0, 20),
    initiatives: (await initiatives(db)).filter((i) => i.status === "proposed" || i.status === "in_progress"),
  };
}
