import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Subscription } from "../../types";
import { Field, MoneyInput, Notice, Select, useConfirm, usePrompt, useToast, usd } from "../../ui";
import type { FrTabProps } from "../Raise";
import { longDate } from "../lp/shared";

const TONE: Record<Subscription["status"], string> = { invited: "outline", submitted: "info", accepted: "good", admitted: "good", rejected: "quiet", withdrawn: "quiet" };

/**
 * Subscriptions: the investor completes its questionnaire from a private
 * link; the firm screens, clears KYC, verifies accreditation, gets the
 * documents signed; a partner accepts or rejects.
 */
export default function Investors({ data, onChange }: FrTabProps) {
  const { can } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const L = data.labels;
  return (
    <>
      {can("queue") && <Invite data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="subs-h">
        <h2 id="subs-h">Subscriptions</h2>
        <p className="small muted" style={{ margin: 0 }}>{data.admitted.investors} investors admitted, {usd(data.admitted.commitments)} committed.</p>
        {data.subscriptions.length === 0 ? <Notice>No subscriptions yet. Invite an investor once it has committed.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Subscriptions</caption>
              <thead><tr><th scope="col">Investor</th><th scope="col" className="num">Commitment</th><th scope="col">Status</th><th scope="col">Still needed</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <th scope="row"><strong>{s.investor_name}</strong><div className="small muted">{s.natural_person ? "Individual" : "Entity"}{s.jurisdiction ? ` · ${s.jurisdiction}` : ""}</div></th>
                    <td className="num">{usd(s.commitment_usd)}</td>
                    <td><span className={`pill ${TONE[s.status]}`}>{L.subscriptionStatus[s.status]}</span>{s.kyc_status === "flagged" && <div><span className="pill bad">KYC flagged</span></div>}</td>
                    <td className="small">{s.status === "admitted" || s.status === "rejected" || s.status === "withdrawn" ? <span className="muted">—</span> : s.open.length ? s.open.join("; ") : "Ready for a closing"}</td>
                    <td><button className="btn small ghost" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Close" : "Review"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <Review key={open} data={data} sub={data.subscriptions.find((s) => s.id === open)!} onChange={onChange} />}
    </>
  );
}

function Invite({ data, onChange }: FrTabProps) {
  const toast = useToast();
  const [prospect, setProspect] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState<number | undefined>();
  const [natural, setNatural] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const p = data.prospects.find((x) => x.id === prospect);
  const submit = async () => {
    try {
      const r = await api<{ url: string; outboxId: string | null }>(`/fundraising/raises/${data.raise.id}/subscriptions`, {
        body: { prospectId: prospect, investorName: name || undefined, emails: email || undefined, commitmentUsd: amount, naturalPerson: natural, kind: p?.kind ?? (natural ? "individual" : "other") },
      });
      setLink(r.url);
      toast("good", r.outboxId ? "Invitation drafted in your mailbox: approve it in Approvals." : "Link created: send it to the investor.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="inv-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="inv-h">Invite an investor to subscribe</h2>
      <div className="form-grid">
        <Field label="From the pipeline"><Select id="i-p" value={prospect} onChange={setProspect} options={data.prospects.filter((x) => ["soft_circle", "committed", "diligence"].includes(x.stage)).map((x) => ({ id: x.id, label: x.name }))} placeholder="Or enter below" /></Field>
        <Field label="Legal name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={p?.name ?? ""} /></Field>
        <Field label="Email"><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={p?.emails[0] ?? ""} /></Field>
        <Field label="Commitment"><MoneyInput id="i-amt" value={amount} onChange={setAmount} /></Field>
      </div>
      <label className="row small"><input type="checkbox" checked={natural} onChange={(e) => setNatural(e.target.checked)} /> The investor is an individual (not an entity)</label>
      {link && <Notice tone="good">Private link, shown once: <span className="token-url">{link}</span></Notice>}
      <div className="row"><button className="btn primary" disabled={!prospect && !name}>Invite</button></div>
    </form>
  );
}

function Review({ data, sub: s, onChange }: FrTabProps & { sub: Subscription }) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const L = data.labels;
  const [verification, setVerification] = useState<string | undefined>(s.verification ?? undefined);
  const [signed, setSigned] = useState(s.signed_on ?? "");
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const base = `/fundraising/subscriptions/${s.id}`;
  const live = s.status === "invited" || s.status === "submitted" || s.status === "accepted";
  const kyc = async (status: "cleared" | "flagged") => {
    const note = await prompt({ title: status === "cleared" ? "Clear KYC?" : "Flag KYC?", label: status === "cleared" ? "Note (required if there were sanctions matches: why each is someone else)" : "What's wrong", confirm: status === "cleared" ? "Clear" : "Flag", required: status === "flagged", multiline: true });
    if (note === null) return;
    await run(() => api(base, { method: "PATCH", body: { kycStatus: status, kycNote: note || undefined } }), status === "cleared" ? "KYC cleared." : "Flagged.");
  };
  const decide = async (accept: boolean) => {
    let reason: string | null = null;
    if (!accept) {
      reason = await prompt({ title: `Reject ${s.investor_name}?`, label: "Why", confirm: "Reject", required: true, danger: true });
      if (!reason) return;
    } else if (!(await confirm({ title: `Accept ${s.investor_name}'s subscription?`, body: `${usd(s.commitment_usd)}. It can then be admitted at a closing.`, confirm: "Accept" }))) return;
    await run(() => api(`${base}/decide`, { body: { accept, reason } }), accept ? "Accepted." : "Rejected.");
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="rv-h">
      <h2 id="rv-h">{s.investor_name}</h2>
      <dl className="kv">
        <dt>Accredited</dt><dd>{s.accredited_basis ? L.accreditedBases[s.accredited_basis] : "Not yet answered"}</dd>
        {data.raise.exemption === "3c7" && <><dt>Qualified purchaser</dt><dd>{s.qp_basis ? L.qpBases[s.qp_basis] : "Not yet answered"}</dd></>}
        <dt>Benefit plan investor</dt><dd>{s.benefit_plan ? "Yes (counts toward the 25% test)" : "No"}</dd>
        <dt>Pooled vehicle</dt><dd>{s.pooled_vehicle ? "Yes" : "No"}</dd>
        <dt>Tax form</dt><dd>{s.tax_form ? L.taxForms[s.tax_form] : "—"}</dd>
        <dt>Beneficial owners (25%+)</dt><dd>{s.natural_person ? "Individual" : s.beneficial_owners.length ? s.beneficial_owners.map((o) => `${o.name} (${o.pct}%)`).join(", ") : "None over 25%"}</dd>
        <dt>Sanctions screening</dt><dd>{s.sanctions ? (s.sanctions.hits.length ? <span style={{ color: "var(--bad)" }}>{s.sanctions.hits.map((h) => `${h.name}: possible match with ${h.match}`).join("; ")}</span> : `No matches (lists as of ${longDate(s.sanctions.checkedAt)})`) : "Not yet screened"}</dd>
        <dt>KYC</dt><dd>{L.kycStatus[s.kyc_status]}{s.kyc_note ? `: ${s.kyc_note}` : ""}</dd>
        <dt>Accreditation verified by</dt><dd>{s.verification ? L.verification[s.verification] : "—"}</dd>
        <dt>Documents signed</dt><dd>{s.signed_on ? longDate(s.signed_on) : "Not yet"}</dd>
        {s.rejected_reason && <><dt>Rejected because</dt><dd>{s.rejected_reason}</dd></>}
      </dl>
      {live && can("work_deals") && (
        <>
          <div className="row">
            <button className="btn small" onClick={() => void run(() => api(`${base}/screen`, { body: {} }), "Screened against OFAC's lists.")}>Screen against OFAC</button>
            {data.sources.find((x) => x.id === "parallel")?.ready && <button className="btn small" onClick={() => void run(() => api(`${base}/parallel`, { body: {} }), "Checked with Parallel Markets.")}>Check with Parallel</button>}
            <button className="btn small" onClick={() => void kyc("cleared")}>Clear KYC</button>
            <button className="btn small ghost" onClick={() => void kyc("flagged")}>Flag KYC</button>
            {can("queue") && <button className="btn small" onClick={() => void run(() => api(`${base}/documents`, { body: {} }), "DocuSign draft waiting in Approvals.")}>Send documents for signature</button>}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(base, { method: "PATCH", body: { verification, signedOn: signed || null } }), "Saved."); }}>
            <div style={{ minWidth: 260 }}><Field label="How accreditation was verified"><Select id="r-ver" value={verification} onChange={setVerification} options={Object.entries(L.verification).map(([id, label]) => ({ id, label }))} /></Field></div>
            <Field label="Documents signed on"><input className="input" type="date" value={signed} onChange={(e) => setSigned(e.target.value)} /></Field>
            <button className="btn small">Save</button>
          </form>
        </>
      )}
      {s.status === "submitted" && can("decide_deals") && (
        <div className="row"><button className="btn primary" onClick={() => void decide(true)}>Accept</button><button className="btn ghost" onClick={() => void decide(false)}>Reject</button></div>
      )}
    </section>
  );
}
