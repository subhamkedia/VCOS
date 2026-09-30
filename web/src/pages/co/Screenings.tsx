import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, Seg, Select } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";

const OUT_TONE = { not_covered: "good", notifiable: "warn", prohibited: "bad" } as const;
const CF_TONE = { none: "good", review: "warn", declaration_likely: "bad" } as const;

interface Answers {
  countryOfConcern: boolean; sector: "none" | "ai" | "semiconductors" | "quantum"; semisAdvanced: boolean; aiProhibited: boolean; aiNotifiable: boolean; excepted: boolean;
  exportControl: "none" | "ear" | "itar"; criticalTechnology: boolean; infrastructureOrData: boolean; foreignRights: boolean; restrictedCountry: boolean; counselNote: string;
}
const BLANK: Answers = { countryOfConcern: false, sector: "none", semisAdvanced: false, aiProhibited: false, aiNotifiable: false, excepted: false, exportControl: "none", criticalTechnology: false, infrastructureOrData: false, foreignRights: false, restrictedCountry: false, counselNote: "" };

/** Every deal is screened before it closes: outbound investment (31 CFR 850), CFIUS (31 CFR 800) and export controls. */
export default function Screenings({ data, onChange }: CoTabProps) {
  const { can } = useSession();
  const [screening, setScreening] = useState<{ id: string; name: string } | null>(null);
  const L = data.labels;
  return (
    <>
      {data.needsScreening.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="ns-h">
          <h2 id="ns-h">In closing, not screened yet</h2>
          {data.profile.require_screening && data.profile.configured && <p className="small muted" style={{ margin: 0 }}>These can't close until they're screened.</p>}
          <ul className="timeline small">
            {data.needsScreening.map((d) => (
              <li key={d.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><Link to={`/execution/${d.id}`}>{d.company_name}</Link></span>
                {can("work_deals") && <button className="btn small primary" onClick={() => setScreening({ id: d.id, name: d.company_name })}>Screen</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {screening && <ScreenForm deal={screening} onDone={() => { setScreening(null); onChange(); }} onCancel={() => setScreening(null)} />}
      <section className="panel panel-pad section" aria-labelledby="sc-h">
        <h2 id="sc-h">Screenings</h2>
        {data.screenings.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No deal has been screened yet. Deals appear here when they reach closing.</p> : data.screenings.map((s) => (
          <article key={s.id} className="section" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div className="spread">
              <h3 style={{ margin: 0 }}><Link to={`/execution/${s.deal_id}`}>{s.company_name}</Link></h3>
              {can("work_deals") && <button className="btn small ghost" onClick={() => setScreening({ id: s.deal_id, name: s.company_name ?? "Company" })}>Screen again</button>}
            </div>
            <div className="row">
              <span className={`pill ${OUT_TONE[s.outbound]}`}>Outbound: {L.outbound[s.outbound]}</span>
              <span className={`pill ${CF_TONE[s.cfius]}`}>CFIUS: {L.cfius[s.cfius]}</span>
              <span className={`pill ${s.export_control === "none" ? "good" : "warn"}`}>{L.exportControl[s.export_control]}</span>
            </div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            {s.counsel_note && <p className="small" style={{ margin: 0 }}><strong>Counsel:</strong> {s.counsel_note}</p>}
            <p className="small muted" style={{ margin: 0 }}>Screened by {person(s.screened_by)} on {longDate(s.created_at)}</p>
          </article>
        ))}
      </section>
    </>
  );
}

function Check({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return <label className="check-row small"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /><span>{label}{hint && <span className="muted"> {hint}</span>}</span></label>;
}

function ScreenForm({ deal, onDone, onCancel }: { deal: { id: string; name: string }; onDone: () => void; onCancel: () => void }) {
  const run = useRun(onDone);
  const [a, setA] = useState<Answers>(BLANK);
  const set = <K extends keyof Answers>(k: K) => (v: Answers[K]) => setA({ ...a, [k]: v });
  const submit = () => run(() => api(`/compliance/deals/${deal.id}/screening`, {
    body: {
      outbound: { countryOfConcern: a.countryOfConcern, sector: a.sector, semisAdvanced: a.semisAdvanced, aiProhibited: a.aiProhibited, aiNotifiable: a.aiNotifiable, excepted: a.excepted },
      cfius: { criticalTechnology: a.criticalTechnology, infrastructureOrData: a.infrastructureOrData, foreignRights: a.foreignRights, restrictedCountry: a.restrictedCountry },
      exportControl: a.exportControl, counselNote: a.counselNote || undefined,
    },
  }), "Screening recorded.");
  return (
    <form className="panel panel-pad section" aria-labelledby="sf-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="sf-h">Screen {deal.name}</h2>
      <p className="small muted" style={{ margin: 0 }}>A first pass from the facts; counsel decides anything that isn't clear. The answers are kept for any Treasury or CFIUS filing.</p>
      <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>Outbound investment</strong> <span className="small muted">(31 CFR Part 850)</span></legend>
        <Check label="The company is a person of a country of concern, or controls one" hint="(China, including Hong Kong and Macau)" value={a.countryOfConcern} onChange={set("countryOfConcern")} />
        {a.countryOfConcern && (
          <>
            <div className="field"><span>Covered technology</span><Seg label="Covered technology" value={a.sector} onChange={set("sector")} options={[{ id: "none", label: "None" }, { id: "ai", label: "AI" }, { id: "semiconductors", label: "Semiconductors" }, { id: "quantum", label: "Quantum" }]} /></div>
            {a.sector === "semiconductors" && <Check label="EDA software, fab or advanced packaging tools, advanced-node chips or supercomputers" value={a.semisAdvanced} onChange={set("semisAdvanced")} />}
            {a.sector === "ai" && <Check label="Trained with more than 10^25 operations, or designed mainly for military, intelligence or mass-surveillance use" value={a.aiProhibited} onChange={set("aiProhibited")} />}
            {a.sector === "ai" && <Check label="Trained with more than 10^23 operations, or for military, surveillance, cybersecurity or robotic-control uses" value={a.aiNotifiable} onChange={set("aiNotifiable")} />}
            <Check label="An exception applies" hint="(a listed security, or an LP interest within the $2M or contractual-assurance exception)" value={a.excepted} onChange={set("excepted")} />
          </>
        )}
      </fieldset>
      <Field label="Export controls" hint="The classification of the company's products and technology"><Select id="sf-ec" value={a.exportControl} onChange={(v) => set("exportControl")(v ?? "none")} options={[{ id: "none", label: "Not controlled (EAR99)" }, { id: "ear", label: "Controlled under the EAR" }, { id: "itar", label: "ITAR" }]} /></Field>
      <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>CFIUS</strong> <span className="small muted">(31 CFR Part 800)</span></legend>
        <Check label="Critical technology: a product needs an export license to at least one country" value={a.criticalTechnology || a.exportControl !== "none"} onChange={set("criticalTechnology")} />
        <Check label="Critical infrastructure, or sensitive personal data of more than a million people" value={a.infrastructureOrData} onChange={set("infrastructureOrData")} />
        <Check label="A foreign investor in the round gets a board or observer seat, nonpublic technical information, or a say over the technology" value={a.foreignRights} onChange={set("foreignRights")} />
        {a.foreignRights && <Check label="That investor is from, or controlled from, a country the export controls restrict" value={a.restrictedCountry} onChange={set("restrictedCountry")} />}
      </fieldset>
      <Field label="Counsel's view" hint="Required when CFIUS may apply: who advised, and what"><textarea className="input" value={a.counselNote} onChange={(e) => set("counselNote")(e.target.value)} /></Field>
      {a.countryOfConcern && a.sector !== "none" && !a.excepted && <Notice tone="warn">This may be a covered transaction. Get counsel's view before signing.</Notice>}
      <div className="row"><button className="btn primary">Record screening</button><button type="button" className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
