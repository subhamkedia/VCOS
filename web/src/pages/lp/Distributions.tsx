import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Distribution } from "../../types";
import { Field, MoneyInput, Notice, Seg, Select, useConfirm, useToast, usd } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { STATUS_TONE, longDate, person } from "./shared";

interface Preview {
  gross: number; carry: number; escrow: number; carryPaidNow: number; lines: string[]; warnings: string[];
  items: { partnerId: string; name: string; gross: number; carry: number; net: number }[];
}

/**
 * Distributions. The engine splits the amount by commitment and runs the
 * carry waterfall (return of capital, preferred return, catch-up, split),
 * taking carry from fee-paying investors only. A second person approves;
 * then the notices are drafted and, once the money has gone, it's recorded
 * as paid.
 */
export default function Distributions({ data, onChange }: LpTabProps) {
  const { can, me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = `human:${me.user.email.toLowerCase()}`;
  const [open, setOpen] = useState<string | null>(null);
  const act = async (d: Distribution, what: "approve" | "paid" | "cancel") => {
    const q = {
      approve: { title: `Approve distribution ${d.number}?`, body: `${usd(d.gross_usd)} on ${longDate(d.paid_on)}, ${usd(d.carry_usd)} of it carried interest. Each investor's notice is then drafted for review.`, confirm: "Approve" },
      paid: { title: `Record distribution ${d.number} as paid?`, body: "Only once the money has left the fund's account. It then counts in capital accounts and returns.", confirm: "Record as paid" },
      cancel: { title: `Cancel distribution ${d.number}?`, body: "It stays on record as cancelled.", confirm: "Cancel distribution", danger: true },
    }[what];
    if (!(await confirm(q))) return;
    try {
      const r = await api<{ queued?: number; channel?: string | null }>(`/lp/distributions/${d.id}/${what}`, { body: {} });
      toast("good", what === "approve" ? (r.channel ? `Approved. ${r.queued} notices are waiting in Approvals.` : "Approved. Connect Gmail or Outlook to draft the notices.") : what === "paid" ? "Recorded as paid." : "Cancelled.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      {can("work_deals") && <NewDistribution data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="d-h">
        <h2 id="d-h">Distributions</h2>
        {data.distributions.length === 0 ? <Notice>No distributions yet.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Distributions</caption>
              <thead><tr><th scope="col">Distribution</th><th scope="col">Date</th><th scope="col" className="num">Gross</th><th scope="col" className="num">Carried interest</th><th scope="col" className="num">To investors</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.distributions.map((d) => (
                  <tr key={d.id}>
                    <td><strong>Distribution {d.number}</strong><div className="small muted">{data.labels.distributionKinds[d.kind]}{d.company_name ? ` · ${d.company_name}` : ""}{d.purpose ? ` · ${d.purpose}` : ""}</div></td>
                    <td className="small">{longDate(d.paid_on)}</td>
                    <td className="num">{usd(d.gross_usd)}</td>
                    <td className="num">{usd(d.carry_usd)}{d.escrow_usd > 0 && <div className="small muted">{usd(d.escrow_usd)} in escrow</div>}</td>
                    <td className="num">{usd(d.gross_usd - d.carry_usd)}</td>
                    <td><span className={`pill ${STATUS_TONE[d.status]}`}>{data.labels.distributionStatus[d.status]}</span><div className="small muted">by {person(d.created_by)}{d.approved_by ? `, approved by ${person(d.approved_by)}` : ""}</div></td>
                    <td>
                      <div className="row">
                        <button className="btn small ghost" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? "Close" : "Details"}</button>
                        {d.status === "draft" && can("decide_deals") && d.created_by !== self && <button className="btn small primary" onClick={() => void act(d, "approve")}>Approve</button>}
                        {d.status === "draft" && d.created_by === self && <span className="small muted">Another partner approves</span>}
                        {d.status === "approved" && can("decide_deals") && <button className="btn small" onClick={() => void act(d, "paid")}>Record as paid</button>}
                        {d.status === "draft" && can("decide_deals") && <button className="btn small ghost" onClick={() => void act(d, "cancel")}>Cancel</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && (() => {
        const d = data.distributions.find((x) => x.id === open)!;
        return (
          <section className="panel panel-pad section" aria-labelledby="dd-h">
            <h2 id="dd-h">Distribution {d.number}, by investor</h2>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{d.waterfall.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <Split items={d.items.map((i) => ({ partnerId: i.partner_id, name: i.partner_name ?? "", gross: i.gross_usd, carry: i.carry_usd, net: i.net_usd }))} caption={`Distribution ${d.number} by investor`} />
          </section>
        );
      })()}
    </>
  );
}

function Split({ items, caption }: { items: Preview["items"]; caption: string }) {
  const t = (k: "gross" | "carry" | "net") => items.reduce((a, i) => a + i[k], 0);
  return (
    <div className="table-wrap alloc">
      <table className="t">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th scope="col">Investor</th><th scope="col" className="num">Share</th><th scope="col" className="num">Carried interest</th><th scope="col" className="num">Net to investor</th></tr></thead>
        <tbody>
          {items.map((i) => <tr key={i.partnerId}><th scope="row">{i.name}</th><td className="num">{usd(i.gross)}</td><td className="num">{usd(i.carry)}</td><td className="num"><strong>{usd(i.net)}</strong></td></tr>)}
          <tr className="total"><th scope="row">Total</th><td className="num">{usd(t("gross"))}</td><td className="num">{usd(t("carry"))}</td><td className="num">{usd(t("net"))}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function NewDistribution({ data, onChange }: LpTabProps) {
  const toast = useToast();
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [gross, setGross] = useState<number | undefined>();
  const [kind, setKind] = useState<"cash" | "in_kind">("cash");
  const [company, setCompany] = useState<string | undefined>();
  const [purpose, setPurpose] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const body = () => ({ paidOn, grossUsd: gross, kind, companyId: company, purpose });
  const reset = () => setPreview(null);
  const check = async () => {
    setErr(null);
    try {
      setPreview(await api<Preview>(`/lp/funds/${data.fund.id}/distributions/preview`, { body: body() }));
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    }
  };
  const save = async () => {
    try {
      await api(`/lp/funds/${data.fund.id}/distributions`, { body: body() });
      toast("good", "Distribution drafted. A partner who didn't prepare it approves it.");
      setPreview(null); setGross(undefined); setPurpose("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!data.investors.length) return null;
  const american = data.fund.terms.waterfall === "american";
  return (
    <form className="panel panel-pad section" aria-labelledby="nd-h" onSubmit={(e) => { e.preventDefault(); void check(); }}>
      <h2 id="nd-h">Prepare a distribution</h2>
      <div className="form-grid">
        <Field label="Payment date" required><input className="input" type="date" required value={paidOn} onChange={(e) => { setPaidOn(e.target.value); reset(); }} /></Field>
        <Field label="Amount to distribute" required><MoneyInput id="d-gross" value={gross} onChange={(v) => { setGross(v); reset(); }} /></Field>
        <Field label={american ? "From which investment" : "From which investment (optional)"} required={american}><Select id="d-co" value={company} onChange={(v) => { setCompany(v); reset(); }} options={data.schedule.map((s) => ({ id: s.companyId, label: s.company }))} placeholder="Not tied to one" /></Field>
      </div>
      <Seg label="Paid in" value={kind} onChange={(v) => { setKind(v); reset(); }} options={[{ id: "cash", label: data.labels.distributionKinds.cash ?? "Cash" }, { id: "in_kind", label: data.labels.distributionKinds.in_kind ?? "In kind" }]} />
      <Field label="Description" hint="On every notice: the sale or event the proceeds came from"><input className="input" value={purpose} onChange={(e) => { setPurpose(e.target.value); reset(); }} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn">Run the waterfall</button></div>
      {preview && (
        <div className="section">
          {preview.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{preview.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <p className="small" style={{ margin: 0 }}>Carried interest: <strong>{usd(preview.carry)}</strong>{preview.escrow ? `, of which ${usd(preview.escrow)} held in escrow` : ""}.</p>
          <Split items={preview.items} caption="Each investor's share" />
          <div className="row"><button type="button" className="btn primary" onClick={() => void save()}>Save as draft for approval</button></div>
        </div>
      )}
    </form>
  );
}
