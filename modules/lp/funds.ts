import type { Db } from "../../lib/db.js";
import { parseCsv } from "../../lib/csv.js";
import { sha256 } from "../../lib/text.js";
import { newToken } from "../../ledger/platform.js";
import {
  funds, getPartner, insertFund, insertLpPortalLink, insertPartner, partners, revokeLpPortalLinks, updateFund, updatePartner, upsertTaxDoc, type FundRow, type TaxDocRow,
} from "../../ledger/lp.js";
import { LP_LABELS } from "../../ledger/labels.js";
import { getProfile } from "../firm/profile.js";
import { addDays, EXPENSE_CATEGORIES, fundOr404, isDay, LpInvalid, PARTNER_KINDS, termsOf, today, type StoredTerms } from "./common.js";

/**
 * Funds and their partners. A fund's economics are copied from the firm
 * profile when it's set up (fee, step-down, carry, hurdle, waterfall), then
 * kept with the fund: the LPA governs, and later edits to the profile don't
 * rewrite a fund's history. Partners are the LPs and the GP's own
 * commitment, which pays no fee or carry.
 */

const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));

export function checkTerms(input: Record<string, unknown>, fallback?: StoredTerms): StoredTerms {
  const t = { ...(fallback ?? {}), ...input } as Record<string, unknown>;
  const pct = (k: string, max: number, required = true) => {
    const v = n(t[k]);
    if (v === undefined) {
      if (required) throw new LpInvalid(`Enter the ${LABEL[k] ?? k}.`);
      return undefined;
    }
    if (!Number.isFinite(v) || v < 0 || v > max) throw new LpInvalid(`The ${LABEL[k] ?? k} should be between 0 and ${max}%.`);
    return v;
  };
  if (!isDay(t.investmentPeriodEnd)) throw new LpInvalid("Enter the last day of the investment period.");
  const out: StoredTerms = {
    managementFeePct: pct("managementFeePct", 10)!,
    feeStepDownPct: pct("feeStepDownPct", 10, false),
    feeBasisAfterPeriod: t.feeBasisAfterPeriod === "invested" ? "invested" : "committed",
    investmentPeriodEnd: t.investmentPeriodEnd,
    carryPct: pct("carryPct", 50)!,
    hurdlePct: pct("hurdlePct", 20)!,
    catchUpPct: pct("catchUpPct", 100)!,
    waterfall: t.waterfall === "american" ? "american" : "european",
    escrowPct: pct("escrowPct", 100, false),
    gpCommitmentPct: pct("gpCommitmentPct", 20, false),
  };
  return out;
}

const LABEL: Record<string, string> = {
  managementFeePct: "management fee", feeStepDownPct: "fee after the investment period", carryPct: "carried interest", hurdlePct: "hurdle (preferred return)",
  catchUpPct: "GP catch-up", escrowPct: "carry escrow", gpCommitmentPct: "GP commitment",
};

