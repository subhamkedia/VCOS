import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { HouseTerms, HOUSE_DEFAULTS } from "../execution/terms.js";
import type { Db } from "../../lib/db.js";
import { insertThesisVersion, latestThesis, thesisHistory } from "../../ledger/workspace.js";
import { construct, type Construction } from "../../engines/portfolio-construction.js";

/**
 * The firm profile: who the firm is, the fund it's investing, and its
 * mandate and thesis. Sourcing and scoring read this (principle 6: thesis
 * is config). Every save is a new version; scores record the version they
 * used. `thesis.yaml` in the repo is a starter template, not the source of
 * truth.
 */

const labelled = <T extends string>(pairs: [T, string][]) => ({
  ids: pairs.map(([id]) => id) as [T, ...T[]],
  labels: Object.fromEntries(pairs) as Record<T, string>,
});

const stage = labelled([["pre_seed", "Pre-seed"], ["seed", "Seed"], ["series_a", "Series A"], ["series_b", "Series B"], ["series_c", "Series C"], ["growth", "Growth"]]);
export const STAGES = stage.ids;
export const STAGE_LABELS = stage.labels;

const structure = labelled([
  ["closed_end_fund", "Closed-end LP fund"], ["rolling_fund", "Rolling fund"], ["evergreen", "Evergreen fund"], ["spv_program", "SPV program"],
  ["corporate_vc", "Corporate VC (balance sheet)"], ["family_office", "Family office"], ["fund_of_funds", "Fund of funds"], ["accelerator", "Accelerator or studio fund"],
]);
export const FUND_STRUCTURES = structure.ids;
export const FUND_STRUCTURE_LABELS = structure.labels;

const firmType = labelled([
  ["independent_vc", "Independent VC"], ["micro_vc", "Micro VC / emerging manager"], ["cvc", "Corporate VC"], ["family_office", "Family office"],
  ["accelerator", "Accelerator"], ["venture_studio", "Venture studio"], ["angel_network", "Angel network or syndicate"], ["growth_equity", "Growth equity"], ["other", "Other"],
]);
const currency = labelled([["USD", "US dollar"], ["EUR", "Euro"], ["GBP", "British pound"], ["CAD", "Canadian dollar"], ["INR", "Indian rupee"], ["SGD", "Singapore dollar"], ["AUD", "Australian dollar"], ["CHF", "Swiss franc"], ["ILS", "Israeli shekel"], ["JPY", "Japanese yen"]]);
const feeBasis = labelled([["committed", "Committed capital"], ["invested", "Invested capital"]]);
const waterfall = labelled([["european", "European (whole fund)"], ["american", "American (deal by deal)"]]);
const followOn = labelled([["pro_rata", "Pro rata"], ["super_pro_rata", "Super pro rata in winners"], ["selective", "Selective"], ["none", "No follow-ons"]]);
const icApproval = labelled([["unanimous", "Unanimous"], ["supermajority", "Supermajority (two thirds)"], ["majority", "Simple majority"], ["champion", "One champion with full conviction, no veto"], ["managing_partner", "Managing partner decides"]]);
const lead = labelled([["lead", "Lead"], ["co_lead", "Co-lead"], ["follow", "Follow"], ["any", "Any"]]);
const board = labelled([["required", "Board seat required"], ["preferred", "Board seat preferred"], ["observer", "Observer seat"], ["none", "No board role"]]);
const traction = labelled([["pre_product", "Pre-product is fine"], ["pre_revenue", "Product, pre-revenue"], ["early_revenue", "Early revenue"], ["scaling", "Scaling revenue"]]);
const impact = labelled([["none", "No impact mandate"], ["esg_screened", "ESG screened"], ["impact_aligned", "Impact aligned"], ["impact_first", "Impact first"]]);

/** Choices the setup screens offer, with labels. Served to the web app as-is. */
export const PROFILE_OPTIONS = {
  stages: stage, structures: structure, firmTypes: firmType, currencies: currency, feeBasis, waterfall, followOn, icApproval, lead, board, traction, impact,
  suggestions: {
    lpTypes: ["Institutional (pensions, endowments)", "Fund of funds", "Family offices", "High-net-worth individuals", "Corporates", "Sovereign wealth", "Government programs", "GP and team"],
    businessModels: ["B2B software", "Hardware", "Hardware plus software", "Marketplace", "Deep tech / IP-led", "Services, tech-enabled", "Infrastructure", "Consumer"],
    customerTypes: ["Enterprise", "Mid-market", "SMB", "Government and public sector", "Utilities and infrastructure owners", "Consumers"],
    geographies: ["US", "Canada", "Europe", "UK", "India", "Israel", "LatAm", "Southeast Asia", "Africa", "Global"],
  },
};

const sector = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  label: z.string().min(1, "name the sector"),
  keywords: z.array(z.string().min(1)).min(1, "give at least one keyword"),
  priority: z.enum(["core", "opportunistic"]).default("core"),
});

const dimension = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  guide: z.string().min(1),
});

