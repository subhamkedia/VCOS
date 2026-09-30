import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { CapTable, Holding, NoteRow, SafeRow, SeriesTerms } from "../../types";
import { Field, Notice, Time, useToast, usd } from "../../ui";
import { person, type ExecTabProps } from "../ExecutionDeal";
import { useVocab } from "../../vocab";

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${n.toFixed(2)}%`;

/**
 * The company's cap table, the pro forma after the round and what the fund
 * gets back at each exit. All the math is in engines/ and tested; this page
 * only shows it.
 */
export default function CapModel({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const m = data.model;
  const p = m.proForma;
  const cap = data.capTable;
  return (
    <>
      {can("work_deals") && !editing && <CapSources data={data} onChange={onChange} onEdit={() => setEditing(true)} />}
      {editing && <CapEditor dealId={data.deal.id} initial={cap} onDone={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />}
      {m.error && <Notice tone={cap && data.termSheets.length ? "warn" : "info"}>{m.error}</Notice>}
      {p && (
        <>
          <section className="panel panel-pad section" aria-labelledby="pf-h">
            <h2 id="pf-h">After the round</h2>
            <p className="small muted" style={{ margin: 0 }}>Term sheet version {m.basedOn.termSheetVersion}, cap table version {m.basedOn.capTableVersion}.</p>
            <div className="stats">
              <div className="stat"><b className="num">${p.pricePerShare.toFixed(4)}</b><span>Price per share</span></div>
              <div className="stat"><b className="num">{usd(p.postMoneyImplied)}</b><span>Post-money</span></div>
              {m.ours && <div className="stat"><b className="num">{pct(m.ours.postPct)}</b><span>Our ownership, fully diluted</span></div>}
              {m.ours && <div className="stat"><b className="num">{n0(m.ours.shares)}</b><span>Our shares for {usd(m.ours.amount)}</span></div>}
              <div className="stat"><b className="num">{pct(p.pool.afterPct)}</b><span>Option pool after{p.pool.increase > 0 ? ` (+${n0(p.pool.increase)} in the pre-money)` : ""}</span></div>
            </div>
            <div className="table-wrap">
              <table className="t">
                <caption className="sr-only">Pro forma cap table</caption>
                <thead><tr><th scope="col">Holder</th><th scope="col">Class</th><th scope="col" className="num">Before</th><th scope="col" className="num">%</th><th scope="col" className="num">After</th><th scope="col" className="num">%</th></tr></thead>
                <tbody>
                  {p.rows.map((r) => (
                    <tr key={r.holder + r.className}>
                      <td>{r.holder}</td><td className="small">{r.className}</td>
                      <td className="num">{r.preShares ? n0(r.preShares) : "—"}</td><td className="num">{r.preShares ? pct(r.prePct) : "—"}</td>
                      <td className="num">{n0(r.postShares)}</td><td className="num">{pct(r.postPct)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row" colSpan={2}>Fully diluted</th><td className="num">{n0(p.preMoneyFullyDiluted)}</td><td /><td className="num">{n0(p.postMoneyFullyDiluted)}</td><td className="num">100%</td></tr></tfoot>
              </table>
            </div>
            {p.conversions.length > 0 && (
              <div className="table-wrap">
                <h3>SAFEs and notes converting</h3>
                <table className="t">
                  <thead><tr><th scope="col">Holder</th><th scope="col">Instrument</th><th scope="col" className="num">Converting</th><th scope="col" className="num">Price</th><th scope="col">Price set by</th><th scope="col" className="num">Shares</th></tr></thead>
                  <tbody>
                    {p.conversions.map((c) => (
                      <tr key={c.holder + c.instrument}>
                        <td>{c.holder}</td><td className="small">{c.instrument}</td>
                        <td className="num">{usd(c.converting)}{c.interest > 0 && <div className="small muted">incl. {usd(c.interest)} interest</div>}</td>
                        <td className="num">${c.price.toFixed(4)}</td><td className="small">{c.basis === "cap" ? "Valuation cap" : c.basis === "discount" ? "Discount" : "Round price"}</td>
                        <td className="num">{n0(c.shares)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <details><summary className="small">How this is calculated</summary><ul className="small muted">{p.conventions.map((c) => <li key={c}>{c}</li>)}</ul></details>
          </section>
          {m.scenarios.length > 0 && <Returns scenarios={m.scenarios} invested={m.ours?.amount ?? 0} />}
        </>
      )}
      {cap && <CapTableView cap={cap} />}
    </>
  );
}

function Returns({ scenarios, invested }: { scenarios: ExecTabProps["data"]["model"]["scenarios"]; invested: number }) {
  const max = Math.max(...scenarios.map((s) => s.proceeds), invested);
  return (
    <section className="panel panel-pad section" aria-labelledby="ret-h">
      <h2 id="ret-h">What we get back</h2>
      <p className="small muted" style={{ margin: 0 }}>Proceeds to the fund at each exit value, through the liquidation preferences, participation and conversion of every class (the waterfall). Before fees, carry and later dilution.</p>
      <div className="bars" role="table" aria-label="Proceeds by exit value">
        {scenarios.map((s) => (
          <div key={s.exit} role="row" style={{ display: "contents" }}>
            <span role="rowheader" className="num">{usd(s.exit)} exit</span>
            <span role="cell" className="bar" aria-hidden="true"><span className={s.multiple < 1 ? "loss" : ""} style={{ width: `${max ? (s.proceeds / max) * 100 : 0}%` }} /></span>
            <span role="cell" className="num val">{usd(s.proceeds)} · <strong>{s.multiple.toFixed(2)}x</strong>{s.converted ? " (converts)" : " (takes preference)"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CapTableView({ cap }: { cap: CapTable }) {
  const vocab = useVocab();
  return (
    <section className="panel panel-pad section" aria-labelledby="cap-h">
      <h2 id="cap-h">Company cap table, version {cap.version}</h2>
      <p className="small muted" style={{ margin: 0 }}>{vocab.term("execution", "capSources", cap.source)} by {person(cap.created_by)}, <Time at={cap.created_at} />. Kept confidential.</p>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th scope="col">Holder</th><th scope="col">Class</th><th scope="col">Kind</th><th scope="col" className="num">Shares</th></tr></thead>
          <tbody>{cap.holdings.map((h, i) => <tr key={i}><td>{h.holder}</td><td className="small">{h.className}</td><td className="small">{vocab.term("execution", "holdingKinds", h.kind)}</td><td className="num">{n0(h.shares)}</td></tr>)}</tbody>
        </table>
      </div>
      {cap.safes.length > 0 && <p className="small" style={{ margin: 0 }}>SAFEs: {cap.safes.map((s) => `${s.holder} ${usd(s.amount)}${s.cap ? ` at a ${usd(s.cap)} cap` : ""}`).join("; ")}.</p>}
      {cap.notes.length > 0 && <p className="small" style={{ margin: 0 }}>Notes: {cap.notes.map((n) => `${n.holder} ${usd(n.principal)} at ${n.ratePct}%`).join("; ")}.</p>}
    </section>
  );
}

function CapSources({ data, onChange, onEdit }: ExecTabProps & { onEdit: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [carta, setCarta] = useState(false);
  const upload = async (f: File) => {
    setBusy(true);
    const form = new FormData();
    form.append("file", f);
    try {
      const r = await api<{ version: number; skipped: string[] }>(`/deals/${data.deal.id}/cap-table/uploads`, { form });
      toast("good", `Imported as version ${r.version}${r.skipped.length ? `; skipped ${r.skipped.length} ${r.skipped.length === 1 ? "row" : "rows"} (totals or blanks)` : ""}.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="src-h">
      <h2 id="src-h">Company cap table</h2>
      <p className="small muted" style={{ margin: 0 }}>Import the company's export from Carta, Pulley or a spreadsheet (CSV with holder, class and shares), pull it from Carta if the company shares it with you, or enter it.</p>
      <div className="row">
        <label className="btn primary" aria-busy={busy}>
          Import a CSV
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </label>
        <button className="btn" onClick={() => setCarta(!carta)} aria-expanded={carta}>From Carta</button>
        <button className="btn ghost" onClick={onEdit}>{data.capTable ? "Edit, add SAFEs and notes" : "Enter by hand"}</button>
      </div>
      {carta && <CartaImport dealId={data.deal.id} onDone={() => { setCarta(false); onChange(); }} />}
    </section>
  );
}

