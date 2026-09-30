import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, useToast, usd } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { monthLabel, SOURCE_LABEL } from "./shared";

const COLUMNS: { key: string; label: string; money?: boolean }[] = [
  { key: "revenue", label: "Revenue", money: true }, { key: "expenses", label: "Expenses", money: true }, { key: "burn", label: "Net burn", money: true },
  { key: "cash", label: "Cash", money: true }, { key: "arr", label: "ARR", money: true }, { key: "headcount", label: "Headcount" }, { key: "customers", label: "Customers" },
  { key: "units", label: "Units deployed" },
];

interface SyncResult { id: string; name: string; status: string; claims: number; detail?: string }

/**
 * The company's numbers by month, each with where it came from (hover a
 * figure for the line it cites). Refresh pulls from the books and the
 * firm's tools; figures can also be entered from a deck or imported from a
 * spreadsheet.
 */
export default function Numbers({ data, onChange }: PfTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SyncResult[] | null>(null);
  const burnBy = new Map(data.burn.map((b) => [b.month, b]));
  const monthsList = [...new Set([...Object.values(data.series).flatMap((s) => (s ?? []).map((p) => p.month)), ...data.burn.map((b) => b.month)])].sort().reverse().slice(0, 18);
  const cols = COLUMNS.filter((c) => c.key === "burn" ? data.burn.length : data.series[c.key]?.length);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<SyncResult[]>(`/portfolio/companies/${data.company.id}/sync`, { body: {} });
      setResults(r);
      const n = r.reduce((a, x) => a + x.claims, 0);
      toast("good", n ? `${n} new figures.` : "No new figures.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="src-h">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="src-h">Where the numbers come from</h2>
          {can("work_deals") && <button className="btn primary" disabled={busy} aria-busy={busy} onClick={() => void sync()}>Refresh numbers</button>}
        </div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {data.accounting.map((a) => (
            <li key={a.id}><strong>{a.provider === "quickbooks" ? "QuickBooks Online" : "Xero"}</strong>{a.external_name ? ` (${a.external_name})` : ""}: connected by the founder{a.last_sync_at ? `, last read ${new Date(a.last_sync_at).toLocaleDateString()}` : ""}{a.last_error ? <span style={{ color: "var(--bad)" }}> · {a.last_error}</span> : null}</li>
          ))}
          {data.sources.filter((s) => !s.perCompany).map((s) => (
            <li key={s.id}><strong>{s.name}</strong>: {s.summary}{s.ready ? "" : <span className="muted"> · not connected (<Link to="/connections?module=portfolio">connect</Link>)</span>}</li>
          ))}
        </ul>
        {!data.accounting.length && <Notice>The founder can connect QuickBooks or Xero (read only) from the link on the Reporting tab. The books are the best source: they win over figures typed in.</Notice>}
        {results && (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }} aria-live="polite">
            {results.map((r) => <li key={r.id}>{r.name}: {r.status === "ok" ? `${r.claims} figures` : r.status === "empty" ? "nothing new" : r.status === "skipped" ? "skipped" : "failed"}{r.detail ? ` (${r.detail})` : ""}</li>)}
          </ul>
        )}
      </section>

      {monthsList.length === 0 ? <Notice>No figures yet.</Notice> : (
        <section className="panel table-wrap" aria-labelledby="tbl-h">
          <h2 id="tbl-h" className="sr-only">Figures by month</h2>
          <table className="t">
            <caption className="sr-only">Figures by month; hover a figure for its source</caption>
            <thead><tr><th scope="col">Month</th>{cols.map((c) => <th key={c.key} scope="col" className="num">{c.label}</th>)}</tr></thead>
            <tbody>
              {monthsList.map((m) => (
                <tr key={m}>
                  <th scope="row">{monthLabel(m)}</th>
                  {cols.map((c) => {
                    if (c.key === "burn") {
                      const b = burnBy.get(m);
                      return <td key={c.key} className="num" title={b ? `Basis: ${b.basis}` : undefined}>{b ? usd(b.value) : <span className="muted">—</span>}</td>;
                    }
                    const pt = data.series[c.key]?.find((x) => x.month === m);
                    const cite = pt ? data.cites[pt.claimId] : undefined;
                    return (
                      <td key={c.key} className="num" title={cite ? `${SOURCE_LABEL[cite.sourceType] ?? cite.sourceType}${cite.citedText ? `: "${cite.citedText}"` : ""}` : undefined}>
                        {pt ? (c.money ? usd(pt.value) : pt.value.toLocaleString("en-US")) : <span className="muted">—</span>}
                        {pt?.sourceType === "primary" && <span className="sr-only"> (from the books)</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {can("work_deals") && <Enter data={data} onChange={onChange} />}
    </>
  );
}

function Enter({ data, onChange }: PfTabProps) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const last = new Date();
  last.setUTCMonth(last.getUTCMonth() - 1);
  const [period, setPeriod] = useState(last.toISOString().slice(0, 7));
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      const r = await api<{ claims: number }>(`/portfolio/companies/${data.company.id}/kpis`, { body: { period, values, note } });
      toast("good", `${r.claims} figures recorded.`);
      setValues({});
      setNote("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const upload = async (f: File) => {
    const form = new FormData();
    form.append("file", f);
    try {
      const r = await api<{ claims: number; ignoredColumns: string[] }>(`/portfolio/companies/${data.company.id}/kpis/uploads`, { form });
      toast("good", `${r.claims} figures imported${r.ignoredColumns.length ? `; not recognized: ${r.ignoredColumns.join(", ")}` : ""}.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      if (file.current) file.current.value = "";
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="enter-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="enter-h">Enter figures</h2>
      <p className="small muted" style={{ margin: 0 }}>From a board deck or an update email. Recorded as company-reported, with your name; figures from the books replace them for the same month.</p>
      <Field label="Month" required><input className="input" type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} style={{ maxWidth: 200 }} /></Field>
      <div className="form-grid">
        {data.options.reportable.map((m) => (
          <Field key={m.id} label={m.label}>
            <input className="input num" inputMode="decimal" value={values[m.id] ?? ""} onChange={(e) => setValues({ ...values, [m.id]: e.target.value })} />
          </Field>
        ))}
      </div>
      <Field label="Notes"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <button className="btn primary">Record figures</button>
        <label className="btn">
          Import a spreadsheet (CSV)
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </label>
        <span className="small muted">A Month column, then one column per metric (Revenue, Cash, Burn, ARR, Headcount...).</span>
      </div>
    </form>
  );
}
