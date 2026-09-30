import { useRef, useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { LpInvestor } from "../../types";
import { Field, MoneyInput, Notice, Select, useConfirm, useToast, usd } from "../../ui";
import type { LpTabProps } from "../LpFund";
import { longDate, x2 } from "./shared";

/**
 * The investor register: each limited partner and the GP's own commitment,
 * what each has paid in and received, and its private link to statements.
 */
export default function Investors({ data, onChange }: LpTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string; expiresAt: string } | null>(null);
  const L = data.labels;
  const makeLink = async (i: LpInvestor) => {
    try {
      const r = await api<{ url: string; expiresAt: string }>(`/lp/investors/${i.id}/portal`, { body: {} });
      setLink({ name: i.name, ...r });
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const revoke = async (i: LpInvestor) => {
    if (!(await confirm({ title: `Turn off ${i.name}'s links?`, body: "Links already sent stop working. You can make a new one at any time.", confirm: "Turn off links", danger: true }))) return;
    try {
      await api(`/lp/investors/${i.id}/portal/revoke`, { body: {} });
      toast("good", "Links turned off.");
      if (link?.name === i.name) setLink(null);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast("good", "Link copied.");
    } catch {
      toast("bad", "Couldn't copy: select the link and copy it.");
    }
  };
  return (
    <>
      {link && (
        <Notice tone="good">
          <strong>{link.name}'s private link</strong>, valid until {longDate(link.expiresAt)}. It's shown once: copy it now, or make a new one later.
          <div className="token-url" style={{ marginTop: 6 }}>{link.url}</div>
          <div className="row" style={{ marginTop: 6 }}><button className="btn small" onClick={() => void copy(link.url)}>Copy link</button></div>
        </Notice>
      )}
      {data.investors.length === 0 ? <Notice>No investors yet.</Notice> : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Investors</caption>
            <thead>
              <tr><th scope="col">Investor</th><th scope="col" className="num">Commitment</th><th scope="col" className="num">Paid in</th><th scope="col" className="num">Unfunded</th><th scope="col" className="num">Distributed</th><th scope="col" className="num">Capital account</th><th scope="col" className="num">Net TVPI</th><th scope="col">Private link</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {data.investors.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.name}</strong>
                    <div className="small muted">
                      {L.partnerKinds[i.kind] ?? "Investor"}{i.closing > 1 ? ` · closing ${i.closing}` : ""}{!i.fee_paying && i.kind !== "gp" ? " · no fee or carry" : ""}{i.kyc_verified_on ? "" : " · KYC not recorded"}
                    </div>
                  </td>
                  <td className="num">{usd(i.commitment_usd)}</td>
                  <td className="num">{usd(i.contributed)}</td>
                  <td className="num">{usd(i.unfunded)}</td>
                  <td className="num">{usd(i.distributed)}</td>
                  <td className="num">{usd(i.balance)}</td>
                  <td className="num">{x2(i.returns?.tvpi)}</td>
                  <td className="small">
                    {i.kind === "gp" ? <span className="muted">Not needed</span> : i.portal ? <>Until {longDate(i.portal.expiresAt)}<div className="muted">{i.portal.lastUsedAt ? `Opened ${longDate(i.portal.lastUsedAt)}` : "Not opened yet"}</div></> : <span className="muted">None</span>}
                  </td>
                  <td>
                    <div className="row">
                      <button className="btn small ghost" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>{open === i.id ? "Close" : "Details"}</button>
                      {can("work_deals") && i.kind !== "gp" && <button className="btn small" onClick={() => void makeLink(i)}>New link</button>}
                      {can("work_deals") && i.portal && <button className="btn small ghost" onClick={() => void revoke(i)}>Turn off</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <InvestorDetails key={open} data={data} investor={data.investors.find((i) => i.id === open)!} onChange={onChange} editable={can("work_deals")} />}
      {can("work_deals") && (
        <div className="grid-2">
          <AddInvestor data={data} onChange={onChange} />
          <ImportRegister data={data} onChange={onChange} />
        </div>
      )}
    </>
  );
}

function InvestorDetails({ data, investor: i, onChange, editable }: LpTabProps & { investor: LpInvestor; editable: boolean }) {
  const toast = useToast();
  const L = data.labels;
  const [emails, setEmails] = useState(i.emails.join(", "));
  const [tax, setTax] = useState<string | undefined>(i.tax_status ?? undefined);
  const [status, setStatus] = useState<string | undefined>(i.investor_status ?? undefined);
  const [kyc, setKyc] = useState(i.kyc_verified_on ?? "");
  const [erisa, setErisa] = useState(i.erisa);
  const [side, setSide] = useState(i.side_letter ?? "");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await api(`/lp/investors/${i.id}`, { method: "PATCH", body: { emails, taxStatus: tax ?? null, investorStatus: status ?? null, kycVerifiedOn: kyc || null, erisa, sideLetter: side } });
      toast("good", "Saved.");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="inv-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="inv-h">{i.name}</h2>
      <p className="small muted" style={{ margin: 0 }}>Admitted {longDate(i.admitted_on)} · commitment {usd(i.commitment_usd)}{i.returns?.irr != null ? ` · net IRR ${(i.returns.irr * 100).toFixed(1)}%` : ""}</p>
      <fieldset disabled={!editable} className="section" style={{ border: 0, margin: 0, padding: 0 }}>
        <div className="form-grid">
          <Field label="Notice emails" hint="Where calls, distributions and reports go; separate with commas"><input className="input" value={emails} onChange={(e) => setEmails(e.target.value)} /></Field>
          <Field label="Tax status"><Select id="i-tax" value={tax} onChange={setTax} options={Object.entries(L.taxStatus).map(([id, label]) => ({ id, label }))} placeholder="Not recorded" /></Field>
          <Field label="Investor status"><Select id="i-status" value={status} onChange={setStatus} options={Object.entries(L.investorStatus).map(([id, label]) => ({ id, label }))} placeholder="Not recorded" /></Field>
          <Field label="KYC and AML verified on"><input className="input" type="date" value={kyc} onChange={(e) => setKyc(e.target.value)} /></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={erisa} onChange={(e) => setErisa(e.target.checked)} /> Benefit plan investor (ERISA)</label>
        <Field label="Side letter terms" hint="What it grants: fee discount, MFN, reporting, excuse rights"><textarea className="input" value={side} onChange={(e) => setSide(e.target.value)} /></Field>
        {err && <Notice tone="bad">{err}</Notice>}
        {editable && <div className="row"><button className="btn primary">Save</button></div>}
      </fieldset>
    </form>
  );
}

function AddInvestor({ data, onChange }: LpTabProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string | undefined>();
  const [commitment, setCommitment] = useState<number | undefined>();
  const [emails, setEmails] = useState("");
  const [closing, setClosing] = useState("1");
  const [admitted, setAdmitted] = useState(data.fund.inception);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      await api(`/lp/funds/${data.fund.id}/investors`, { body: { name, kind, commitmentUsd: commitment, emails, closing: Number(closing), admittedOn: admitted } });
      toast("good", `${name} added.`);
      setName(""); setCommitment(undefined); setEmails(""); setKind(undefined);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="add-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="add-h">Add an investor</h2>
      <div className="form-grid">
        <Field label="Legal name" required><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type" required><Select id="a-kind" value={kind} onChange={setKind} options={Object.entries(data.labels.partnerKinds).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Commitment" required><MoneyInput id="a-commit" value={commitment} onChange={setCommitment} /></Field>
        <Field label="Notice emails"><input className="input" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="ir@example.org" /></Field>
        <Field label="Closing"><input className="input" type="number" min={1} value={closing} onChange={(e) => setClosing(e.target.value)} /></Field>
        <Field label="Admitted on"><input className="input" type="date" value={admitted} onChange={(e) => setAdmitted(e.target.value)} /></Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>The GP's own commitment pays no management fee or carry.</p>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={!kind}>Add investor</button></div>
    </form>
  );
}

function ImportRegister({ data, onChange }: LpTabProps) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: { row: number; reason: string }[] } | null>(null);
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const r = await api<{ added: number; skipped: { row: number; reason: string }[] }>(`/lp/funds/${data.fund.id}/investors/uploads`, { form });
      setResult(r);
      toast("good", `${r.added} investors added.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="imp-h" onSubmit={(e) => { e.preventDefault(); void upload(); }}>
      <h2 id="imp-h">Import from your fund administrator</h2>
      <p className="small" style={{ margin: 0 }}>An investor list exported as CSV from Carta, Juniper Square, AngelList or a spreadsheet. It needs a name and a commitment column; type, email, closing, admission date, fee-paying and tax columns are read when present. Investors already here are skipped, never overwritten.</p>
      <Field label="CSV file"><input ref={file} className="input" type="file" accept=".csv,text/csv" /></Field>
      <div className="row"><button className="btn" disabled={busy}>{busy ? "Importing…" : "Import"}</button></div>
      {result && result.skipped.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{result.skipped.map((s) => <li key={s.row}>Row {s.row}: {s.reason}</li>)}</ul>
      )}
    </form>
  );
}
