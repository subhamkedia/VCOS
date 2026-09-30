import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { ClosingRow, ClosingView } from "../../types";
import { ErrorState, Field, Loading, Notice, useConfirm, useToast, usd } from "../../ui";
import type { FrTabProps } from "../Raise";
import { STATUS_TONE, acct, longDate, person } from "../lp/shared";

/**
 * Closings. A closing admits accepted investors into the fund's register in
 * LP Reporting; at a later closing, newcomers pay in their share of earlier
 * calls with interest and earlier investors get their excess back.
 */
export default function Closings({ data, onChange }: FrTabProps) {
  const { can } = useSession();
  const [open, setOpen] = useState<string | null>(data.closings.find((c) => c.status === "draft")?.id ?? null);
  return (
    <>
      {can("work_deals") && <Draft data={data} onChange={onChange} onDone={setOpen} />}
      <section className="panel panel-pad section" aria-labelledby="cl-h">
        <h2 id="cl-h">Closings</h2>
        {data.closings.length === 0 ? <Notice>No closings yet.</Notice> : (
          <ul className="timeline small">
            {data.closings.map((c) => (
              <li key={c.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><button className="linkish" aria-pressed={open === c.id} onClick={() => setOpen(c.id)}><strong>Closing {c.number}</strong>, {longDate(c.closing_date)}</button><br /><span className="muted">Prepared by {person(c.created_by)}{c.approved_by ? `, approved by ${person(c.approved_by)}` : ""}</span></span>
                <span><span className={`pill ${STATUS_TONE[c.status]}`}>{data.labels.closingStatus[c.status]}</span></span>
              </li>
            ))}
          </ul>
        )}
        {data.raise.fund_id && <p className="small" style={{ margin: 0 }}>Admitted investors are in <Link to={`/lp-reporting/${data.raise.fund_id}?tab=investors`}>LP Reporting</Link>.</p>}
      </section>
      {open && data.closings.some((c) => c.id === open) && <Detail key={open} row={data.closings.find((c) => c.id === open)!} data={data} onChange={onChange} />}
    </>
  );
}

function Draft({ data, onChange, onDone }: FrTabProps & { onDone: (id: string) => void }) {
  const toast = useToast();
  const ready = data.subscriptions.filter((s) => s.status === "accepted" && !s.closing_id);
  const [pick, setPick] = useState<Set<string>>(new Set(ready.map((s) => s.id)));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  if (!ready.length) return <Notice>Accepted subscriptions appear here, ready to be admitted at a closing.</Notice>;
  const submit = async () => {
    try {
      const r = await api<{ closing: ClosingRow; blocked: boolean }>(`/fundraising/raises/${data.raise.id}/closings`, { body: { closingDate: date, subscriptionIds: [...pick] } });
      toast(r.blocked ? "bad" : "good", r.blocked ? "Drafted, but something blocks it: see the checks." : "Drafted. A partner who didn't prepare it approves it.");
      onDone(r.closing.id);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="dc-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="dc-h">Prepare a closing</h2>
      <Field label="Closing date" required><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <fieldset className="section" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="small">Investors to admit</legend>
        {ready.map((s) => (
          <label key={s.id} className="row small"><input type="checkbox" checked={pick.has(s.id)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(s.id); else n.delete(s.id); setPick(n); }} /> {s.investor_name}, {usd(s.commitment_usd)}</label>
        ))}
      </fieldset>
      <div className="row"><button className="btn primary" disabled={!pick.size}>Draft closing</button></div>
    </form>
  );
}

function Detail({ row, data, onChange }: FrTabProps & { row: ClosingRow }) {
  const { can, me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = `human:${me.user.email.toLowerCase()}`;
  const { data: v, error, reload } = useApi<ClosingView>(`/fundraising/closings/${row.id}`);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!v) return <Loading what="Loading the closing" />;
  const approve = async () => {
    if (!(await confirm({ title: `Approve closing ${row.number}?`, body: `${v.investors.length} investors are admitted to the fund's register${v.equalization.length ? ", equalization is recorded" : ""}, and notices are drafted for review.`, confirm: "Approve closing" }))) return;
    try {
      const r = await api<{ formDDueOn: string | null; notices: { queued: number } }>(`/fundraising/closings/${row.id}/approve`, { body: {} });
      toast("good", `Closed.${r.formDDueOn ? ` Form D is due by ${longDate(r.formDDueOn)}.` : ""}${r.notices.queued ? ` ${r.notices.queued} notices wait in Approvals.` : ""}`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const cancel = async () => {
    if (!(await confirm({ title: `Cancel closing ${row.number}?`, body: "Its investors go back to accepted.", confirm: "Cancel closing", danger: true }))) return;
    try {
      await api(`/fundraising/closings/${row.id}/cancel`, { body: {} });
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const settle = async (id: string) => {
    try {
      await api(`/fundraising/equalization/${id}/settle`, { body: {} });
      toast("good", "Recorded as settled.");
      void reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="cd-h">
      <div className="spread">
        <h2 id="cd-h">Closing {row.number}, {longDate(row.closing_date)}</h2>
        {row.status === "draft" && (
          <div className="row">
            {can("decide_deals") && row.created_by !== self && <button className="btn small primary" disabled={v.blocked} onClick={() => void approve()}>Approve closing</button>}
            {row.created_by === self && <span className="small muted">Another partner approves it</span>}
            {can("decide_deals") && <button className="btn small ghost" onClick={() => void cancel()}>Cancel</button>}
          </div>
        )}
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{v.investors.map((i) => <li key={i.id}>{i.name}: {usd(i.commitment)}</li>)}</ul>
      {row.status === "draft" && (
        v.issues.length || v.perInvestor.some((p) => p.open.length) ? (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {v.issues.map((i, k) => <li key={k} style={{ color: i.severity === "block" ? "var(--bad)" : "var(--warn)" }}>{i.message}</li>)}
            {v.perInvestor.filter((p) => p.open.length).map((p) => <li key={p.subscriptionId} style={{ color: "var(--bad)" }}>{p.investor}: {p.open.join("; ")}</li>)}
          </ul>
        ) : <Notice tone="good">Every check passes: hard cap, investor count, qualification, verification, KYC, sanctions and signatures.</Notice>
      )}
      {v.equalization.length > 0 && (
        <>
          <h3>Equalization</h3>
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Equalization</caption>
              <thead><tr><th scope="col">Partner</th><th scope="col" className="num">Capital</th><th scope="col" className="num">Fee</th><th scope="col" className="num">Interest</th><th scope="col"><span className="sr-only">Settled</span></th></tr></thead>
              <tbody>
                {v.equalization.map((e, i) => (
                  <tr key={e.id ?? i}>
                    <th scope="row">{e.partner_name}</th><td className="num">{acct(e.capital_usd)}</td><td className="num">{acct(e.fee_usd)}</td><td className="num">{acct(e.interest_usd)}</td>
                    <td className="small">{e.settled_on ? `Settled ${longDate(e.settled_on)}` : e.id && can("work_deals") ? <button className="btn small ghost" onClick={() => void settle(e.id!)}>Mark settled</button> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Positive: paid by the partner. In parentheses: returned to it. Capital returned to an earlier investor can be called again; interest is at the LPA's {data.raise.equalization_rate_pct}%.</p>
        </>
      )}
    </section>
  );
}
