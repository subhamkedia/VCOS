/**
 * Compliance rules as deterministic, tested code: what's due and when for
 * the adviser's status, the pay-to-play de minimis test, and first-pass
 * classifications for outbound investment, CFIUS and export controls. They
 * flag and date things; counsel and the CCO decide. Rule citations are in
 * each result so a person can check them.
 */

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const quarterEnds = (year: number) => [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`];

export type AdviserStatus = "registered" | "era" | "state" | "none";

export interface Obligation {
  key: string;
  title: string;
  due: string;
  basis: string;
  /** Who or what it's for (a fund, a state, a company), when it isn't the firm. */
  subject?: string;
  /** The filing form that satisfies it, so a recorded filing can close it. */
  form: string;
}

export interface Facts {
  status: AdviserStatus;
  /** Fiscal year end as MM-DD (December 31 for almost every VC firm). */
  fiscalYearEnd: string;
  /** Regulatory assets in private funds, for the Form PF threshold. */
  privateFundAumUsd: number;
  /** First closings (first sale) by fund, for Form D. */
  firstSales: { fund: string; date: string; stillOffering: boolean }[];
  /** Admissions by US state (the first sale in each state), for notice filings. */
  stateSales: { fund: string; state: string; date: string }[];
  /** Notifiable outbound transactions, by closing date. */
  outboundNotifiable: { company: string; closed: string }[];
  /** Listed holdings of 5% or more (Schedule 13G), or where we're an insider (Form 3), from the listing date. */
  publicHoldings: { company: string; crossed: string; pct: number; insider: boolean }[];
}

/** Everything due in a calendar year, for a December (or other) fiscal year end. */
export function obligations(f: Facts, year: number): Obligation[] {
  const out: Obligation[] = [];
  const fye = `${year}-${f.fiscalYearEnd}`;
  if (f.status === "registered" || f.status === "era") {
    out.push({ key: `adv_${year}`, title: `Form ADV annual amendment for fiscal ${year}`, due: addDays(fye, 90), form: "form_adv", basis: "Advisers Act Rule 204-1: within 90 days of fiscal year end (registered and exempt reporting advisers)" });
  }
  if (f.status === "state") {
    out.push({ key: `adv_${year}`, title: `Form ADV annual amendment for fiscal ${year}`, due: addDays(fye, 90), form: "form_adv", basis: "State rules generally follow Rule 204-1: within 90 days of fiscal year end" });
  }
  if (f.status === "registered") {
    if (f.privateFundAumUsd >= 150e6) {
      out.push({ key: `pf_${year}`, title: `Form PF for fiscal ${year}`, due: addDays(fye, 120), form: "form_pf", basis: "Rule 204(b)-1: advisers with $150 million or more in private fund assets, annually within 120 days (the amended form's compliance date is now July 1, 2027)" });
    }
    out.push({ key: `audit_${year}`, title: `Audited financial statements to investors for ${year}`, due: addDays(fye, 120), form: "audit", basis: "Custody rule 206(4)-2 audit provision: within 120 days of fiscal year end" });
    out.push({ key: `review_${year}`, title: `Annual review of the compliance program (${year})`, due: fye, form: "annual_review", basis: "Rule 206(4)-7: review at least annually" });
    out.push({ key: `holdings_${year}`, title: `Access persons' annual holdings reports (${year})`, due: fye, form: "coe_holdings", basis: "Rule 204A-1: annually, current within 45 days of the report" });
    quarterEnds(year).forEach((q, i) => out.push({ key: `txn_q${i + 1}_${year}`, title: `Access persons' Q${i + 1} ${year} transaction reports`, due: addDays(q, 30), form: "coe_transactions", basis: "Rule 204A-1: within 30 days of quarter end" }));
  }
  for (const s of f.firstSales) {
    const due = addDays(s.date, 15);
    if (due.startsWith(String(year))) out.push({ key: `formd_${s.fund}`, title: `Form D for ${s.fund}`, subject: s.fund, due, form: "form_d", basis: "Regulation D Rule 503: within 15 days after the first sale (the first investor irrevocably committed)" });
    // A continuing offering files an annual amendment on or before each anniversary.
    for (let n = 1; n <= 10; n++) {
      const anniv = `${Number(s.date.slice(0, 4)) + n}${s.date.slice(4)}`;
      if (anniv.startsWith(String(year)) && s.stillOffering) out.push({ key: `formd_amend_${s.fund}_${n}`, title: `Form D annual amendment for ${s.fund}`, subject: s.fund, due: anniv, form: "form_d", basis: "Rule 503(a)(3): amend annually while the offering continues" });
    }
  }
  for (const s of f.stateSales) {
    const due = addDays(s.date, 15);
    if (due.startsWith(String(year))) out.push({ key: `bluesky_${s.fund}_${s.state}`, title: `${s.state} notice filing for ${s.fund}`, subject: `${s.fund} · ${s.state}`, due, form: "blue_sky", basis: "State notice filing for a Rule 506 offering (NSMIA), generally within 15 days of the first sale in the state; check the state's rule and fee" });
  }
  for (const o of f.outboundNotifiable) {
    const due = addDays(o.closed, 30);
    if (due.startsWith(String(year))) out.push({ key: `outbound_${o.company}_${o.closed}`, title: `Treasury notification: ${o.company}`, subject: o.company, due, form: "outbound_notice", basis: "31 CFR Part 850: notify Treasury within 30 calendar days after completing a notifiable transaction" });
  }
  for (const h of f.publicHoldings) {
    const q = quarterEnds(Number(h.crossed.slice(0, 4))).find((x) => x >= h.crossed)!;
    const due = addDays(q, 45);
    if (h.pct >= 5 && due.startsWith(String(year))) out.push({ key: `13g_${h.company}`, title: `Schedule 13G: ${h.company} (${h.pct.toFixed(1)}%)`, subject: h.company, due, form: "schedule_13g", basis: "Exchange Act Rule 13d-1 (as amended 2023): exempt investors file within 45 days after the quarter they cross 5%" });
    if (h.insider) out.push({ key: `form3_${h.company}`, title: `Form 3: ${h.company}`, subject: h.company, due: addDays(h.crossed, 10), form: "form_345", basis: "Section 16: a 10% owner or director files Form 3 within 10 days (at an IPO, by the registration's effective date), then Form 4 within two business days of each trade" });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

// ---------------------------------------------------------------------------
// Pay to play (Rule 206(4)-5)
// ---------------------------------------------------------------------------

export interface Contribution {
  amountUsd: number;
  /** Total already given to the same candidate for the same election. */
  priorSameElectionUsd: number;
  canVote: boolean;
  /** The official can influence the choice of adviser for a government entity (a state pension, a university endowment, a sovereign fund). */
  influencesGovernmentInvestor: boolean;
}

export function payToPlay(c: Contribution): { limit: number; total: number; withinDeMinimis: boolean; timeOut: boolean; message: string } {
  const limit = c.canVote ? 350 : 150;
  const total = c.amountUsd + c.priorSameElectionUsd;
  const within = total <= limit;
  const timeOut = !within && c.influencesGovernmentInvestor;
  return {
    limit, total, withinDeMinimis: within, timeOut,
    message: within
      ? `Within the $${limit} de minimis for an election the person ${c.canVote ? "can" : "can't"} vote in.`
      : timeOut
        ? `Over the $${limit} de minimis to an official who can influence a government investor: the adviser couldn't be paid by that government entity for two years. Don't make it without the CCO.`
        : `Over the $${limit} de minimis; the recipient doesn't appear to influence a government investor, so the CCO reviews it.`,
  };
}

// ---------------------------------------------------------------------------
// Outbound investment (31 CFR Part 850, in effect since January 2, 2025)
// ---------------------------------------------------------------------------

export interface OutboundAnswers {
  /** The company is a person of a country of concern (China, including Hong Kong and Macau), or controls one engaged in the activities below. */
  countryOfConcern: boolean;
  sector: "semiconductors" | "quantum" | "ai" | "none";
  /** Semiconductors: EDA software, fabrication or advanced packaging tools, advanced-node chips or supercomputers (prohibited); other chip design, fabrication or packaging (notifiable). */
  semisAdvanced?: boolean;
  /** AI: trained with more than 10^25 operations (10^24 using mainly biological sequence data), or designed exclusively or primarily for military, intelligence or mass-surveillance end use. */
  aiProhibited?: boolean;
  /** AI: trained with more than 10^23 operations, or for any military, intelligence or surveillance end use, cybersecurity, digital forensics, penetration testing, or the control of robotic systems. */
  aiNotifiable?: boolean;
  /** An exception applies: a publicly traded security, or an LP interest within the $2 million or contractual-assurance exception. */
  excepted?: boolean;
}

export function outbound(a: OutboundAnswers): { result: "not_covered" | "notifiable" | "prohibited"; reason: string } {
  if (!a.countryOfConcern || a.sector === "none") return { result: "not_covered", reason: "Not a covered foreign person in a covered sector." };
  if (a.excepted) return { result: "not_covered", reason: "An excepted transaction under 31 CFR 850.501." };
  if (a.sector === "quantum") return { result: "prohibited", reason: "Quantum computers, sensors and networking by a covered foreign person are prohibited (31 CFR 850.224)." };
  if (a.sector === "semiconductors") {
    return a.semisAdvanced
      ? { result: "prohibited", reason: "Advanced semiconductors, their tools and supercomputers are prohibited (31 CFR 850.224)." }
      : { result: "notifiable", reason: "Other semiconductor design, fabrication or packaging is notifiable within 30 days of closing (31 CFR 850.217)." };
  }
  if (a.aiProhibited) return { result: "prohibited", reason: "AI above 10^25 operations, or designed for military, intelligence or mass-surveillance end use, is prohibited (31 CFR 850.224)." };
  if (a.aiNotifiable) return { result: "notifiable", reason: "AI above 10^23 operations, or for military, intelligence, surveillance, cybersecurity or robotic control uses, is notifiable within 30 days of closing (31 CFR 850.217)." };
  return { result: "not_covered", reason: "AI below the thresholds and outside the listed end uses." };
}

// ---------------------------------------------------------------------------
// CFIUS and export controls: a first pass for counsel
// ---------------------------------------------------------------------------

export interface CfiusAnswers {
  /** The company's products need an export license to at least one country (ITAR, or EAR beyond EAR99): critical technology. */
  criticalTechnology: boolean;
  /** Critical infrastructure functions, or sensitive personal data of more than a million people. */
  infrastructureOrData: boolean;
  /** A foreign investor in the round (or a foreign LP through the fund) gets a board or observer seat, access to material nonpublic technical information, or a say in decisions about the technology. */
  foreignRights: boolean;
  /** The foreign investor is from, or is controlled from, a country the export controls restrict. */
  restrictedCountry?: boolean;
}

export function cfius(a: CfiusAnswers): { result: "none" | "review" | "declaration_likely"; reason: string } {
  const tid = a.criticalTechnology || a.infrastructureOrData;
  if (!tid) return { result: "none", reason: "Not a TID U.S. business on these answers." };
  if (!a.foreignRights) return { result: "none", reason: "A TID business, but no foreign person gets control, access or involvement rights: passive investment." };
  if (a.criticalTechnology && a.restrictedCountry) return { result: "declaration_likely", reason: "Critical technology that would need a license to the investor's country, with access or board rights: a mandatory declaration (31 CFR 800.401) is likely." };
  return { result: "review", reason: "A TID business with a foreign investor getting access or board rights: counsel should assess a filing (31 CFR Part 800)." };
}

// ---------------------------------------------------------------------------
// Marketing Rule (206(4)-1) review of an advertisement
// ---------------------------------------------------------------------------

export const MARKETING_CHECKLIST = [
  { key: "net_with_gross", label: "Any gross performance is shown with net performance, with equal prominence, over the same periods" },
  { key: "periods", label: "Performance for a fund covers 1, 5 and 10 years (or its life), or the rule's private fund treatment is applied" },
  { key: "hypothetical", label: "No hypothetical performance (targets, projections, model returns), or it's relevant to the audience with its assumptions and risks disclosed" },
  { key: "extracted", label: "Extracted performance (selected deals) is shown with the total portfolio's performance" },
  { key: "testimonials", label: "Testimonials and endorsements are disclosed as such, with compensation and conflicts" },
  { key: "fair_balanced", label: "Nothing is untrue or misleading, and benefits aren't presented without the material risks" },
] as const;

export function marketingComplete(answers: Record<string, unknown>): { complete: boolean; missing: string[] } {
  const missing = MARKETING_CHECKLIST.filter((c) => answers[c.key] !== true).map((c) => c.label);
  return { complete: missing.length === 0, missing };
}
