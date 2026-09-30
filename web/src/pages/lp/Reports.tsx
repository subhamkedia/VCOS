import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { LpReport, LpReportRow, ReportSnapshot } from "../../types";
import { ErrorState, Field, Loading, Notice, useConfirm, useToast, usd } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { LetterView, NetAndGross, STATUS_TONE, StatementTable, acct, longDate, person, quarterLabel, x2 } from "./shared";

/**
 * Quarterly reports. Preparing one snapshots the quarter's numbers (from
 * code) and drafts a letter whose every factual sentence cites the books or
 * a public source. A partner who didn't prepare it approves it; then it's
 * final, investors can read it through their private links, and the
 * notices are drafted for someone to send.
 */
export default function Reports({ data, onChange }: LpTabProps) {
  const { can } = useSession();
  const [open, setOpen] = useState<string | null>(data.reports[0]?.id ?? null);
  return (
    <>
      {can("work_deals") && <Prepare data={data} onChange={onChange} onDone={setOpen} />}
      <section className="panel panel-pad section" aria-labelledby="rl-h">
        <h2 id="rl-h">Reports</h2>
        {data.reports.length === 0 ? <Notice>No reports yet. ILPA asks for quarterly reports within 45 days of quarter end, and the annual one within 90.</Notice> : (
          <ul className="timeline small">
            {data.reports.map((r) => (
              <li key={r.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span>
                  <button className="linkish" aria-pressed={open === r.id} onClick={() => setOpen(r.id)}><strong>{quarterLabel(r.period)}</strong>, version {r.version}</button>
                  <br /><span className="muted">Prepared by {person(r.prepared_by)}{r.approved_by ? `, approved by ${person(r.approved_by)}` : ""}</span>
                </span>
                <span><span className={`pill ${STATUS_TONE[r.status]}`}>{data.labels.reportStatus[r.status]}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {open && data.reports.some((r) => r.id === open) && <ReportView key={open} row={data.reports.find((r) => r.id === open)!} data={data} onChange={onChange} />}
    </>
  );
}

function Prepare({ data, onChange, onDone }: LpTabProps & { onDone: (id: string) => void }) {
  const toast = useToast();
  const [period, setPeriod] = useState(data.suggestedPeriod);
  const [commentary, setCommentary] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<LpReportRow>(`/lp/funds/${data.fund.id}/reports`, { body: { period, commentary } });
      toast("good", `${quarterLabel(r.period)} report prepared (version ${r.version}). A partner who didn't prepare it approves it.`);
      onDone(r.id);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="pr-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="pr-h">Prepare a quarterly report</h2>
      <div className="form-grid">
        <Field label="Quarter" required hint="Like 2026-Q2"><input className="input" required pattern="\d{4}-Q[1-4]" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
      </div>
      <Field label="Commentary from the general partner" hint="Labeled as opinion in the letter. Any figure you state must match the report's numbers, or it's rejected.">
        <textarea className="input" rows={4} value={commentary} onChange={(e) => setCommentary(e.target.value)} />
      </Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? "Preparing…" : "Prepare report"}</button></div>
    </form>
  );
}

function ReportView({ row, data, onChange }: LpTabProps & { row: LpReportRow }) {
  const { can, me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = `human:${me.user.email.toLowerCase()}`;
  const { data: r, error, reload } = useApi<LpReport>(`/lp/reports/${row.id}`);
  const [who, setWho] = useState<string>("");
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!r) return <Loading what="Loading the report" />;
  const s: ReportSnapshot = r.snapshot;
  const act = async (what: "approve" | "withdraw" | "notices") => {
    const q = {
      approve: { title: `Approve the ${quarterLabel(r.period)} report?`, body: "It becomes final: investors can read it through their private links, and nothing in it can change. A correction is a new version.", confirm: "Approve" },
      withdraw: { title: `Withdraw version ${r.version}?`, body: "Investors stop seeing it. It stays on record as withdrawn.", confirm: "Withdraw", danger: true },
      notices: { title: "Draft a notice to each investor?", body: "Each gets a new private link to its statement, in an email drafted in your mailbox for someone to review and send.", confirm: "Draft notices" },
    }[what];
    if (!(await confirm(q))) return;
    try {
      const out = await api<{ queued?: number; noEmail?: string[] }>(`/lp/reports/${r.id}/${what}`, { body: {} });
      toast("good", what === "notices" ? `${out.queued} notices are waiting in Approvals.${out.noEmail?.length ? ` No email for ${out.noEmail.join(", ")}.` : ""}` : what === "approve" ? "Approved. The report is final." : "Withdrawn.");
      onChange();
      void reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const one = s.statements.find((x) => x.partnerId === who);
  const fe = s.feesExpenses;
  const exp = (k: "capital-accounts" | "fees-expenses" | "performance" | "investments", label: string) => <a className="btn small" href={`/api/lp/reports/${r.id}/export/${k}.csv`} download>{label}</a>;
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="rv-h">
        <div className="spread">
          <h2 id="rv-h">{r.letter.title} <span className={`pill ${STATUS_TONE[r.status]}`}>{data.labels.reportStatus[r.status]}</span></h2>
          <div className="row">
            {r.status === "draft" && can("decide_deals") && r.prepared_by !== self && <button className="btn small primary" onClick={() => void act("approve")}>Approve</button>}
            {r.status === "draft" && r.prepared_by === self && <span className="small muted">Another partner approves</span>}
            {r.status === "approved" && can("queue") && <button className="btn small" onClick={() => void act("notices")}>Draft investor notices</button>}
            {r.status !== "withdrawn" && can("decide_deals") && <button className="btn small ghost" onClick={() => void act("withdraw")}>Withdraw</button>}
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>As of {longDate(s.asOf)} · {r.letter.check.facts} factual sentences, every one cited ({r.letter.check.citations} citations)</p>
        <LetterView letter={r.letter} />
      </section>

      <section className="panel panel-pad section" aria-labelledby="rp-h">
        <h2 id="rp-h">Performance</h2>
        <NetAndGross net={s.performance.net} gross={s.performance.gross} note={s.performance.marketingNote} />
        <div className="row">{exp("performance", "Cash flows and returns (CSV)")}</div>
      </section>

      <section className="panel panel-pad section" aria-labelledby="rs-h">
        <h2 id="rs-h">Schedule of investments</h2>
        <div className="table-wrap">
          <table className="t">
            <caption className="sr-only">Schedule of investments</caption>
            <thead><tr><th scope="col">Company</th><th scope="col">First invested</th><th scope="col" className="num">Cost</th><th scope="col" className="num">Realized</th><th scope="col" className="num">Fair value</th><th scope="col" className="num">Multiple</th><th scope="col">Valuation basis</th></tr></thead>
            <tbody>
              {s.schedule.map((x) => (
                <tr key={x.companyId}><th scope="row">{x.company}</th><td className="small">{longDate(x.firstInvested)}</td><td className="num">{usd(x.cost)}</td><td className="num">{usd(x.realized)}</td><td className="num">{usd(x.fairValue)}</td><td className="num">{x2(x.moic)}</td><td className="small">{x.basis}{x.markDate ? `, ${longDate(x.markDate)}` : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">{exp("investments", "Schedule (CSV)")}</div>
      </section>

      <section className="panel panel-pad section" aria-labelledby="rf-h">
        <h2 id="rf-h">Fees, expenses and carried interest</h2>
        <div className="table-wrap">
          <table className="t">
            <caption className="sr-only">Fees, expenses and carried interest</caption>
            <thead><tr><th scope="col">Line</th><th scope="col" className="num">Quarter</th><th scope="col" className="num">Year to date</th><th scope="col" className="num">Inception to date</th></tr></thead>
            <tbody>
              <tr><th scope="row">Management fees, gross</th><td className="num">{usd(fe.managementFees.quarter.gross)}</td><td className="num">{usd(fe.managementFees.year.gross)}</td><td className="num">{usd(fe.managementFees.inception.gross)}</td></tr>
              <tr><th scope="row">Fee offsets</th><td className="num">{acct(-fe.managementFees.quarter.offsets)}</td><td className="num">{acct(-fe.managementFees.year.offsets)}</td><td className="num">{acct(-fe.managementFees.inception.offsets)}</td></tr>
              <tr className="total"><th scope="row">Management fees, net</th><td className="num">{usd(fe.managementFees.quarter.net)}</td><td className="num">{usd(fe.managementFees.year.net)}</td><td className="num">{usd(fe.managementFees.inception.net)}</td></tr>
              {fe.expenses.filter((e) => e.inception).map((e) => <tr key={e.category}><th scope="row">{e.label}</th><td className="num">{usd(e.quarter)}</td><td className="num">{usd(e.year)}</td><td className="num">{usd(e.inception)}</td></tr>)}
              <tr><th scope="row">Carried interest paid</th><td className="num">{usd(fe.carry.paidQuarter)}</td><td className="num">{usd(fe.carry.paidYear)}</td><td className="num">{usd(fe.carry.paidInception)}</td></tr>
              <tr><th scope="row">Carried interest accrued, not paid</th><td /><td /><td className="num">{usd(Math.max(0, fe.carry.accrued))}</td></tr>
              {fe.carry.escrowInception > 0 && <tr><th scope="row">Carried interest in escrow</th><td /><td /><td className="num">{usd(fe.carry.escrowInception)}</td></tr>}
              {fe.carry.clawbackExposure > 0 && <tr><th scope="row">Clawback exposure</th><td /><td /><td className="num">{usd(fe.carry.clawbackExposure)}</td></tr>}
            </tbody>
          </table>
        </div>
        {fe.managementFees.offsetsUnapplied > 0 && <p className="small" style={{ margin: 0 }}>{usd(fe.managementFees.offsetsUnapplied)} of fees the GP received from portfolio companies will reduce the next management fee.</p>}
        {fe.relatedParty.length > 0 && (
          <>
            <h3>Related-party charges this year</h3>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{fe.relatedParty.map((x, i) => <li key={i}>{longDate(x.date)}: {x.description} ({x.category}), {usd(x.amount)}</li>)}</ul>
          </>
        )}
        <div className="row">{exp("fees-expenses", "Fees and expenses (CSV)")}</div>
      </section>

      <section className="panel panel-pad section" aria-labelledby="rc-h">
        <div className="spread">
          <h2 id="rc-h">Capital accounts</h2>
          <label className="small">
            <span className="sr-only">Whose account</span>
            <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">All partners</option>
              {s.statements.map((x) => <option key={x.partnerId} value={x.partnerId}>{x.name}</option>)}
            </select>
          </label>
        </div>
        <StatementTable caption={one ? `${one.name}'s capital account` : "All partners' capital accounts"} s={one ?? s.total} />
        <div className="row">{exp("capital-accounts", "Every investor's statement (CSV)")}</div>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>
    </>
  );
}
