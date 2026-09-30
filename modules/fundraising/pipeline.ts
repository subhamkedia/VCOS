import type { Db } from "../../lib/db.js";
import { parseCsv } from "../../lib/csv.js";
import {
  activities, getProspect, insertActivity, insertProspect, insertRaise, prospects, raises, updateProspect, updateRaise, type ProspectInput, type ProspectRow,
} from "../../ledger/fundraising.js";
import { funds } from "../../ledger/lp.js";
import { FUNDRAISING_LABELS, LP_LABELS } from "../../ledger/labels.js";
import { STAGES, type Stage } from "../../engines/fundraising.js";
import { affinityListOrgs } from "../../connectors/affinity.js";
import { fundName, getProfile } from "../firm/profile.js";
import { isReady, withFirmCredentials } from "../connections/index.js";
import { kindFrom } from "../lp/index.js";
import { EMAIL, emailsOf, FundraisingInvalid, isDay, money, raiseOr404, text, today } from "./common.js";

/**
 * A raise and its pipeline of prospective LPs. The raise carries the
 * offering's terms (target, hard cap, minimum, the Investment Company Act
 * and Regulation D exemptions, the equalization rate); prospects move
 * through stages with a next step and an owner, and every change is logged.
 * A declined prospect must say why: judgment is data.
 */

const EXEMPTIONS = ["3c1", "3c1_qvcf", "3c7"] as const;
const OFFERINGS = ["506b", "506c"] as const;

