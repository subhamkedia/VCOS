import type { Db } from "../../lib/db.js";
import {
  bankTxns, callItems, calls, getCallItem, distributionItems, distributions, expenses, getCall, getDistribution, getPartner, insertBankTxn, insertCall, insertDistribution,
  insertExpense, matchBankTxn, partners, recordReceipt, setCallStatus, setDistributionStatus, type CallItemRow, type FundRow, type PartnerRow,
} from "../../ledger/lp.js";
import { getEntity } from "../../ledger/repository.js";
import { LP_LABELS } from "../../ledger/labels.js";
import { allocate, managementFee, splitDealDistribution, splitDistribution, type FeeResult } from "../../engines/fund-accounting.js";
import { mercuryAccounts, mercuryTransactions, parseBankCsv, type BankTxn } from "../../connectors/bank.js";
import { getProfile } from "../firm/profile.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { queue } from "../outbox/index.js";
import { readLedger, gainsAt } from "./books.js";
import {
  addDays, businessDaysBetween, EXPENSE_CATEGORIES, fundOr404, isDay, longDate, LpInvalid, round2, sum, termsOf, today, usd,
} from "./common.js";

/**
 * Capital calls and distributions. A person prepares one, the engine
 * allocates it to the cent, a different person approves it, and only then
 * are the notices drafted, one per investor, into the firm's own mailbox
 * for someone to review and send. VC OS never moves money and never sends:
 * receipts are reconciled from the bank (read only) or recorded by hand.
 */

const n = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v));
/** ILPA's Capital Call and Distribution Notice guidance: at least 10 business days' notice. */
export const MIN_NOTICE_BUSINESS_DAYS = 10;

const ANTI_FRAUD =
  "Please wire only to the fund's bank account on file from your subscription documents. We will never change our bank details by email. If you receive wire instructions that differ, do not send funds: call us on a number you already have to confirm.";

async function mailChannel(db: Db): Promise<"gmail_draft" | "outlook_draft" | null> {
  return (await isReady(db, "gmail")) ? "gmail_draft" : (await isReady(db, "outlook")) ? "outlook_draft" : null;
}

// ---------------------------------------------------------------------------
// Capital calls
// ---------------------------------------------------------------------------

export interface CallInput {
  noticeDate: string;
  dueDate: string;
  investmentsUsd: number;
  expensesUsd: number;
  fee: { from: string; to: string } | null;
  purpose: string | null;
}

function callInput(input: Record<string, unknown>): CallInput {
  const noticeDate = isDay(input.noticeDate) ? input.noticeDate : today();
  if (!isDay(input.dueDate)) throw new LpInvalid("Pick the date the money is due.");
  if (input.dueDate < noticeDate) throw new LpInvalid("The due date is before the notice date.");
  const investmentsUsd = round2(n(input.investmentsUsd));
  const expensesUsd = round2(n(input.expensesUsd));
  if (investmentsUsd < 0 || expensesUsd < 0 || !Number.isFinite(investmentsUsd + expensesUsd)) throw new LpInvalid("Amounts can't be negative.");
  const f = input.fee as { from?: unknown; to?: unknown } | null | undefined;
  const fee = f && (f.from || f.to) ? { from: String(f.from ?? ""), to: String(f.to ?? "") } : null;
  if (fee && (!isDay(fee.from) || !isDay(fee.to) || fee.to < fee.from)) throw new LpInvalid("Pick the fee period: first and last day.");
  if (!investmentsUsd && !expensesUsd && !fee) throw new LpInvalid("A call needs an amount: investments, expenses or a management fee period.");
  const purpose = typeof input.purpose === "string" && input.purpose.trim() ? input.purpose.trim() : null;
  return { noticeDate, dueDate: input.dueDate, investmentsUsd, expensesUsd, fee, purpose };
}

