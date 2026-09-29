import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../api";
import type { CompanyRow } from "../types";
import { ErrorState, Loading, Notice, PageHead, Time } from "../ui";
import { UploadForm } from "./Company";

export default function Companies() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const { data, error, reload } = useApi<CompanyRow[]>(`/companies${search ? `?q=${encodeURIComponent(search)}` : ""}`);
  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Companies"
        lead="Every company in your firm's ledger. Each fact is a claim with its source, date and exact quote."
        actions={<button className="btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Close" : "Add a deck or transcript"}</button>}
      />
      {adding && <div className="panel panel-pad"><UploadForm onDone={(id) => { setAdding(false); if (id) nav(`/companies/${id}`); else void reload(); }} /></div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <input className="input" style={{ maxWidth: 360 }} id="company-search" type="search" aria-label="Search companies by name" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
        {search && <button type="button" className="btn ghost" onClick={() => { setQ(""); setSearch(""); }}>Clear</button>}
      </form>
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading /> : data.length === 0 ? (
        <Notice>{search ? `No company matches "${search}".` : "No companies yet. Sourcing feeds and uploads add them."}</Notice>
      ) : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Companies in your ledger</caption>
            <thead><tr><th scope="col">Company</th><th scope="col">Website</th><th scope="col">Facts</th><th scope="col">Sources disagree</th><th scope="col">Updated</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="click" onClick={() => nav(`/companies/${c.id}`)}>
                  <td><Link to={`/companies/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></Link></td>
                  <td className="mono muted">{c.domain ?? "—"}</td>
                  <td className="num">{c.claims}</td>
                  <td>{c.open_contradictions ? <span className="pill warn">{c.open_contradictions}</span> : <span className="muted">—</span>}</td>
                  <td className="small muted"><Time at={c.updated_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
