import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../../lib/db.js";
import { insertThesisVersion, latestThesis, thesisHistory } from "../../ledger/workspace.js";

/**
 * The firm profile: who the firm is, the fund it's investing, and its
 * mandate and thesis. Sourcing and scoring read this (principle 6: thesis
 * is config). Every save is a new version; scores record the version they
 * used. `thesis.yaml` in the repo is a starter template, not the source of
 * truth.
 */

export const STAGES = ["pre_seed", "seed", "series_a", "series_b", "series_c", "growth"] as const;
export const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C", growth: "Growth",
};

export const FUND_STRUCTURES = [
  "closed_end_fund", "rolling_fund", "evergreen", "spv_program", "corporate_vc", "family_office", "fund_of_funds", "accelerator",
] as const;
export const FUND_STRUCTURE_LABELS: Record<(typeof FUND_STRUCTURES)[number], string> = {
  closed_end_fund: "Closed-end LP fund", rolling_fund: "Rolling fund", evergreen: "Evergreen fund", spv_program: "SPV program",
  corporate_vc: "Corporate VC", family_office: "Family office", fund_of_funds: "Fund of funds", accelerator: "Accelerator or studio",
};

const sector = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  label: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1, "give at least one keyword"),
  priority: z.enum(["core", "opportunistic"]).default("core"),
});

const dimension = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  guide: z.string().min(1),
});

const usd = z.number().nonnegative();

export const FirmProfile = z
  .object({
    firm: z.object({
      name: z.string().min(1),
      website: z.string().optional(),
      hq: z.string().optional(),
      description: z.string().optional(),
    }),
    fund: z.object({
      name: z.string().min(1),
      structure: z.enum(FUND_STRUCTURES),
      vintage: z.number().int().min(1990).max(2100).optional(),
      targetSizeUsd: usd.optional(),
      committedUsd: usd.optional(),
      investmentPeriodYears: z.number().min(0).max(30).optional(),
      termYears: z.number().min(0).max(30).optional(),
      reservesPct: z.number().min(0).max(100).optional(),
      managementFeePct: z.number().min(0).max(10).optional(),
      carryPct: z.number().min(0).max(50).optional(),
      targetInvestments: z.number().int().min(0).optional(),
    }),
    mandate: z.object({
      stages: z.array(z.enum(STAGES)).min(1, "pick at least one stage"),
      checkSizeUsd: z.object({ min: usd, max: usd }),
      targetOwnershipPct: z.object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) }).optional(),
      leadPreference: z.enum(["lead", "co_lead", "follow", "any"]).default("any"),
      geographies: z.array(z.string().min(1)).min(1, "pick at least one geography"),
      sectors: z.array(sector).min(1, "add at least one sector"),
      exclusions: z.array(z.string().min(1)).default([]),
      thesis: z.string().default(""),
    }),
    scoring: z.object({ dimensions: z.array(dimension).min(1) }),
  })
  .superRefine((p, ctx) => {
    if (p.mandate.checkSizeUsd.min > p.mandate.checkSizeUsd.max)
      ctx.addIssue({ code: "custom", path: ["mandate", "checkSizeUsd"], message: "minimum check is above the maximum" });
    const total = p.scoring.dimensions.reduce((a, d) => a + d.weight, 0);
    if (Math.abs(total - 1) > 0.001)
      ctx.addIssue({ code: "custom", path: ["scoring", "dimensions"], message: `weights add up to ${total.toFixed(2)}; they must add up to 1` });
    const ids = p.mandate.sectors.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["mandate", "sectors"], message: "sector ids must be unique" });
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

export interface ProfileError {
  path: string;
  message: string;
}

/** Validate without saving: for the onboarding form, field by field. */
export function checkProfile(input: unknown): { ok: true; profile: FirmProfile } | { ok: false; errors: ProfileError[] } {
  const r = FirmProfile.safeParse(input);
  if (r.success) return { ok: true, profile: r.data };
  return { ok: false, errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
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
