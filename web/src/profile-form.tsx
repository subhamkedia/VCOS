import type { Dimension, Profile, ProfileResponse, Sector } from "./types";
import { Chips, Field, Seg, TagInput } from "./ui";

/**
 * The firm profile, in sections. Onboarding shows them one step at a time;
 * Settings shows them as tabs. Errors come back from the server keyed by
 * field path ("mandate.stages").
 */

export type Errors = Record<string, string>;
type Props = { p: Profile; set: (p: Profile) => void; errors: Errors; options: ProfileResponse["options"] };

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
const millions = (n?: number) => (n === undefined ? "" : String(n / 1e6));
const fromMillions = (v: string) => (v.trim() === "" ? undefined : Math.round(Number(v) * 1e6));
const err = (e: Errors, path: string) => e[path] ?? Object.entries(e).find(([k]) => k.startsWith(`${path}.`))?.[1];

export function FirmSection({ p, set, errors }: Props) {
  const f = p.firm;
  const up = (patch: Partial<Profile["firm"]>) => set({ ...p, firm: { ...f, ...patch } });
  return (
    <div className="section">
      <div className="grid-2">
        <Field label="Firm name" error={err(errors, "firm.name")}>
          <input className="input" id="firm-name" value={f.name} onChange={(e) => up({ name: e.target.value })} />
        </Field>
        <Field label="Website">
          <input className="input" id="firm-website" value={f.website ?? ""} placeholder="alphaventures.com" onChange={(e) => up({ website: e.target.value || undefined })} />
        </Field>
      </div>
      <Field label="Headquarters">
        <input className="input" id="firm-hq" value={f.hq ?? ""} placeholder="Pittsburgh, PA" onChange={(e) => up({ hq: e.target.value || undefined })} />
      </Field>
      <Field label="About the firm" hint="A few sentences. Used when drafting materials for founders and LPs.">
        <textarea className="input" id="firm-about" value={f.description ?? ""} onChange={(e) => up({ description: e.target.value || undefined })} />
      </Field>
    </div>
  );
}

