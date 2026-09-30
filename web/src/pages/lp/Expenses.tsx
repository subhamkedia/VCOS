import { Fragment, useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, NumberInput, Select, useToast, usd } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { longDate, person } from "./shared";

type Kind = "expense" | "offset";

/**
 * Partnership expenses in the ILPA template's categories, related-party
 * charges (ILPA: internal chargebacks), and fee offsets (fees the GP
 * received from portfolio companies, which reduce the next management fee
 * call). Entries are permanent: a correction is a reversing entry.
 */
export default function Expenses({ data, onChange }: LpTabProps) {
  const { can } = useSession();
  const L = data.labels;
  const byCat = Object.keys(L.expenseCategories).map((k) => ({ k, total: data.expenses.filter((e) => !e.fee_offset && e.category === k).reduce((a, e) => a + e.amount_usd, 0) })).filter((x) => x.total);
  const fees = data.calls.filter((c) => c.status === "approved").reduce((a, c) => a + c.fees_usd, 0);
  return (
    <>
      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="fe-h">
          <h2 id="fe-h">Since inception</h2>
          <dl className="kv">
            <dt>Management fees called</dt><dd>{usd(fees)}</dd>
            {byCat.map((x) => <Fragment key={x.k}><dt>{L.expenseCategories[x.k]}</dt><dd>{usd(x.total)}</dd></Fragment>)}
            <dt>Carried interest paid</dt><dd>{usd(data.gpCarry.paid)}</dd>
          </dl>
        </section>
        {can("work_deals") && <AddExpense data={data} onChange={onChange} />}
      </div>
      <section className="panel panel-pad section" aria-labelledby="el-h">
        <h2 id="el-h">Entries</h2>
        {data.expenses.length === 0 ? <Notice>No expenses recorded.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Expense entries</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Category</th><th scope="col">Description</th><th scope="col" className="num">Amount</th><th scope="col">Recorded by</th></tr></thead>
              <tbody>
                {[...data.expenses].reverse().map((e) => (
                  <tr key={e.id}>
                    <td className="small">{longDate(e.incurred_on)}</td>
                    <td className="small">{e.fee_offset ? "Fee offset" : L.expenseCategories[e.category]}{e.related_party && <> <span className="pill warn">Related party</span></>}</td>
                    <td className="small">{e.description}</td>
                    <td className="num">{usd(e.amount_usd)}</td>
                    <td className="small muted">{person(e.created_by)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function AddExpense({ data, onChange }: LpTabProps) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("expense");
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState<number | undefined>();
  const [cat, setCat] = useState<string | undefined>();
  const [desc, setDesc] = useState("");
  const [related, setRelated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      await api(`/lp/funds/${data.fund.id}/expenses`, { body: { incurredOn: on, amountUsd: amount, category: cat, description: desc, relatedParty: related, feeOffset: kind === "offset" } });
      toast("good", "Recorded.");
      setAmount(undefined); setDesc(""); setRelated(false);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="ae-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="ae-h">Record an entry</h2>
      <div className="form-grid">
        <Field label="Kind"><Select id="e-kind" value={kind} onChange={(v) => setKind(v ?? "expense")} options={[{ id: "expense" as Kind, label: "Partnership expense" }, { id: "offset" as Kind, label: "Fee offset (fee the GP received)" }]} /></Field>
        <Field label="Date" required><input className="input" type="date" required value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Amount" required hint="Negative to reverse an earlier entry"><NumberInput id="e-amt" value={amount} onChange={setAmount} prefix="$" /></Field>
        {kind === "expense" && <Field label="Category" required><Select id="e-cat" value={cat} onChange={setCat} options={Object.entries(data.labels.expenseCategories).map(([id, label]) => ({ id, label }))} /></Field>}
      </div>
      <Field label="Description" required><input className="input" required value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      {kind === "expense" && <label className="row small"><input type="checkbox" checked={related} onChange={(e) => setRelated(e.target.checked)} /> Charged by the GP or an affiliate (reported as a related-party charge)</label>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={kind === "expense" && !cat}>Record</button></div>
    </form>
  );
}