function CartaImport({ dealId, onDone }: { dealId: string; onDone: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState({ firmId: "", fundId: "", companyId: "", capTableId: "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    try {
      await api(`/deals/${dealId}/cap-table/carta`, { body: ids });
      toast("good", "Cap table pulled from Carta.");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const f = (k: keyof typeof ids, label: string) => <Field label={label} required><input className="input mono" required value={ids[k]} onChange={(e) => setIds({ ...ids, [k]: e.target.value.trim() })} /></Field>;
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="small muted" style={{ margin: 0 }}>Carta's investor API shares a portfolio company's cap table once the company grants your fund access. The identifiers are in the Carta investor portal. <Link to="/connections?module=execution">Connect Carta</Link> first.</p>
      <div className="form-grid">{f("firmId", "Carta firm")}{f("fundId", "Carta fund")}{f("companyId", "Company")}{f("capTableId", "Cap table")}</div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Pull cap table</button></div>
    </form>
  );
}

type Col<T> = { key: keyof T; label: string; type?: "number" | "date" | "select"; options?: { id: string; label: string }[]; optional?: boolean };

/** A small table editor: one row per holder, SAFE, note or series. */
function Rows<T extends object>({ title, rows, set, cols, blank, hint }: { title: string; rows: T[]; set: (r: T[]) => void; cols: Col<T>[]; blank: T; hint?: ReactNode }) {
  const upd = (i: number, k: keyof T, v: string) => set(rows.map((r, j) => {
    if (j !== i) return r;
    const col = cols.find((c) => c.key === k)!;
    const val = col.type === "number" ? (v.trim() === "" ? undefined : Number(v.replace(/,/g, ""))) : v;
    return { ...r, [k]: val };
  }));
  return (
    <fieldset className="section" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
      <legend><strong>{title}</strong></legend>
      {hint && <p className="small muted" style={{ margin: 0 }}>{hint}</p>}
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{cols.map((c) => <th key={String(c.key)} scope="col">{c.label}{c.optional ? "" : " *"}</th>)}<th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  const v = (r as Record<string, unknown>)[c.key as string];
                  const label = `${title} row ${i + 1}: ${c.label}`;
                  return (
                    <td key={String(c.key)}>
                      {c.type === "select" ? (
                        <select className="input" aria-label={label} value={String(v ?? "")} onChange={(e) => upd(i, c.key, e.target.value)}>{c.options!.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
                      ) : (
                        <input className={`input ${c.type === "number" ? "num" : ""}`} aria-label={label} type={c.type === "date" ? "date" : "text"} inputMode={c.type === "number" ? "decimal" : undefined}
                          required={!c.optional} value={v === undefined ? "" : String(v)} onChange={(e) => upd(i, c.key, e.target.value)} />
                      )}
                    </td>
                  );
                })}
                <td><button type="button" className="btn small ghost" onClick={() => set(rows.filter((_, j) => j !== i))} aria-label={`Remove ${title.toLowerCase()} row ${i + 1}`}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><button type="button" className="btn small" onClick={() => set([...rows, { ...blank }])}>Add a row</button></div>
    </fieldset>
  );
}

