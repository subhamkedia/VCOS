/**
 * Fundraising math and the offering's legal limits, as deterministic,
 * unit-tested checks. They flag; counsel decides. Sources:
 * - Investment Company Act 3(c)(1): at most 100 beneficial owners; a
 *   "qualifying venture capital fund" (at most $12M in capital, since the
 *   SEC's August 2024 inflation adjustment) may have 250. 3(c)(7): every
 *   investor a qualified purchaser (knowledgeable employees aside).
 * - Regulation D: 506(b) sells to accredited investors without general
 *   solicitation; 506(c) allows it but the issuer must take reasonable
 *   steps to verify accreditation. SEC staff (no-action letter, 12 March
 *   2025): a minimum investment of $200,000 for a natural person or $1
 *   million for an entity, with written representations that the investor
 *   is accredited and isn't financed by a third party for this purpose, can
 *   be a reasonable step.
 * - ERISA plan assets: if benefit plan investors hold 25% or more of any
 *   class, the fund holds plan assets unless it operates as a VCOC.
 */

export type Stage = "identified" | "contacted" | "meeting" | "diligence" | "soft_circle" | "committed" | "closed" | "declined";

export const STAGES: Stage[] = ["identified", "contacted", "meeting", "diligence", "soft_circle", "committed", "closed", "declined"];

/** Default odds a prospect at each stage invests; a person can override per prospect. */
export const STAGE_PROBABILITY: Record<Stage, number> = {
  identified: 0.05, contacted: 0.1, meeting: 0.2, diligence: 0.4, soft_circle: 0.75, committed: 0.95, closed: 1, declined: 0,
};

