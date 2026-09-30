import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Claim } from "../../types";
import { Field, Notice, Time, actor, dateOnly, useToast } from "../../ui";
import { useVocab } from "../../vocab";
import { SourceViewer } from "../Company";
import type { TabProps } from "../Deal";

const SEVERITY_TONE: Record<string, string> = { high: "bad", medium: "warn", low: "quiet" };

/**
 * Where sources disagree, side by side. Explain it (both can be true) or
 * settle it (one source is right): settling records a new fact from your
 * note and supersedes the wrong one. Nothing is deleted.
 */
export default function Conflicts({ data, onChange }: TabProps) {
  const [reading, setReading] = useState<{ id: string; claim?: string } | null>(null);
  const byId = new Map(data.claims.map((c) => [c.id, c]));
  return (
    <>
      {data.contradictions.length === 0 ? <Notice tone="good">No open conflicts between sources.</Notice> : data.contradictions.map((x) => (
        <ConflictCard key={x.id} x={x} claims={x.claim_ids.map((id) => byId.get(id)).filter((c): c is Claim => Boolean(c))} dealId={data.deal.id} onChange={onChange} onRead={setReading} />
      ))}
      {reading && <SourceViewer id={reading.id} claimId={reading.claim} onClose={() => setReading(null)} />}
      {data.settled.length > 0 && (
        <section className="section" aria-labelledby="settled-h">
          <h2 id="settled-h">Explained and settled</h2>
          <ul className="panel timeline small" style={{ padding: "0 14px" }}>
            {data.settled.map((s) => (
              <li key={s.id}>
                <span className="muted"><Time at={s.resolved_at} /></span>
                <span><span className={`pill ${s.status === "resolved" ? "good" : "info"}`}>{s.status === "resolved" ? "Settled" : "Explained"}</span> {s.detail} <br /><span className="muted">{actor(s.resolved_by)}: “{s.resolution_note}”</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ConflictCard({ x, claims, dealId, onChange, onRead }: {
  x: { id: string; predicate: string; severity: string; detail: string }; claims: Claim[]; dealId: string; onChange: () => void; onRead: (s: { id: string; claim?: string }) => void;
}) {
  const { can } = useSession();
  const v = useVocab();
  const toast = useToast();
  const [mode, setMode] = useState<"none" | "explain" | "settle">("none");
  const [keep, setKeep] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/deals/${dealId}/contradictions/${x.id}`, { body: { status: mode === "settle" ? "resolved" : "explained", note, keepClaimId: keep ?? undefined } });
      toast("good", mode === "settle" ? "Settled. The ledger now carries the right value, and the old one is kept as superseded." : "Explained.");
      onChange();
    } catch (err) {
      toast("bad", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [a, b] = claims;
  return (
    <article className="panel panel-pad section" aria-label={`Conflict: ${v.predicate(x.predicate)}`}>
      <div className="spread"><h2>{v.predicate(x.predicate)}</h2><span className={`pill ${SEVERITY_TONE[x.severity]}`}>{v.severity(x.severity)}</span></div>
      {a && b ? (
        <div className="vs">
          {[a, b].map((c, i) => (
            <div key={c.id} className="side" style={i === 1 ? { gridColumn: 3 } : undefined}>
              <strong>{c.display}</strong>
              <span className="small"><span className="pill outline" title={v.sourceTypeHelp(c.source_type)}>{v.sourceType(c.source_type)}</span> {c.evidence.title ?? v.source(c.evidence.source)}</span>
              <span className="small muted">As of {dateOnly(c.as_of ?? c.evidence.occurred_at)}</span>
              {c.cited_text && <q className="quote small">{c.cited_text}</q>}
              <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => onRead({ id: c.evidence_id, claim: c.id })}>Show in source</button>
            </div>
          )).flatMap((el, i) => (i === 0 ? [el, <span key="vs" className="mid" aria-hidden="true">vs</span>] : [el]))}
        </div>
      ) : <p className="small">{x.detail}</p>}
      {can("work_deals") && (mode === "none" ? (
        <div className="row">
          <button className="btn small" onClick={() => setMode("settle")}>One is right</button>
          <button className="btn small ghost" onClick={() => setMode("explain")}>Both can be true</button>
        </div>
      ) : (
        <form className="section" style={{ gap: 8 }} onSubmit={submit}>
          {mode === "settle" && (
            <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Which is right?</legend>
              {claims.map((c) => (
                <label key={c.id} className="row small" style={{ gap: 6 }}>
                  <input type="radio" name={`keep-${x.id}`} required checked={keep === c.id} onChange={() => setKeep(c.id)} /> {c.display} ({v.sourceType(c.source_type).toLowerCase()})
                </label>
              ))}
            </fieldset>
          )}
          <Field label={mode === "settle" ? "How do you know?" : "What explains the difference?"} required hint={mode === "settle" ? "E.g. 'Payroll export shows 21 full-time; 34 counts contractors.'" : "E.g. 'Different dates: the team grew between March and October.'"}>
            <textarea className="input" required value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row"><button className="btn primary small" disabled={busy} aria-busy={busy}>{mode === "settle" ? "Settle" : "Save explanation"}</button><button type="button" className="btn ghost small" onClick={() => setMode("none")}>Cancel</button></div>
        </form>
      ))}
    </article>
  );
}
