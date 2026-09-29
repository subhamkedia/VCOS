/**
 * The controlled predicate vocabulary. A claim's predicate must be one of
 * these. This is what lets the system compare a founder's number with a
 * filing's number without guessing they mean the same thing.
 *
 * Add predicates here, never columns to tables.
 */

export type EntityType = "company" | "person" | "investor" | "fund" | "program" | "customer" | "lp";

export type ValueKind = "money" | "number" | "integer" | "percent" | "string" | "date" | "enum" | "boolean";

export interface PredicateDef {
  id: string;
  kind: ValueKind;
  /** Canonical unit. Money is USD unless a claim says otherwise. */
  unit?: string;
  description: string;
  /** "one": one true value at a time (ARR). "many": a set (named customers). */
  cardinality: "one" | "many";
  /** True if the value legitimately changes over time, so claims are only compared within a window. */
  timeVarying: boolean;
  /** Relative difference tolerated before two numeric claims contradict (0.1 = 10%). */
  tolerance?: number;
  enumValues?: readonly string[];
  appliesTo: readonly EntityType[];
  /** False for free text that's worded differently by every source (descriptions): never a contradiction. */
  comparable?: boolean;
  /**
   * For time-varying values: claims further apart than this many days are
   * change over time, not contradiction. Fast-moving metrics get short
   * windows. Default 120.
   */
  windowDays?: number;
}

/** The pilot ladder. Every deployment claim lands on exactly one rung. */
export const PILOT_LADDER = [
  "conversation",
  "unpaid_trial",
  "paid_pilot",
  "production_contract",
  "expansion",
] as const;

export const ROUND_STAGES = [
  "pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus", "grant", "debt", "other",
] as const;

const C: EntityType[] = ["company"];
const P: EntityType[] = ["person"];