/** Set up a fund, from the firm profile's fund unless told otherwise. */
export async function createFund(db: Db, input: Record<string, unknown>, by: string): Promise<FundRow> {
  const profile = (await getProfile(db))?.profile.fund;
  const name = String(input.name ?? profile?.name ?? "").trim();
  if (!name) throw new LpInvalid("Name the fund.");
  if ((await funds(db)).some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new LpInvalid(`There's already a fund called ${name}.`);
  const inception = isDay(input.inception) ? input.inception : profile?.firstCloseDate;
  if (!isDay(inception)) throw new LpInvalid("Enter the fund's first closing date.");
  const years = n(input.investmentPeriodYears) ?? profile?.investmentPeriodYears ?? 5;
  const ipEnd = isDay(input.investmentPeriodEnd) ? input.investmentPeriodEnd : addDays(`${Number(inception.slice(0, 4)) + years}${inception.slice(4)}`, -1);
  const waterfall = (input.waterfall ?? profile?.waterfall ?? "european") as string;
  const terms = checkTerms({
    managementFeePct: input.managementFeePct ?? profile?.managementFeePct ?? 2,
    feeStepDownPct: input.feeStepDownPct ?? profile?.feeStepDownPct,
    feeBasisAfterPeriod: input.feeBasisAfterPeriod ?? profile?.feeBasisAfterPeriod ?? "committed",
    investmentPeriodEnd: ipEnd,
    carryPct: input.carryPct ?? profile?.carryPct ?? 20,
    hurdlePct: input.hurdlePct ?? profile?.hurdlePct ?? 0,
    catchUpPct: input.catchUpPct ?? 100,
    waterfall,
    // ILPA Principles 3.0: deal-by-deal carry should hold back at least 30% in escrow.
    escrowPct: input.escrowPct ?? (waterfall === "american" ? 30 : undefined),
    gpCommitmentPct: input.gpCommitmentPct ?? profile?.gpCommitmentPct,
  });
  const vintage = n(input.vintage) ?? profile?.vintage ?? Number(inception.slice(0, 4));
  const currency = String(input.currency ?? profile?.currency ?? "USD");
  return insertFund(db, { name, vintage, currency, inception, terms }, by);
}

export async function setTerms(db: Db, fundId: string, input: Record<string, unknown>, by: string): Promise<StoredTerms> {
  const f = await fundOr404(db, fundId);
  const terms = checkTerms(input, termsOf(f));
  await updateFund(db, fundId, { terms }, by);
  return terms;
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const emailsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,;\s]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function addPartner(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  const f = await fundOr404(db, fundId);
  const name = String(input.name ?? "").trim();
  if (!name) throw new LpInvalid("Enter the investor's legal name.");
  const kind = String(input.kind ?? "other");
  if (!PARTNER_KINDS.includes(kind)) throw new LpInvalid("Pick the type of investor.");
  const commitment = n(input.commitmentUsd);
  if (!commitment || commitment <= 0) throw new LpInvalid("Enter the commitment.");
  const emails = emailsOf(input.emails);
  if (emails.some((e) => !EMAIL.test(e))) throw new LpInvalid("Check the email addresses.");
  const gp = kind === "gp";
  const admittedOn = isDay(input.admittedOn) ? input.admittedOn : f.inception;
  if ((await partners(db, fundId)).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new LpInvalid(`${name} is already an investor in this fund.`);
  const taxStatus = input.taxStatus ? String(input.taxStatus) : null;
  if (taxStatus && !(taxStatus in LP_LABELS.taxStatus)) throw new LpInvalid("Pick a tax status.");
  const investorStatus = input.investorStatus ? String(input.investorStatus) : null;
  if (investorStatus && !(investorStatus in LP_LABELS.investorStatus)) throw new LpInvalid("Pick an investor status.");
  return insertPartner(db, {
    fundId, name, kind, commitmentUsd: commitment, feePaying: gp ? false : input.feePaying !== false, closing: Math.max(1, Math.round(n(input.closing) ?? 1)),
    admittedOn, emails, taxStatus, erisa: input.erisa === true, investorStatus, kycVerifiedOn: isDay(input.kycVerifiedOn) ? input.kycVerifiedOn : null,
    sideLetter: typeof input.sideLetter === "string" && input.sideLetter.trim() ? input.sideLetter.trim() : null,
  }, by);
}

export async function editPartner(db: Db, partnerId: string, input: Record<string, unknown>, by: string) {
  const p = await getPartner(db, partnerId);
  if (!p) throw new LpInvalid("No such investor.");
  const patch: Parameters<typeof updatePartner>[2] = {};
  if (input.emails !== undefined) {
    const emails = emailsOf(input.emails);
    if (emails.some((e) => !EMAIL.test(e))) throw new LpInvalid("Check the email addresses.");
    patch.emails = emails;
  }
  if (input.taxStatus !== undefined) patch.taxStatus = input.taxStatus ? String(input.taxStatus) : null;
  if (input.investorStatus !== undefined) patch.investorStatus = input.investorStatus ? String(input.investorStatus) : null;
  if (input.erisa !== undefined) patch.erisa = input.erisa === true;
  if (input.kycVerifiedOn !== undefined) patch.kycVerifiedOn = isDay(input.kycVerifiedOn) ? input.kycVerifiedOn : null;
  if (input.sideLetter !== undefined) patch.sideLetter = typeof input.sideLetter === "string" && input.sideLetter.trim() ? input.sideLetter.trim() : null;
  await updatePartner(db, partnerId, patch, by);
}

/** Map a fund administrator's investor type to ours (Carta, Juniper Square and AngelList exports all word these differently). */
export function kindFrom(s: string): string {
  const t = s.toLowerCase();
  if (/general partner|\bgp\b|sponsor|manager commit/.test(t)) return "gp";
  if (/pension|retirement|superannuation/.test(t)) return "pension";
  if (/endow|foundation|university|charit/.test(t)) return "endowment_foundation";
  if (/insur/.test(t)) return "insurance";
  if (/fund of funds|fof|fund-of-funds/.test(t)) return "fund_of_funds";
  if (/family/.test(t)) return "family_office";
  if (/sovereign|swf/.test(t)) return "sovereign";
  if (/individual|person|natural|trust|ira\b/.test(t)) return "individual";
  if (/corporat|company|strategic|llc|inc\b/.test(t)) return "corporate";
  return PARTNER_KINDS.includes(t) ? t : "other";
}

/**
 * Import the LP register from a fund administrator's or spreadsheet export.
 * Needs a name and a commitment column; understands type, email, closing,
 * admission date, fee-paying and tax columns when present. Investors already
 * in the fund are skipped, never overwritten.
 */
export async function importPartnersCsv(db: Db, fundId: string, file: { name: string; text: string }, by: string) {
  await fundOr404(db, fundId);
  const [head, ...rows] = parseCsv(file.text);
  if (!head) throw new LpInvalid("The file is empty.");
  const h = head.map((x) => x.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => h.findIndex((x) => names.some((nm) => x === nm || x.startsWith(nm)));
  const name = col("investorname", "legalname", "limitedpartner", "investor", "name", "entity");
  const commitment = col("commitment", "commitmentamount", "capitalcommitment", "committed", "subscription");
  if (name < 0 || commitment < 0) throw new LpInvalid("The file needs an investor name column and a commitment column.");
  const type = col("investortype", "type", "entitytype", "category");
  const email = col("email", "emails", "contactemail", "noticeemail");
  const closing = col("closing", "closenumber", "close");
  const admitted = col("admitted", "admissiondate", "closedate", "closingdate", "date");
  const fee = col("feepaying", "managementfee", "fee");
  const tax = col("taxstatus", "taxexempt", "tax");
  const existing = new Set((await partners(db, fundId)).map((p) => p.name.toLowerCase()));
  const added: string[] = [];
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of rows.entries()) {
    if (!r.some((x) => x.trim())) continue;
    const nm = r[name]?.trim() ?? "";
    const amt = Number((r[commitment] ?? "").replace(/[^0-9.]/g, ""));
    if (!nm || !amt) { skipped.push({ row: i + 2, reason: "No name or commitment." }); continue; }
    if (existing.has(nm.toLowerCase())) { skipped.push({ row: i + 2, reason: `${nm} is already in the fund.` }); continue; }
    const taxRaw = tax >= 0 ? (r[tax] ?? "").toLowerCase() : "";
    const us = admitted >= 0 ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((r[admitted] ?? "").trim()) : null;
    const admittedOn = us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : admitted >= 0 ? r[admitted]?.trim().slice(0, 10) : undefined;
    try {
      await addPartner(db, fundId, {
        name: nm, kind: type >= 0 ? kindFrom(r[type] ?? "") : "other", commitmentUsd: amt,
        emails: email >= 0 ? r[email] : "", closing: closing >= 0 ? Number((r[closing] ?? "").replace(/\D/g, "")) || 1 : 1,
        admittedOn, feePaying: fee >= 0 ? !/^(no|n|false|0|waived)$/i.test((r[fee] ?? "").trim()) : undefined,
        taxStatus: /exempt|yes|true/.test(taxRaw) ? "tax_exempt" : /foreign|non-us|nonus/.test(taxRaw) ? "foreign" : taxRaw ? "taxable" : undefined,
      }, by);
      existing.add(nm.toLowerCase());
      added.push(nm);
    } catch (err) {
      skipped.push({ row: i + 2, reason: (err as Error).message });
    }
  }
  return { added: added.length, names: added, skipped };
}

// ---------------------------------------------------------------------------
// Tax documents
// ---------------------------------------------------------------------------

/** Track a partner's K-1, K-3 or estimate for a tax year (the documents themselves come from the fund's tax preparer). */
export async function setTaxDoc(db: Db, fundId: string, input: Record<string, unknown>, by: string) {
  await fundOr404(db, fundId);
  const p = await getPartner(db, String(input.partnerId ?? ""));
  if (!p || p.fund_id !== fundId) throw new LpInvalid("No such investor in this fund.");
  const year = Math.round(Number(input.taxYear));
  if (!(year > 2000 && year < 2100)) throw new LpInvalid("Enter the tax year.");
  const kind = String(input.kind ?? "k1") as TaxDocRow["kind"];
  if (!(kind in LP_LABELS.taxDocKinds)) throw new LpInvalid("Pick the document.");
  const status = input.status === "delivered" ? "delivered" : "pending";
  const deliveredOn = status === "delivered" ? (isDay(input.deliveredOn) ? input.deliveredOn : today()) : null;
  await upsertTaxDoc(db, { fundId, partnerId: p.id, taxYear: year, kind, status, deliveredOn, note: typeof input.note === "string" ? input.note.trim() || null : null }, by);
}

// ---------------------------------------------------------------------------
// LP portal links
// ---------------------------------------------------------------------------

export const LP_PORTAL_DAYS = 90;

/**
 * An investor's private link to its own statements, notices and the fund's
 * approved reports. Random, shown once, stored as a hash, expiring and
 * revocable. It never shows another investor's account.
 */
export async function createLpPortalLink(db: Db, partnerId: string, by: string, appUrl: string) {
  const p = await getPartner(db, partnerId);
  if (!p) throw new LpInvalid("No such investor.");
  if (p.kind === "gp") throw new LpInvalid("The GP's own commitment doesn't need a portal link.");
  const token = newToken();
  const row = await insertLpPortalLink(db, partnerId, sha256(token), LP_PORTAL_DAYS, by);
  return { id: row.id, url: `${appUrl.replace(/\/$/, "")}/investor/${token}`, expiresAt: row.expires_at };
}

export async function revokeLpPortal(db: Db, partnerId: string, by: string) {
  const p = await getPartner(db, partnerId);
  if (!p) throw new LpInvalid("No such investor.");
  return { revoked: await revokeLpPortalLinks(db, partnerId, by) };
}

export { EXPENSE_CATEGORIES };
