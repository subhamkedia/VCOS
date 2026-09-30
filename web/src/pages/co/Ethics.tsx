import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, NumberInput, Notice, Select, useConfirm } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";
import { Decide, REQ_TONE } from "./Decide";

/** Rule 204A-1: the restricted list, holdings and transaction reports, and pre-clearance of IPOs and private placements. */
export default function Ethics({ data, onChange }: CoTabProps) {
  return (
    <>
      <Restricted data={data} onChange={onChange} />
      <Preclearance data={data} onChange={onChange} />
      <Reports data={data} onChange={onChange} />
    </>
  );
}

function Restricted({ data, onChange }: CoTabProps) {
  const { can } = useSession();
  const confirm = useConfirm();
  const run = useRun(onChange);
  const [f, setF] = useState({ name: "", ticker: "", reason: "" });
  const current = data.restricted.filter((r) => !r.removed_on);
  const remove = async (id: string, name: string) => {
    if (!(await confirm({ title: `Take ${name} off the restricted list?`, body: "Personal trading in it will no longer be flagged. The entry stays on record.", confirm: "Remove", danger: true }))) return;
    await run(() => api(`/compliance/restricted/${id}/remove`, { body: {} }), "Removed.");
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="rl-h">
      <h2 id="rl-h">Restricted list</h2>
      <p className="small muted" style={{ margin: 0 }}>Securities where the firm may hold material nonpublic information. Pre-clearance requests are checked against it.</p>
      {current.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing restricted.</p> : (
        <ul className="timeline small">
          {current.map((r) => (
            <li key={r.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span><strong>{r.name}</strong>{r.ticker ? ` (${r.ticker})` : ""}: {r.reason} <span className="muted">since {longDate(r.added_on)}, added by {person(r.added_by)}</span></span>
              {can("decide_deals") && <button className="btn small ghost" onClick={() => void remove(r.id, r.name)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {can("decide_deals") && data.restrictedSuggestions.length > 0 && (
        <>
          <h3>Consider adding</h3>
          <ul className="timeline small">
            {data.restrictedSuggestions.map((s) => (
              <li key={s.companyId} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><strong>{s.name}</strong>: {s.reason}</span>
                <button className="btn small ghost" onClick={() => void run(() => api("/compliance/restricted", { body: { companyId: s.companyId, reason: s.reason } }), `${s.name} added.`)}>Add</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {can("decide_deals") && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/compliance/restricted", { body: f }); setF({ name: "", ticker: "", reason: "" }); }, "Added."); }}>
          <Field label="Company or security" required><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Ticker"><input className="input" value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value })} /></Field>
          <Field label="Why" required><input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <div className="row" style={{ alignSelf: "end" }}><button className="btn">Add to the list</button></div>
        </form>
      )}
    </section>
  );
}

function Preclearance({ data, onChange }: CoTabProps) {
  const run = useRun(onChange);
  const L = data.labels;
  const [f, setF] = useState<{ kind?: string; security: string; ticker: string; amountUsd?: number; reason: string }>({ security: "", ticker: "", reason: "" });
  return (
    <section className="panel panel-pad section" aria-labelledby="pc-h">
      <h2 id="pc-h">Pre-clearance</h2>
      <p className="small muted" style={{ margin: 0 }}>Ask before buying into an IPO or a private placement (the rule requires it) or a listed security. Someone else decides.</p>
      {data.preclearances.length > 0 && (
        <ul className="timeline small">
          {data.preclearances.map((r) => (
            <li key={r.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span>
                <strong>{r.security}</strong>{r.ticker ? ` (${r.ticker})` : ""} · {L.preclearanceKinds[r.kind]}{r.amount_usd ? ` · $${r.amount_usd.toLocaleString()}` : ""} <span className="muted">for {person(r.person)}, {longDate(r.created_at)}</span>
                {r.restricted_hit && <> <span className="pill bad">On the restricted list</span></>}
                {r.note && <><br /><span className="muted">{person(r.decided_by)}: {r.note}</span></>}
              </span>
              {r.status === "pending" && data.reviewer && r.person !== data.person
                ? <Decide path={`/compliance/preclearances/${r.id}/decide`} who={r.person} what="pre-clearance" noteToApprove={r.restricted_hit ? "It's on the restricted list: why approve anyway?" : undefined} onChange={onChange} />
                : <span className={`pill ${REQ_TONE[r.status]}`}>{L.requestStatus[r.status]}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/compliance/preclearances", { body: f }); setF({ security: "", ticker: "", reason: "" }); }, "Requested. You'll see the decision here."); }}>
        <Field label="What" required><Select id="pc-kind" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={Object.entries(L.preclearanceKinds).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Security" required><input className="input" required value={f.security} onChange={(e) => setF({ ...f, security: e.target.value })} /></Field>
        <Field label="Ticker"><input className="input" value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value })} /></Field>
        <Field label="Amount"><NumberInput id="pc-amt" prefix="$" value={f.amountUsd} onChange={(v) => setF({ ...f, amountUsd: v })} /></Field>
        <Field label="Why"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <div className="row" style={{ alignSelf: "end" }}><button className="btn" disabled={!f.kind}>Ask for pre-clearance</button></div>
      </form>
    </section>
  );
}

interface Line { security: string; ticker: string; action: string; quantity: string; tradedOn: string; account: string }
const LINE: Line = { security: "", ticker: "", action: "buy", quantity: "", tradedOn: "", account: "" };

function Reports({ data, onChange }: CoTabProps) {
  const run = useRun(onChange);
  const L = data.labels;
  const [kind, setKind] = useState<string | undefined>();
  const [period, setPeriod] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...LINE }]);
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const submit = () => run(async () => {
    await api("/compliance/reports", { body: { kind, period: period || undefined, items: kind === "no_activity" ? [] : lines.filter((l) => l.security.trim()) } });
    setLines([{ ...LINE }]);
    setPeriod("");
  }, "Report filed.");
  const byPeriod = new Map<string, typeof data.reports>();
  for (const r of data.reports) byPeriod.set(`${r.person}|${r.period}`, [...(byPeriod.get(`${r.person}|${r.period}`) ?? []), r]);
  return (
    <section className="panel panel-pad section" aria-labelledby="rp-h">
      <h2 id="rp-h">{data.reviewer ? "Holdings and transaction reports" : "Your holdings and transaction reports"}</h2>
      <p className="small muted" style={{ margin: 0 }}>Holdings within 10 days of joining and every year; transactions within 30 days of each quarter's end. Reports are private: only you and the reviewers see them.</p>
      {byPeriod.size === 0 ? <Notice>No reports filed yet.</Notice> : (
        <ul className="timeline small">
          {[...byPeriod.entries()].map(([k, rs]) => (
            <li key={k}>
              <span>{rs[0]!.period}</span>
              <span>{data.reviewer && <strong>{person(rs[0]!.person)}: </strong>}{rs.map((r) => r.kind === "no_activity" ? L.reportKinds.no_activity : `${r.action && r.action !== "hold" ? `${r.action} ` : ""}${r.quantity ?? ""} ${r.security}${r.ticker ? ` (${r.ticker})` : ""}${r.traded_on ? ` on ${longDate(r.traded_on)}` : ""}`).join("; ")}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="section" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h3>File a report</h3>
        <div className="form-grid">
          <Field label="Report" required><Select id="rp-kind" value={kind} onChange={setKind} options={[{ id: "holding", label: "Holdings (initial or annual)" }, { id: "transaction", label: "Quarterly transactions" }, { id: "no_activity", label: "No reportable activity this quarter" }]} /></Field>
          <Field label="Period" hint={kind === "holding" ? "The year, e.g. 2026" : "The quarter, e.g. 2026-Q3"}><input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder={kind === "holding" ? "2026" : "2026-Q3"} /></Field>
        </div>
        {kind && kind !== "no_activity" && lines.map((l, i) => (
          <fieldset key={i} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">Security {i + 1}</legend>
            <Field label="Security" required={i === 0}><input className="input" value={l.security} onChange={(e) => set(i, "security", e.target.value)} required={i === 0} /></Field>
            <Field label="Ticker"><input className="input" value={l.ticker} onChange={(e) => set(i, "ticker", e.target.value)} /></Field>
            {kind === "transaction" && <Field label="Bought or sold"><Select id={`rp-a-${i}`} value={l.action} onChange={(v) => set(i, "action", v ?? "buy")} options={[{ id: "buy", label: "Bought" }, { id: "sell", label: "Sold" }, { id: "other", label: "Other" }]} /></Field>}
            <Field label={kind === "holding" ? "Shares or principal" : "Quantity"}><input className="input" inputMode="decimal" value={l.quantity} onChange={(e) => set(i, "quantity", e.target.value)} /></Field>
            {kind === "transaction" && <Field label="Trade date" required><input className="input" type="date" value={l.tradedOn} onChange={(e) => set(i, "tradedOn", e.target.value)} required={Boolean(l.security)} /></Field>}
            <Field label="Account"><input className="input" value={l.account} onChange={(e) => set(i, "account", e.target.value)} /></Field>
          </fieldset>
        ))}
        <div className="row">
          {kind && kind !== "no_activity" && <button type="button" className="btn ghost" onClick={() => setLines([...lines, { ...LINE }])}>Add a line</button>}
          <button className="btn primary" disabled={!kind}>File report</button>
        </div>
      </form>
    </section>
  );
}