/** What a call would ask of each investor. Pure over the ledger: nothing is saved. */
export async function previewCall(db: Db, fundId: string, input: Record<string, unknown>) {
  const f = await fundOr404(db, fundId);
  const c = callInput(input);
  const ps = await partners(db, fundId);
  if (!ps.length) throw new LpInvalid("Add the fund's investors first.");
  const t = termsOf(f);
  const warnings: string[] = [];
  const payers = ps.filter((p) => p.fee_paying);
  let fee: FeeResult | null = null;
  if (c.fee) {
    const earlier = (await calls(db, fundId)).filter((x) => x.status !== "cancelled" && x.fee_detail.from && x.fee_detail.to);
    const overlap = earlier.find((x) => !(c.fee!.to < x.fee_detail.from! || c.fee!.from > x.fee_detail.to!));
    if (overlap) throw new LpInvalid(`Fees for ${overlap.fee_detail.from} to ${overlap.fee_detail.to} are already in call ${overlap.number}.`);
    const l = await readLedger(db, f);
    // Every offset received by the end of the fee period that an earlier call hasn't already applied.
    const received = sum((await expenses(db, fundId)).filter((e) => e.fee_offset && e.incurred_on <= c.fee!.to).map((e) => e.amount_usd));
    const applied = sum(earlier.map((x) => Number(x.fee_detail.offsets ?? 0)));
    const offsets = Math.max(0, received - applied);
    fee = managementFee(t, {
      from: c.fee.from, to: c.fee.to, feePayingCommitments: sum(payers.map((p) => p.commitment_usd)),
      investedCost: gainsAt(l.holdings, c.fee.to).investedCostHeld, offsets,
    });
  }
  const byCommitment = ps.map((p) => ({ id: p.id, weight: p.commitment_usd }));
  const inv = c.investmentsUsd ? allocate(c.investmentsUsd, byCommitment) : [];
  const exp = c.expensesUsd ? allocate(c.expensesUsd, byCommitment) : [];
  const fees = fee && fee.net > 0 && payers.length ? allocate(fee.net, payers.map((p) => ({ id: p.id, weight: p.commitment_usd }))) : [];
  const got = (xs: { id: string; amount: number }[], id: string) => xs.find((x) => x.id === id)?.amount ?? 0;
  const approvedIds = new Set((await calls(db, fundId)).filter((x) => x.status === "approved").map((x) => x.id));
  const called = new Map<string, number>();
  for (const i of await callItems(db, { fundId })) if (approvedIds.has(i.call_id)) called.set(i.partner_id, (called.get(i.partner_id) ?? 0) + i.amount_usd);
  const items = ps.map((p) => {
    const investment = got(inv, p.id);
    const feeUsd = got(fees, p.id);
    const expense = got(exp, p.id);
    const amount = round2(investment + feeUsd + expense);
    const before = called.get(p.id) ?? 0;
    return { partnerId: p.id, name: p.name, kind: p.kind, commitment: p.commitment_usd, investment, fee: feeUsd, expense, amount, calledBefore: round2(before), unfundedAfter: round2(p.commitment_usd - before - amount) };
  });
  const over = items.filter((i) => i.unfundedAfter < -0.005);
  if (over.length) throw new LpInvalid(`This call is more than ${over.map((o) => o.name).join(", ")} ${over.length === 1 ? "has" : "have"} left to fund.`);
  const notice = businessDaysBetween(c.noticeDate, c.dueDate);
  if (notice < MIN_NOTICE_BUSINESS_DAYS) warnings.push(`Only ${notice} business days' notice. ILPA recommends at least ${MIN_NOTICE_BUSINESS_DAYS}; check what the LPA requires.`);
  if (c.investmentsUsd && !c.purpose) warnings.push("Say what the investment is for: LPs expect the use of proceeds on the notice.");
  return {
    ...c,
    feeResult: fee,
    totals: { investments: c.investmentsUsd, fees: fee?.net ?? 0, expenses: c.expensesUsd, amount: round2(sum(items.map((i) => i.amount))) },
    items,
    warnings,
  };
}