const money = z.number().nonnegative();
const percent = (max = 100) => z.number().min(0).max(max);
const year = z.number().int().min(1900).max(2100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const range = z.object({ min: money, max: money });

/**
 * Amounts are in the fund's currency (`fund.currency`); field names say Usd
 * for history. Everything beyond the basics is optional, so a firm can save
 * early and fill in the rest later.
 */
export const FirmProfile = z
  .object({
    firm: z.object({
      name: z.string().min(1, "the firm needs a name"),
      legalName: z.string().optional(),
      type: z.enum(firmType.ids).default("independent_vc"),
      website: z.string().optional(),
      linkedin: z.string().optional(),
      /** Domains your team's email addresses use. Meetings with only these people are internal. */
      emailDomains: z.array(z.string().min(1)).default([]),
      hq: z.string().optional(),
      offices: z.array(z.string().min(1)).default([]),
      foundedYear: year.optional(),
      aumUsd: money.optional(),
      fundsRaised: z.number().int().min(0).optional(),
      teamSize: z.number().int().min(0).optional(),
      investmentTeamSize: z.number().int().min(0).optional(),
      description: z.string().optional(),
    }),
    fund: z.object({
      name: z.string().min(1, "the fund needs a name"),
      number: z.string().optional(),
      structure: z.enum(structure.ids),
      legalForm: z.string().optional(),
      domicile: z.string().optional(),
      currency: z.enum(currency.ids).default("USD"),
      vintage: year.optional(),
      targetSizeUsd: money.optional(),
      hardCapUsd: money.optional(),
      committedUsd: money.optional(),
      firstCloseDate: date.optional(),
      finalCloseDate: date.optional(),
      gpCommitmentPct: percent(20).optional(),
      investmentPeriodYears: z.number().min(0).max(30).optional(),
      termYears: z.number().min(0).max(30).optional(),
      extensionYears: z.number().min(0).max(10).optional(),
      managementFeePct: percent(10).optional(),
      feeStepDownPct: percent(10).optional(),
      feeBasisAfterPeriod: z.enum(feeBasis.ids).default("committed"),
      fundExpensesPct: percent(10).optional(),
      recyclingPct: percent(50).optional(),
      carryPct: percent(50).optional(),
      hurdlePct: percent(20).optional(),
      waterfall: z.enum(waterfall.ids).optional(),
      reservesPct: percent().optional(),
      targetInvestments: z.number().int().min(0).optional(),
      avgInitialCheckUsd: money.optional(),
      maxConcentrationPct: percent().optional(),
      followOnStrategy: z.enum(followOn.ids).optional(),
      lpTypes: z.array(z.string().min(1)).default([]),
      icMembers: z.number().int().min(1).max(50).optional(),
      icApproval: z.enum(icApproval.ids).optional(),
    }),
    mandate: z.object({
      stages: z.array(z.enum(stage.ids)).min(1, "pick at least one stage"),
      checkSizeUsd: range,
      followOnCheckUsd: range.optional(),
      targetOwnershipPct: z.object({ min: percent(), max: percent() }).optional(),
      leadPreference: z.enum(lead.ids).default("any"),
      boardSeat: z.enum(board.ids).optional(),
      geographies: z.array(z.string().min(1)).min(1, "pick at least one geography"),
      sectors: z.array(sector).min(1, "add at least one sector"),
      businessModels: z.array(z.string().min(1)).default([]),
      customerTypes: z.array(z.string().min(1)).default([]),
      traction: z.enum(traction.ids).optional(),
      minArrUsd: money.optional(),
      maxCompanyAgeYears: z.number().min(0).max(50).optional(),
      impact: z.enum(impact.ids).optional(),
      exclusions: z.array(z.string().min(1)).default([]),
      thesis: z.string().default(""),
    }),
    scoring: z.object({ dimensions: z.array(dimension).min(1) }),
    /** House terms for term sheets; defaults follow the NVCA model. */
    terms: HouseTerms.default(HOUSE_DEFAULTS),
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const m = p.mandate;
    const f = p.fund;
    if (m.checkSizeUsd.min > m.checkSizeUsd.max) issue(["mandate", "checkSizeUsd"], "the smallest check is above the largest");
    if (m.followOnCheckUsd && m.followOnCheckUsd.min > m.followOnCheckUsd.max) issue(["mandate", "followOnCheckUsd"], "the smallest follow-on is above the largest");
    if (m.targetOwnershipPct && m.targetOwnershipPct.min > m.targetOwnershipPct.max) issue(["mandate", "targetOwnershipPct"], "the minimum ownership is above the maximum");
    if (f.hardCapUsd !== undefined && f.targetSizeUsd !== undefined && f.hardCapUsd < f.targetSizeUsd) issue(["fund", "hardCapUsd"], "the hard cap is below the target size");
    if (f.committedUsd !== undefined && f.hardCapUsd !== undefined && f.committedUsd > f.hardCapUsd) issue(["fund", "committedUsd"], "commitments exceed the hard cap");
    if (f.firstCloseDate && f.finalCloseDate && f.finalCloseDate < f.firstCloseDate) issue(["fund", "finalCloseDate"], "the final close is before the first close");
    if (f.termYears !== undefined && f.investmentPeriodYears !== undefined && f.termYears < f.investmentPeriodYears) issue(["fund", "termYears"], "the term is shorter than the investment period");
    const total = p.scoring.dimensions.reduce((a, d) => a + d.weight, 0);
    if (Math.abs(total - 1) > 0.001) issue(["scoring", "dimensions"], `weights add up to ${Math.round(total * 100)}%; they must add up to 100%`);
    const ids = m.sectors.map((s) => s.id);
    if (new Set(ids).size !== ids.length) issue(["mandate", "sectors"], "two sectors have the same name");
  });

export type FirmProfile = z.infer<typeof FirmProfile>;

const STAGE_ALIASES: Record<string, (typeof STAGES)[number]> = {
  "pre-seed": "pre_seed", preseed: "pre_seed", seed: "seed", "series-a": "series_a", "series-b": "series_b", "series-c": "series_c",
};

/** The starter profile from thesis.yaml, with the firm's own name filled in. */
export async function starterProfile(firmName: string): Promise<FirmProfile> {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../thesis.yaml");
  const y = parseYaml(await readFile(file, "utf8")) as {
    name: string; stages: string[]; geographies: string[]; check_size_usd: { min: number; max: number };
    sectors: { id: string; label: string; keywords: string[] }[];
    dimensions: { id: string; weight: number; guide: string }[]; exclude?: string[];
  };
  return FirmProfile.parse({
    firm: { name: firmName },
    fund: { name: `${firmName} Fund I`, structure: "closed_end_fund" },
    mandate: {
      stages: y.stages.map((s) => STAGE_ALIASES[s] ?? s),
      checkSizeUsd: y.check_size_usd,
      geographies: y.geographies,
      sectors: y.sectors.map((s) => ({ ...s, priority: "core" })),
      exclusions: y.exclude ?? [],
      thesis: y.name,
      leadPreference: "any",
    },
    scoring: {
      dimensions: y.dimensions.map((d) => ({ ...d, label: d.id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) })),
    },
  });
}