export interface ProspectLike {
  stage: Stage;
  askUsd: number | null;
  softCircleUsd: number | null;
  committedUsd: number | null;
  probability: number | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The expected amount from a prospect: the firmest figure it has, times its odds. */
export function expected(p: ProspectLike): number {
  const amount = p.committedUsd ?? p.softCircleUsd ?? p.askUsd ?? 0;
  const odds = p.probability ?? STAGE_PROBABILITY[p.stage];
  return amount * odds;
}

export interface PipelineResult {
  target: number;
  closed: number;
  committed: number;
  softCircled: number;
  weighted: number;
  /** Closed plus the weighted remainder, over the target. */
  coverage: number | null;
  remaining: number;
  byStage: { stage: Stage; count: number; amount: number; weighted: number }[];
}

export function pipeline(prospects: ProspectLike[], target: number): PipelineResult {
  const byStage = STAGES.map((stage) => {
    const ps = prospects.filter((p) => p.stage === stage);
    return { stage, count: ps.length, amount: round2(sum(ps.map((p) => p.committedUsd ?? p.softCircleUsd ?? p.askUsd ?? 0))), weighted: round2(sum(ps.map(expected))) };
  });
  const closed = sum(prospects.filter((p) => p.stage === "closed").map((p) => p.committedUsd ?? 0));
  const committed = sum(prospects.filter((p) => p.stage === "committed").map((p) => p.committedUsd ?? p.softCircleUsd ?? 0));
  const softCircled = sum(prospects.filter((p) => p.stage === "soft_circle").map((p) => p.softCircleUsd ?? p.askUsd ?? 0));
  const weighted = sum(prospects.filter((p) => p.stage !== "closed").map(expected));
  return {
    target, closed: round2(closed), committed: round2(committed), softCircled: round2(softCircled), weighted: round2(weighted),
    coverage: target > 0 ? (closed + weighted) / target : null, remaining: round2(Math.max(0, target - closed)), byStage,
  };
}

// ---------------------------------------------------------------------------
// The offering's limits
// ---------------------------------------------------------------------------

export type Exemption = "3c1" | "3c1_qvcf" | "3c7";
export type Offering = "506b" | "506c";
export type Verification = "self_certified" | "minimum_investment" | "third_party_letter" | "documents_reviewed" | "platform";

export interface Subscriber {
  id: string;
  name: string;
  natural: boolean;
  commitment: number;
  accredited: boolean;
  qualifiedPurchaser: boolean;
  knowledgeableEmployee: boolean;
  benefitPlanInvestor: boolean;
  /** For a fund-of-funds or other pooled investor holding 10% or more: its own beneficial owners may count (look-through). */
  pooledVehicle: boolean;
  verification: Verification | null;
  /** 506(c) minimum-investment representations: accredited, and not financed by a third party for this investment. */
  minimumInvestmentReps: boolean;
  gp: boolean;
}

export interface Offer {
  exemption: Exemption;
  offering: Offering;
  hardCapUsd: number | null;
  minCommitmentUsd: number | null;
  /** The fund relies on the venture capital operating company exception, so the 25% test doesn't bind. */
  vcoc: boolean;
}

export interface Issue {
  key: string;
  severity: "block" | "warn";
  investor?: string;
  message: string;
}

export const QVCF_MAX_USD = 12_000_000;
export const MIN_INVESTMENT_NATURAL = 200_000;
export const MIN_INVESTMENT_ENTITY = 1_000_000;

/** Checks for the fund's investors taken together (everyone admitted so far plus the ones being admitted). */
export function offeringIssues(offer: Offer, investors: Subscriber[]): Issue[] {
  const out: Issue[] = [];
  const total = sum(investors.map((i) => i.commitment));
  const counted = investors.filter((i) => !i.knowledgeableEmployee && !i.gp);
  if (offer.hardCapUsd && total > offer.hardCapUsd + 0.005) {
    out.push({ key: "hard_cap", severity: "block", message: `Commitments of $${Math.round(total).toLocaleString("en-US")} exceed the hard cap of $${offer.hardCapUsd.toLocaleString("en-US")}.` });
  }
  if (offer.exemption === "3c1" && counted.length > 100) {
    out.push({ key: "owners_100", severity: "block", message: `${counted.length} beneficial owners: a 3(c)(1) fund may have at most 100 (knowledgeable employees don't count).` });
  }
  if (offer.exemption === "3c1_qvcf") {
    if (counted.length > 250) out.push({ key: "owners_250", severity: "block", message: `${counted.length} beneficial owners: a qualifying venture capital fund may have at most 250.` });
    if (total > QVCF_MAX_USD) out.push({ key: "qvcf_size", severity: "block", message: `A qualifying venture capital fund may have at most $12 million in capital commitments; this is $${Math.round(total).toLocaleString("en-US")}.` });
  }
  const pooled = investors.filter((i) => i.pooledVehicle && total > 0 && i.commitment / total >= 0.1);
  for (const p of pooled) {
    if (offer.exemption !== "3c7") out.push({ key: "look_through", severity: "warn", investor: p.name, message: `${p.name} holds 10% or more and is itself a pooled vehicle: its own investors may count toward the limit. Ask counsel.` });
  }
  for (const i of investors) {
    if (i.gp) continue;
    if (!i.accredited && !i.knowledgeableEmployee) out.push({ key: "not_accredited", severity: "block", investor: i.name, message: `${i.name} hasn't confirmed accredited investor status.` });
    if (offer.exemption === "3c7" && !i.qualifiedPurchaser && !i.knowledgeableEmployee) out.push({ key: "not_qp", severity: "block", investor: i.name, message: `${i.name} isn't a qualified purchaser, which a 3(c)(7) fund requires.` });
    if (offer.offering === "506c") {
      if (!i.verification || i.verification === "self_certified") {
        out.push({ key: "not_verified", severity: "block", investor: i.name, message: `${i.name}: a 506(c) offering must take reasonable steps to verify accreditation; self-certification isn't enough.` });
      } else if (i.verification === "minimum_investment") {
        const min = i.natural ? MIN_INVESTMENT_NATURAL : MIN_INVESTMENT_ENTITY;
        if (i.commitment < min) out.push({ key: "min_investment", severity: "block", investor: i.name, message: `${i.name}: the minimum-investment method needs at least $${min.toLocaleString("en-US")} from ${i.natural ? "a natural person" : "an entity"}.` });
        if (!i.minimumInvestmentReps) out.push({ key: "min_investment_reps", severity: "block", investor: i.name, message: `${i.name}: the minimum-investment method needs written representations that it's accredited and not financed by a third party for this investment.` });
      }
    }
    if (offer.minCommitmentUsd && i.commitment < offer.minCommitmentUsd) out.push({ key: "below_min", severity: "warn", investor: i.name, message: `${i.name}'s commitment is below the $${offer.minCommitmentUsd.toLocaleString("en-US")} minimum; the GP can waive it.` });
  }
  const plan = sum(investors.filter((i) => i.benefitPlanInvestor).map((i) => i.commitment));
  if (total > 0 && plan / total >= 0.25 && !offer.vcoc) {
    out.push({ key: "erisa_25", severity: "block", message: `Benefit plan investors hold ${((plan / total) * 100).toFixed(1)}%: at 25% or more the fund holds plan assets unless it operates as a VCOC.` });
  } else if (total > 0 && plan / total >= 0.2 && !offer.vcoc) {
    out.push({ key: "erisa_near", severity: "warn", message: `Benefit plan investors hold ${((plan / total) * 100).toFixed(1)}%, close to the 25% plan-asset threshold.` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Side letters and MFN
// ---------------------------------------------------------------------------

export interface SideTerm {
  id: string;
  holderId: string;
  holderCommitment: number;
  category: string;
  /** Some terms are never electable (an LPAC seat, a regulatory or tax term that applies only to its holder). */
  electable: boolean;
}

export interface MfnHolder {
  id: string;
  commitment: number;
  /** Most MFN clauses let an investor elect what was granted to investors with the same or a smaller commitment. */
  hasMfn: boolean;
}

/** For each investor with an MFN right, the terms it may elect: granted to someone else with an equal or smaller commitment, electable, and not already its own. */
export function mfnElectable(terms: SideTerm[], holders: MfnHolder[]): Map<string, SideTerm[]> {
  const out = new Map<string, SideTerm[]>();
  for (const h of holders.filter((x) => x.hasMfn)) {
    const own = new Set(terms.filter((t) => t.holderId === h.id).map((t) => t.category));
    out.set(h.id, terms.filter((t) => t.electable && t.holderId !== h.id && t.holderCommitment <= h.commitment && !own.has(t.category)));
  }
  return out;
}