export async function draftCall(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  const p = await previewCall(db, fundId, input);
  const row = await insertCall(db, {
    fundId, noticeDate: p.noticeDate, dueDate: p.dueDate, investmentsUsd: p.investmentsUsd, feesUsd: p.totals.fees, expensesUsd: p.expensesUsd,
    feeDetail: p.fee ? { from: p.fee.from, to: p.fee.to, lines: p.feeResult?.lines ?? [], offsets: p.feeResult?.offsets ?? 0, gross: p.feeResult?.gross ?? 0 } : {},
    purpose: p.purpose,
  }, p.items.filter((i) => i.amount > 0).map((i) => ({ partnerId: i.partnerId, investmentUsd: i.investment, feeUsd: i.fee, expenseUsd: i.expense })), by);
  return { call: row, warnings: p.warnings };
}

function callNotice(fund: FundRow, firm: string, call: { number: number; due_date: string; purpose: string | null; fee_detail: { from?: string; to?: string } }, p: PartnerRow, i: CallItemRow, calledBefore: number) {
  const lines = [
    `Dear ${p.name},`,
    "",
    `${fund.name} is calling capital. Your share is ${usd(i.amount_usd)}, due ${longDate(call.due_date)}.`,
    "",
    ...(i.investment_usd ? [`Investments: ${usd(i.investment_usd)}${call.purpose ? ` (${call.purpose})` : ""}`] : []),
    ...(i.fee_usd ? [`Management fee${call.fee_detail.from ? ` for ${longDate(call.fee_detail.from)} to ${longDate(call.fee_detail.to!)}` : ""}: ${usd(i.fee_usd)}`] : []),
    ...(i.expense_usd ? [`Partnership expenses: ${usd(i.expense_usd)}`] : []),
    `Total due: ${usd(i.amount_usd)}`,
    "",
    `Your commitment: ${usd(p.commitment_usd)}. Called before this notice: ${usd(calledBefore)}. Remaining after it: ${usd(p.commitment_usd - calledBefore - i.amount_usd)}.`,
    "",
    ANTI_FRAUD,
    "",
    `With thanks,`,
    firm,
  ];
  return { subject: `${fund.name}: capital call ${call.number}, due ${longDate(call.due_date)}`, body: lines.join("\n") };
}

/** A second person approves a call; then each investor's notice is drafted for review in the firm's mailbox. */
export async function approveCall(db: Db, callId: string, by: string) {
  const c = await getCall(db, callId);
  if (!c) throw new LpInvalid("No such call.");
  if (c.status !== "draft") throw new LpInvalid(`This call is already ${LP_LABELS.callStatus[c.status]!.toLowerCase()}.`);
  if (c.created_by === by) throw new LpInvalid("Someone other than the person who prepared the call approves it.");
  await setCallStatus(db, callId, "approved", by);
  return { ...(await queueCallNotices(db, callId, by)), approved: true };
}

export async function queueCallNotices(db: Db, callId: string, by: string) {
  const c = await getCall(db, callId);
  if (!c || c.status !== "approved") throw new LpInvalid("Approve the call first.");
  const f = await fundOr404(db, c.fund_id);
  const firm = (await getProfile(db))?.profile.firm.name ?? f.name;
  const ps = new Map((await partners(db, f.id)).map((p) => [p.id, p]));
  const earlier = new Set((await calls(db, f.id)).filter((x) => x.status === "approved" && x.number < c.number).map((x) => x.id));
  const all = await callItems(db, { fundId: f.id });
  const channel = await mailChannel(db);
  const queued: string[] = [];
  const noEmail: string[] = [];
  const notices = [];
  for (const i of all.filter((x) => x.call_id === callId)) {
    const p = ps.get(i.partner_id)!;
    const before = sum(all.filter((x) => x.partner_id === p.id && earlier.has(x.call_id)).map((x) => x.amount_usd));
    const note = callNotice(f, firm, c, p, i, before);
    notices.push({ partner: p.name, to: p.emails, ...note });
    if (!p.emails.length) { noEmail.push(p.name); continue; }
    if (channel) queued.push(await queue(db, channel, { to: p.emails, subject: note.subject, body: note.body }, { summary: `Capital call ${c.number} notice: ${p.name}`, proposedBy: by }));
  }
  return { channel, queued: queued.length, noEmail, notices: channel ? [] : notices };
}