export async function createRaise(db: Db, input: Record<string, unknown>, by: string) {
  const full = (await getProfile(db))?.profile;
  const f = full?.fund;
  const name = text(input.name) ?? fundName(full);
  if (!name) throw new FundraisingInvalid("Name the raise.");
  if ((await raises(db)).some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new FundraisingInvalid(`There's already a raise called ${name}.`);
  const target = money(input.targetUsd) ?? f?.targetSizeUsd ?? null;
  if (!target || target <= 0) throw new FundraisingInvalid("Enter the target size.");
  const hardCap = money(input.hardCapUsd) ?? f?.hardCapUsd ?? null;
  if (hardCap !== null && hardCap < target) throw new FundraisingInvalid("The hard cap is below the target.");
  const exemption = (EXEMPTIONS as readonly string[]).includes(String(input.exemption)) ? (input.exemption as (typeof EXEMPTIONS)[number]) : "3c1";
  const offering = (OFFERINGS as readonly string[]).includes(String(input.offering)) ? (input.offering as (typeof OFFERINGS)[number]) : "506b";
  const rate = money(input.equalizationRatePct) ?? 8;
  if (rate > 20) throw new FundraisingInvalid("The equalization rate should be at most 20%.");
  // Link to the LP Reporting fund of the same name when there is one; a closing creates it otherwise.
  const fund = (await funds(db)).find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? null;
  return insertRaise(db, {
    name, fund_id: fund?.id ?? null, target_usd: target, hard_cap_usd: hardCap, min_commitment_usd: money(input.minCommitmentUsd),
    exemption, offering, vcoc: input.vcoc === true, equalization_rate_pct: rate,
    first_close_target: isDay(input.firstCloseTarget) ? input.firstCloseTarget : f?.firstCloseDate ?? null,
    final_close_deadline: isDay(input.finalCloseDeadline) ? input.finalCloseDeadline : f?.finalCloseDate ?? null,
  }, by);
}

export async function editRaise(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const r = await raiseOr404(db, id);
  const patch: Parameters<typeof updateRaise>[2] = {};
  if (input.targetUsd !== undefined) patch.target_usd = money(input.targetUsd) ?? r.target_usd;
  if (input.hardCapUsd !== undefined) patch.hard_cap_usd = money(input.hardCapUsd);
  if (input.minCommitmentUsd !== undefined) patch.min_commitment_usd = money(input.minCommitmentUsd);
  if (input.exemption !== undefined) {
    if (!(EXEMPTIONS as readonly string[]).includes(String(input.exemption))) throw new FundraisingInvalid("Pick the Investment Company Act exemption.");
    patch.exemption = input.exemption as RaiseRowExemption;
  }
  if (input.offering !== undefined) {
    if (!(OFFERINGS as readonly string[]).includes(String(input.offering))) throw new FundraisingInvalid("Pick the Regulation D exemption.");
    patch.offering = input.offering as "506b" | "506c";
  }
  if (input.vcoc !== undefined) patch.vcoc = input.vcoc === true;
  if (input.equalizationRatePct !== undefined) patch.equalization_rate_pct = money(input.equalizationRatePct) ?? 8;
  if (input.finalCloseDeadline !== undefined) patch.final_close_deadline = isDay(input.finalCloseDeadline) ? input.finalCloseDeadline : null;
  if (input.status === "closed" || input.status === "open") patch.status = input.status;
  const hard = patch.hard_cap_usd === undefined ? r.hard_cap_usd : patch.hard_cap_usd;
  if (hard !== null && hard < (patch.target_usd ?? r.target_usd)) throw new FundraisingInvalid("The hard cap is below the target.");
  await updateRaise(db, id, patch, by);
}
type RaiseRowExemption = "3c1" | "3c1_qvcf" | "3c7";

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

function prospectFields(input: Record<string, unknown>): ProspectInput {
  const out: ProspectInput = {};
  if (input.contactName !== undefined) out.contact_name = text(input.contactName);
  if (input.emails !== undefined) {
    const e = emailsOf(input.emails);
    if (e.some((x) => !EMAIL.test(x))) throw new FundraisingInvalid("Check the email addresses.");
    out.emails = e;
  }
  if (input.jurisdiction !== undefined) out.jurisdiction = text(input.jurisdiction);
  if (input.askUsd !== undefined) out.ask_usd = money(input.askUsd);
  if (input.softCircleUsd !== undefined) out.soft_circle_usd = money(input.softCircleUsd);
  if (input.committedUsd !== undefined) out.committed_usd = money(input.committedUsd);
  if (input.probability !== undefined) {
    const p = money(input.probability);
    if (p !== null && (p < 0 || p > 100)) throw new FundraisingInvalid("Odds are a percentage from 0 to 100.");
    out.probability = p === null ? null : p / 100;
  }
  if (input.source !== undefined) out.source = text(input.source);
  if (input.owner !== undefined) out.owner = text(input.owner);
  if (input.nextStep !== undefined) out.next_step = text(input.nextStep);
  if (input.nextStepOn !== undefined) out.next_step_on = isDay(input.nextStepOn) ? input.nextStepOn : null;
  return out;
}

export async function addProspect(db: Db, raiseId: string, input: Record<string, unknown>, by: string): Promise<ProspectRow> {
  await raiseOr404(db, raiseId);
  const name = text(input.name);
  if (!name) throw new FundraisingInvalid("Enter the investor's name.");
  const kind = String(input.kind ?? "other");
  if (!(kind in LP_LABELS.partnerKinds) || kind === "gp") throw new FundraisingInvalid("Pick the type of investor.");
  if ((await prospects(db, raiseId)).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new FundraisingInvalid(`${name} is already in this raise's pipeline.`);
  const p = await insertProspect(db, raiseId, { ...prospectFields(input), name, kind }, by);
  await insertActivity(db, { prospectId: p.id, occurredOn: today(), kind: "stage", summary: `Added at ${FUNDRAISING_LABELS.stages[p.stage]!.toLowerCase()}` }, by);
  return p;
}

/** Edit a prospect; a stage change is logged, and a decline needs a reason. */
export async function editProspect(db: Db, id: string, input: Record<string, unknown>, by: string) {
  const p = await getProspect(db, id);
  if (!p) throw new FundraisingInvalid("No such prospect.");
  const patch = prospectFields(input);
  if (input.stage !== undefined && input.stage !== p.stage) {
    const stage = String(input.stage) as Stage;
    if (!STAGES.includes(stage)) throw new FundraisingInvalid("Pick a stage.");
    if (stage === "closed") throw new FundraisingInvalid("A prospect is closed by admitting its subscription at a closing.");
    if (stage === "declined") {
      const reason = text(input.declineReason);
      if (!reason) throw new FundraisingInvalid("Say why they declined: it's what the next raise learns from.");
      patch.decline_reason = reason;
    }
    if (stage === "soft_circle" && !(patch.soft_circle_usd ?? p.soft_circle_usd)) throw new FundraisingInvalid("Enter the soft-circled amount.");
    patch.stage = stage;
    await insertActivity(db, { prospectId: id, occurredOn: today(), kind: "stage", summary: `${FUNDRAISING_LABELS.stages[p.stage]} → ${FUNDRAISING_LABELS.stages[stage]}${stage === "declined" ? `: ${patch.decline_reason}` : ""}` }, by);
  }
  await updateProspect(db, id, patch, by);
}

export async function logActivity(db: Db, prospectId: string, input: Record<string, unknown>, by: string) {
  const p = await getProspect(db, prospectId);
  if (!p) throw new FundraisingInvalid("No such prospect.");
  const kind = String(input.kind ?? "note");
  if (!["note", "meeting", "call", "email"].includes(kind)) throw new FundraisingInvalid("Pick what happened.");
  const summary = text(input.summary);
  if (!summary) throw new FundraisingInvalid("Say what happened.");
  await insertActivity(db, { prospectId, occurredOn: isDay(input.occurredOn) ? input.occurredOn : today(), kind, summary }, by);
  if (input.nextStep !== undefined || input.nextStepOn !== undefined) await updateProspect(db, prospectId, prospectFields({ nextStep: input.nextStep, nextStepOn: input.nextStepOn }), by);
}

export async function prospectActivity(db: Db, prospectId: string) {
  return activities(db, { prospectId });
}

/** Prospects from a spreadsheet or CRM export: name required; type, contact, email, ask, source and owner read when present. */
export async function importProspectsCsv(db: Db, raiseId: string, file: { name: string; text: string }, by: string) {
  await raiseOr404(db, raiseId);
  const [head, ...rows] = parseCsv(file.text);
  if (!head) throw new FundraisingInvalid("The file is empty.");
  const h = head.map((x) => x.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => h.findIndex((x) => names.some((n) => x === n || x.startsWith(n)));
  const name = col("organization", "investorname", "investor", "name", "firm", "company");
  if (name < 0) throw new FundraisingInvalid("The file needs an investor or organization name column.");
  const type = col("investortype", "type", "category");
  const contact = col("contactname", "contact", "person");
  const email = col("email", "emails");
  const ask = col("ask", "target", "ticket", "expectedcommitment", "amount");
  const source = col("source", "introducedby", "intro", "referral");
  const owner = col("owner", "lead", "relationshipowner");
  let added = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of rows.entries()) {
    if (!r.some((x) => x.trim())) continue;
    try {
      await addProspect(db, raiseId, {
        name: r[name], kind: type >= 0 ? (kindFrom(r[type] ?? "") === "gp" ? "other" : kindFrom(r[type] ?? "")) : "other",
        contactName: contact >= 0 ? r[contact] : undefined, emails: email >= 0 ? r[email] : undefined, askUsd: ask >= 0 ? r[ask] : undefined,
        source: source >= 0 ? r[source] : undefined, owner: owner >= 0 ? r[owner] : undefined,
      }, by);
      added++;
    } catch (err) {
      skipped.push({ row: i + 2, reason: (err as Error).message });
    }
  }
  return { added, skipped };
}

/** Prospects from an Affinity list of organizations (the firm's own CRM key). */
export async function importAffinityList(db: Db, raiseId: string, listId: unknown, by: string, deps: { list?: typeof affinityListOrgs } = {}) {
  await raiseOr404(db, raiseId);
  const id = Number(listId);
  if (!Number.isInteger(id) || id <= 0) throw new FundraisingInvalid("Enter the Affinity list id (the number in the list's address).");
  if (!deps.list && !(await isReady(db, "affinity"))) throw new FundraisingInvalid("Connect Affinity first.");
  const orgs = deps.list ? await deps.list(id) : await withFirmCredentials(db, ["affinity"], () => affinityListOrgs(id));
  const existing = new Set((await prospects(db, raiseId)).map((p) => p.name.toLowerCase()));
  let added = 0;
  for (const o of orgs) {
    if (existing.has(o.name.toLowerCase())) continue;
    await addProspect(db, raiseId, { name: o.name, kind: "other", source: "Affinity" }, by);
    existing.add(o.name.toLowerCase());
    added++;
  }
  return { found: orgs.length, added };
}