function CapEditor({ dealId, initial, onDone, onCancel }: { dealId: string; initial: CapTable | null; onDone: () => void; onCancel: () => void }) {
  const vocab = useVocab();
  const toast = useToast();
  const [holdings, setHoldings] = useState<Holding[]>(initial?.holdings ?? [{ holder: "", className: "Common", shares: 0, kind: "common" }]);
  const [safes, setSafes] = useState<SafeRow[]>(initial?.safes ?? []);
  const [notes, setNotes] = useState<NoteRow[]>(initial?.notes ?? []);
  const [series, setSeries] = useState<SeriesTerms[]>(initial?.series_terms ?? []);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      const r = await api<{ version: number }>(`/deals/${dealId}/cap-table`, { method: "PUT", body: { holdings, safes, notes, seriesTerms: series } });
      toast("good", `Saved as version ${r.version}.`);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="ce-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="ce-h">Cap table</h2>
      <Rows title="Holdings" rows={holdings} set={setHoldings} blank={{ holder: "", className: "Common", shares: 0, kind: "common" }} cols={[
        { key: "holder", label: "Holder" }, { key: "className", label: "Class" }, { key: "shares", label: "Shares", type: "number" },
        { key: "kind", label: "Kind", type: "select", options: vocab.terms("execution", "holdingKinds") },
      ]} />
      <Rows title="SAFEs outstanding" rows={safes} set={setSafes} blank={{ holder: "", amount: 0, kind: "post" }} hint="They convert in this round: at the cap, the discount, or the round price, whichever gives more shares." cols={[
        { key: "holder", label: "Holder" }, { key: "amount", label: "Amount ($)", type: "number" },
        { key: "kind", label: "Type", type: "select", options: [{ id: "post", label: "Post-money" }, { id: "pre", label: "Pre-money" }, { id: "mfn", label: "MFN (no cap)" }] },
        { key: "cap", label: "Cap ($)", type: "number", optional: true }, { key: "discountPct", label: "Discount %", type: "number", optional: true },
      ]} />
      <Rows title="Convertible notes" rows={notes} set={setNotes} blank={{ holder: "", principal: 0, ratePct: 5, issueDate: "" }} hint="Principal plus simple interest to the closing date converts." cols={[
        { key: "holder", label: "Holder" }, { key: "principal", label: "Principal ($)", type: "number" }, { key: "ratePct", label: "Interest %", type: "number" },
        { key: "issueDate", label: "Issued", type: "date" }, { key: "cap", label: "Cap ($)", type: "number", optional: true }, { key: "discountPct", label: "Discount %", type: "number", optional: true },
      ]} />
      <Rows title="Earlier preferred series" rows={series} set={setSeries} blank={{ name: "", issuePrice: 0, multiple: 1, participating: false, seniority: 2 }} hint="The preferences of earlier rounds, for the waterfall. The name must match the class in holdings." cols={[
        { key: "name", label: "Class" }, { key: "issuePrice", label: "Issue price ($)", type: "number" }, { key: "multiple", label: "Preference (x)", type: "number" },
        { key: "seniority", label: "Rank (1 is most senior)", type: "number" },
      ]} />
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Save as a new version</button><button type="button" className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