export async function cancelCall(db: Db, callId: string, by: string) {
  const c = await getCall(db, callId);
  if (!c) throw new LpInvalid("No such call.");
  if (c.status !== "draft") throw new LpInvalid("Only a draft call can be cancelled. An approved call is corrected by a new one.");
  await setCallStatus(db, callId, "cancelled", by);
}

// ---------------------------------------------------------------------------
// Receipts and the bank
// ---------------------------------------------------------------------------

async function openItem(db: Db, itemId: string) {
  const r = await getCallItem(db, itemId);
  if (!r) throw new LpInvalid("No such call line.");
  if (r.status !== "approved") throw new LpInvalid("Receipts are recorded against approved calls.");
  return r;
}

/** Record money received against an investor's call line, by hand. */
export async function receive(db: Db, itemId: string, input: Record<string, unknown>, by: string) {
  await openItem(db, itemId);
  const amount = round2(n(input.amountUsd));
  if (!(amount >= 0)) throw new LpInvalid("Enter the amount received.");
  const receivedOn = isDay(input.receivedOn) ? input.receivedOn : today();
  await recordReceipt(db, itemId, { amountUsd: amount, receivedOn }, by);
}

/** Match a bank transaction to a call line (a person's decision when the automatic match can't tell). */
export async function matchReceipt(db: Db, txnId: string, itemId: string, by: string) {
  const r = await openItem(db, itemId);
  const t = (await bankTxns(db, r.fund_id)).find((x) => x.id === txnId);
  if (!t) throw new LpInvalid("No such bank transaction.");
  if (t.matched_item_id) throw new LpInvalid("That transaction is already matched.");
  if (t.amount_usd <= 0) throw new LpInvalid("Only money coming in pays a capital call.");
  await recordReceipt(db, itemId, { amountUsd: round2(r.received_usd + t.amount_usd), receivedOn: t.posted_on, bankTxnId: t.id }, by);
  await matchBankTxn(db, t.id, itemId, by);
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "llc", "inc", "fund", "trust", "ltd", "partners", "capital", "wire"].includes(w));

/**
 * Match incoming bank transactions to open call lines: the amount still due
 * must equal the transaction, received on or after the notice. When more
 * than one investor owes the same amount, the counterparty or memo must
 * name exactly one of them; otherwise it waits for a person.
 */
export async function reconcile(db: Db, fundId: string, by: string) {
  const f = await fundOr404(db, fundId);
  const approved = new Map((await calls(db, f.id)).filter((c) => c.status === "approved").map((c) => [c.id, c]));
  const items = (await callItems(db, { fundId: f.id })).filter((i) => approved.has(i.call_id));
  const ps = new Map((await partners(db, f.id)).map((p) => [p.id, p]));
  let matched = 0;
  const txns = (await bankTxns(db, f.id)).filter((t) => !t.matched_item_id && t.amount_usd > 0).sort((a, b) => a.posted_on.localeCompare(b.posted_on));
  for (const t of txns) {
    const open = items.filter((i) => Math.abs(i.amount_usd - i.received_usd - t.amount_usd) < 0.01 && t.posted_on >= approved.get(i.call_id)!.notice_date);
    let pick = open.length === 1 ? open[0] : undefined;
    if (open.length > 1) {
      const text = words(`${t.counterparty ?? ""} ${t.memo ?? ""}`);
      const named = open.filter((i) => words(ps.get(i.partner_id)!.name).some((w) => text.includes(w)));
      if (named.length === 1) pick = named[0];
    }
    if (!pick) continue;
    await recordReceipt(db, pick.id, { amountUsd: round2(pick.received_usd + t.amount_usd), receivedOn: t.posted_on, bankTxnId: t.id }, by);
    await matchBankTxn(db, t.id, pick.id, by);
    pick.received_usd = round2(pick.received_usd + t.amount_usd);
    matched++;
  }
  return { matched, unmatched: txns.length - matched };
}

