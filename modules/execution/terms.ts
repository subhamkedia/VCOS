import { z } from "zod";

/**
 * A term sheet as structured terms, and how each term compares with the
 * NVCA model documents' defaults and with the firm's own house terms.
 *
 * NVCA reference points (NVCA model term sheet and charter, as updated
 * 2 October 2025): 1x non-participating liquidation preference;
 * non-cumulative dividends; broad-based weighted-average anti-dilution;
 * pay-to-play, redemption and participation are options, not defaults;
 * information and pro rata rights for major investors; standard protective
 * provisions; drag-along; outbound-investment (OISP) representations and
 * covenants were added in 2025. Market norms that aren't NVCA text (4-year
 * founder vesting with a 1-year cliff, a 30 to 45 day no-shop) are labeled
 * "market", not "NVCA".
 */

const money = z.number().positive();
const pct = z.number().min(0).max(100);

export const TermSheet = z.object({
  security: z.enum(["preferred", "safe_post", "safe_pre", "note"]),
  seriesName: z.string().trim().min(1).default("Series A Preferred"),
  preMoneyUsd: money.optional(),
  raiseUsd: money.optional(),
  ourAllocationUsd: money.optional(),
  leadInvestor: z.string().trim().optional(),
  poolTopUpPostPct: pct.optional(),
  // SAFEs and notes
  valuationCapUsd: money.optional(),
  discountPct: pct.optional(),
  noteRatePct: pct.optional(),
  noteMaturityMonths: z.number().int().positive().optional(),
  // Economics of the preferred
  liquidation: z.object({
    multiple: z.number().min(0).max(10).default(1),
    participation: z.enum(["none", "full", "capped"]).default("none"),
    capMultiple: z.number().min(1).max(20).optional(),
    seniority: z.enum(["pari_passu", "senior", "stacked"]).default("pari_passu"),
  }).default({ multiple: 1, participation: "none", seniority: "pari_passu" }),
  dividends: z.object({ kind: z.enum(["none", "non_cumulative", "cumulative"]).default("non_cumulative"), ratePct: pct.optional() }).default({ kind: "non_cumulative" }),
  antiDilution: z.enum(["broad_wa", "narrow_wa", "full_ratchet", "none"]).default("broad_wa"),
  redemption: z.boolean().default(false),
  payToPlay: z.boolean().default(false),
  // Control
  board: z.object({
    size: z.number().int().min(1).max(15).optional(),
    investorSeats: z.number().int().min(0).optional(),
    commonSeats: z.number().int().min(0).optional(),
    independentSeats: z.number().int().min(0).optional(),
    ours: z.enum(["seat", "observer", "none"]).default("none"),
  }).default({ ours: "none" }),
  protectiveProvisions: z.enum(["standard", "expanded", "limited"]).default("standard"),
  dragAlong: z.boolean().default(true),
  // Investor rights
  proRata: z.enum(["major_investors", "all", "super", "none"]).default("major_investors"),
  informationRights: z.boolean().default(true),
  managementRightsLetter: z.boolean().default(false),
  mfn: z.boolean().default(false),
  // Founders and process
  founderVesting: z.object({ years: z.number().min(0).max(10).default(4), cliffMonths: z.number().min(0).max(24).default(12), acceleration: z.enum(["none", "single", "double"]).default("double") }).default({ years: 4, cliffMonths: 12, acceleration: "double" }),
  noShopDays: z.number().int().min(0).max(365).optional(),
  investorCounselCapUsd: money.optional(),
  // National security and tax (NVCA 2025 added OISP provisions)
  oispRepresentation: z.boolean().default(false),
  qsbsRepresentation: z.boolean().default(false),
  tranched: z.boolean().default(false),
  otherTerms: z.string().max(5000).optional(),
});
export type TermSheet = z.infer<typeof TermSheet>;

/** The firm's own standards, set in Firm settings. Defaults follow the NVCA model. */
export const HouseTerms = z.object({
  maxLiquidationMultiple: z.number().min(0).max(10).default(1),
  acceptParticipation: z.enum(["never", "capped", "any"]).default("capped"),
  acceptAntiDilution: z.array(z.enum(["broad_wa", "narrow_wa", "full_ratchet", "none"])).default(["broad_wa", "narrow_wa", "none"]),
  acceptCumulativeDividends: z.boolean().default(false),
  acceptRedemption: z.boolean().default(false),
  requireProRata: z.boolean().default(true),
  requireInformationRights: z.boolean().default(true),
  requireManagementRightsLetter: z.boolean().default(false),
  maxPoolTopUpPostPct: pct.default(15),
  requireFounderVesting: z.boolean().default(true),
  maxNoShopDays: z.number().int().min(0).max(365).default(45),
  requireOisp: z.boolean().default(true),
});
export type HouseTerms = z.infer<typeof HouseTerms>;

export const HOUSE_DEFAULTS: HouseTerms = HouseTerms.parse({});

