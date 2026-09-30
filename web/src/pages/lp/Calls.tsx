import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { BankTxn, CapitalCall, CallItem } from "../../types";
import { Field, MoneyInput, Notice, Select, useConfirm, usePrompt, useToast, usd } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { STATUS_TONE, longDate, person } from "./shared";

interface Preview {
  totals: { investments: number; fees: number; expenses: number; amount: number };
  feeResult: { gross: number; offsets: number; net: number; lines: string[] } | null;
  items: { partnerId: string; name: string; investment: number; fee: number; expense: number; amount: number; unfundedAfter: number }[];
  warnings: string[];
}

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Capital calls. Prepare one and see each investor's share before saving;
 * a partner who didn't prepare it approves it, and the notices are drafted
 * into your mailbox for review. Receipts are matched from the bank.
 */
export default function Calls({ data, onChange }: LpTabProps) {
  const { can, me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = `human:${me.user.email.toLowerCase()}`;
  const [open, setOpen] = useState<string | null>(null);
  const act = async (c: CapitalCall, what: "approve" | "cancel") => {
    if (what === "approve" && !(await confirm({ title: `Approve call ${c.number}?`, body: `${usd(c.investments_usd + c.fees_usd + c.expenses_usd)} due ${longDate(c.due_date)}. Each investor's notice is then drafted in your mailbox for someone to review and send.`, confirm: "Approve" }))) return;
    if (what === "cancel" && !(await confirm({ title: `Cancel call ${c.number}?`, body: "It stays on record as cancelled.", confirm: "Cancel call", danger: true }))) return;
    try {
      const r = await api<{ queued?: number; channel?: string | null; noEmail?: string[] }>(`/lp/calls/${c.id}/${what}`, { body: {} });
      if (what === "approve") {
        toast("good", r.channel ? `Approved. ${r.queued} notices are waiting in Approvals.` : "Approved. Connect Gmail or Outlook to draft the notices.");
        if (r.noEmail?.length) toast("bad", `No email on file for ${r.noEmail.join(", ")}: send their notice another way.`);
      } else toast("good", "Call cancelled.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      {can("work_deals") && <NewCall data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="calls-h">
        <h2 id="calls-h">Calls</h2>
        {data.calls.length === 0 ? <Notice>No capital calls yet.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Capital calls</caption>
              <thead><tr><th scope="col">Call</th><th scope="col">Due</th><th scope="col" className="num">Investments</th><th scope="col" className="num">Fees</th><th scope="col" className="num">Expenses</th><th scope="col" className="num">Total</th><th scope="col" className="num">Received</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.calls.map((c) => {
                  const total = c.investments_usd + c.fees_usd + c.expenses_usd;
                  return (
                    <tr key={c.id}>
                      <td><strong>Call {c.number}</strong><div className="small muted">{c.purpose ?? "No purpose given"}</div></td>
                      <td className="small">{longDate(c.due_date)}<div className="muted">notice {longDate(c.notice_date)}</div></td>
                      <td className="num">{usd(c.investments_usd)}</td><td className="num">{usd(c.fees_usd)}</td><td className="num">{usd(c.expenses_usd)}</td>
                      <td className="num"><strong>{usd(total)}</strong></td>
                      <td className="num">{c.status === "approved" ? usd(c.received) : "—"}</td>
                      <td><span className={`pill ${STATUS_TONE[c.status]}`}>{data.labels.callStatus[c.status]}</span><div className="small muted">by {person(c.created_by)}{c.approved_by ? `, approved by ${person(c.approved_by)}` : ""}</div></td>
                      <td>
                        <div className="row">
                          <button className="btn small ghost" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : "By investor"}</button>
                          {c.status === "draft" && can("decide_deals") && c.created_by !== self && <button className="btn small primary" onClick={() => void act(c, "approve")}>Approve</button>}
                          {c.status === "draft" && c.created_by === self && <span className="small muted">Another partner approves</span>}
                          {c.status === "draft" && can("decide_deals") && <button className="btn small ghost" onClick={() => void act(c, "cancel")}>Cancel</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <CallDetail key={open} call={data.calls.find((c) => c.id === open)!} onChange={onChange} editable={can("work_deals")} />}
      <Bank data={data} onChange={onChange} />
    </>
  );
}

function NewCall({ data, onChange }: LpTabProps) {
  const toast = useToast();
  const [notice, setNotice] = useState(today());
  const [due, setDue] = useState(addDays(today(), 14));
  const [investments, setInvestments] = useState<number | undefined>();
  const [expenses, setExpenses] = useState<number | undefined>();
  const [feeFrom, setFeeFrom] = useState("");
  const [feeTo, setFeeTo] = useState("");
  const [purpose, setPurpose] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const body = () => ({ noticeDate: notice, dueDate: due, investmentsUsd: investments ?? 0, expensesUsd: expenses ?? 0, fee: feeFrom || feeTo ? { from: feeFrom, to: feeTo } : null, purpose });
  const check = async () => {
    setErr(null);
    try {
      setPreview(await api<Preview>(`/lp/funds/${data.fund.id}/calls/preview`, { body: body() }));
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    }
  };
  const save = async () => {
    try {
      await api(`/lp/funds/${data.fund.id}/calls`, { body: body() });
      toast("good", "Call drafted. A partner who didn't prepare it approves it.");
      setPreview(null); setInvestments(undefined); setExpenses(undefined); setFeeFrom(""); setFeeTo(""); setPurpose("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!data.investors.length) return <Notice>Add the fund's investors before calling capital.</Notice>;
  return (
    <form className="panel panel-pad section" aria-labelledby="new-h" onSubmit={(e) => { e.preventDefault(); void check(); }}>
      <h2 id="new-h">Prepare a capital call</h2>
      <div className="form-grid">
        <Field label="Notice date" required><input className="input" type="date" required value={notice} onChange={(e) => { setNotice(e.target.value); setPreview(null); }} /></Field>
        <Field label="Due date" required hint="ILPA recommends at least 10 business days' notice"><input className="input" type="date" required value={due} onChange={(e) => { setDue(e.target.value); setPreview(null); }} /></Field>
        <Field label="For investments"><MoneyInput id="c-inv" value={investments} onChange={(v) => { setInvestments(v); setPreview(null); }} /></Field>
        <Field label="For partnership expenses"><MoneyInput id="c-exp" value={expenses} onChange={(v) => { setExpenses(v); setPreview(null); }} /></Field>
        <Field label="Management fee from" hint="Leave blank for no fee"><input className="input" type="date" value={feeFrom} onChange={(e) => { setFeeFrom(e.target.value); setPreview(null); }} /></Field>
        <Field label="Management fee to"><input className="input" type="date" value={feeTo} onChange={(e) => { setFeeTo(e.target.value); setPreview(null); }} /></Field>
      </div>
      <Field label="What it's for" hint="Shown on every notice: the investments and costs this pays for"><input className="input" value={purpose} onChange={(e) => { setPurpose(e.target.value); setPreview(null); }} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn">Preview each investor's share</button></div>
      {preview && (
        <div className="section">
          {preview.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
          {preview.feeResult && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{preview.feeResult.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          <div className="table-wrap alloc">
            <table className="t">
              <caption className="sr-only">Each investor's share</caption>
              <thead><tr><th scope="col">Investor</th><th scope="col" className="num">Investments</th><th scope="col" className="num">Fee</th><th scope="col" className="num">Expenses</th><th scope="col" className="num">Total</th><th scope="col" className="num">Unfunded after</th></tr></thead>
              <tbody>
                {preview.items.map((i) => <tr key={i.partnerId}><th scope="row">{i.name}</th><td className="num">{usd(i.investment)}</td><td className="num">{usd(i.fee)}</td><td className="num">{usd(i.expense)}</td><td className="num"><strong>{usd(i.amount)}</strong></td><td className="num">{usd(i.unfundedAfter)}</td></tr>)}
                <tr className="total"><th scope="row">Total</th><td className="num">{usd(preview.totals.investments)}</td><td className="num">{usd(preview.totals.fees)}</td><td className="num">{usd(preview.totals.expenses)}</td><td className="num">{usd(preview.totals.amount)}</td><td /></tr>
              </tbody>
            </table>
          </div>
          <div className="row"><button type="button" className="btn primary" onClick={() => void save()}>Save as draft for approval</button></div>
        </div>
      )}
    </form>
  );
}

function CallDetail({ call, onChange, editable }: { call: CapitalCall; onChange: () => void; editable: boolean }) {
  const toast = useToast();
  const prompt = usePrompt();
  const receive = async (i: CallItem) => {
    const v = await prompt({ title: `Record ${i.partner_name}'s payment`, label: "Amount received, in total", confirm: "Record", initial: String(i.amount_usd), required: true });
    if (v === null) return;
    try {
      await api(`/lp/call-items/${i.id}/receipt`, { body: { amountUsd: Number(v.replace(/[^0-9.]/g, "")) } });
      toast("good", "Payment recorded.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="cd-h">
      <h2 id="cd-h">Call {call.number}, by investor</h2>
      {call.fee_detail.lines?.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{call.fee_detail.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
      <div className="table-wrap">
        <table className="t">
          <caption className="sr-only">Call {call.number} by investor</caption>
          <thead><tr><th scope="col">Investor</th><th scope="col" className="num">Investments</th><th scope="col" className="num">Fee</th><th scope="col" className="num">Expenses</th><th scope="col" className="num">Due</th><th scope="col" className="num">Received</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {call.items.map((i) => {
              const paid = i.received_usd >= i.amount_usd - 0.005;
              return (
                <tr key={i.id}>
                  <th scope="row">{i.partner_name}</th>
                  <td className="num">{usd(i.investment_usd)}</td><td className="num">{usd(i.fee_usd)}</td><td className="num">{usd(i.expense_usd)}</td><td className="num">{usd(i.amount_usd)}</td>
                  <td className="num">{i.received_usd ? usd(i.received_usd) : "—"}{i.received_on && <div className="small muted">{longDate(i.received_on)}{i.bank_txn_id ? " · from the bank" : ""}</div>}</td>
                  <td>{call.status === "approved" && (paid ? <span className="pill good">Paid</span> : editable ? <button className="btn small ghost" onClick={() => void receive(i)}>Record payment</button> : <span className="pill warn">Outstanding</span>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Bank({ data, onChange }: LpTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const mercury = data.sources.find((s) => s.id === "mercury");
  const openItems = data.calls.filter((c) => c.status === "approved").flatMap((c) => c.items.filter((i) => i.received_usd < i.amount_usd - 0.005).map((i) => ({ id: i.id, label: `Call ${c.number}: ${i.partner_name}, ${usd(i.amount_usd - i.received_usd)} due` })));
  const done = (r: { matched: number; unmatched: number; added?: number }) => {
    toast("good", `${r.added ?? 0} new transactions; ${r.matched} matched to calls.${r.unmatched ? ` ${r.unmatched} need a person.` : ""}`);
    onChange();
  };
  const sync = async () => {
    setBusy(true);
    try {
      done(await api(`/lp/funds/${data.fund.id}/bank/sync`, { body: {} }));
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", f);
      done(await api(`/lp/funds/${data.fund.id}/bank/uploads`, { form }));
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const match = async (t: BankTxn, itemId: string | undefined) => {
    if (!itemId) return;
    try {
      await api(`/lp/bank/${t.id}/match`, { body: { itemId } });
      toast("good", "Matched.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="bank-h">
      <h2 id="bank-h">Receipts from the bank</h2>
      <p className="small" style={{ margin: 0 }}>Incoming wires are matched to what each investor owes: by amount, then by the sender's name when two investors owe the same. VC OS reads the account; it can't move money.</p>
      {can("work_deals") && (
        <div className="row">
          {mercury?.ready ? <button className="btn" disabled={busy} onClick={() => void sync()}>Sync Mercury</button> : <span className="small muted"><Link to="/connections">Connect Mercury</Link> (read-only token), or upload a statement:</span>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); void upload(); }}>
            <label className="sr-only" htmlFor="bank-file">Bank statement (CSV)</label>
            <input id="bank-file" ref={file} className="input" type="file" accept=".csv,text/csv" />
            <button className="btn" disabled={busy}>Upload statement</button>
          </form>
        </div>
      )}
      {data.bank.unmatched.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No unmatched incoming transactions.</p> : (
        <div className="table-wrap">
          <table className="t">
            <caption className="sr-only">Incoming transactions to match</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">From</th><th scope="col" className="num">Amount</th><th scope="col">Match to</th></tr></thead>
            <tbody>
              {data.bank.unmatched.map((t) => (
                <tr key={t.id}>
                  <td className="small">{longDate(t.posted_on)}</td>
                  <td className="small">{t.counterparty ?? "—"}<div className="muted">{t.memo}</div></td>
                  <td className="num">{usd(t.amount_usd)}</td>
                  <td>{can("work_deals") && openItems.length ? <Select id={`m-${t.id}`} value={undefined} onChange={(v) => void match(t, v)} options={openItems} placeholder="Pick a call line" /> : <span className="small muted">Nothing open</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