async function store(db: Db, fundId: string, provider: string, rows: BankTxn[]) {
  let added = 0;
  for (const r of rows) if (await insertBankTxn(db, { fundId, provider, externalId: r.externalId, postedOn: r.postedOn, amountUsd: r.amount, counterparty: r.counterparty, memo: r.memo })) added++;
  return added;
}

/** Pull the fund's Mercury transactions (read only) since a date, then reconcile. */
export async function syncBank(db: Db, fundId: string, input: { since?: unknown; accountId?: unknown }, by: string, deps: { fetchImpl?: Parameters<typeof mercuryAccounts>[0] } = {}) {
  const f = await fundOr404(db, fundId);
  if (!(await isReady(db, "mercury"))) throw new LpInvalid("Connect Mercury first (Connections → Fund banking), or upload a bank statement.");
  const since = isDay(input.since) ? input.since : addDays(today(), -90);
  const rows = await withFirmCredentials(db, ["mercury"], async () => {
    const accounts = await mercuryAccounts(deps.fetchImpl);
    const pickId = typeof input.accountId === "string" && input.accountId ? input.accountId : null;
    const use = pickId ? accounts.filter((a) => a.id === pickId) : accounts;
    const out: BankTxn[] = [];
    for (const a of use) out.push(...(await mercuryTransactions(a.id, since, today(), deps.fetchImpl)));
    return out;
  });
  const added = await store(db, f.id, "mercury", rows);
  return { fetched: rows.length, added, ...(await reconcile(db, f.id, by)) };
}

