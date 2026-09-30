import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { SideLetterView } from "../../types";
import { ErrorState, Field, Loading, Notice, NumberInput, Select, useToast } from "../../ui";
import type { FrTabProps } from "../Raise";
import { STATUS_TONE, longDate } from "../lp/shared";

/** Side letter terms by investor, MFN elections, and the obligations the firm has taken on. */
export default function SideLetters({ data }: FrTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<SideLetterView>(`/fundraising/raises/${data.raise.id}/side-letters`);
  const [sub, setSub] = useState<string | undefined>();
  const [cat, setCat] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [days, setDays] = useState<number | undefined>(45);
  if (q.error) return <ErrorState error={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="Loading side letters" />;
  const L = data.labels;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      void q.reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const byInvestor = new Map<string, SideLetterView["terms"]>();
  for (const t of q.data.terms) byInvestor.set(t.investor_name ?? "", [...(byInvestor.get(t.investor_name ?? "") ?? []), t]);
  const holders = data.subscriptions.filter((s) => ["submitted", "accepted", "admitted"].includes(s.status));
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="sl-h">
        <h2 id="sl-h">Side letters</h2>
        {byInvestor.size === 0 ? <Notice>No side letter terms recorded.</Notice> : [...byInvestor.entries()].map(([name, ts]) => (
          <div key={name} className="section" style={{ gap: 4 }}>
            <h3>{name}</h3>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{ts.map((t) => <li key={t.id}><strong>{L.termCategories[t.category]}</strong>: {t.text} <span className="muted">({longDate(t.granted_on)}{t.elected_from ? ", elected under MFN" : ""}{!t.electable && !t.elected_from ? ", not electable" : ""})</span></li>)}</ul>
          </div>
        ))}
      </section>
      {can("decide_deals") && holders.length > 0 && (
        <form className="panel panel-pad section" aria-labelledby="at-h" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/fundraising/subscriptions/${sub}/terms`, { body: { category: cat, text } }); setText(""); }, "Term recorded."); }}>
          <h2 id="at-h">Record a negotiated term</h2>
          <div className="form-grid">
            <Field label="Investor" required><Select id="t-sub" value={sub} onChange={setSub} options={holders.map((s) => ({ id: s.id, label: s.investor_name }))} /></Field>
            <Field label="Kind of term" required><Select id="t-cat" value={cat} onChange={setCat} options={Object.entries(L.termCategories).map(([id, label]) => ({ id, label }))} /></Field>
          </div>
          <Field label="The term, as agreed" required><textarea className="input" required value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <p className="small muted" style={{ margin: 0 }}>An MFN term gives its holder the right to elect terms granted to investors with equal or smaller commitments. LPAC seats are never electable.</p>
          <div className="row"><button className="btn primary" disabled={!sub || !cat}>Record</button></div>
        </form>
      )}
      <section className="panel panel-pad section" aria-labelledby="mfn-h">
        <h2 id="mfn-h">MFN elections</h2>
        {can("queue") && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/fundraising/raises/${data.raise.id}/mfn`, { body: { windowDays: days } }), "Election package prepared; the letters wait in Approvals."); }}>
            <Field label="Election window, days"><NumberInput id="m-days" value={days} onChange={setDays} /></Field>
            <button className="btn small">Prepare the election package</button>
          </form>
        )}
        {q.data.elections.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None offered yet. Prepare the package after the final closing.</p> : (
          <ul className="timeline small">
            {q.data.elections.map((e) => (
              <li key={e.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><strong>{e.investor}</strong> may elect <em>{e.term ? `${L.termCategories[e.term.category]}: ${e.term.text}` : "a term"}</em><br /><span className="muted">Window ends {longDate(e.window_ends)}</span></span>
                <span className="row">
                  <span className={`pill ${STATUS_TONE[e.status === "offered" ? "pending" : e.status === "elected" ? "approved" : "withdrawn"]}`}>{L.electionStatus[e.status]}</span>
                  {e.status === "offered" && can("work_deals") && <><button className="btn small" onClick={() => void run(() => api(`/fundraising/mfn/${e.id}`, { body: { elect: true } }), "Elected: added to the side letter.")}>Elected</button><button className="btn small ghost" onClick={() => void run(() => api(`/fundraising/mfn/${e.id}`, { body: { elect: false } }), "Recorded.")}>Not elected</button></>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel panel-pad section" aria-labelledby="ob-h">
        <h2 id="ob-h">Obligations to keep</h2>
        {q.data.obligations.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None.</p> : <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{q.data.obligations.map((o, i) => <li key={i}><strong>{o.investor}</strong> · {o.category}: {o.text}</li>)}</ul>}
      </section>
    </>
  );
}
