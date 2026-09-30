import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Wire, WireStatus } from "../../types";
import { Field, MoneyInput, Notice, Select, Time, dateOnly, useConfirm, usePrompt, useToast, usd } from "../../ui";
import { SECURITY_LABELS } from "../Execution";
import { person, type ExecTabProps } from "../ExecutionDeal";

const WIRE_LABELS: Record<WireStatus, string> = {
  received: "Instructions received", verified: "Confirmed by phone", approved: "Approved by two people", sent: "Sent", confirmed: "Received by the company", cancelled: "Replaced",
};
const STEPS: WireStatus[] = ["received", "verified", "approved", "sent", "confirmed"];

/**
 * Funding and the close. Wire fraud (business email compromise) targets
 * exactly this step, so the controls follow the FBI's guidance: confirm the
 * instructions by phone at a number you already had, and have two people
 * approve. VC OS records each step; a person sends the wire from the bank.
 */
export default function Funding({ data, onChange }: ExecTabProps) {
  const inv = data.investments[0];
  if (inv) return <Closed data={data} />;
  if (data.deal.stage !== "closing") return <Notice>The wire and the close come after IC approval, once closing has started.</Notice>;
  const live = data.wires.find((w) => w.status !== "cancelled");
  const replaced = data.wires.filter((w) => w.status === "cancelled");
  return (
    <>
      {live ? <WireCard w={live} onChange={onChange} /> : <Instructions data={data} onChange={onChange} />}
      {live && live.status !== "confirmed" && <Instructions data={data} onChange={onChange} replacing />}
      {replaced.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="old-h">
          <h2 id="old-h">Replaced instructions</h2>
          <ul className="small">{replaced.map((w) => <li key={w.id}>{w.bank_name}, account ending {w.account_last4}, entered by {person(w.created_by)} <Time at={w.created_at} /></li>)}</ul>
        </section>
      )}
      <CloseForm data={data} onChange={onChange} />
    </>
  );
}

function Instructions({ data, onChange, replacing }: ExecTabProps & { replacing?: boolean }) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const ours = data.termSheets.find((t) => t.status === "signed")?.terms.ourAllocationUsd ?? data.deal.our_check_usd ?? undefined;
  const [open, setOpen] = useState(!replacing);
  const [amount, setAmount] = useState<number | undefined>(ours);
  const [beneficiary, setBeneficiary] = useState("");
  const [bank, setBank] = useState("");
  const [last4, setLast4] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!can("work_deals")) return replacing ? null : <Notice>Waiting for the wire instructions.</Notice>;
  if (!open) return <div className="row"><button className="btn small ghost" onClick={() => setOpen(true)}>The company sent new instructions</button></div>;
  const submit = async () => {
    if (replacing && !(await confirm({
      title: "Replace the wire instructions?",
      body: "Changed instructions are the most common sign of wire fraud. The old instructions are cancelled, and the new ones need a fresh call-back and two new approvals.",
      confirm: "Replace", danger: true,
    }))) return;
    try {
      await api(`/deals/${data.deal.id}/wires`, { body: { amountUsd: amount, beneficiary, bankName: bank, accountLast4: last4 } });
      toast("good", "Instructions recorded. Next: confirm them by phone.");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="wi-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="wi-h">{replacing ? "New wire instructions" : "Wire instructions"}</h2>
      <Notice tone="warn">Take instructions only from a secure channel (the company's counsel, or a portal), never from a plain email alone. VC OS keeps only the last four digits of the account.</Notice>
      <div className="form-grid">
        <Field label="Amount" required><MoneyInput id="w-amt" value={amount} onChange={setAmount} /></Field>
        <Field label="Beneficiary (the company's legal name)" required><input className="input" required value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} /></Field>
        <Field label="Bank" required><input className="input" required value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
        <Field label="Account, last four digits" required><input className="input mono" required inputMode="numeric" pattern="\d{4}" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Record instructions</button>{replacing && <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>}</div>
    </form>
  );
}

