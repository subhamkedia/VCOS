import { Fragment } from "react";
import type { Construction, Dimension, Profile, ProfileOptions, Sector } from "./types";
import { Chips, Field, Group, MoneyInput, NumberInput, Seg, Select, TagInput, currencySymbol, money } from "./ui";

/**
 * The firm profile, in sections. Setup shows them one step at a time with a
 * review at the end; Settings shows them as tabs. Errors come back from the
 * server keyed by field path ("fund.hardCapUsd").
 */

export type Errors = Record<string, string>;
type Props = { p: Profile; set: (p: Profile) => void; errors: Errors; options: ProfileOptions };

const err = (e: Errors, path: string) => e[path] ?? Object.entries(e).find(([k]) => k.startsWith(`${path}.`))?.[1];
const text = (v: string) => (v.trim() === "" ? undefined : v);

export function FirmSection({ p, set, errors, options }: Props) {
  const f = p.firm;
  const up = (patch: Partial<Profile["firm"]>) => set({ ...p, firm: { ...f, ...patch } });
  return (
    <div className="section">
      <Group title="Identity">
        <div className="grid-2">
          <Field label="Firm name" required error={err(errors, "firm.name")}>
            <input className="input" id="firm-name" value={f.name} onChange={(e) => up({ name: e.target.value })} />
          </Field>
          <Field label="Legal name" hint="As it appears on your fund documents.">
            <input className="input" id="firm-legal" value={f.legalName ?? ""} onChange={(e) => up({ legalName: text(e.target.value) })} />
          </Field>
          <Field label="Type of firm">
            <Select id="firm-type" value={f.type} options={options.firmTypes} onChange={(v) => up({ type: v ?? "independent_vc" })} />
          </Field>
          <Field label="Website">
            <input className="input" id="firm-website" value={f.website ?? ""} placeholder="yourfirm.com" onChange={(e) => up({ website: text(e.target.value) })} />
          </Field>
          <Field label="LinkedIn page">
            <input className="input" id="firm-linkedin" value={f.linkedin ?? ""} placeholder="linkedin.com/company/yourfirm" onChange={(e) => up({ linkedin: text(e.target.value) })} />
          </Field>
          <Field label="Your team's email domains" hint="Meetings where everyone is from these domains are internal. The rest are matched to companies.">
            <TagInput id="firm-email-domains" value={f.emailDomains ?? []} onChange={(emailDomains) => up({ emailDomains: emailDomains.map((d) => d.toLowerCase().replace(/^.*@/, "")) })} placeholder="yourfirm.com" />
          </Field>
        </div>
      </Group>
      <Group title="Where you are">
        <div className="grid-2">
          <Field label="Headquarters">
            <input className="input" id="firm-hq" value={f.hq ?? ""} placeholder="Pittsburgh, PA" onChange={(e) => up({ hq: text(e.target.value) })} />
          </Field>
          <Field label="Other offices">
            <TagInput id="firm-offices" value={f.offices} onChange={(offices) => up({ offices })} placeholder="London, Bengaluru" />
          </Field>
        </div>
      </Group>
      <Group title="Size and history">
        <div className="grid-3">
          <Field label="Founded" error={err(errors, "firm.foundedYear")}>
            <NumberInput id="firm-founded" value={f.foundedYear} onChange={(foundedYear) => up({ foundedYear })} placeholder="2019" />
          </Field>
          <Field label="Assets under management" hint="Across all funds.">
            <MoneyInput id="firm-aum" value={f.aumUsd} onChange={(aumUsd) => up({ aumUsd })} currency={p.fund.currency} />
          </Field>
          <Field label="Funds raised to date">
            <NumberInput id="firm-funds" value={f.fundsRaised} onChange={(fundsRaised) => up({ fundsRaised })} />
          </Field>
          <Field label="Team size">
            <NumberInput id="firm-team" value={f.teamSize} onChange={(teamSize) => up({ teamSize })} suffix="people" />
          </Field>
          <Field label="Investment team" hint="People who source and lead deals.">
            <NumberInput id="firm-invest-team" value={f.investmentTeamSize} onChange={(investmentTeamSize) => up({ investmentTeamSize })} suffix="people" />
          </Field>
        </div>
      </Group>
      <Group title="About the firm">
        <Field label="Description" hint="A few sentences, used when drafting materials for founders and LPs.">
          <textarea className="input" id="firm-about" value={f.description ?? ""} onChange={(e) => up({ description: text(e.target.value) })} />
        </Field>
      </Group>
    </div>
  );
}

