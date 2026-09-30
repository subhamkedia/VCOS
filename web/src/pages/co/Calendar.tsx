import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { CoObligation } from "../../types";
import { Field, Notice, Select } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";

const TONE = { done: "good", overdue: "bad", upcoming: "warn" } as const;
const STATE = { done: "Filed", overdue: "Overdue", upcoming: "Due" } as const;
const today = () => new Date().toISOString().slice(0, 10);

/** What's due this year and next, built from the other modules' records, and the filings made against it. */
export default function Calendar({ data, onChange }: CoTabProps) {
  const { can } = useSession();
  const run = useRun(onChange);
  const L = data.labels;
  const open = data.calendar.filter((o) => o.state !== "done");
  const [f, setF] = useState<{ key?: string; form?: string; filedOn: string; reference: string; note: string; subject: string }>({ filedOn: today(), reference: "", note: "", subject: "" });
  const pick = (key: string | undefined) => {
    const o = data.calendar.find((x) => x.key === key);
    setF({ ...f, key, form: o?.form ?? f.form, subject: o?.subject ?? "" });
  };
  const soon = open.filter((o) => o.due <= new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  return (
    <>
      {soon.length > 0 && <Notice tone={soon.some((o) => o.state === "overdue") ? "bad" : "warn"}>{soon.length} due in the next 60 days or overdue. Record each filing once it's made so the calendar closes it.</Notice>}
      <section className="panel panel-pad section" aria-labelledby="cal-h">
        <h2 id="cal-h">Obligations</h2>
        {data.calendar.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing is due on your current status. Check the regulatory profile.</p> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Regulatory obligations by due date</caption>
              <thead><tr><th scope="col">Due</th><th scope="col">Obligation</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {data.calendar.map((o: CoObligation) => (
                  <tr key={o.key}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>{longDate(o.due)}</td>
                    <th scope="row">{o.title}{o.subject && <span className="muted"> · {o.subject}</span>}<div className="small muted">{o.basis}</div></th>
                    <td><span className={`pill ${TONE[o.state]}`}>{STATE[o.state]}</span>{o.filing && <div className="small muted">{longDate(o.filing.filed_on)}{o.filing.reference ? ` · ${o.filing.reference}` : ""}</div>}{o.waitingOn && <div className="small muted">Waiting on {o.waitingOn.map(person).join(", ")}</div>}{!o.filing && o.state === "done" && <div className="small muted">Everyone has reported</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {can("decide_deals") && (
        <form className="panel panel-pad section" aria-labelledby="rf-h" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/compliance/filings", { body: { form: f.form, obligationKey: f.key, subject: f.subject || undefined, filedOn: f.filedOn, reference: f.reference || undefined, note: f.note || undefined } });
            setF({ filedOn: today(), reference: "", note: "", subject: "" });
          }, "Filing recorded.");
        }}>
          <h2 id="rf-h">Record a filing</h2>
          <div className="form-grid">
            <Field label="For obligation" hint="Leave blank for a filing that isn't on the calendar"><Select id="rf-ob" value={f.key} onChange={pick} placeholder="None" options={open.map((o) => ({ id: o.key, label: `${o.title}${o.subject ? ` (${o.subject})` : ""}` }))} /></Field>
            <Field label="Form" required><Select id="rf-form" value={f.form} onChange={(v) => setF({ ...f, form: v })} options={Object.entries(L.forms).map(([id, label]) => ({ id, label }))} /></Field>
            <Field label="Filed on" required><input className="input" type="date" required value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} /></Field>
            <Field label="Reference" hint="Accession number, confirmation or state file number"><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
            <Field label="For" hint="A fund, state or company"><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
            <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          </div>
          <div className="row"><button className="btn primary" disabled={!f.form}>Record filing</button></div>
        </form>
      )}
      <FormDLookup onUse={(hit) => setF({ ...f, form: "form_d", reference: hit.accession, filedOn: hit.filedOn, subject: hit.name })} canRecord={can("decide_deals")} />
      <section className="panel panel-pad section" aria-labelledby="fl-h">
        <h2 id="fl-h">Filings on record</h2>
        {data.filings.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None recorded yet.</p> : (
          <ul className="timeline small">
            {data.filings.map((x) => <li key={x.id}><span>{longDate(x.filed_on)}</span><span><strong>{L.forms[x.form]}</strong>{x.subject ? ` · ${x.subject}` : ""}{x.reference ? ` · ${x.reference}` : ""} <span className="muted">recorded by {person(x.created_by)}{x.note ? `: ${x.note}` : ""}</span></span></li>)}
          </ul>
        )}
      </section>
    </>
  );
}

interface Hit { name: string; cik: string; accession: string; filedOn: string; url: string }

/** Confirm a fund's Form D is on EDGAR and pick up its accession number. */
function FormDLookup({ onUse, canRecord }: { onUse: (h: Hit) => void; canRecord: boolean }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<{ busy: boolean; hits: Hit[] | null; error: string | null }>({ busy: false, hits: null, error: null });
  const search = async () => {
    setState({ busy: true, hits: null, error: null });
    try {
      setState({ busy: false, hits: await api<Hit[]>(`/compliance/form-d?name=${encodeURIComponent(name)}`), error: null });
    } catch (e) {
      setState({ busy: false, hits: null, error: (e as Error).message });
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="fd-h" onSubmit={(e) => { e.preventDefault(); void search(); }}>
      <h2 id="fd-h">Find a Form D on EDGAR</h2>
      <div className="row">
        <Field label="Fund name as filed"><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn" style={{ alignSelf: "end" }} disabled={state.busy}>{state.busy ? "Searching…" : "Search"}</button>
      </div>
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.hits && (state.hits.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No Form D found under that name.</p> : (
        <ul className="timeline small">
          {state.hits.map((h) => (
            <li key={h.accession} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span><a href={h.url} target="_blank" rel="noreferrer">{h.name}</a> <span className="muted">filed {longDate(h.filedOn)} · {h.accession}</span></span>
              {canRecord && <button type="button" className="btn small ghost" onClick={() => onUse(h)}>Use for a filing</button>}
            </li>
          ))}
        </ul>
      ))}
    </form>
  );
}
