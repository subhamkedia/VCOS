import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { FundTermsView } from "../../types";
import { Field, Notice, NumberInput, Select, useToast, usd } from "../../ui";
import type { LpTab, LpTabProps } from "../LpFund";
import { NetAndGross, longDate } from "./shared";

export default function Overview({ data, onChange, go }: LpTabProps & { go: (t: LpTab) => void }) {
  const { can } = useSession();
  const s = data.summary;
  const c = data.gpCarry;
  const drafts = {
    calls: data.calls.filter((x) => x.status === "draft").length,
    dists: data.distributions.filter((x) => x.status === "draft").length,
    toPay: data.distributions.filter((x) => x.status === "approved").length,
    reports: data.reports.filter((x) => x.status === "draft").length,
  };
  const next = data.calendar.filter((d) => d.state === "upcoming" || d.state === "overdue").slice(0, 4);
  return (
    <>
      {data.investors.length === 0 && <Notice>Add the fund's investors to start: by hand or from your fund administrator's export. <button className="btn small" onClick={() => go("investors")}>Add investors</button></Notice>}
      <section className="panel panel-pad section" aria-labelledby="sum-h">
        <h2 id="sum-h">The fund</h2>
        <div className="stats">
          <div className="stat"><b className="num">{usd(s.commitments)}</b><span>Committed</span></div>
          <div className="stat"><b className="num">{usd(s.called)}</b><span>Called ({s.calledPct.toFixed(1)}%)</span></div>
          <div className="stat"><b className="num">{usd(s.uncalled)}</b><span>Uncalled</span></div>
          <div className="stat"><b className="num">{usd(s.distributed)}</b><span>Distributed</span></div>
          <div className="stat"><b className="num">{usd(s.nav)}</b><span>Net asset value</span></div>
          {s.receivable > 0 && <div className="stat"><b className="num">{usd(s.receivable)}</b><span>Called, not yet received</span></div>}
        </div>
        <div className="meter" role="img" aria-label={`${s.calledPct.toFixed(1)}% of commitments called`}>
          <span className="deployed" style={{ width: `${Math.min(100, s.calledPct)}%` }} />
        </div>
      </section>

      <section className="panel panel-pad section" aria-labelledby="perf-h">
        <h2 id="perf-h">Returns since inception</h2>
        <NetAndGross net={data.performance.net} gross={data.performance.gross} note={data.performance.marketingNote} />
      </section>

      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="work-h">
          <h2 id="work-h">Waiting on you</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li><button className="linkish" onClick={() => go("calls")}>{drafts.calls} capital {drafts.calls === 1 ? "call" : "calls"} to approve</button>{data.bank.unmatched.length ? `, ${data.bank.unmatched.length} bank ${data.bank.unmatched.length === 1 ? "receipt" : "receipts"} to match` : ""}</li>
            <li><button className="linkish" onClick={() => go("distributions")}>{drafts.dists} {drafts.dists === 1 ? "distribution" : "distributions"} to approve{drafts.toPay ? `, ${drafts.toPay} to record as paid` : ""}</button></li>
            <li><button className="linkish" onClick={() => go("reports")}>{drafts.reports} {drafts.reports === 1 ? "report" : "reports"} to approve</button></li>
          </ul>
          {next.length > 0 && (
            <>
              <h3>Next deadlines</h3>
              <ul className="timeline small">
                {next.map((d) => <li key={d.key}><span>{longDate(d.due)}</span><span>{d.title}{d.state === "overdue" && <> <span className="pill bad">Overdue</span></>}</span></li>)}
              </ul>
            </>
          )}
        </section>
        <section className="panel panel-pad section" aria-labelledby="carry-h">
          <h2 id="carry-h">Carried interest</h2>
          <dl className="kv">
            <dt>Earned at today's values</dt><dd>{usd(c.entitled)}</dd>
            <dt>Paid</dt><dd>{usd(c.paid)}</dd>
            <dt>Accrued, not paid</dt><dd>{usd(Math.max(0, c.accrued))}</dd>
            <dt>Clawback exposure</dt><dd>{c.clawbackExposure > 0 ? <span className="pill bad">{usd(c.clawbackExposure)}</span> : "None"}</dd>
          </dl>
          <p className="small muted" style={{ margin: 0 }}>What a sale of every holding at its approved mark would pay the general partner. Waterfall: {data.labels.waterfalls[data.fund.terms.waterfall]}. ILPA asks that clawback exposure be disclosed each period.</p>
        </section>
      </div>

      <Terms data={data} onChange={onChange} editable={can("decide_deals")} />

      <section className="panel panel-pad section" aria-labelledby="src-h">
        <h2 id="src-h">Connected sources</h2>
        <ul className="timeline small">
          {data.sources.map((x) => (
            <li key={x.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span><strong>{x.name}</strong><br /><span className="muted">{x.summary}</span></span>
              <span><span className={`pill ${x.ready ? "good" : "outline"}`}>{x.manual ? "Upload" : x.ready ? "Connected" : "Not connected"}</span></span>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ margin: 0 }}>Connect Mercury and your mailbox once in <Link to="/connections">Connections</Link>. VC OS reads the bank and drafts notices; it never moves money or sends.</p>
      </section>
    </>
  );
}

function Terms({ data, onChange, editable }: LpTabProps & { editable: boolean }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [t, setT] = useState<FundTermsView>(data.fund.terms);
  const [err, setErr] = useState<string | null>(null);
  const L = data.labels;
  const save = async () => {
    setErr(null);
    try {
      await api(`/lp/funds/${data.fund.id}/terms`, { method: "PUT", body: t });
      toast("good", "Terms saved.");
      setEdit(false);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const f = data.fund.terms;
  if (!edit) {
    return (
      <section className="panel panel-pad section" aria-labelledby="terms-h">
        <div className="spread"><h2 id="terms-h">Terms</h2>{editable && <button className="btn small" onClick={() => setEdit(true)}>Edit terms</button>}</div>
        <dl className="kv">
          <dt>Management fee</dt><dd>{f.managementFeePct}% a year on commitments through {longDate(f.investmentPeriodEnd)}, then {f.feeStepDownPct ?? f.managementFeePct}% on {L.feeBasis[f.feeBasisAfterPeriod]?.toLowerCase()}</dd>
          <dt>Carried interest</dt><dd>{f.carryPct}%{f.hurdlePct ? `, over a ${f.hurdlePct}% preferred return with a ${f.catchUpPct}% catch-up` : ", no preferred return"}</dd>
          <dt>Waterfall</dt><dd>{L.waterfalls[f.waterfall]}{f.escrowPct ? `, ${f.escrowPct}% of carry held in escrow` : ""}</dd>
          {f.gpCommitmentPct !== undefined && <><dt>GP commitment</dt><dd>{f.gpCommitmentPct}%</dd></>}
        </dl>
      </section>
    );
  }
  const n = (k: keyof FundTermsView, label: string, hint?: string) => (
    <Field label={label} hint={hint}><NumberInput id={`t-${k}`} value={t[k] as number | undefined} onChange={(v) => setT({ ...t, [k]: v })} suffix="%" /></Field>
  );
  return (
    <form className="panel panel-pad section" aria-labelledby="terms-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="terms-h">Terms</h2>
      <p className="small muted" style={{ margin: 0 }}>As the LPA sets them. Changing them changes every calculation from here on; approved reports keep the numbers they were approved with.</p>
      <div className="form-grid">
        {n("managementFeePct", "Management fee", "During the investment period, on commitments")}
        <Field label="Investment period ends" required><input className="input" type="date" required value={t.investmentPeriodEnd} onChange={(e) => setT({ ...t, investmentPeriodEnd: e.target.value })} /></Field>
        {n("feeStepDownPct", "Fee after the investment period")}
        <Field label="Charged on, after the investment period"><Select id="t-basis" value={t.feeBasisAfterPeriod} onChange={(v) => setT({ ...t, feeBasisAfterPeriod: v ?? "committed" })} options={Object.entries(L.feeBasis).map(([id, label]) => ({ id: id as FundTermsView["feeBasisAfterPeriod"], label }))} /></Field>
        {n("carryPct", "Carried interest")}
        {n("hurdlePct", "Preferred return (hurdle)", "0 for none, common in venture")}
        {n("catchUpPct", "GP catch-up", "100 for a full catch-up")}
        <Field label="Waterfall"><Select id="t-wf" value={t.waterfall} onChange={(v) => setT({ ...t, waterfall: v ?? "european" })} options={Object.entries(L.waterfalls).map(([id, label]) => ({ id: id as FundTermsView["waterfall"], label }))} /></Field>
        {n("escrowPct", "Carry held in escrow", "ILPA: at least 30% for deal by deal")}
        {n("gpCommitmentPct", "GP commitment")}
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Save terms</button><button type="button" className="btn ghost" onClick={() => { setT(data.fund.terms); setEdit(false); }}>Cancel</button></div>
    </form>
  );
}