export function FundSection({ p, set, errors, options }: Props) {
  const f = p.fund;
  const up = (patch: Partial<Profile["fund"]>) => set({ ...p, fund: { ...f, ...patch } });
  const cur = f.currency;
  const ratio = f.reservesPct === undefined || f.reservesPct >= 100 ? undefined : Math.round((f.reservesPct / (100 - f.reservesPct)) * 100) / 100;
  return (
    <div className="section">
      <Group title="The fund">
        <div className="grid-3">
          <Field label="Fund name" required error={err(errors, "fund.name")}>
            <input className="input" id="fund-name" value={f.name} onChange={(e) => up({ name: e.target.value })} />
          </Field>
          <Field label="Fund number" hint="I, II, III…">
            <input className="input" id="fund-number" value={f.number ?? ""} onChange={(e) => up({ number: text(e.target.value) })} />
          </Field>
          <Field label="Structure" required>
            <Select id="fund-structure" value={f.structure} options={options.structures} onChange={(v) => up({ structure: v ?? "closed_end_fund" })} />
          </Field>
          <Field label="Currency" hint="Amounts below are in this currency.">
            <Select id="fund-currency" value={f.currency} options={options.currencies.map((c) => ({ id: c.id, label: `${c.id} · ${c.label}` }))} onChange={(v) => up({ currency: v ?? "USD" })} />
          </Field>
          <Field label="Vintage year" error={err(errors, "fund.vintage")}>
            <NumberInput id="fund-vintage" value={f.vintage} onChange={(vintage) => up({ vintage })} placeholder="2026" />
          </Field>
          <Field label="Legal form">
            <input className="input" id="fund-legal" value={f.legalForm ?? ""} placeholder="Delaware LP" onChange={(e) => up({ legalForm: text(e.target.value) })} />
          </Field>
          <Field label="Domicile">
            <input className="input" id="fund-domicile" value={f.domicile ?? ""} placeholder="Delaware, US" onChange={(e) => up({ domicile: text(e.target.value) })} />
          </Field>
        </div>
      </Group>
      <Group title="Size and closing">
        <div className="grid-3">
          <Field label="Target size" error={err(errors, "fund.targetSizeUsd")}>
            <MoneyInput id="fund-target" value={f.targetSizeUsd} onChange={(targetSizeUsd) => up({ targetSizeUsd })} currency={cur} />
          </Field>
          <Field label="Hard cap" error={err(errors, "fund.hardCapUsd")}>
            <MoneyInput id="fund-hardcap" value={f.hardCapUsd} onChange={(hardCapUsd) => up({ hardCapUsd })} currency={cur} />
          </Field>
          <Field label="Committed so far" error={err(errors, "fund.committedUsd")} hint="Used for the portfolio math once entered.">
            <MoneyInput id="fund-committed" value={f.committedUsd} onChange={(committedUsd) => up({ committedUsd })} currency={cur} />
          </Field>
          <Field label="GP commitment">
            <NumberInput id="fund-gp" value={f.gpCommitmentPct} onChange={(gpCommitmentPct) => up({ gpCommitmentPct })} suffix="%" />
          </Field>
          <Field label="First close" error={err(errors, "fund.firstCloseDate")}>
            <input className="input" type="date" id="fund-first-close" value={f.firstCloseDate ?? ""} onChange={(e) => up({ firstCloseDate: text(e.target.value) })} />
          </Field>
          <Field label="Final close" error={err(errors, "fund.finalCloseDate")}>
            <input className="input" type="date" id="fund-final-close" value={f.finalCloseDate ?? ""} onChange={(e) => up({ finalCloseDate: text(e.target.value) })} />
          </Field>
        </div>
      </Group>
      <Group title="Term">
        <div className="grid-3">
          <Field label="Investment period">
            <NumberInput id="fund-period" value={f.investmentPeriodYears} onChange={(investmentPeriodYears) => up({ investmentPeriodYears })} suffix="years" />
          </Field>
          <Field label="Fund term" error={err(errors, "fund.termYears")}>
            <NumberInput id="fund-term" value={f.termYears} onChange={(termYears) => up({ termYears })} suffix="years" />
          </Field>
          <Field label="Extensions">
            <NumberInput id="fund-extension" value={f.extensionYears} onChange={(extensionYears) => up({ extensionYears })} suffix="years" />
          </Field>
        </div>
      </Group>
      <Group title="Economics">
        <div className="grid-3">
          <Field label="Management fee">
            <NumberInput id="fund-fee" value={f.managementFeePct} onChange={(managementFeePct) => up({ managementFeePct })} suffix="% a year" />
          </Field>
          <Field label="Fee after the investment period" hint="Leave blank if it doesn't step down.">
            <NumberInput id="fund-stepdown" value={f.feeStepDownPct} onChange={(feeStepDownPct) => up({ feeStepDownPct })} suffix="% a year" />
          </Field>
          <Field label="Charged on, after the period">
            <Select id="fund-fee-basis" value={f.feeBasisAfterPeriod} options={options.feeBasis} onChange={(v) => up({ feeBasisAfterPeriod: v ?? "committed" })} />
          </Field>
          <Field label="Fund expenses" hint="Over the fund's life, as % of commitments.">
            <NumberInput id="fund-expenses" value={f.fundExpensesPct} onChange={(fundExpensesPct) => up({ fundExpensesPct })} suffix="%" />
          </Field>
          <Field label="Recycling" hint="Proceeds you can reinvest.">
            <NumberInput id="fund-recycling" value={f.recyclingPct} onChange={(recyclingPct) => up({ recyclingPct })} suffix="%" />
          </Field>
          <Field label="Carried interest">
            <NumberInput id="fund-carry" value={f.carryPct} onChange={(carryPct) => up({ carryPct })} suffix="%" />
          </Field>
          <Field label="Hurdle (preferred return)">
            <NumberInput id="fund-hurdle" value={f.hurdlePct} onChange={(hurdlePct) => up({ hurdlePct })} suffix="%" />
          </Field>
          <Field label="Waterfall">
            <Select id="fund-waterfall" value={f.waterfall} options={options.waterfall} onChange={(waterfall) => up({ waterfall })} />
          </Field>
        </div>
      </Group>
      <Group title="Portfolio construction" hint="How the fund turns into checks. The panel alongside updates as you type.">
        <div className="grid-3">
          <Field label="Number of first checks">
            <NumberInput id="fund-count" value={f.targetInvestments} onChange={(targetInvestments) => up({ targetInvestments })} suffix="companies" />
          </Field>
          <Field label="Average first check">
            <MoneyInput id="fund-avg-check" value={f.avgInitialCheckUsd} onChange={(avgInitialCheckUsd) => up({ avgInitialCheckUsd })} currency={cur} />
          </Field>
          <Field label="Reserves for follow-ons" error={err(errors, "fund.reservesPct")} hint="Share of investable capital held back.">
            <NumberInput id="fund-reserves" value={f.reservesPct} onChange={(reservesPct) => up({ reservesPct })} suffix="%" />
          </Field>
          <Field label="New-to-reserve ratio" hint="Follow-on dollars per dollar of first check. Sets reserves.">
            <NumberInput id="fund-ratio" value={ratio} prefix="1 :" onChange={(r) => up({ reservesPct: r === undefined ? undefined : Math.round((r / (1 + r)) * 1000) / 10 })} />
          </Field>
          <Field label="Most in any one company" hint="First check plus follow-ons, as % of the fund.">
            <NumberInput id="fund-concentration" value={f.maxConcentrationPct} onChange={(maxConcentrationPct) => up({ maxConcentrationPct })} suffix="%" />
          </Field>
          <Field label="Follow-on approach">
            <Select id="fund-follow-on" value={f.followOnStrategy} options={options.followOn} onChange={(followOnStrategy) => up({ followOnStrategy })} />
          </Field>
        </div>
      </Group>
      <Group title="LPs and decisions">
        <Field label="Your LPs">
          <TagInput id="fund-lps" value={f.lpTypes} onChange={(lpTypes) => up({ lpTypes })} suggestions={options.suggestions.lpTypes} />
        </Field>
        <div className="grid-2">
          <Field label="Investment committee members">
            <NumberInput id="fund-ic-members" value={f.icMembers} onChange={(icMembers) => up({ icMembers })} suffix="people" />
          </Field>
          <Field label="How the committee decides">
            <Select id="fund-ic-approval" value={f.icApproval} options={options.icApproval} onChange={(icApproval) => up({ icApproval })} />
          </Field>
        </div>
      </Group>
    </div>
  );
}

