import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, MoneyInput, Notice, NumberInput, Seg, Select, dateOnly, useConfirm, useToast, usd } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { person } from "./shared";

const DECISION_LABEL: Record<string, string> = { invest: "Invested", partial: "Invested less than pro rata", pass: "Passed" };
const REAL_LABEL: Record<string, string> = { sale: "Sale", partial_sale: "Partial sale", distribution: "Distribution", dividend: "Dividend", write_off: "Write-off" };

/**
 * Our checks, the reserve set aside for this company, follow-on decisions
 * (each one re-underwritten, with its reason) and money back.
 */
export default function Capital({ data, onChange }: PfTabProps) {
  const { can } = useSession();
  return (
    <>
      <section className="panel table-wrap" aria-labelledby="inv-h">
        <h2 id="inv-h" className="panel-pad" style={{ paddingBottom: 0 }}>Checks</h2>
        <table className="t">
          <caption className="sr-only">Our investments in the company</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Round</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Ownership</th><th scope="col">Kind</th></tr></thead>
          <tbody>
            {data.investments.map((i) => (
              <tr key={i.id}>
                <td>{dateOnly(i.close_date)}</td><td>{i.series_name ?? i.security}</td><td className="num">{usd(i.amount_usd)}</td>
                <td className="num">{i.shares ? Math.round(i.shares).toLocaleString("en-US") : "—"}</td><td className="num">{i.ownership_fd_pct !== null ? `${i.ownership_fd_pct.toFixed(2)}%` : "—"}</td>
                <td className="small">{i.round_kind === "follow_on" ? "Follow-on" : "Initial"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="res-h">
          <h2 id="res-h">Reserve</h2>
          <p className="small muted" style={{ margin: 0 }}>What the fund sets aside for this company's next rounds. A plan, not a promise: each follow-on is decided on its own merits.</p>
          {data.reservePlans[0] ? (
            <p style={{ margin: 0 }}><strong className="num">{usd(Number(data.reservePlans[0].value.amountUsd))}</strong> <span className="small muted">set by {person(data.reservePlans[0].actor)}, {dateOnly(data.reservePlans[0].created_at)}: {data.reservePlans[0].rationale}</span></p>
          ) : <Notice>No reserve set.</Notice>}
          {can("decide_deals") && data.valueBasis !== "exited" && <ReserveForm data={data} onChange={onChange} />}
        </section>
        <section className="panel panel-pad section" aria-labelledby="real-h">
          <h2 id="real-h">Money back</h2>
          {data.realizations.length ? (
            <ul className="timeline small">
              {data.realizations.map((r) => <li key={r.id}><span>{dateOnly(r.occurred_on)}</span><span><strong>{REAL_LABEL[r.kind] ?? r.kind}</strong> · {usd(r.amount_usd)}{r.note ? ` · ${r.note}` : ""}</span></li>)}
            </ul>
          ) : <Notice>Nothing returned yet.</Notice>}
          {can("decide_deals") && <RealizationForm data={data} onChange={onChange} />}
        </section>
      </div>

      <section className="panel panel-pad section" aria-labelledby="fo-h">
        <h2 id="fo-h">Follow-on decisions</h2>
        {data.followOns.length ? (
          <ul className="timeline small">
            {data.followOns.map((d) => (
              <li key={d.id}>
                <span>{dateOnly(String(d.value.roundDate))}</span>
                <span><strong>{String(d.value.round)}</strong>: {DECISION_LABEL[String(d.value.decision)]}{Number(d.value.amountUsd) ? ` ${usd(Number(d.value.amountUsd))}` : ""}{d.value.proRataUsd ? ` (pro rata ${usd(Number(d.value.proRataUsd))})` : ""} · {person(d.actor)}<br />{d.rationale}</span>
              </li>
            ))}
          </ul>
        ) : <Notice>No follow-on decisions yet.</Notice>}
        {can("decide_deals") && data.valueBasis !== "exited" && <FollowOnForm data={data} onChange={onChange} />}
      </section>
    </>
  );
}

function useSubmit(path: string, onChange: () => void, done: string) {
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const run = async (body: object, reset: () => void) => {
    setErr(null);
    try {
      await api(path, { body });
      toast("good", done);
      reset();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return { err, run };
}

function ReserveForm({ data, onChange }: PfTabProps) {
  const [amount, setAmount] = useState<number | undefined>();
  const [why, setWhy] = useState("");
  const { err, run } = useSubmit(`/portfolio/companies/${data.company.id}/reserve`, onChange, "Reserve recorded.");
  return (
    <form className="section" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void run({ amountUsd: amount, rationale: why }, () => { setAmount(undefined); setWhy(""); }); }}>
      <div className="form-grid">
        <Field label="Reserve" required><MoneyInput id="rs-amt" value={amount} onChange={setAmount} /></Field>
        <Field label="Why" required><input className="input" required minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="The round you expect and what it depends on" /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn">Set reserve</button></div>
    </form>
  );
}

function RealizationForm({ data, onChange }: PfTabProps) {
  const confirm = useConfirm();
  const [kind, setKind] = useState<string | undefined>();
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState<number | undefined>();
  const [note, setNote] = useState("");
  const { err, run } = useSubmit(`/portfolio/companies/${data.company.id}/realizations`, onChange, "Recorded.");
  return (
    <form className="section" style={{ gap: 8 }} onSubmit={async (e) => {
      e.preventDefault();
      if ((kind === "sale" || kind === "write_off") && !(await confirm({ title: kind === "sale" ? "Record the sale?" : "Write the position off?", body: "The position leaves the active portfolio. This record can't be edited; a correction is a new record.", confirm: "Record", danger: kind === "write_off" }))) return;
      void run({ kind, occurredOn: date, amountUsd: amount, note }, () => { setKind(undefined); setAmount(undefined); setNote(""); });
    }}>
      <div className="form-grid">
        <Field label="What happened" required><Select id="rl-kind" value={kind} onChange={setKind} options={Object.entries(REAL_LABEL).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Date" required><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {kind !== "write_off" && <Field label="Amount to the fund" required><MoneyInput id="rl-amt" value={amount} onChange={setAmount} /></Field>}
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn" disabled={!kind}>Record</button></div>
    </form>
  );
}

function FollowOnForm({ data, onChange }: PfTabProps) {
  const [decision, setDecision] = useState<"invest" | "partial" | "pass">("invest");
  const [f, setF] = useState<Record<string, number | undefined>>({});
  const [round, setRound] = useState("");
  const [date, setDate] = useState("");
  const [why, setWhy] = useState("");
  const [fund, setFund] = useState<string | undefined>(data.investments[0]?.fund_name);
  const { err, run } = useSubmit(`/portfolio/companies/${data.company.id}/follow-on`, onChange, "Decision recorded.");
  const m = (k: string, label: string) => <Field label={label}><MoneyInput id={`fo-${k}`} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} /></Field>;
  return (
    <form className="section" style={{ gap: 8, borderTop: "1px solid var(--line)", paddingTop: 12 }} onSubmit={(e) => { e.preventDefault(); void run({ decision, roundName: round, roundDate: date, rationale: why, fundName: fund, ...f }, () => { setF({}); setRound(""); setWhy(""); }); }}>
      <h3>Record a follow-on decision</h3>
      <Seg label="Decision" value={decision} onChange={setDecision} options={[{ id: "invest", label: "Invest pro rata or more" }, { id: "partial", label: "Invest less" }, { id: "pass", label: "Pass" }]} />
      <div className="form-grid">
        <Field label="Round" required><input className="input" required value={round} onChange={(e) => setRound(e.target.value)} placeholder="Series A Preferred" /></Field>
        <Field label="Closing date" required><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {decision !== "pass" && data.options.funds.length > 1 && <Field label="From fund" required><Select id="fo-fund" value={fund} onChange={setFund} options={data.options.funds.map((x) => ({ id: x, label: x }))} /></Field>}
        {decision !== "pass" && m("amountUsd", "Our check")}
        {m("proRataUsd", "Our pro rata")}
        {m("preMoneyUsd", "Pre-money")}
        {m("roundSizeUsd", "Round size")}
        {decision !== "pass" && <Field label="Shares"><NumberInput id="fo-shares" value={f.shares} onChange={(v) => setF({ ...f, shares: v })} /></Field>}
        {decision !== "pass" && <Field label="Ownership after" hint="Fully diluted"><NumberInput id="fo-own" value={f.ownershipPct} onChange={(v) => setF({ ...f, ownershipPct: v })} suffix="%" /></Field>}
      </div>
      <Field label="Why" required hint="Re-underwrite it like a new investment: conviction versus the price."><textarea className="input" required minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Record decision</button></div>
    </form>
  );
}
