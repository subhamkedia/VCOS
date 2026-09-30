import { ModuleSources } from "./ModuleSources";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { CompanyRow, DealListRow, DealStage } from "../types";
import { ErrorState, Field, Loading, Notice, PageHead, Seg, Time, actor, useToast } from "../ui";
import { useVocab } from "../vocab";

/** A deal stage's name, from the vocabulary. */
export function StageName({ stage }: { stage: string }) {
  return <>{useVocab().dealStage(stage)}</>;
}
export const STAGE_TONE: Record<DealStage, string> = { screening: "quiet", diligence: "info", ic: "warn", approved: "good", closing: "info", passed: "quiet", closed: "good" };

/** The deals the firm is looking at, most advanced first, with how far diligence has got. */
export default function Diligence() {
  const { can } = useSession();
  const nav = useNavigate();
  const [view, setView] = useState<"active" | "decided">("active");
  const stages = view === "active" ? "screening,diligence,ic" : "approved,closing,passed,closed";
  const { data, error, reload } = useApi<DealListRow[]>(`/deals?stages=${stages}`);
  const [starting, setStarting] = useState(false);
  return (
    <>
      <PageHead
        title="Diligence"
        lead="One workspace per company you're seriously looking at: everything your connected tools and public sources know, meetings and calls, a checklist that fills in from the ledger, questions for the founders, and a memo where every fact is cited."
        actions={can("work_deals") && <button className="btn primary" onClick={() => setStarting(!starting)} aria-expanded={starting}>{starting ? "Close" : "Start diligence"}</button>}
      />
      <ModuleSources module="diligence" />
      {starting && <StartDeal onDone={(id) => nav(`/diligence/${id}`)} />}
      <Seg label="Which deals" options={[{ id: "active", label: "Active" }, { id: "decided", label: "Decided" }]} value={view} onChange={setView} />
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading what="Loading deals" /> : data.length === 0 ? (
        <Notice>{view === "active" ? "No deals in diligence. Start one from a company you've sourced, or from scratch." : "No decided deals yet."}</Notice>
      ) : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">{view === "active" ? "Deals in progress" : "Decided deals"}</caption>
            <thead>
              <tr>
                <th scope="col">Company</th><th scope="col">Stage</th><th scope="col">Checklist</th><th scope="col">Open questions</th>
                <th scope="col">Sources disagree</th><th scope="col">Meetings</th><th scope="col">Lead</th><th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="click" onClick={() => nav(`/diligence/${d.id}`)}>
                  <td>
                    <Link to={`/diligence/${d.id}`} onClick={(e) => e.stopPropagation()}><strong>{d.company_name}</strong></Link>
                    {d.domain && <div className="small muted mono">{d.domain}</div>}
                  </td>
                  <td><span className={`pill ${STAGE_TONE[d.stage]}`}><StageName stage={d.stage} /></span></td>
                  <td style={{ minWidth: 150 }}>
                    <Progress done={d.readiness.complete} total={d.readiness.total} label={`${d.company_name} checklist`} />
                    <div className="small muted">{d.readiness.ready ? "Ready for IC" : `${d.readiness.requiredOpen} required open`}</div>
                  </td>
                  <td className="num">{d.open_questions || <span className="muted">—</span>}</td>
                  <td>{d.open_contradictions ? <span className="pill warn">{d.open_contradictions}</span> : <span className="muted">—</span>}</td>
                  <td className="num">{d.meetings || <span className="muted">—</span>}</td>
                  <td className="small">{actor(d.lead)}</td>
                  <td className="small muted"><Time at={d.last_activity ?? d.updated_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${done} of ${total} complete`}>
      <span className="bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="small num">{done}/{total}</span>
    </div>
  );
}

/** Start from a company in the ledger, or a new one by name and website. */
export function StartDeal({ onDone, company }: { onDone: (id: string) => void; company?: { id: string; name: string } }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(company ?? null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: matches } = useApi<CompanyRow[]>(!picked && q.trim().length >= 2 ? `/companies?q=${encodeURIComponent(q.trim())}` : null);
  const start = async (body: object) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string; existing: boolean }>("/deals", { body });
      toast("good", r.existing ? "There's already a deal open for this company. Opening it." : "Diligence started.");
      onDone(r.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="start-h">
      <h2 id="start-h">Start diligence</h2>
      {picked ? (
        <div className="row">
          <span>On <strong>{picked.name}</strong></span>
          {!company && <button className="btn ghost small" onClick={() => setPicked(null)}>Change</button>}
          <button className="btn primary" disabled={busy} aria-busy={busy} onClick={() => void start({ companyId: picked.id })}>Start</button>
        </div>
      ) : (
        <div className="grid-2">
          <div className="section" style={{ gap: 8 }}>
            <Field label="A company in your ledger">
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type two letters or more" />
            </Field>
            <ul className="row" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-live="polite" aria-label="Matching companies">
              {(matches ?? []).slice(0, 8).map((c) => <li key={c.id}><button className="btn small" onClick={() => setPicked(c)}>{c.name}</button></li>)}
              {q.trim().length >= 2 && matches?.length === 0 && <li className="small muted">No match: add it on the right.</li>}
            </ul>
          </div>
          <form className="section" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void start({ company: { name, domain } }); }}>
            <Field label="Or a new company" required><input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name" /></Field>
            <Field label="Website" hint="Lets VC OS read the company's site, job board and more."><input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" /></Field>
            <div className="row"><button className="btn primary" disabled={busy || !name.trim()} aria-busy={busy}>Start</button></div>
          </form>
        </div>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
    </section>
  );
}