function RangeMoney({ id, value, onChange, currency }: { id: string; value?: { min: number; max: number }; onChange: (v?: { min: number; max: number }) => void; currency: string }) {
  const set = (k: "min" | "max", v?: number) => {
    const next = { min: value?.min ?? 0, max: value?.max ?? 0, [k]: v ?? 0 };
    onChange(next.min === 0 && next.max === 0 ? undefined : next);
  };
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <MoneyInput id={`${id}-min`} value={value?.min || undefined} onChange={(v) => set("min", v)} currency={currency} />
      <span className="muted small">to</span>
      <MoneyInput id={`${id}-max`} value={value?.max || undefined} onChange={(v) => set("max", v)} currency={currency} />
    </div>
  );
}

export function MandateSection({ p, set, errors, options }: Props) {
  const m = p.mandate;
  const cur = p.fund.currency;
  const up = (patch: Partial<Profile["mandate"]>) => set({ ...p, mandate: { ...m, ...patch } });
  return (
    <div className="section">
      <Group title="Stage and checks">
        <Field label="Stages you invest in" required error={err(errors, "mandate.stages")}>
          <Chips options={options.stages} value={m.stages} onChange={(stages) => up({ stages })} />
        </Field>
        <div className="grid-2">
          <Field label="First check range" required error={err(errors, "mandate.checkSizeUsd")}>
            <RangeMoney id="check" value={m.checkSizeUsd} onChange={(v) => up({ checkSizeUsd: v ?? { min: 0, max: 0 } })} currency={cur} />
          </Field>
          <Field label="Follow-on check range" error={err(errors, "mandate.followOnCheckUsd")}>
            <RangeMoney id="followon" value={m.followOnCheckUsd} onChange={(followOnCheckUsd) => up({ followOnCheckUsd })} currency={cur} />
          </Field>
          <Field label="Ownership you aim for at entry" error={err(errors, "mandate.targetOwnershipPct")}>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <NumberInput id="own-min" value={m.targetOwnershipPct?.min} suffix="%" onChange={(v) => up({ targetOwnershipPct: v === undefined && m.targetOwnershipPct?.max === undefined ? undefined : { min: v ?? 0, max: m.targetOwnershipPct?.max ?? 0 } })} />
              <span className="muted small">to</span>
              <NumberInput id="own-max" value={m.targetOwnershipPct?.max} suffix="%" onChange={(v) => up({ targetOwnershipPct: { min: m.targetOwnershipPct?.min ?? 0, max: v ?? 0 } })} />
            </div>
          </Field>
          <Field label="Board role">
            <Select id="board" value={m.boardSeat} options={options.board} onChange={(boardSeat) => up({ boardSeat })} />
          </Field>
        </div>
        <Field label="Do you lead rounds?">
          <Seg label="Lead preference" options={options.lead} value={m.leadPreference} onChange={(leadPreference) => up({ leadPreference })} />
        </Field>
      </Group>
      <Group title="Where">
        <Field label="Geographies" required error={err(errors, "mandate.geographies")} hint="Countries or regions. Sourcing checks each company's headquarters against these.">
          <TagInput id="geos" value={m.geographies} onChange={(geographies) => up({ geographies })} placeholder="US, Europe" suggestions={options.suggestions.geographies} />
        </Field>
      </Group>
      <Group title="What kind of company">
        <div className="grid-2">
          <Field label="Business models">
            <TagInput id="models" value={m.businessModels} onChange={(businessModels) => up({ businessModels })} suggestions={options.suggestions.businessModels} />
          </Field>
          <Field label="Customers they sell to">
            <TagInput id="customers" value={m.customerTypes} onChange={(customerTypes) => up({ customerTypes })} suggestions={options.suggestions.customerTypes} />
          </Field>
          <Field label="Traction you need at first check">
            <Select id="traction" value={m.traction} options={options.traction} onChange={(traction) => up({ traction })} />
          </Field>
          <Field label="Minimum ARR" hint="Leave blank if revenue isn't required.">
            <MoneyInput id="min-arr" value={m.minArrUsd} onChange={(minArrUsd) => up({ minArrUsd })} currency={cur} />
          </Field>
          <Field label="Oldest company you'd back" hint="Years since founding. Sourcing marks older companies.">
            <NumberInput id="max-age" value={m.maxCompanyAgeYears} onChange={(maxCompanyAgeYears) => up({ maxCompanyAgeYears })} suffix="years" />
          </Field>
          <Field label="Impact or ESG mandate">
            <Select id="impact" value={m.impact} options={options.impact} onChange={(impact) => up({ impact })} />
          </Field>
        </div>
      </Group>
      <Group title="Your thesis">
        <Field label="In your own words" hint="What you back and why. Shown to your team and used when drafting memos.">
          <textarea className="input" id="thesis" value={m.thesis} onChange={(e) => up({ thesis: e.target.value })} />
        </Field>
      </Group>
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
      <p className="muted small" style={{ margin: 0 }}>
        Sourcing matches these keywords against each company's description (robot, robots and robotics all count). Core
        sectors score full marks; opportunistic ones score a little less.
      </p>
      {err(errors, "mandate.sectors") && <span className="err small" role="alert" style={{ color: "var(--bad)" }}>{err(errors, "mandate.sectors")}</span>}
      {m.sectors.map((s, i) => (
        <div className="sector" key={i}>
          <div className="grid-2">
            <Field label="Sector" required error={err(errors, `mandate.sectors.${i}.label`)}>
              <input className="input" id={`sector-${i}-label`} value={s.label} onChange={(e) => upd(i, { label: e.target.value, id: slug(e.target.value) || s.id })} />
            </Field>
            <Field label="Priority">
              <Seg label="Priority" options={[{ id: "core", label: "Core" }, { id: "opportunistic", label: "Opportunistic" }]} value={s.priority} onChange={(priority) => upd(i, { priority })} />
            </Field>
          </div>
          <Field label="Keywords" required error={err(errors, `mandate.sectors.${i}.keywords`)}>
            <TagInput id={`sector-${i}-keywords`} value={s.keywords} onChange={(keywords) => upd(i, { keywords })} placeholder="robotics, autonomy" />
          </Field>
          <div><button type="button" className="btn ghost small danger" onClick={() => setSectors(m.sectors.filter((_, j) => j !== i))} aria-label={`Remove sector ${s.label || i + 1}`}>Remove sector</button></div>
        </div>
      ))}
      <div><button type="button" className="btn" onClick={() => setSectors([...m.sectors, blankSector(m.sectors.length + 1)])}>Add a sector</button></div>
      <Field label="Exclusions" hint="Companies whose description matches one of these are marked excluded and scored 0.">
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
  const off = Math.abs(total - 1) > 0.001;
  return (
    <div className="section">
      <p className="muted small" style={{ margin: 0 }}>
        How you weigh a company once it passes the sector, geography and stage checks. Diligence scores each dimension
        from evidence. Weights must add up to 100%.
      </p>
      {dims.map((d, i) => (
        <div className="weight" key={d.id}>
          <div>
            <label htmlFor={`weight-${d.id}`}><strong>{d.label}</strong></label>
            <div className="muted small">{d.guide}</div>
          </div>
          <input type="range" id={`weight-${d.id}`} min={0} max={100} step={5} value={Math.round(d.weight * 100)} onChange={(e) => upd(i, { weight: Number(e.target.value) / 100 })} />
          <span className="num">{Math.round(d.weight * 100)}%</span>
        </div>
      ))}
      <div className={`notice ${off ? "warn" : "good"}`} role="status">
        Total: <span className="num">{Math.round(total * 100)}%</span>
        {off && " — adjust the sliders to reach 100%."}
        {err(errors, "scoring.dimensions") && !off && ` ${err(errors, "scoring.dimensions")}`}
      </div>
    </div>
  );
}

/** The fund's math, live: computed by the server's tested engine, never estimated. */
export function FundMath({ c, currency }: { c: Construction | null; currency: string }) {
  if (!c) {
    return (
      <aside className="panel panel-pad math" aria-label="Portfolio math">
        <h3>Portfolio math</h3>
        <p className="muted small" style={{ margin: 0 }}>Enter a fund size to see fees, investable capital, first checks and reserves.</p>
      </aside>
    );
  }
  const m = (n: number | null) => money(n, currency);
  const firstShare = c.investableUsd > 0 ? (c.initialCapitalUsd / c.investableUsd) * 100 : 100;
  return (
    <aside className="panel panel-pad math" aria-label="Portfolio math">
      <h3>Portfolio math</h3>
      <dl>
        <dt>Fund size</dt><dd>{m(c.sizeUsd)}</dd>
        <dt>Management fees</dt><dd>−{m(c.managementFeesUsd)} <span className="muted">({c.feeLoadPct.toFixed(1)}%)</span></dd>
        {c.expensesUsd > 0 && <><dt>Fund expenses</dt><dd>−{m(c.expensesUsd)}</dd></>}
        {c.recycledUsd > 0 && <><dt>Recycled proceeds</dt><dd>+{m(c.recycledUsd)}</dd></>}
        <dt><strong>Investable</strong></dt><dd>{m(c.investableUsd)}</dd>
      </dl>
      <div className="split" role="img" aria-label={`First checks ${Math.round(firstShare)}%, reserves ${100 - Math.round(firstShare)}%`}>
        <span style={{ width: `${firstShare}%` }} />
        <span style={{ width: `${100 - firstShare}%` }} />
      </div>
      <div className="legend"><span><i style={{ background: "var(--accent)" }} />First checks {m(c.initialCapitalUsd)}</span><span><i style={{ background: "var(--good)" }} />Reserves {m(c.reserveCapitalUsd)}</span></div>
      <dl>
        <dt>New-to-reserve ratio</dt><dd>{c.reserveRatio === null ? "—" : `1 : ${c.reserveRatio.toFixed(2)}`}</dd>
        {c.impliedInvestments !== null && <><dt>Companies at your average check</dt><dd>{Math.round(c.impliedInvestments)}</dd></>}
        {c.impliedAvgInitialCheckUsd !== null && <><dt>Average check for your count</dt><dd>{m(c.impliedAvgInitialCheckUsd)}</dd></>}
        {c.avgReservePerCompanyUsd !== null && <><dt>Reserves per company</dt><dd>{m(c.avgReservePerCompanyUsd)}</dd></>}
        {c.avgPositionPct !== null && <><dt>Average position</dt><dd>{c.avgPositionPct.toFixed(1)}% of fund</dd></>}
      </dl>
      {c.warnings.map((w) => <div key={w} className="notice warn small">{w}</div>)}
      <p className="muted small" style={{ margin: 0 }}>Calculated from your inputs by tested code, not estimated.</p>
    </aside>
  );
}

const labelOf = (list: { id: string; label: string }[], id?: string) => (id ? list.find((o) => o.id === id)?.label ?? id : "—");
const pct = (n?: number) => (n === undefined ? "—" : `${n}%`);
const range = (r: { min: number; max: number } | undefined, cur: string) => (r ? `${money(r.min, cur)}–${money(r.max, cur)}` : "—");
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "—");

