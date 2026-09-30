import type { Db } from "../../lib/db.js";
import { decideElection, elections, getSubscription, insertElection, insertTerm, subscriptions, terms } from "../../ledger/fundraising.js";
import { FUNDRAISING_LABELS } from "../../ledger/labels.js";
import { mfnElectable } from "../../engines/fundraising.js";
import { queue } from "../outbox/index.js";
import { addDays, FundraisingInvalid, firmName, isDay, longDate, mailChannel, raiseOr404, text, today } from "./common.js";

/**
 * Side letters and MFN. Each negotiated term is recorded by category.
 * An investor holding an MFN term may elect terms granted to investors with
 * an equal or smaller commitment, except ones marked not electable (an
 * LPAC seat, a tax or regulatory term particular to its holder). After the
 * final closing, the election package goes to each MFN holder with a window
 * (ILPA and market practice: 30 to 60 days); elected terms are added to the
 * holder's side letter. Terms that oblige the firm (reporting, excuse
 * rights, confidentiality) are listed as obligations to keep.
 */

const OBLIGATIONS = ["reporting", "excuse", "esg", "confidentiality", "tax_regulatory", "co_invest", "transfer"];

export async function addTerm(db: Db, subscriptionId: string, input: Record<string, unknown>, by: string) {
  const s = await getSubscription(db, subscriptionId);
  if (!s) throw new FundraisingInvalid("No such subscription.");
  const category = String(input.category ?? "");
  if (!(category in FUNDRAISING_LABELS.termCategories)) throw new FundraisingInvalid("Pick the kind of term.");
  const t = text(input.text);
  if (!t) throw new FundraisingInvalid("Write the term as agreed.");
  const electable = category === "mfn" || category === "lpac_seat" ? false : input.electable !== false;
  return insertTerm(db, { raiseId: s.raise_id, subscriptionId, category, text: t, electable, grantedOn: isDay(input.grantedOn) ? input.grantedOn : today() }, by);
}

export async function sideLetterView(db: Db, raiseId: string) {
  await raiseOr404(db, raiseId);
  const ts = await terms(db, raiseId);
  const subs = await subscriptions(db, raiseId);
  const es = await elections(db, raiseId);
  return {
    terms: ts,
    elections: es.map((e) => ({ ...e, investor: subs.find((s) => s.id === e.subscription_id)?.investor_name ?? "", term: ts.find((t) => t.id === e.term_id) ?? null })),
    obligations: ts.filter((t) => OBLIGATIONS.includes(t.category)).map((t) => ({ investor: t.investor_name, category: FUNDRAISING_LABELS.termCategories[t.category], text: t.text, since: t.granted_on })),
  };
}

/** Offer each MFN holder what it may elect, with a window, and draft the letters. */
export async function mfnPackage(db: Db, raiseId: string, input: { windowDays?: unknown }, by: string) {
  const r = await raiseOr404(db, raiseId);
  const days = Math.min(90, Math.max(15, Number(input.windowDays) || 45));
  const windowEnds = addDays(today(), days);
  const subs = (await subscriptions(db, raiseId)).filter((s) => s.status === "admitted" || s.status === "accepted");
  const ts = (await terms(db, raiseId)).filter((t) => subs.some((s) => s.id === t.subscription_id));
  const commitment = new Map(subs.map((s) => [s.id, s.commitment_usd ?? 0]));
  const menu = mfnElectable(
    ts.filter((t) => !t.elected_from).map((t) => ({ id: t.id, holderId: t.subscription_id, holderCommitment: commitment.get(t.subscription_id) ?? 0, category: t.category, electable: t.electable })),
    subs.map((s) => ({ id: s.id, commitment: s.commitment_usd ?? 0, hasMfn: ts.some((t) => t.subscription_id === s.id && t.category === "mfn") })),
  );
  const channel = await mailChannel(db);
  const firm = await firmName(db);
  let offered = 0;
  let letters = 0;
  for (const [holderId, options] of menu) {
    if (!options.length) continue;
    for (const o of options) if (await insertElection(db, { raiseId, subscriptionId: holderId, termId: o.id, windowEnds })) offered++;
    const s = subs.find((x) => x.id === holderId)!;
    if (channel && s.emails.length) {
      const body = [`Dear ${s.investor_name},`, "", `Under your side letter's most favored nation provision, you may elect any of the following terms granted to other investors in ${r.name}. Please tell us which you elect by ${longDate(windowEnds)}.`, "",
        ...options.map((o, i) => `${i + 1}. ${FUNDRAISING_LABELS.termCategories[o.category]}: ${ts.find((t) => t.id === o.id)!.text}`), "", "With thanks,", firm].join("\n");
      await queue(db, channel, { to: s.emails, subject: `${r.name}: MFN election`, body }, { summary: `MFN election package: ${s.investor_name}`, proposedBy: by });
      letters++;
    }
  }
  return { offered, letters, windowEnds };
}

export async function decideMfn(db: Db, electionId: string, input: { elect?: unknown }, by: string) {
  const e = await decideElection(db, electionId, input.elect === true ? "elected" : "declined", today(), by);
  if (e.status === "elected") {
    const src = (await terms(db, (await getSubscription(db, e.subscription_id))!.raise_id)).find((t) => t.id === e.term_id)!;
    await insertTerm(db, { raiseId: src.raise_id, subscriptionId: e.subscription_id, category: src.category, text: src.text, electable: false, grantedOn: today(), electedFrom: src.id }, by);
  }
  return e;
}