export function FundSection({ p, set, errors, options }: Props) {
  const f = p.fund;
  const up = (patch: Partial<Profile["fund"]>) => set({ ...p, fund: { ...f, ...patch } });
  return (
    <div className="section">
      <div className="grid-2">
        <Field label="Fund name" error={err(errors, "fund.name")}>
          <input className="input" id="fund-name" value={f.name} onChange={(e) => up({ name: e.target.value })} />
        </Field>
        <Field label="Structure" error={err(errors, "fund.structure")}>
          <select className="input" id="fund-structure" value={f.structure} onChange={(e) => up({ structure: e.target.value })}>
            {options.structures.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Target size ($M)" error={err(errors, "fund.targetSizeUsd")}>
          <input className="input num" id="fund-target" inputMode="decimal" value={millions(f.targetSizeUsd)} onChange={(e) => up({ targetSizeUsd: fromMillions(e.target.value) })} />
        </Field>
        <Field label="Committed so far ($M)">
          <input className="input num" id="fund-committed" inputMode="decimal" value={millions(f.committedUsd)} onChange={(e) => up({ committedUsd: fromMillions(e.target.value) })} />
        </Field>
        <Field label="Vintage year" error={err(errors, "fund.vintage")}>
          <input className="input num" id="fund-vintage" inputMode="numeric" value={f.vintage ?? ""} onChange={(e) => up({ vintage: num(e.target.value) })} />
        </Field>
        <Field label="Investment period (years)">
          <input className="input num" id="fund-period" inputMode="decimal" value={f.investmentPeriodYears ?? ""} onChange={(e) => up({ investmentPeriodYears: num(e.target.value) })} />
        </Field>
        <Field label="Fund term (years)">
          <input className="input num" id="fund-term" inputMode="decimal" value={f.termYears ?? ""} onChange={(e) => up({ termYears: num(e.target.value) })} />
        </Field>
        <Field label="Reserves for follow-ons (%)" error={err(errors, "fund.reservesPct")}>
          <input className="input num" id="fund-reserves" inputMode="decimal" value={f.reservesPct ?? ""} onChange={(e) => up({ reservesPct: num(e.target.value) })} />
        </Field>
        <Field label="Management fee (%)">
          <input className="input num" id="fund-fee" inputMode="decimal" value={f.managementFeePct ?? ""} onChange={(e) => up({ managementFeePct: num(e.target.value) })} />
        </Field>
        <Field label="Carry (%)">
          <input className="input num" id="fund-carry" inputMode="decimal" value={f.carryPct ?? ""} onChange={(e) => up({ carryPct: num(e.target.value) })} />
        </Field>
        <Field label="Target number of companies">
          <input className="input num" id="fund-count" inputMode="numeric" value={f.targetInvestments ?? ""} onChange={(e) => up({ targetInvestments: num(e.target.value) })} />
        </Field>
      </div>
    </div>
  );
}

export function MandateSection({ p, set, errors, options }: Props) {
  const m = p.mandate;
  const up = (patch: Partial<Profile["mandate"]>) => set({ ...p, mandate: { ...m, ...patch } });
  return (
    <div className="section">
      <Field label="Stages you invest in" error={err(errors, "mandate.stages")}>
        <Chips options={options.stages} value={m.stages} onChange={(stages) => up({ stages })} />
      </Field>
      <div className="grid-3">
        <Field label="Smallest check ($M)" error={err(errors, "mandate.checkSizeUsd")}>
          <input className="input num" id="check-min" inputMode="decimal" value={millions(m.checkSizeUsd.min)} onChange={(e) => up({ checkSizeUsd: { ...m.checkSizeUsd, min: fromMillions(e.target.value) ?? 0 } })} />
        </Field>
        <Field label="Largest check ($M)">
          <input className="input num" id="check-max" inputMode="decimal" value={millions(m.checkSizeUsd.max)} onChange={(e) => up({ checkSizeUsd: { ...m.checkSizeUsd, max: fromMillions(e.target.value) ?? 0 } })} />
        </Field>
        <Field label="Target ownership (%)" hint="Minimum to maximum">
          <div className="row">
            <input className="input num" id="own-min" style={{ width: "5em" }} inputMode="decimal" value={m.targetOwnershipPct?.min ?? ""} onChange={(e) => up({ targetOwnershipPct: { min: num(e.target.value) ?? 0, max: m.targetOwnershipPct?.max ?? 0 } })} />
            <span className="muted">to</span>
            <input className="input num" id="own-max" style={{ width: "5em" }} inputMode="decimal" value={m.targetOwnershipPct?.max ?? ""} onChange={(e) => up({ targetOwnershipPct: { min: m.targetOwnershipPct?.min ?? 0, max: num(e.target.value) ?? 0 } })} />
          </div>
        </Field>
      </div>
      <Field label="Do you lead rounds?">
        <Seg
          options={[{ id: "lead", label: "Lead" }, { id: "co_lead", label: "Co-lead" }, { id: "follow", label: "Follow" }, { id: "any", label: "Any" }]}
          value={m.leadPreference}
          onChange={(leadPreference) => up({ leadPreference })}
        />
      </Field>
      <Field label="Geographies" error={err(errors, "mandate.geographies")} hint="Countries or regions: US, Canada, Europe, UK, India, Israel, LatAm, or a country name.">
        <TagInput id="geos" value={m.geographies} onChange={(geographies) => up({ geographies })} placeholder="US, Europe" />
      </Field>
      <Field label="Thesis" hint="In your own words: what you back and why. Shown to your team and used when drafting.">
        <textarea className="input" id="thesis" value={m.thesis} onChange={(e) => up({ thesis: e.target.value })} />
      </Field>
    </div>
  );
}

const blankSector = (n: number): Sector => ({ id: `sector-${n}`, label: "", keywords: [], priority: "core" });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function SectorsSection({ p, set, errors }: Props) {
  const m = p.mandate;
  const setSectors = (sectors: Sector[]) => set({ ...p, mandate: { ...m, sectors } });
  const upd = (i: number, patch: Partial<Sector>) => setSectors(m.sectors.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="section">
      <p className="muted small">
        Sourcing matches these keywords against each company's description (robot, robots and robotics all count).
        Core sectors score full marks; opportunistic ones score a little less.
      </p>
      {err(errors, "mandate.sectors") && <span className="err small" style={{ color: "var(--bad)" }}>{err(errors, "mandate.sectors")}</span>}
      {m.sectors.map((s, i) => (
        <div className="sector" key={i}>
          <div className="grid-2">
            <Field label="Sector">
              <input className="input" id={`sector-${i}-label`} value={s.label} onChange={(e) => upd(i, { label: e.target.value, id: slug(e.target.value) || s.id })} />
            </Field>
            <Field label="Priority">
              <Seg options={[{ id: "core", label: "Core" }, { id: "opportunistic", label: "Opportunistic" }]} value={s.priority} onChange={(priority) => upd(i, { priority })} />
            </Field>
          </div>
          <Field label="Keywords">
            <TagInput id={`sector-${i}-keywords`} value={s.keywords} onChange={(keywords) => upd(i, { keywords })} placeholder="robotics, autonomy" />
          </Field>
          <div><button type="button" className="btn ghost small" onClick={() => setSectors(m.sectors.filter((_, j) => j !== i))}>Remove sector</button></div>
        </div>
      ))}
      <div><button type="button" className="btn" onClick={() => setSectors([...m.sectors, blankSector(m.sectors.length + 1)])}>Add a sector</button></div>
      <Field label="Exclusions" hint="Companies matching these are marked excluded and scored 0.">
        <TagInput id="exclusions" value={m.exclusions} onChange={(exclusions) => set({ ...p, mandate: { ...m, exclusions } })} placeholder="consumer-only products" />
      </Field>
    </div>
  );
}

export function ScoringSection({ p, set, errors }: Props) {
  const dims = p.scoring.dimensions;
  const total = dims.reduce((a, d) => a + d.weight, 0);
  const upd = (i: number, patch: Partial<Dimension>) =>
    set({ ...p, scoring: { dimensions: dims.map((d, j) => (j === i ? { ...d, ...patch } : d)) } });
  return (
    <div className="section">
      <p className="muted small">
        How you weigh a company once it passes the sector, geography and stage checks. Diligence scores each
        dimension from evidence. Weights must add up to 100%.
      </p>
      {dims.map((d, i) => (
        <div className="weight" key={d.id}>
          <div>
            <strong>{d.label}</strong>
            <div className="muted small">{d.guide}</div>
          </div>
          <input type="range" min={0} max={100} step={5} value={Math.round(d.weight * 100)} aria-label={`${d.label} weight`} onChange={(e) => upd(i, { weight: Number(e.target.value) / 100 })} />
          <span className="num">{Math.round(d.weight * 100)}%</span>
        </div>
      ))}
      <div className={`notice ${Math.abs(total - 1) > 0.001 ? "warn" : "good"}`}>
        Total: <span className="num">{Math.round(total * 100)}%</span>
        {Math.abs(total - 1) > 0.001 && " — adjust the sliders to reach 100%."}
        {err(errors, "scoring.dimensions") && ` ${err(errors, "scoring.dimensions")}`}
      </div>
    </div>
  );
}

export const SECTIONS = [
  { id: "firm", paths: ["firm."], label: "Firm", title: "Your firm", lead: "The basics your team and your drafts will use.", C: FirmSection },
  { id: "fund", paths: ["fund."], label: "Fund", title: "The fund you're investing", lead: "Size and structure drive check sizes, reserves and LP reporting.", C: FundSection },
  { id: "mandate", paths: ["mandate.stages", "mandate.checkSizeUsd", "mandate.targetOwnershipPct", "mandate.leadPreference", "mandate.geographies", "mandate.thesis"], label: "Mandate", title: "What you invest in", lead: "Stages, check sizes, geographies and your thesis.", C: MandateSection },
  { id: "sectors", paths: ["mandate.sectors", "mandate.exclusions"], label: "Sectors", title: "Sectors and exclusions", lead: "The sectors sourcing looks for, and what you never do.", C: SectorsSection },
  { id: "scoring", paths: ["scoring."], label: "Scoring", title: "How you score companies", lead: "Weights for the dimensions diligence assesses.", C: ScoringSection },
] as const;

/** Errors that belong to one section. */
export function errorsIn(errors: Errors, paths: readonly string[]): Errors {
  const owns = (k: string) => paths.some((p) => (p.endsWith(".") ? k.startsWith(p) : k === p || k.startsWith(`${p}.`)));
  return Object.fromEntries(Object.entries(errors).filter(([k]) => owns(k)));
}

export function errorsFrom(list?: { path: string; message: string }[]): Errors {
  return Object.fromEntries((list ?? []).map((e) => [e.path, e.message]));
}
