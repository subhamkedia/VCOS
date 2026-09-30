import type { Db } from "../../lib/db.js";
import { activities, closings, docs, prospects, raises, subscriptions } from "../../ledger/fundraising.js";
import { FUNDRAISING_LABELS } from "../../ledger/labels.js";
import { pipeline, offeringIssues, type Issue } from "../../engines/fundraising.js";
import { CONNECTORS } from "../../connectors/registry.js";
import { isReady } from "../connections/index.js";
import { engagement } from "./dataroom.js";
import { readiness, subscriber } from "./subscriptions.js";
import { raiseOr404, today } from "./common.js";

/**
 * Fundraising & Investor Relations: raising a fund (the pipeline of
 * prospective LPs, the data room, the DDQ, subscriptions, closings,
 * equalization, side letters and MFN) and looking after investors after
 * the close (the LPAC, investor requests). Closings feed LP Reporting's
 * investor register, so an investor is entered once.
 */

export { FundraisingInvalid } from "./common.js";
export { createRaise, editRaise, addProspect, editProspect, logActivity, prospectActivity, importProspectsCsv, importAffinityList } from "./pipeline.js";
export { uploadDoc, approveDoc, archiveDoc, downloadDocInternal, shareDataRoom, revokeDataRoom, engagement, dataRoomView, acknowledgeDataRoom, openDoc } from "./dataroom.js";
export { DDQ_QUESTIONS, DDQ_SECTIONS, ddqView, draftFromRecords, saveAnswer, approveDdqAnswer, exportDdq } from "./ddq.js";
export {
  inviteSubscriber, subscriptionView, subscriptionSubmit, screenSubscriber, checkWithParallel, reviewSubscription, decideSubscription, withdrawSubscription, sendSubscriptionDocs, readiness,
} from "./subscriptions.js";
export { draftClosing, closingView, approveClosing, cancelClosing, settle } from "./closings.js";
export { addTerm, sideLetterView, mfnPackage, decideMfn } from "./sideletters.js";
export { addLpacMember, endLpacMember, requestConsent, castVote, decideLpacConsent, lpacView, logRequest, answerInvestorRequest, requestQueue, tally } from "./ir.js";

export async function overview(db: Db) {
  const rs = await raises(db);
  const out = [];
  for (const r of rs) {
    const ps = await prospects(db, r.id);
    const p = pipeline(ps.map((x) => ({ stage: x.stage, askUsd: x.ask_usd, softCircleUsd: x.soft_circle_usd, committedUsd: x.committed_usd, probability: x.probability })), r.target_usd);
    out.push({
      id: r.id, name: r.name, status: r.status, targetUsd: r.target_usd, hardCapUsd: r.hard_cap_usd, closedUsd: p.closed, weightedUsd: p.weighted, coverage: p.coverage,
      prospects: ps.filter((x) => x.stage !== "declined").length,
      followUpsDue: ps.filter((x) => x.next_step_on && x.next_step_on <= today() && !["closed", "declined"].includes(x.stage)).length,
    });
  }
  return { raises: out, labels: FUNDRAISING_LABELS };
}

/** One raise, everything its pages show. */
export async function raiseView(db: Db, id: string) {
  const r = await raiseOr404(db, id);
  const ps = await prospects(db, id);
  const subs = await subscriptions(db, id);
  const p = pipeline(ps.map((x) => ({ stage: x.stage, askUsd: x.ask_usd, softCircleUsd: x.soft_circle_usd, committedUsd: x.committed_usd, probability: x.probability })), r.target_usd);
  const eng = await engagement(db, id);
  const admitted = subs.filter((s) => s.status === "admitted");
  const issues: Issue[] = offeringIssues({ exemption: r.exemption, offering: r.offering, hardCapUsd: r.hard_cap_usd, minCommitmentUsd: r.min_commitment_usd, vcoc: r.vcoc },
    subs.filter((s) => ["admitted", "accepted", "submitted"].includes(s.status)).map(subscriber));
  const now = today();
  return {
    raise: r,
    labels: FUNDRAISING_LABELS,
    pipeline: p,
    prospects: ps.map((x) => ({ ...x, engagement: eng.byProspect.find((e) => e.prospectId === x.id) ?? null, dataRoom: eng.links.find((l) => l.prospect_id === x.id && !l.revoked_at && l.expires_at > new Date().toISOString()) ?? null, overdue: Boolean(x.next_step_on && x.next_step_on < now && !["closed", "declined"].includes(x.stage)) })),
    activity: await activities(db, { raiseId: id }),
    documents: await docs(db, id),
    dataRoomViews: eng.recent,
    subscriptions: subs.map((s) => ({ ...s, open: readiness(s, r) })),
    closings: await closings(db, id),
    admitted: { investors: admitted.length, commitments: admitted.reduce((a, s) => a + (s.commitment_usd ?? 0), 0) },
    issues,
    sources: await Promise.all(CONNECTORS.filter((c) => c.fundraising).map(async (c) => ({ id: c.id, name: c.name, summary: c.fundraising!.summary, manual: Boolean(c.manual), ready: c.manual || c.auth.kind === "none" ? true : await isReady(db, c.id) }))),
  };
}
