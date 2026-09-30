import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { InvestorRequest, LpacView, RaiseView } from "../../types";
import { ErrorState, Field, Loading, Notice, Select, usePrompt, useToast } from "../../ui";
import { STATUS_TONE, longDate } from "../lp/shared";

/** After the close: the LP advisory committee and investor requests. */
export default function Relations({ data }: { data: RaiseView }) {
  return (
    <>
      {data.raise.fund_id ? <Lpac fundId={data.raise.fund_id} data={data} /> : <Notice>The LPAC is set up once the fund has its first closing.</Notice>}
      <Requests data={data} />
    </>
  );
}

function Lpac({ fundId, data }: { fundId: string; data: RaiseView }) {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<LpacView>(`/ir/funds/${fundId}/lpac`);
  const [partner, setPartner] = useState<string | undefined>();
  const [rep, setRep] = useState("");
  const [c, setC] = useState<{ kind?: string; topic: string; detail: string }>({ topic: "", detail: "" });
  if (q.error) return <ErrorState error={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="Loading the LPAC" />;
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
  const current = q.data.members.filter((m) => !m.until);
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="lpac-h">
        <h2 id="lpac-h">LP advisory committee</h2>
        {current.length === 0 ? <Notice>No members seated yet.</Notice> : <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{current.map((m) => <li key={m.id}><strong>{m.partner_name}</strong>, represented by {m.representative} since {longDate(m.since)}</li>)}</ul>}
        {can("decide_deals") && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/ir/funds/${fundId}/lpac/members`, { body: { partnerId: partner, representative: rep } }); setRep(""); }, "Seated."); }}>
            <div style={{ minWidth: 220 }}><Field label="Investor"><Select id="l-p" value={partner} onChange={setPartner} options={q.data.investors.map((i) => ({ id: i.id, label: i.name }))} /></Field></div>
            <Field label="Representative"><input className="input" value={rep} onChange={(e) => setRep(e.target.value)} required /></Field>
            <button className="btn small" disabled={!partner}>Seat</button>
          </form>
        )}
      </section>
      {can("decide_deals") && current.length > 0 && (
        <form className="panel panel-pad section" aria-labelledby="rc-h" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/ir/funds/${fundId}/lpac/consents`, { body: c }); setC({ topic: "", detail: "" }); }, "Request prepared; the email to members waits in Approvals."); }}>
          <h2 id="rc-h">Ask the committee for consent</h2>
          <div className="form-grid">
            <Field label="For" required><Select id="c-kind" value={c.kind} onChange={(v) => setC({ ...c, kind: v })} options={Object.entries(L.consentKinds).map(([id, label]) => ({ id, label }))} /></Field>
            <Field label="Title" required><input className="input" required value={c.topic} onChange={(e) => setC({ ...c, topic: e.target.value })} /></Field>
          </div>
          <Field label="What the committee is asked to approve" required hint="The facts, any conflict, how it's mitigated, and what the LPA requires"><textarea className="input" required value={c.detail} onChange={(e) => setC({ ...c, detail: e.target.value })} /></Field>
          <div className="row"><button className="btn primary" disabled={!c.kind}>Prepare request</button></div>
        </form>
      )}
      {q.data.consents.map((x) => (
        <section key={x.id} className="panel panel-pad section" aria-labelledby={`cn-${x.id}`}>
          <div className="spread"><h3 id={`cn-${x.id}`}>{x.topic}</h3><span className={`pill ${STATUS_TONE[x.status === "open" ? "pending" : x.status === "approved" ? "approved" : "withdrawn"]}`}>{L.consentStatus[x.status]}</span></div>
          <p className="small" style={{ margin: 0 }}>{L.consentKinds[x.kind]} · requested {longDate(x.requested_on)}{x.due_on ? `, due ${longDate(x.due_on)}` : ""}</p>
          <p style={{ margin: 0 }}>{x.detail}</p>
          <p className="small" style={{ margin: 0 }}>{x.tally.approve} approve, {x.tally.decline} decline, {x.tally.abstain} abstain, {x.tally.pending} yet to vote, of {x.tally.members} members{x.tally.majority ? " · a majority has approved" : ""}.</p>
          {x.status === "open" && (
            <div className="row">
              {can("work_deals") && current.map((m) => {
                const v = x.votes.find((y) => y.member_id === m.id);
                return (
                  <span key={m.id} className="row small">
                    {m.partner_name}: {v ? <strong>{L.votes[v.vote]}</strong> : (["approve", "decline", "abstain"] as const).map((vote) => <button key={vote} className="btn small ghost" onClick={() => void run(() => api(`/ir/lpac/consents/${x.id}/votes`, { body: { memberId: m.id, vote } }), "Vote recorded.")}>{L.votes[vote]}</button>)}
                  </span>
                );
              })}
            </div>
          )}
          {x.status === "open" && can("decide_deals") && (
            <div className="row">
              <button className="btn small primary" onClick={() => void run(() => api(`/ir/lpac/consents/${x.id}/decide`, { body: { outcome: "approved" } }), "Recorded as approved.")}>Record approval</button>
              <button className="btn small" onClick={() => void run(() => api(`/ir/lpac/consents/${x.id}/decide`, { body: { outcome: "declined" } }), "Recorded as declined.")}>Record decline</button>
              <button className="btn small ghost" onClick={() => void run(() => api(`/ir/lpac/consents/${x.id}/decide`, { body: { outcome: "withdrawn" } }), "Withdrawn.")}>Withdraw</button>
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function Requests({ data }: { data: RaiseView }) {
  const { can } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const q = useApi<InvestorRequest[]>("/ir/requests");
  const [f, setF] = useState<{ fromName: string; category?: string; subject: string; dueOn: string }>({ fromName: "", subject: "", dueOn: "" });
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
  const answer = async (r: InvestorRequest) => {
    const a = await prompt({ title: `Answer ${r.from_name}`, label: "The answer, or what was done", confirm: "Record", required: true, multiline: true });
    if (a) await run(() => api(`/ir/requests/${r.id}/answer`, { body: { answer: a } }), "Recorded.");
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="rq-h">
      <h2 id="rq-h">Investor requests</h2>
      {q.error ? <Notice tone="bad">{q.error.message}</Notice> : !q.data ? <p className="small muted">Loading…</p> : q.data.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No requests.</p> : (
        <ul className="timeline small">
          {q.data.map((r) => (
            <li key={r.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span><strong>{r.from_name}</strong>: {r.subject} <span className="muted">({L.requestCategories[r.category]}, received {longDate(r.received_on)}{r.due_on ? `, due ${longDate(r.due_on)}` : ""})</span>{r.answer ? <><br /><span className="muted">{r.answer}</span></> : null}</span>
              <span className="row">{r.overdue ? <span className="pill bad">Overdue</span> : <span className={`pill ${r.status === "open" ? "warn" : "good"}`}>{L.requestStatus[r.status]}</span>}{r.status === "open" && can("work_deals") && <button className="btn small ghost" onClick={() => void answer(r)}>Answer</button>}</span>
            </li>
          ))}
        </ul>
      )}
      {can("work_deals") && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/ir/requests", { body: { ...f, fundId: data.raise.fund_id, dueOn: f.dueOn || undefined } }); setF({ fromName: "", subject: "", dueOn: "" }); }, "Logged."); }}>
          <Field label="From" required><input className="input" required value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></Field>
          <Field label="About" required><Select id="rq-cat" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={Object.entries(L.requestCategories).map(([id, label]) => ({ id, label }))} /></Field>
          <Field label="Request" required><input className="input" required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Due" hint="Blank: 10 days"><input className="input" type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></Field>
          <div className="row" style={{ alignSelf: "end" }}><button className="btn" disabled={!f.category}>Log request</button></div>
        </form>
      )}
    </section>
  );
}