export type Standing = "standard" | "investor_friendly" | "founder_friendly" | "off_market";

export interface TermCheck {
  key: string;
  label: string;
  value: string;
  /** Against the NVCA model or market norm. */
  nvca: Standing;
  reference: string;
  /** Against the firm's house terms. */
  house: "ok" | "outside" | "n/a";
  note?: string;
}

const yes = (b: boolean) => (b ? "Yes" : "No");
const usd = (n?: number) => (n === undefined ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `$${Math.round(n / 1e3)}K`);

/** Compare every term with NVCA norms and the house terms. Pure. */
export function checkTerms(t: TermSheet, house: HouseTerms = HOUSE_DEFAULTS, opts: { erisaLps?: boolean; sensitiveTech?: boolean } = {}): TermCheck[] {
  const out: TermCheck[] = [];
  const add = (c: TermCheck) => out.push(c);
  const priced = t.security === "preferred";

  if (priced) {
    const l = t.liquidation;
    add({
      key: "liquidation.multiple", label: "Liquidation preference", value: `${l.multiple}x`,
      nvca: l.multiple === 1 ? "standard" : l.multiple > 1 ? "off_market" : "founder_friendly", reference: "NVCA: 1x",
      house: l.multiple <= house.maxLiquidationMultiple ? "ok" : "outside",
    });
    add({
      key: "liquidation.participation", label: "Participation",
      value: l.participation === "none" ? "Non-participating" : l.participation === "full" ? "Fully participating" : `Participating, capped at ${l.capMultiple ?? "?"}x`,
      nvca: l.participation === "none" ? "standard" : "investor_friendly", reference: "NVCA default: non-participating",
      house: l.participation === "none" || house.acceptParticipation === "any" || (house.acceptParticipation === "capped" && l.participation === "capped") ? "ok" : "outside",
      note: l.participation === "capped" && !l.capMultiple ? "A capped participation needs its cap." : undefined,
    });
    add({
      key: "liquidation.seniority", label: "Seniority", value: { pari_passu: "Pari passu with earlier preferred", senior: "Senior to earlier preferred", stacked: "Stacked (each series senior to the last)" }[l.seniority],
      nvca: l.seniority === "pari_passu" ? "standard" : "investor_friendly", reference: "NVCA offers both; pari passu is most common at early stage", house: "n/a",
    });
    add({
      key: "dividends", label: "Dividends", value: t.dividends.kind === "none" ? "None" : `${t.dividends.kind === "cumulative" ? "Cumulative" : "Non-cumulative"}${t.dividends.ratePct ? `, ${t.dividends.ratePct}%` : ""}`,
      nvca: t.dividends.kind === "cumulative" ? "off_market" : "standard", reference: "NVCA default: non-cumulative, when and if declared",
      house: t.dividends.kind !== "cumulative" || house.acceptCumulativeDividends ? "ok" : "outside",
    });
    add({
      key: "antiDilution", label: "Anti-dilution", value: { broad_wa: "Broad-based weighted average", narrow_wa: "Narrow-based weighted average", full_ratchet: "Full ratchet", none: "None" }[t.antiDilution],
      nvca: t.antiDilution === "broad_wa" ? "standard" : t.antiDilution === "full_ratchet" ? "off_market" : t.antiDilution === "none" ? "founder_friendly" : "investor_friendly",
      reference: "NVCA: broad-based weighted average", house: house.acceptAntiDilution.includes(t.antiDilution) ? "ok" : "outside",
    });
    add({ key: "redemption", label: "Redemption rights", value: yes(t.redemption), nvca: t.redemption ? "investor_friendly" : "standard", reference: "NVCA: optional; uncommon at early stage", house: !t.redemption || house.acceptRedemption ? "ok" : "outside" });
    add({ key: "payToPlay", label: "Pay-to-play", value: yes(t.payToPlay), nvca: t.payToPlay ? "investor_friendly" : "standard", reference: "NVCA: optional", house: "n/a", note: t.payToPlay ? "Your fund must keep participating in later rounds to keep its preferred rights: check reserves." : undefined });
    if (t.poolTopUpPostPct !== undefined) {
      add({
        key: "pool", label: "Option pool (post-money, in the pre-money)", value: `${t.poolTopUpPostPct}%`,
        nvca: t.poolTopUpPostPct <= 20 ? "standard" : "investor_friendly", reference: "Market: sized to the hiring plan, often 10 to 20%",
        house: t.poolTopUpPostPct <= house.maxPoolTopUpPostPct ? "ok" : "outside", note: "A pool in the pre-money lowers the effective pre-money valuation for existing holders.",
      });
    }
    add({ key: "protectiveProvisions", label: "Protective provisions", value: { standard: "Standard", expanded: "Expanded", limited: "Limited" }[t.protectiveProvisions], nvca: t.protectiveProvisions === "standard" ? "standard" : t.protectiveProvisions === "expanded" ? "investor_friendly" : "founder_friendly", reference: "NVCA list", house: "n/a" });
    add({ key: "dragAlong", label: "Drag-along", value: yes(t.dragAlong), nvca: t.dragAlong ? "standard" : "founder_friendly", reference: "NVCA voting agreement includes drag-along", house: "n/a" });
    add({
      key: "board", label: "Board", value: t.board.size ? `${t.board.size} seats: ${t.board.investorSeats ?? 0} investor, ${t.board.commonSeats ?? 0} common, ${t.board.independentSeats ?? 0} independent; you: ${t.board.ours}` : `You: ${t.board.ours}`,
      nvca: "standard", reference: "Negotiated per deal", house: "n/a",
    });
  } else {
    add({
      key: "valuationCap", label: "Valuation cap", value: t.valuationCapUsd ? `${usd(t.valuationCapUsd)} (${t.security === "safe_post" ? "post-money" : "pre-money"})` : "None",
      nvca: t.valuationCapUsd || t.discountPct ? "standard" : t.mfn ? "standard" : "founder_friendly", reference: t.security === "note" ? "Market: cap and/or discount" : "YC SAFE: cap, discount, or MFN", house: "n/a",
    });
    add({ key: "discount", label: "Discount", value: t.discountPct ? `${t.discountPct}%` : "None", nvca: "standard", reference: "Market: 0 to 20%", house: "n/a" });
    if (t.security === "note") add({ key: "noteRate", label: "Interest and maturity", value: `${t.noteRatePct ?? 0}% · ${t.noteMaturityMonths ?? "?"} months`, nvca: "standard", reference: "Market: 2 to 8%, 18 to 24 months", house: "n/a" });
  }

  add({ key: "proRata", label: "Pro rata rights", value: { major_investors: "Major investors", all: "All investors", super: "Super pro rata", none: "None" }[t.proRata], nvca: t.proRata === "major_investors" ? "standard" : t.proRata === "super" ? "investor_friendly" : "standard", reference: priced ? "NVCA IRA: major investors" : "YC SAFE: pro rata side letter", house: t.proRata !== "none" || !house.requireProRata ? "ok" : "outside" });
  add({ key: "informationRights", label: "Information rights", value: yes(t.informationRights), nvca: "standard", reference: "NVCA IRA: major investors", house: t.informationRights || !house.requireInformationRights ? "ok" : "outside" });
  const mrlNeeded = house.requireManagementRightsLetter || Boolean(opts.erisaLps);
  add({
    key: "managementRightsLetter", label: "Management rights letter", value: yes(t.managementRightsLetter), nvca: "standard", reference: "NVCA model letter (VCOC, for funds with ERISA plan investors)",
    house: t.managementRightsLetter || !mrlNeeded ? "ok" : "outside", note: mrlNeeded && !t.managementRightsLetter ? "Your fund has pension or other ERISA investors: get a management rights letter so the fund keeps its VCOC status." : undefined,
  });
  add({
    key: "founderVesting", label: "Founder vesting", value: `${t.founderVesting.years} years, ${t.founderVesting.cliffMonths}-month cliff, ${t.founderVesting.acceleration} trigger acceleration`,
    nvca: t.founderVesting.years >= 3 && t.founderVesting.acceleration !== "single" ? "standard" : "founder_friendly", reference: "Market: 4 years, 1-year cliff, double-trigger", house: t.founderVesting.years > 0 || !house.requireFounderVesting ? "ok" : "outside",
  });
  if (t.noShopDays !== undefined) add({ key: "noShop", label: "No-shop", value: `${t.noShopDays} days`, nvca: t.noShopDays <= 45 ? "standard" : "investor_friendly", reference: "Market: 30 to 45 days", house: t.noShopDays <= house.maxNoShopDays ? "ok" : "outside" });
  add({
    key: "oisp", label: "Outbound investment (OISP) representations", value: yes(t.oispRepresentation), nvca: "standard", reference: "NVCA 2025: OISP representations and covenants",
    house: t.oispRepresentation || !(house.requireOisp && opts.sensitiveTech) ? "ok" : "outside",
    note: opts.sensitiveTech && !t.oispRepresentation ? "The company works in AI, semiconductors, quantum or a nearby field: get OISP representations, or confirm it isn't covered." : undefined,
  });
  add({ key: "qsbs", label: "QSBS representation", value: yes(t.qsbsRepresentation), nvca: "standard", reference: "Section 1202 (after 4 July 2025: $15M exclusion, $75M gross assets, 3/4/5-year tiers)", house: "n/a" });
  if (t.tranched) add({ key: "tranched", label: "Tranched financing", value: "Yes", nvca: "standard", reference: "NVCA 2025 added tranche mechanics", house: "n/a", note: "Track each tranche's milestone and closing separately." });
  return out;
}

export const STANDING_LABELS: Record<Standing, string> = {
  standard: "Standard", investor_friendly: "Investor-friendly", founder_friendly: "Founder-friendly", off_market: "Off-market",
};