const defs: PredicateDef[] = [
  // --- Company profile ---
  { id: "company.description", kind: "string", cardinality: "one", timeVarying: true, appliesTo: C, comparable: false,
    description: "One-line description of what the company does." },
  { id: "company.founded_year", kind: "integer", cardinality: "one", timeVarying: false, tolerance: 0, appliesTo: C,
    description: "Year the company was founded." },
  { id: "company.hq_location", kind: "string", cardinality: "one", timeVarying: true, appliesTo: C,
    description: "Headquarters city and country." },
  { id: "company.website", kind: "string", cardinality: "one", timeVarying: true, appliesTo: C,
    description: "Primary website domain." },
  { id: "company.program", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "An accelerator, incubator, venture studio or university program the company went through." },
  { id: "company.sector", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "Sector tag from thesis.yaml sector ids." },
  { id: "company.stage", kind: "enum", enumValues: ROUND_STAGES, cardinality: "one", timeVarying: true, appliesTo: C,
    description: "Latest financing stage." },
  { id: "company.legal_name", kind: "string", cardinality: "one", timeVarying: true, appliesTo: C,
    description: "Registered legal name, as in filings (\"Acme Robotics, Inc.\")." },
  { id: "company.status", kind: "enum", enumValues: ["operating", "acquired", "shut_down", "stealth", "ipo"], cardinality: "one",
    timeVarying: true, appliesTo: C, description: "Operating status." },

  // --- Team ---
  { id: "team.headcount", kind: "integer", windowDays: 45, cardinality: "one", timeVarying: true, tolerance: 0.2, appliesTo: C,
    description: "Full-time employees." },
  { id: "team.founder", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "Name of a founder. Link the person entity with a 'founded' relation too." },
  { id: "team.key_hire", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "Senior hire, as 'Name, Title'." },
  { id: "team.open_roles", kind: "integer", windowDays: 30, cardinality: "one", timeVarying: true, tolerance: 0.25, appliesTo: C,
    description: "Open job postings on the company's careers page or applicant tracking system." },
  { id: "person.role", kind: "string", cardinality: "many", timeVarying: true, appliesTo: P,
    description: "Role, as 'Title at Organization (start-end)'." },
  { id: "person.education", kind: "string", cardinality: "many", timeVarying: false, appliesTo: P,
    description: "Degree and institution." },
  { id: "person.prior_exit", kind: "string", cardinality: "many", timeVarying: false, appliesTo: P,
    description: "Prior company exit, as 'Company, acquirer or IPO, year'." },

  // --- Funding ---
  { id: "funding.round.amount", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Amount raised in the most recent round (as_of = close date)." },
  { id: "funding.round.stage", kind: "enum", enumValues: ROUND_STAGES, cardinality: "one", timeVarying: true, appliesTo: C,
    description: "Stage of the most recent round." },
  { id: "funding.round.post_money", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Post-money valuation of the most recent round." },
  { id: "funding.total_raised", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.15, appliesTo: C,
    description: "Total equity raised to date." },
  { id: "funding.investor", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "Name of an investor in the company." },

  // --- The round being raised now (the deal in diligence) ---
  { id: "raise.amount", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, windowDays: 90, appliesTo: C,
    description: "Amount the company is raising in its current round." },
  { id: "raise.stage", kind: "enum", enumValues: ROUND_STAGES, cardinality: "one", timeVarying: true, windowDays: 90, appliesTo: C,
    description: "Stage of the round being raised now." },
  { id: "raise.pre_money", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, windowDays: 90, appliesTo: C,
    description: "Pre-money valuation proposed for the current round." },
  { id: "raise.lead_investor", kind: "string", cardinality: "one", timeVarying: true, windowDays: 90, appliesTo: C,
    description: "Lead investor of the current round, if there is one." },

  // --- Revenue and customers ---
  { id: "revenue.arr", kind: "money", windowDays: 45, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Annual recurring revenue." },
  { id: "revenue.annual", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Revenue for a fiscal year (as_of = year end)." },
  { id: "revenue.growth_yoy", kind: "percent", unit: "%", cardinality: "one", timeVarying: true, tolerance: 0.15, appliesTo: C,
    description: "Year-over-year revenue growth." },
  { id: "revenue.contracted_backlog", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.15, appliesTo: C,
    description: "Signed but not yet recognized revenue." },
  { id: "customers.paying.count", kind: "integer", windowDays: 45, cardinality: "one", timeVarying: true, tolerance: 0, appliesTo: C,
    description: "Number of paying customers." },
  { id: "customers.named", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "A named customer. Pair with pilot.status for that customer when known." },
  { id: "customers.logo_on_site", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "A customer logo shown on the company's website. Not proof of a paying relationship." },

  // --- Pilots and deployments (physical AI, construction, industrial) ---
  { id: "pilot.status", kind: "enum", windowDays: 60, enumValues: PILOT_LADDER, cardinality: "many", timeVarying: true, appliesTo: C,
    description: "Rung on the pilot ladder, qualified by customer: value = { customer, rung }." },
  { id: "pilot.site_count", kind: "integer", windowDays: 45, cardinality: "one", timeVarying: true, tolerance: 0, appliesTo: C,
    description: "Number of deployed sites or units in the field." },
  { id: "product.stage", kind: "enum", enumValues: ["concept", "prototype", "beta", "ga", "scaled"], cardinality: "one",
    timeVarying: true, appliesTo: C, description: "Product maturity." },

  // --- Monthly operating results (portfolio monitoring; as_of = the month's last day) ---
  { id: "revenue.monthly", kind: "money", windowDays: 20, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Revenue recognized in one month, from the income statement (as_of = last day of the month)." },
  { id: "expenses.monthly", kind: "money", windowDays: 20, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Total expenses in one month: cost of revenue plus operating expenses (as_of = last day of the month)." },
  { id: "customers.nrr", kind: "percent", unit: "%", windowDays: 60, cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Net revenue retention over the trailing twelve months (100% = no net churn)." },
  { id: "fleet.units_deployed", kind: "integer", windowDays: 45, cardinality: "one", timeVarying: true, tolerance: 0.05, appliesTo: C,
    description: "Units (robots, machines, sensors) deployed and operating at customers." },
  { id: "fleet.uptime", kind: "percent", unit: "%", windowDays: 45, cardinality: "one", timeVarying: true, tolerance: 0.05, appliesTo: C,
    description: "Share of scheduled hours the deployed fleet was available and working." },
  { id: "debt.balance", kind: "money", windowDays: 45, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Outstanding debt: venture debt, loans and credit lines drawn." },

  // --- The company's plan (budget), for plan-versus-actual ---
  { id: "plan.revenue.monthly", kind: "money", windowDays: 20, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Budgeted revenue for one month, from the board-approved plan (as_of = last day of the month)." },
  { id: "plan.burn.monthly", kind: "money", windowDays: 20, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Budgeted net burn for one month, from the board-approved plan (as_of = last day of the month)." },

  // --- Unit economics and cash ---
  { id: "unit_economics.gross_margin", kind: "percent", unit: "%", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Gross margin." },
  { id: "unit_economics.bom_cost", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.15, appliesTo: C,
    description: "Bill of materials cost per unit (hardware)." },
  { id: "unit_economics.asp", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.15, appliesTo: C,
    description: "Average selling price per unit or contract." },
  { id: "burn.monthly", kind: "money", windowDays: 45, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.2, appliesTo: C,
    description: "Net monthly burn." },
  { id: "cash.balance", kind: "money", windowDays: 30, unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.1, appliesTo: C,
    description: "Cash on hand." },
  { id: "runway.months", kind: "number", windowDays: 45, unit: "months", cardinality: "one", timeVarying: true, tolerance: 0.2, appliesTo: C,
    description: "Months of runway at current burn." },

  // --- IP and technology ---
  { id: "ip.patent", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "Patent or application number and title." },
  { id: "ip.patent_count", kind: "integer", cardinality: "one", timeVarying: true, tolerance: 0, appliesTo: C,
    description: "Granted patents plus pending applications." },
  { id: "tech.benchmark", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "A performance claim, as 'metric: value (conditions)'." },
  { id: "tech.readiness_level", kind: "integer", cardinality: "one", timeVarying: true, tolerance: 0, windowDays: 180, appliesTo: C,
    description: "Technology readiness level, 1 (basic principles) to 9 (proven in operation), on the NASA and DoD scale." },
  { id: "tech.manufacturing_readiness", kind: "integer", cardinality: "one", timeVarying: true, tolerance: 0, windowDays: 180, appliesTo: C,
    description: "Manufacturing readiness level, 1 to 10, on the DoD scale. Hardware only." },
  { id: "compliance.certification", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "A certification, approval or standard met, as 'Standard or regulator: status' (UL 3100: certified)." },
  { id: "contract.government", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "A government contract, as 'Agency: description, amount, year'." },
  { id: "grant.award", kind: "string", cardinality: "many", timeVarying: false, appliesTo: C,
    description: "Non-dilutive award, as 'Program, amount, year'." },

  // --- Market ---
  { id: "market.tam", kind: "money", unit: "USD", cardinality: "one", timeVarying: true, tolerance: 0.5, appliesTo: C,
    description: "Total addressable market as claimed. Label source carefully; these are rarely primary." },
  { id: "competition.competitor", kind: "string", cardinality: "many", timeVarying: true, appliesTo: C,
    description: "A named competitor." },
];

export const PREDICATES: ReadonlyMap<string, PredicateDef> = new Map(defs.map((d) => [d.id, d]));

/** What people see instead of predicate ids. Every predicate needs one (tested). */
export const PREDICATE_LABELS: Record<string, string> = {
  "company.description": "Company description",
  "company.founded_year": "Founded year",
  "company.hq_location": "Headquarters",
  "company.website": "Website",
  "company.program": "Program",
  "company.sector": "Sector",
  "company.legal_name": "Legal name",
  "company.stage": "Company stage",
  "company.status": "Operating status",
  "team.headcount": "Team headcount",
  "team.founder": "Founder",
  "team.key_hire": "Key hire",
  "team.open_roles": "Open roles",
  "person.role": "Role",
  "person.education": "Education",
  "person.prior_exit": "Prior exit",
  "funding.round.amount": "Last round amount",
  "funding.round.stage": "Last round stage",
  "funding.round.post_money": "Post-money valuation",
  "funding.total_raised": "Total raised",
  "funding.investor": "Investor",
  "raise.amount": "Raising now",
  "raise.stage": "Stage of current raise",
  "raise.pre_money": "Proposed pre-money valuation",
  "raise.lead_investor": "Lead investor (current raise)",
  "revenue.arr": "Annual recurring revenue (ARR)",
  "revenue.annual": "Annual revenue",
  "revenue.growth_yoy": "Revenue growth (year over year)",
  "revenue.contracted_backlog": "Contracted backlog",
  "customers.paying.count": "Paying customers",
  "customers.named": "Named customer",
  "customers.logo_on_site": "Customer logo on website",
  "pilot.status": "Pilot or deployment",
  "pilot.site_count": "Deployment sites",
  "product.stage": "Product stage",
  "unit_economics.gross_margin": "Gross margin",
  "unit_economics.bom_cost": "Bill of materials cost",
  "unit_economics.asp": "Average selling price",
  "burn.monthly": "Monthly burn",
  "cash.balance": "Cash balance",
  "runway.months": "Runway (months)",
  "ip.patent": "Patent",
  "ip.patent_count": "Patent count",
  "tech.benchmark": "Technical benchmark",
  "grant.award": "Grant or award",
  "tech.readiness_level": "Technology readiness level (TRL)",
  "tech.manufacturing_readiness": "Manufacturing readiness level (MRL)",
  "compliance.certification": "Certification or approval",
  "contract.government": "Government contract",
  "market.tam": "Total addressable market",
  "competition.competitor": "Competitor",
  "revenue.monthly": "Monthly revenue",
  "expenses.monthly": "Monthly expenses",
  "customers.nrr": "Net revenue retention",
  "fleet.units_deployed": "Units deployed",
  "fleet.uptime": "Fleet uptime",
  "debt.balance": "Debt outstanding",
  "plan.revenue.monthly": "Planned monthly revenue",
  "plan.burn.monthly": "Planned monthly burn",
};

/** Sections of a company page, in order. A predicate belongs to the first group whose prefix it starts with. */
export const PREDICATE_GROUPS: { id: string; label: string; prefixes: string[] }[] = [
  { id: "company", label: "Company", prefixes: ["company."] },
  { id: "team", label: "Team", prefixes: ["team.", "person."] },
  { id: "raise", label: "Current raise", prefixes: ["raise."] },
  { id: "funding", label: "Funding history", prefixes: ["funding."] },
  { id: "traction", label: "Revenue and customers", prefixes: ["revenue.", "customers.", "pilot.", "fleet."] },
  { id: "product", label: "Product and technology", prefixes: ["product.", "tech.", "ip."] },
  { id: "regulatory", label: "Regulatory and government", prefixes: ["compliance.", "contract.", "grant."] },
  { id: "economics", label: "Unit economics and cash", prefixes: ["unit_economics.", "expenses.", "burn.", "cash.", "runway.", "debt."] },
  { id: "plan", label: "Plan and budget", prefixes: ["plan."] },
  { id: "market", label: "Market", prefixes: ["market.", "competition."] },
];

export function predicateLabel(id: string): string {
  return PREDICATE_LABELS[id] ?? id.split(".").pop()!.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function getPredicate(id: string): PredicateDef {
  const def = PREDICATES.get(id);
  if (!def) throw new Error(`Unknown predicate "${id}". Add it to ledger/predicates.ts.`);
  return def;
}

/**
 * Validate and normalize a raw value for a predicate. Returns the JSON value
 * to store. Throws on anything that doesn't fit, so bad extractions fail
 * loudly instead of polluting the ledger.
 */
export function normalizeValue(predicateId: string, raw: unknown): unknown {
  const def = getPredicate(predicateId);
  const fail = (why: string): never => {
    throw new Error(`Invalid value for ${predicateId}: ${why} (got ${JSON.stringify(raw)})`);
  };

  switch (def.kind) {
    case "money":
    case "number":
    case "percent": {
      const n = typeof raw === "number" ? raw : parseNumber(String(raw));
      if (n === null || !Number.isFinite(n)) return fail("not a number");
      if (def.kind !== "percent" && n < 0 && def.id !== "revenue.growth_yoy") return fail("negative");
      return n;
    }
    case "integer": {
      const n = typeof raw === "number" ? raw : parseNumber(String(raw));
      if (n === null || !Number.isInteger(n) || n < 0) return fail("not a non-negative integer");
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return fail("not a boolean");
    case "date": {
      const s = String(raw);
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return fail("not YYYY-MM or YYYY-MM-DD");
      return s;
    }
    case "enum": {
      if (def.id === "pilot.status") {
        const v = raw as { customer?: unknown; rung?: unknown };
        if (!v || typeof v !== "object" || typeof v.customer !== "string" || typeof v.rung !== "string")
          return fail("expected { customer, rung }");
        if (!PILOT_LADDER.includes(v.rung as (typeof PILOT_LADDER)[number])) return fail(`rung must be one of ${PILOT_LADDER.join(", ")}`);
        return { customer: v.customer.trim(), rung: v.rung };
      }
      const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!def.enumValues?.includes(s)) return fail(`must be one of ${def.enumValues?.join(", ")}`);
      return s;
    }
    case "string": {
      if (typeof raw !== "string" || !raw.trim()) return fail("empty string");
      return raw.trim();
    }
  }
}

/**
 * Parse human numbers: "$4.1M" -> 4100000, "1.2bn" -> 1.2e9, "35%" -> 35,
 * "12,500" -> 12500. Returns null if it can't.
 */
export function parseNumber(s: string): number | null {
  const m = s
    .replace(/,/g, "")
    .trim()
    .match(/^[$€£]?\s*(-?\d+(?:\.\d+)?)\s*(k|thousand|m|mm|mn|million|b|bn|billion)?\s*%?$/i);
  if (!m) return null;
  const n = parseFloat(m[1] ?? "");
  const mult: Record<string, number> = {
    k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
  };
  // Round away float noise: 4.1 * 1e6 is 4099999.9999999995 in IEEE-754.
  return parseFloat((n * (m[2] ? (mult[m[2].toLowerCase()] ?? 1) : 1)).toFixed(6));
}