/**
 * Portfolio math for a profile, complete or half-filled (the setup wizard
 * asks on every change). Uses commitments when known, else the target size.
 */
export function construction(input: unknown): Construction | null {
  const p = (input ?? {}) as { fund?: Record<string, unknown>; mandate?: Record<string, unknown> };
  const f = p.fund ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const size = n(f.committedUsd) || n(f.targetSizeUsd);
  if (!size) return null;
  const range = p.mandate?.checkSizeUsd as { min?: unknown; max?: unknown } | undefined;
  return construct({
    sizeUsd: size,
    managementFeePct: n(f.managementFeePct),
    investmentPeriodYears: n(f.investmentPeriodYears),
    termYears: n(f.termYears),
    feeStepDownPct: n(f.feeStepDownPct),
    feeBasisAfterPeriod: f.feeBasisAfterPeriod === "invested" ? "invested" : "committed",
    fundExpensesPct: n(f.fundExpensesPct),
    recyclingPct: n(f.recyclingPct),
    reservesPct: n(f.reservesPct),
    avgInitialCheckUsd: n(f.avgInitialCheckUsd),
    targetInvestments: n(f.targetInvestments),
    maxConcentrationPct: n(f.maxConcentrationPct),
    checkRangeUsd: range && n(range.min) !== undefined && n(range.max) ? { min: n(range.min)!, max: n(range.max)! } : undefined,
  });
}

/** The option lists as { id, label } pairs, for the web app. */
export function profileOptions() {
  const pairs = (o: { ids: readonly string[]; labels: Record<string, string> }) => o.ids.map((id) => ({ id, label: o.labels[id]! }));
  const { suggestions, ...lists } = PROFILE_OPTIONS;
  return { ...Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, pairs(v)])), suggestions };
}

export interface ProfileError {
  path: string;
  message: string;
}

/** Validate without saving: for the onboarding form, field by field. */
export function checkProfile(input: unknown):
  | { ok: true; profile: FirmProfile; construction: Construction | null }
  | { ok: false; errors: ProfileError[]; construction: Construction | null } {
  const r = FirmProfile.safeParse(input);
  const c = construction(input);
  if (r.success) return { ok: true, profile: r.data, construction: c };
  return { ok: false, errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), construction: c };
}

export async function getProfile(db: Db): Promise<{ version: number; profile: FirmProfile } | null> {
  const row = await latestThesis<FirmProfile>(db);
  return row ? { version: row.version, profile: row.profile } : null;
}

export async function saveProfile(db: Db, input: unknown, by: string): Promise<{ version: number; profile: FirmProfile }> {
  const checked = checkProfile(input);
  if (!checked.ok) throw new ProfileInvalid(checked.errors);
  const version = await insertThesisVersion(db, checked.profile, by);
  return { version, profile: checked.profile };
}

export const profileHistory = thesisHistory;

export class ProfileInvalid extends Error {
  constructor(readonly errors: ProfileError[]) {
    super(`Profile is invalid: ${errors.map((e) => `${e.path || "profile"}: ${e.message}`).join("; ")}`);
  }
}