export async function importBankCsv(db: Db, fundId: string, file: { name: string; text: string }, by: string) {
  const f = await fundOr404(db, fundId);
  let parsed;
  try {
    parsed = parseBankCsv(file.text);
  } catch (err) {
    throw new LpInvalid((err as Error).message);
  }
  const added = await store(db, f.id, "csv", parsed.rows);
  return { rows: parsed.rows.length, skipped: parsed.skipped, added, ...(await reconcile(db, f.id, by)) };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/** How a distribution splits between investors and the GP's carry, to the cent. Nothing is saved. */
export async function previewDistribution(db: Db, fundId: string, input: Record<string, unknown>) {
  const f = await fundOr404(db, fundId);
  const t = termsOf(f);
  const gross = round2(n(input.grossUsd));
  if (!(gross > 0)) throw new LpInvalid("Enter the amount to distribute.");
  const paidOn = isDay(input.paidOn) ? input.paidOn : today();
  const kind: "cash" | "in_kind" = input.kind === "in_kind" ? "in_kind" : "cash";
  const companyId = typeof input.companyId === "string" && input.companyId ? input.companyId : null;
  if (companyId && !(await getEntity(db, companyId))) throw new LpInvalid("No such company.");
  if (t.waterfall === "american" && !companyId) throw new LpInvalid("A deal-by-deal waterfall needs the investment the proceeds came from.");
  const purpose = typeof input.purpose === "string" && input.purpose.trim() ? input.purpose.trim() : null;
  const ps = await partners(db, fundId);
  if (!ps.length) throw new LpInvalid("Add the fund's investors first.");
  const payers = ps.filter((p) => p.fee_paying);
  const shares = allocate(gross, ps.map((p) => ({ id: p.id, weight: p.commitment_usd })));
  const payerGross = round2(sum(shares.filter((s) => payers.some((p) => p.id === s.id)).map((s) => s.amount)));
  const l = await readLedger(db, f);
  const isPayer = (id: string) => payers.some((p) => p.id === id);
  // Earlier distributions count once approved (paid or about to be), in order.
  const prior = (await distributions(db, fundId)).filter((d) => d.status === "approved" || d.status === "paid");
  const priorIds = new Set(prior.map((d) => d.id));
  const priorItems = (await distributionItems(db, { fundId })).filter((i) => priorIds.has(i.distribution_id) && isPayer(i.partner_id));
  const dated = new Map(prior.map((d) => [d.id, d]));
  const warnings: string[] = [];
  let split;
  if (t.waterfall === "american") {
    const h = l.holdings.find((x) => x.companyId === companyId);
    if (!h) throw new LpInvalid("The fund has no investment in that company.");
    const payerShare = sum(payers.map((p) => p.commitment_usd)) / sum(ps.map((p) => p.commitment_usd));
    const same = prior.filter((d) => d.company_id === companyId);
    split = splitDealDistribution(payerGross, paidOn, {
      cost: h.investments.map((i) => ({ date: i.close_date, amount: round2(i.amount_usd * payerShare) })),
      priorProceeds: priorItems.filter((i) => same.some((d) => d.id === i.distribution_id)).map((i) => ({ date: dated.get(i.distribution_id)!.paid_on, amount: i.net_usd })),
      carryPaid: sum(same.map((d) => d.carry_usd)),
    }, t);
    if ((t.escrowPct ?? 0) < 30) warnings.push("Deal-by-deal carry with less than 30% held in escrow: ILPA Principles 3.0 ask for at least 30% against clawback.");
  } else {
    split = splitDistribution(payerGross, paidOn, {
      contributions: l.contributions.filter((c) => isPayer(c.partnerId) && c.date <= paidOn).map((c) => ({ date: c.date, amount: c.amount })),
      lpDistributions: priorItems.map((i) => ({ date: dated.get(i.distribution_id)!.paid_on, amount: i.net_usd })),
      carryPaid: sum(prior.map((d) => d.carry_usd)),
    }, t);
  }
  const carryByPartner = split.carry > 0 ? allocate(split.carry, payers.map((p) => ({ id: p.id, weight: p.commitment_usd }))) : [];
  const items = ps.map((p) => {
    const g = shares.find((s) => s.id === p.id)?.amount ?? 0;
    const c = carryByPartner.find((s) => s.id === p.id)?.amount ?? 0;
    return { partnerId: p.id, name: p.name, kind: p.kind, gross: g, carry: c, net: round2(g - c) };
  });
  if (kind === "in_kind") warnings.push("An in-kind distribution is valued at the shares' fair value on the date; say how it was valued in the notice.");
  return { paidOn, gross, kind, companyId, purpose, carry: split.carry, escrow: split.escrow, carryPaidNow: split.carryPaidNow, lines: split.lines, items, warnings, waterfall: t.waterfall };
}

export async function draftDistribution(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  const p = await previewDistribution(db, fundId, input);
  const row = await insertDistribution(db, {
    fundId, paidOn: p.paidOn, grossUsd: p.gross, kind: p.kind, companyId: p.companyId, purpose: p.purpose, carryUsd: p.carry, escrowUsd: p.escrow, waterfall: p.lines,
  }, p.items.filter((i) => i.gross > 0).map((i) => ({ partnerId: i.partnerId, grossUsd: i.gross, carryUsd: i.carry, netUsd: i.net })), by);
  return { distribution: row, warnings: p.warnings };
}

export async function approveDistribution(db: Db, id: string, by: string) {
  const d = await getDistribution(db, id);
  if (!d) throw new LpInvalid("No such distribution.");
  if (d.status !== "draft") throw new LpInvalid(`This distribution is already ${LP_LABELS.distributionStatus[d.status]!.toLowerCase()}.`);
  if (d.created_by === by) throw new LpInvalid("Someone other than the person who prepared the distribution approves it.");
  // Everything distributed before this one must be approved first, so the waterfall it was split on still holds.
  const earlierDrafts = (await distributions(db, d.fund_id)).filter((x) => x.status === "draft" && x.number < d.number);
  if (earlierDrafts.length) throw new LpInvalid(`Approve or cancel distribution ${earlierDrafts[0]!.number} first.`);
  await setDistributionStatus(db, id, "approved", by);
  const f = await fundOr404(db, d.fund_id);
  const firm = (await getProfile(db))?.profile.firm.name ?? f.name;
  const company = d.company_id ? (await getEntity(db, d.company_id))?.name ?? null : null;
  const channel = await mailChannel(db);
  const noEmail: string[] = [];
  let queued = 0;
  for (const i of await distributionItems(db, { distributionId: id })) {
    const p = (await getPartner(db, i.partner_id))!;
    const body = [
      `Dear ${p.name},`,
      "",
      `${f.name} is making a ${d.kind === "in_kind" ? "distribution in kind" : "cash distribution"} on ${longDate(d.paid_on)}${company ? `, from ${company}` : ""}${d.purpose ? ` (${d.purpose})` : ""}.`,
      "",
      `Your share: ${usd(i.gross_usd)}`,
      ...(i.carry_usd ? [`Less carried interest: ${usd(i.carry_usd)}`] : []),
      `Net to you: ${usd(i.net_usd)}`,
      "",
      "It will be paid to the account on file. If your bank details have changed, tell us by phone, never only by email: we confirm every change on a number we already have.",
      "",
      "The tax character of this distribution will be reported on your Schedule K-1.",
      "",
      "With thanks,",
      firm,
    ].join("\n");
    if (!p.emails.length) { noEmail.push(p.name); continue; }
    if (channel) {
      await queue(db, channel, { to: p.emails, subject: `${f.name}: distribution ${d.number}, ${longDate(d.paid_on)}`, body }, { summary: `Distribution ${d.number} notice: ${p.name}`, proposedBy: by });
      queued++;
    }
  }
  return { approved: true, channel, queued, noEmail };
}

export async function markDistributionPaid(db: Db, id: string, by: string) {
  const d = await getDistribution(db, id);
  if (!d) throw new LpInvalid("No such distribution.");
  if (d.status !== "approved") throw new LpInvalid("Approve the distribution before recording it as paid.");
  await setDistributionStatus(db, id, "paid", by);
}

export async function cancelDistribution(db: Db, id: string, by: string) {
  const d = await getDistribution(db, id);
  if (!d) throw new LpInvalid("No such distribution.");
  if (d.status !== "draft") throw new LpInvalid("Only a draft distribution can be cancelled.");
  await setDistributionStatus(db, id, "cancelled", by);
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * Record a partnership expense in the ILPA template's categories, a
 * related-party charge (ILPA: an internal chargeback from the GP or an
 * affiliate), or a fee offset (a fee the GP received from a portfolio
 * company that reduces the management fee). A correction is a reversing
 * entry with a negative amount.
 */
export async function addExpense(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  const amount = round2(n(input.amountUsd));
  if (!amount || !Number.isFinite(amount)) throw new LpInvalid("Enter the amount (negative to reverse an entry).");
  const feeOffset = input.feeOffset === true;
  const category = feeOffset ? "other" : String(input.category ?? "");
  if (!EXPENSE_CATEGORIES.includes(category)) throw new LpInvalid("Pick the category.");
  const description = String(input.description ?? "").trim();
  if (description.length < 3) throw new LpInvalid("Describe the expense.");
  const incurredOn = isDay(input.incurredOn) ? input.incurredOn : today();
  return insertExpense(db, { fundId, incurredOn, amountUsd: amount, category, description, relatedParty: input.relatedParty === true, feeOffset }, by);
}