function WireCard({ w, onChange }: { w: Wire; onChange: () => void }) {
  const { can, me } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [source, setSource] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const self = `human:${me.user.email.toLowerCase()}`;
  const step = STEPS.indexOf(w.status);
  const call = async (path: string, body: object, done: string) => {
    try {
      await api(`/wires/${w.id}/${path}`, { body });
      toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const approve = async () => {
    if (await confirm({ title: `Approve a ${usd(w.amount_usd)} wire?`, body: `To ${w.beneficiary} at ${w.bank_name}, account ending ${w.account_last4}. Check these against the call-back before you approve.`, confirm: "Approve" })) {
      await call("approve", {}, "Approval recorded.");
    }
  };
  const sent = async () => {
    const ref = await prompt({ title: "Wire sent from the bank", label: "The bank's reference (Fed reference or confirmation number)", confirm: "Record", required: true });
    if (ref) await call("sent", { bankReference: ref }, "Recorded as sent.");
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="wc-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="wc-h">Wire: {usd(w.amount_usd)} to {w.beneficiary}</h2>
        <span className={`pill ${w.status === "confirmed" ? "good" : "info"}`}>{WIRE_LABELS[w.status]}</span>
      </div>
      <ol className="phases" aria-label="Wire steps">
        {STEPS.map((s, i) => <li key={s} aria-current={i === step ? "step" : undefined} className={i <= step ? "done" : i === step + 1 ? "now" : ""}>{WIRE_LABELS[s]}</li>)}
      </ol>
      <dl className="kv">
        <dt>Bank</dt><dd>{w.bank_name}, account ending <span className="mono">{w.account_last4}</span></dd>
        <dt>Entered by</dt><dd>{person(w.created_by)}, <Time at={w.created_at} /></dd>
        {w.callback_by && <><dt>Call-back</dt><dd>{person(w.callback_by)}: {w.callback_number_source}</dd></>}
        {w.approvals.length > 0 && <><dt>Approved by</dt><dd>{w.approvals.map(person).join(" and ")}</dd></>}
        {w.bank_reference && <><dt>Bank reference</dt><dd className="mono">{w.bank_reference}</dd></>}
      </dl>
      {w.status === "received" && can("work_deals") && (
        <form className="section" onSubmit={(e) => { e.preventDefault(); void call("verify", { numberSource: source, confirmed }, "Call-back recorded."); }} aria-label="Confirm by phone">
          <h3>Confirm by phone</h3>
          <p className="small muted" style={{ margin: 0 }}>Call the company at a number you had before the instructions arrived, and read back the bank, beneficiary and account. Never use a number from the instructions or the email they came in.</p>
          <Field label="Which number did you call?" required hint="E.g. 'CEO's mobile, saved from our first meeting'."><input className="input" required minLength={5} value={source} onChange={(e) => setSource(e.target.value)} /></Field>
          <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required /><span>The company confirmed the bank, beneficiary and account by phone.</span></label>
          <div className="row"><button className="btn primary" disabled={!confirmed}>Record the call-back</button></div>
        </form>
      )}
      {w.status === "verified" && (
        can("approve_outbox") && !w.approvals.includes(self)
          ? <div className="row"><button className="btn primary" onClick={() => void approve()}>Approve the wire ({w.approvals.length} of 2)</button></div>
          : <Notice>{w.approvals.includes(self) ? "You've approved. A second person must approve." : `Waiting for ${2 - w.approvals.length} partner ${2 - w.approvals.length === 1 ? "approval" : "approvals"}.`}</Notice>
      )}
      {w.status === "approved" && (can("approve_outbox") ? <div className="row"><button className="btn primary" onClick={() => void sent()}>I've sent the wire from the bank</button></div> : <Notice>Approved. A partner sends it from the bank and records the reference.</Notice>)}
      {w.status === "sent" && can("work_deals") && <div className="row"><button className="btn primary" onClick={() => void call("confirm", {}, "Receipt recorded.")}>The company confirms receipt</button></div>}
    </section>
  );
}

function CloseForm({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [fund, setFund] = useState<string | undefined>(data.funds[0]);
  const [err, setErr] = useState<string | null>(null);
  const r = data.closing.ready;
  const titles = r.open.map((k) => data.closing.items.find((i) => i.key === k)?.title ?? k);
  const signed = data.termSheets.some((t) => t.status === "signed");
  const submit = async () => {
    if (!(await confirm({ title: `Record the close of ${data.deal.company_name}?`, body: "The investment is recorded for Portfolio, with the figures from the signed terms and the pro forma. This can't be undone; corrections are new records.", confirm: "Record the close" }))) return;
    try {
      await api(`/deals/${data.deal.id}/close`, { body: { closeDate: date, fundName: fund } });
      toast("good", "Closed. The investment is on record.");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="close-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="close-h">Close</h2>
      {!signed && <Notice tone="warn">Mark the signed term sheet on the Term sheet tab first.</Notice>}
      {r.ready ? <Notice tone="good">Every required item is complete.</Notice> : <Notice>Still open: {titles.join("; ")}.</Notice>}
      {data.regulatory.blocked && <Notice tone="bad">{data.regulatory.blocked} <Link to="/compliance?tab=deals">Open deal screening</Link></Notice>}
      {!data.regulatory.blocked && data.regulatory.screening && <p className="small muted" style={{ margin: 0 }}>Regulatory screening done {dateOnly(data.regulatory.screening.screenedAt)}. <Link to="/compliance?tab=deals">See it</Link></p>}
      {can("decide_deals") ? (
        <>
          <div className="form-grid">
            <Field label="Closing date" required><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            {data.funds.length > 1 && <Field label="Investing fund" required><Select id="close-fund" value={fund} onChange={setFund} options={data.funds.map((f) => ({ id: f, label: f }))} /></Field>}
          </div>
          {err && <Notice tone="bad">{err}</Notice>}
          <div className="row"><button className="btn primary" disabled={!r.ready || !signed || Boolean(data.regulatory.blocked)}>Record the close</button></div>
        </>
      ) : <p className="small muted" style={{ margin: 0 }}>A partner records the close.</p>}
    </form>
  );
}

function Closed({ data }: { data: ExecTabProps["data"] }) {
  const i = data.investments[0]!;
  return (
    <section className="panel panel-pad section" aria-labelledby="inv-h">
      <h2 id="inv-h">Closed {dateOnly(i.close_date)}</h2>
      <div className="stats">
        <div className="stat"><b className="num">{usd(i.amount_usd)}</b><span>Invested from {i.fund_name}</span></div>
        {i.ownership_fd_pct !== null && <div className="stat"><b className="num">{i.ownership_fd_pct.toFixed(2)}%</b><span>Ownership, fully diluted</span></div>}
        {i.post_money_usd !== null && <div className="stat"><b className="num">{usd(i.post_money_usd)}</b><span>{i.security === "preferred" ? "Post-money" : "Valuation cap"}</span></div>}
        {i.shares !== null && <div className="stat"><b className="num">{Math.round(i.shares).toLocaleString("en-US")}</b><span>Shares at ${i.price_per_share?.toFixed(4)}</span></div>}
      </div>
      <dl className="kv">
        <dt>Instrument</dt><dd>{i.series_name ?? SECURITY_LABELS[i.security]}</dd>
        <dt>Board</dt><dd>{i.board_role === "seat" ? "Board seat" : i.board_role === "observer" ? "Observer" : "None"}</dd>
        <dt>Recorded by</dt><dd>{person(i.created_by)}</dd>
      </dl>
      <p className="small muted" style={{ margin: 0 }}>Portfolio management starts from this record.</p>
    </section>
  );
}