/** Everything on one page before saving. Each card links back to its step. */
export function Review({ p, options, onEdit }: { p: Profile; options: ProfileOptions; onEdit: (step: number) => void }) {
  const cur = p.fund.currency;
  const card = (title: string, step: number, rows: [string, string][]) => (
    <section className="panel panel-pad section" style={{ gap: 8 }} aria-label={title}>
      <div className="spread"><h3>{title}</h3><button type="button" className="btn ghost small" onClick={() => onEdit(step)}>Edit</button></div>
      <dl>{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
    </section>
  );
  return (
    <div className="summary">
      {card("Firm", 0, [["Name", p.firm.name], ["Type", labelOf(options.firmTypes, p.firm.type)], ["Headquarters", p.firm.hq ?? "—"], ["AUM", money(p.firm.aumUsd, cur)], ["Team", p.firm.teamSize ? `${p.firm.teamSize} people` : "—"]])}
      {card("Fund", 1, [
        ["Name", [p.fund.name, p.fund.number].filter(Boolean).join(" ")], ["Structure", labelOf(options.structures, p.fund.structure)],
        ["Size", `${money(p.fund.targetSizeUsd, cur)} target${p.fund.hardCapUsd ? `, ${money(p.fund.hardCapUsd, cur)} cap` : ""}`],
        ["Fees and carry", `${pct(p.fund.managementFeePct)} / ${pct(p.fund.carryPct)}`], ["Term", p.fund.termYears ? `${p.fund.termYears} years (${p.fund.investmentPeriodYears ?? "—"} investing)` : "—"],
        ["Reserves", pct(p.fund.reservesPct)], ["First checks", p.fund.targetInvestments ? `${p.fund.targetInvestments} × ${money(p.fund.avgInitialCheckUsd, cur)}` : "—"],
      ])}
      {card("Mandate", 2, [
        ["Stages", p.mandate.stages.map((s) => labelOf(options.stages, s)).join(", ")], ["First checks", range(p.mandate.checkSizeUsd, cur)],
        ["Ownership", p.mandate.targetOwnershipPct ? `${p.mandate.targetOwnershipPct.min}–${p.mandate.targetOwnershipPct.max}%` : "—"],
        ["Lead", labelOf(options.lead, p.mandate.leadPreference)], ["Geographies", list(p.mandate.geographies)], ["Business models", list(p.mandate.businessModels)],
      ])}
      {card("Sectors", 3, [...p.mandate.sectors.map((s): [string, string] => [s.label || "Unnamed", `${s.priority === "core" ? "Core" : "Opportunistic"}: ${s.keywords.join(", ")}`]), ["Exclusions", list(p.mandate.exclusions)]])}
      {card("Scoring", 4, p.scoring.dimensions.map((d): [string, string] => [d.label, `${Math.round(d.weight * 100)}%`]))}
    </div>
  );
}

export const SECTIONS = [
  { id: "firm", paths: ["firm."], label: "Firm", title: "Your firm", lead: "Who you are. Used across drafts, reports and your team's workspace.", C: FirmSection, math: false },
  { id: "fund", paths: ["fund."], label: "Fund", title: "The fund you're investing", lead: "Size, structure, economics and how it turns into checks.", C: FundSection, math: true },
  { id: "mandate", paths: ["mandate.stages", "mandate.checkSizeUsd", "mandate.followOnCheckUsd", "mandate.targetOwnershipPct", "mandate.leadPreference", "mandate.boardSeat", "mandate.geographies", "mandate.businessModels", "mandate.customerTypes", "mandate.traction", "mandate.minArrUsd", "mandate.maxCompanyAgeYears", "mandate.impact", "mandate.thesis"], label: "Mandate", title: "What you invest in", lead: "Stages, checks, geographies and the companies you look for.", C: MandateSection, math: true },
  { id: "sectors", paths: ["mandate.sectors", "mandate.exclusions"], label: "Sectors", title: "Sectors and exclusions", lead: "The sectors sourcing looks for, and what you never do.", C: SectorsSection, math: false },
  { id: "scoring", paths: ["scoring."], label: "Scoring", title: "How you score companies", lead: "Weights for the dimensions diligence assesses.", C: ScoringSection, math: false },
] as const;

/** Errors that belong to one section. */
export function errorsIn(errors: Errors, paths: readonly string[]): Errors {
  const owns = (k: string) => paths.some((p) => (p.endsWith(".") ? k.startsWith(p) : k === p || k.startsWith(`${p}.`)));
  return Object.fromEntries(Object.entries(errors).filter(([k]) => owns(k)));
}

export function errorsFrom(list?: { path: string; message: string }[]): Errors {
  return Object.fromEntries((list ?? []).map((e) => [e.path, e.message]));
}

export { currencySymbol };
