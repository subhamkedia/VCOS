import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, useApi } from "../api";
import type { SubscribePublic } from "../types";
import { ErrorState, Field, Loading, MoneyInput, Notice, PageHead, Select } from "../ui";

/**
 * The subscription questionnaire an investor completes from its private
 * link: who it is, how it qualifies, its tax form and, for an entity, who
 * owns it. It never asks for bank details.
 */
export default function Subscribe() {
  const { token } = useParams();
  const { data, error, reload } = useApi<SubscribePublic>(`/subscribe/${token}`);
  const [f, setF] = useState<Record<string, unknown>>({});
  const [owners, setOwners] = useState<{ name: string; pct: string }[]>([{ name: "", pct: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ belowMinimum: boolean } | null>(null);
  if (error) return <main className="portal" id="main"><PageHead title="Subscription" /><ErrorState error={error} retry={() => void reload()} /></main>;
  if (!data) return <main className="portal" id="main"><Loading what="Loading" /></main>;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const submit = async () => {
    setErr(null);
    try {
      const r = await api<{ belowMinimum: boolean }>(`/subscribe/${token}`, { body: { legalName: data.investor, commitmentUsd: data.commitmentUsd ?? undefined, ...f, beneficialOwners: owners.filter((o) => o.name.trim()).map((o) => ({ name: o.name, pct: Number(o.pct) })) } });
      setDone(r);
      window.scrollTo(0, 0);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (done) {
    return (
      <main className="portal" id="main">
        <PageHead eyebrow={data.firm} title="Thank you" lead={`Your questionnaire for ${data.raise} is with ${data.firm}. They'll send the subscription documents for signature.`} />
        {done.belowMinimum && <Notice>Your commitment is below the fund's usual minimum; {data.firm} will confirm whether it can accept it.</Notice>}
      </main>
    );
  }
  return (
    <main className="portal" id="main">
      <PageHead eyebrow={data.firm} title={`${data.raise}: investor questionnaire`} lead={`For ${data.investor}. It takes about ten minutes. We never ask for bank details here or by email.`} />
      {data.documents.length > 0 && <Notice>Please read {data.documents.map((d) => d.title).join(", ")} in the data room before you answer.</Notice>}
      <form className="panel panel-pad section" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-labelledby="q-h">
        <h2 id="q-h">About the investor</h2>
        <div className="form-grid">
          <Field label="Legal name" required hint="Exactly as it should appear on the fund's register"><input className="input" required defaultValue={data.investor} onChange={(e) => set("legalName", e.target.value)} /></Field>
          <Field label="Commitment" required hint={data.minCommitmentUsd ? `Minimum $${data.minCommitmentUsd.toLocaleString("en-US")}` : undefined}><MoneyInput id="q-amt" value={(f.commitmentUsd as number | undefined) ?? data.commitmentUsd ?? undefined} onChange={(v) => set("commitmentUsd", v)} /></Field>
          <Field label="Country and state" required hint="Of residence, or where the entity is organized"><input className="input" required onChange={(e) => set("jurisdiction", e.target.value)} placeholder="US, Pennsylvania" /></Field>
          <Field label="Emails for notices" required><input className="input" required onChange={(e) => set("noticeEmails", e.target.value)} /></Field>
        </div>
        <h2>How you qualify</h2>
        <Field label="Accredited investor" required hint="Under SEC Rule 501(a)"><Select id="q-acc" value={f.accreditedBasis as string | undefined} onChange={(v) => set("accreditedBasis", v)} options={data.accreditedBases} /></Field>
        {data.needsQualifiedPurchaser && <Field label="Qualified purchaser" required hint="This fund accepts only qualified purchasers (Investment Company Act section 2(a)(51))"><Select id="q-qp" value={f.qpBasis as string | undefined} onChange={(v) => set("qpBasis", v)} options={data.qpBases} /></Field>}
        {data.generalSolicitation && (
          <label className="row small"><input type="checkbox" onChange={(e) => set("minimumInvestmentReps", e.target.checked)} /> I confirm I'm an accredited investor in the category above, and my commitment isn't financed, in whole or in part, by a third party for the purpose of this investment.</label>
        )}
        <label className="row small"><input type="checkbox" onChange={(e) => set("benefitPlan", e.target.checked)} /> The investor is a benefit plan investor: an ERISA plan, an IRA or Keogh plan, or an entity holding their assets (governmental and church plans are not)</label>
        {!data.naturalPerson && <label className="row small"><input type="checkbox" onChange={(e) => set("pooledVehicle", e.target.checked)} /> The investor is itself a fund or other pooled investment vehicle</label>}
        {!data.naturalPerson && <label className="row small"><input type="checkbox" onChange={(e) => set("foiaSubject", e.target.checked)} /> The investor is subject to public records laws (FOIA or a state equivalent)</label>}
        <h2>Tax</h2>
        <Field label="Tax form you'll provide" required><Select id="q-tax" value={f.taxForm as string | undefined} onChange={(v) => set("taxForm", v)} options={data.taxForms} /></Field>
        {!data.naturalPerson && (
          <fieldset className="section" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend><h2 style={{ margin: 0 }}>Beneficial owners</h2></legend>
            <p className="small muted" style={{ margin: 0 }}>Anyone who owns 25% or more of the investing entity, directly or indirectly.</p>
            {owners.map((o, i) => (
              <div key={i} className="form-grid">
                <Field label={`Owner ${i + 1}: name`}><input className="input" value={o.name} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
                <Field label="Ownership, %"><input className="input" inputMode="decimal" value={o.pct} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} /></Field>
              </div>
            ))}
            <div className="row"><button type="button" className="btn small ghost" onClick={() => setOwners([...owners, { name: "", pct: "" }])}>Add an owner</button></div>
            <label className="row small"><input type="checkbox" onChange={(e) => set("noOwnerOver25", e.target.checked)} /> No one owns 25% or more</label>
          </fieldset>
        )}
        <Field label="Source of the funds" hint="For example: operating income, endowment assets, proceeds of a business sale"><input className="input" onChange={(e) => set("sourceOfFunds", e.target.value)} /></Field>
        <h2>Signature</h2>
        <label className="row small"><input type="checkbox" required onChange={(e) => set("accurate", e.target.checked)} /> The answers are true and complete, and I'll tell the fund if any of them change.</label>
        <Field label="Your full name, as a signature" required><input className="input" required onChange={(e) => set("signedName", e.target.value)} /></Field>
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="row"><button className="btn primary">Submit</button></div>
      </form>
    </main>
  );
}
