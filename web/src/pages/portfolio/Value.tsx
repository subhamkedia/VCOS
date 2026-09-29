import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Mark } from "../../types";
import { Field, MoneyInput, Notice, NumberInput, Select, dateOnly, usePrompt, useToast, usd } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { person } from "./shared";

const STATUS_TONE: Record<Mark["status"], string> = { proposed: "info", approved: "good", rejected: "quiet" };
const STATUS_LABEL: Record<Mark["status"], string> = { proposed: "Waiting for review", approved: "Approved", rejected: "Rejected" };

const quarterEnd = () => {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 0)).toISOString().slice(0, 10); // last completed quarter end
};

/**
 * Fair value marks. One person prepares a mark with a method and a reason;
 * a partner who didn't prepare it approves it. Each mark shows its steps,
 * so it can be explained to auditors and LPs.
 */
export default function Value({ data, onChange }: PfTabProps) {
  const { can, me } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const self = `human:${me.user.email.toLowerCase()}`;
  const review = async (m: Mark, approve: boolean) => {
    let note: string | undefined;
    if (!approve) {
      const r = await prompt({ title: "Reject this mark?", label: "Why", confirm: "Reject", required: true, danger: true });
      if (!r) return;
      note = r;
    }
    try {
      await api(`/portfolio/marks/${m.id}/review`, { body: { approve, note } });
      toast("good", approve ? "Mark approved." : "Mark rejected.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      {can("work_deals") && data.valueBasis !== "exited" && <Propose data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="marks-h">
        <h2 id="marks-h">Marks</h2>
        {data.marks.length === 0 ? <Notice>No marks yet: the position is carried at cost. Record one at each quarter end.</Notice> : (
          <ul className="timeline">
            {data.marks.map((m) => (
              <li key={m.id} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span><strong className="num">{usd(m.fair_value_usd)}</strong> at {dateOnly(m.as_of)} · {data.methods[m.method] ?? m.method}</span>
                  <span className={`pill ${STATUS_TONE[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                </div>
                <ol className="small" style={{ margin: "6px 0", paddingLeft: 18 }}>{m.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                <p className="small" style={{ margin: 0 }}><strong>Why:</strong> {m.rationale}</p>
                {m.warnings.length > 0 && <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--warn)" }}>{m.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                <p className="small muted" style={{ margin: "6px 0 0" }}>
                  Prepared by {person(m.prepared_by)}{m.reviewed_by ? ` · ${m.status} by ${person(m.reviewed_by)}${m.review_note ? `: ${m.review_note}` : ""}` : ""}
                </p>
                {m.status === "proposed" && can("decide_deals") && m.prepared_by !== self && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn small primary" onClick={() => void review(m, true)}>Approve</button>
                    <button className="btn small ghost" onClick={() => void review(m, false)}>Reject</button>
                  </div>
                )}
                {m.status === "proposed" && m.prepared_by === self && <p className="small muted" style={{ margin: "6px 0 0" }}>Another partner reviews it.</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type Method = "recent_round" | "milestone" | "revenue_multiple" | "exit" | "write_off" | "cost";

const HELP: Record<Method, string> = {
  recent_round: "Our shares at the price of an arm's-length round. Not a default: adjust for what's changed since, and check it if the round is more than a year old.",
  milestone: "The last mark moved for progress against the milestones the round was priced on (early-stage companies without revenue).",
  revenue_multiple: "ARR (or monthly revenue x 12) from the ledger, times a multiple from comparable companies, plus cash less debt. Preferences are applied when the cap table is on record.",
  exit: "Proceeds due to the fund from a sale.",
  write_off: "The company has failed or the position is worthless.",
  cost: "Only close to the investment date, when nothing material has changed.",
};

function Propose({ data, onChange }: PfTabProps) {
  const toast = useToast();
  const [method, setMethod] = useState<Method | undefined>();
  const [asOf, setAsOf] = useState(quarterEnd());
  const [f, setF] = useState<Record<string, number | undefined>>({});
  const [roundDate, setRoundDate] = useState("");
  const [why, setWhy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const num = (k: string, label: string, suffix?: string, hint?: string) => (
    <Field label={label} hint={hint}><NumberInput id={`mk-${k}`} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} suffix={suffix} /></Field>
  );
  const money = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}><MoneyInput id={`mk-${k}`} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} /></Field>
  );
  const submit = async () => {
    setErr(null);
    try {
      await api(`/portfolio/companies/${data.company.id}/marks`, { body: { method, asOf, roundDate: roundDate || undefined, rationale: why, ...f } });
      toast("good", "Mark proposed. Another partner reviews it.");
      setWhy("");
      setF({});
      setMethod(undefined);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const priorShares = data.investments.reduce((a, i) => a + (i.shares ?? 0), 0);
  return (
    <form className="panel panel-pad section" aria-labelledby="prop-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="prop-h">Propose a mark</h2>
      <div className="form-grid">
        <Field label="Measurement date" required><input className="input" type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label="Method" required><Select id="mk-method" value={method} onChange={setMethod} options={(Object.keys(HELP) as Method[]).map((id) => ({ id, label: data.methods[id] ?? id }))} /></Field>
      </div>
      {method && <p className="small muted" style={{ margin: 0 }}>{HELP[method]}</p>}
      {method === "recent_round" && (
        <div className="form-grid">
          {num("roundPrice", "Round price per share", "$")}
          <Field label="Round date" required><input className="input" type="date" required value={roundDate} onChange={(e) => setRoundDate(e.target.value)} /></Field>
          {num("ourShares", "Our shares", undefined, priorShares ? `On record: ${priorShares.toLocaleString("en-US")}` : undefined)}
          {num("adjustmentPct", "Adjustment", "%", "For changes since the round; negative for down")}
        </div>
      )}
      {method === "milestone" && <div className="form-grid">{num("adjustmentPct", "Adjustment", "%", "Negative for down")}{money("priorValue", "Prior value", "Blank: the last approved mark, else cost")}</div>}
      {method === "revenue_multiple" && (
        <div className="form-grid">
          {num("multiple", "Multiple", "x")}
          {num("discountPct", "Discount to comparables", "%", "For stage, size and liquidity")}
          {money("metricValue", "Revenue metric", "Blank: ARR from the ledger")}
          {money("cash", "Cash", "Blank: the latest figure")}
          {money("debt", "Debt", "Blank: the latest figure")}
        </div>
      )}
      {method === "exit" && <div className="form-grid">{money("proceeds", "Proceeds to the fund")}</div>}
      <Field label="Why this value" required hint="What supports it: the round, the comparables, the milestones hit or missed."><textarea className="input" required minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={!method}>Propose mark</button></div>
    </form>
  );
}
