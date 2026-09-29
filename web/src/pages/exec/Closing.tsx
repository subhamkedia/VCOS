import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { ClosingItem, ClosingStatus } from "../../types";
import { Field, Notice, dateOnly, usePrompt, useToast } from "../../ui";
import { Progress } from "../Diligence";
import { person, type ExecTabProps } from "../ExecutionDeal";

export const CLOSING_LABELS: Record<ClosingStatus, string> = {
  open: "Open", requested: "Requested", received: "Received", signed: "Signed", filed: "Filed", done: "Done", waived: "Waived", na: "Not applicable", red_flag: "Red flag",
};
const TONE: Record<ClosingStatus, string> = {
  open: "quiet", requested: "info", received: "info", signed: "good", filed: "good", done: "good", waived: "outline", na: "outline", red_flag: "bad",
};
const COMPLETE: ClosingStatus[] = ["done", "signed", "filed", "received", "waived", "na"];
const NEEDS_REASON: ClosingStatus[] = ["waived", "na", "red_flag"];
// These complete from the wire record (Wire and close tab), never by hand.
const WIRE_STEPS = ["wire_callback", "wire_approvals", "funds_sent"];
const SIGNABLE = ["spa", "charter", "ira", "voting_agreement", "rofr_cosale", "board_consent", "stockholder_consent", "safe_or_note", "pro_rata_letter", "management_rights_letter", "compliance_certificate"];

/**
 * The closing checklist, built from the signed terms: the financing
 * documents, approvals and filings, compliance (sanctions, KYC, conflicts,
 * OISP), funding and the steps after closing. Signature status comes from
 * DocuSign; a DocuSign envelope is only ever created as a draft, after a
 * partner approves it.
 */
export default function Closing({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const items = data.closing.items;
  const run = async (key: string, path: string, done: (r: never) => string) => {
    setBusy(key);
    try {
      const r = await api<never>(path, { body: {} });
      toast("good", done(r));
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (data.deal.stage === "ic" || data.deal.stage === "screening" || data.deal.stage === "diligence") {
    return <Notice>Closing starts once IC approves the deal.</Notice>;
  }
  if (!items.length) {
    return data.deal.stage === "approved" && can("work_deals") ? (
      <section className="panel panel-pad section" aria-labelledby="start-h">
        <h2 id="start-h">Start closing</h2>
        <p className="small muted" style={{ margin: 0 }}>Builds the checklist from the signed term sheet (or the latest one), the deal's flags and your fund's investors: a priced round gets the NVCA document set; a SAFE or note gets its own short list.</p>
        <div className="row"><button className="btn primary" disabled={busy === "start"} aria-busy={busy === "start"} onClick={() => void run("start", `/deals/${data.deal.id}/closing`, () => "Closing checklist ready.")}>Start closing</button></div>
      </section>
    ) : <Notice>No closing checklist for this deal.</Notice>;
  }
  const done = items.filter((i) => COMPLETE.includes(i.status)).length;
  const red = items.filter((i) => i.status === "red_flag");
  const withEnvelope = items.some((i) => i.envelope_id);
  const cats = Object.keys(data.closing.categories);
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="cl-h">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="cl-h">Closing checklist</h2>
          <Progress done={done} total={items.length} label="Closing checklist" />
        </div>
        {red.length > 0 ? <Notice tone="bad">Red flags: {red.map((i) => i.title).join("; ")}.</Notice>
          : data.closing.ready.ready ? <Notice tone="good">Everything required before funding is done. Record the close on the Wire and close tab once the wire is sent.</Notice>
          : <Notice>{data.closing.ready.open.length} required {data.closing.ready.open.length === 1 ? "item" : "items"} open before closing.</Notice>}
        {can("work_deals") && data.deal.stage === "closing" && (
          <div className="row">
            <button className="btn" disabled={busy === "ofac"} aria-busy={busy === "ofac"} onClick={() => void run("ofac", `/deals/${data.deal.id}/closing/sanctions`, (r: { names: string[]; results: { hits: unknown[] }[] }) => {
              const hits = r.results.filter((x) => x.hits.length).length;
              return hits ? `${hits} potential ${hits === 1 ? "match" : "matches"} to review.` : `${r.names.length} names screened: no matches.`;
            })}>Screen against OFAC lists</button>
            {withEnvelope && <button className="btn" disabled={busy === "ds"} aria-busy={busy === "ds"} onClick={() => void run("ds", `/deals/${data.deal.id}/closing/signatures/sync`, (r: { updated: number }) => r.updated ? `${r.updated} ${r.updated === 1 ? "item" : "items"} updated from DocuSign.` : "No changes in DocuSign.")}>Check DocuSign</button>}
          </div>
        )}
      </section>
      {cats.map((c) => {
        const list = items.filter((i) => i.category === c);
        if (!list.length) return null;
        return (
          <section key={c} className="panel panel-pad section" aria-labelledby={`cat-${c}`}>
            <h2 id={`cat-${c}`}>{data.closing.categories[c]}</h2>
            <ul className="timeline" style={{ gap: 0 }}>
              {list.map((i) => <Item key={i.key} i={i} dealId={data.deal.id} editable={can("work_deals") && data.deal.stage === "closing"} onChange={onChange} />)}
            </ul>
          </section>
        );
      })}
      {can("work_deals") && data.deal.stage === "closing" && <AddItem dealId={data.deal.id} categories={data.closing.categories} onDone={onChange} />}
    </>
  );
}

function Item({ i, dealId, editable, onChange }: { i: ClosingItem; dealId: string; editable: boolean; onChange: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const [signing, setSigning] = useState(false);
  const wireStep = WIRE_STEPS.includes(i.key);
  const patch = async (body: object, done: string) => {
    try {
      await api(`/deals/${dealId}/closing/${encodeURIComponent(i.key)}`, { method: "PATCH", body });
      toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const setStatus = async (status: ClosingStatus) => {
    let note: string | undefined;
    if (NEEDS_REASON.includes(status)) {
      const r = await prompt({ title: `${CLOSING_LABELS[status]}: ${i.title}`, label: "Why?", confirm: "Save", required: true });
      if (!r) return;
      note = r;
    }
    await patch({ status, note }, `${i.title}: ${CLOSING_LABELS[status].toLowerCase()}.`);
  };
  const envelope = async () => {
    const r = await prompt({ title: "Link a DocuSign envelope", label: "Envelope ID (from DocuSign)", confirm: "Link", initial: i.envelope_id ?? "" });
    if (r !== null) await patch({ envelopeId: r || null }, r ? "Envelope linked. Status updates when you check DocuSign." : "Envelope unlinked.");
  };
  return (
    <li style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <strong>{i.title}</strong> {i.required ? <span className="pill outline">Required</span> : <span className="pill quiet">Optional</span>}
          <div className="small muted">
            {i.note && <span>{i.note} · </span>}
            {i.envelope_id && <span>DocuSign envelope linked · </span>}
            {i.due_date && <span>Due {dateOnly(i.due_date)} · </span>}
            {i.owner && <span>{person(i.owner)} · </span>}
            {i.status !== "open" && <span>updated by {person(i.updated_by)}</span>}
            {i.evidence_id && <span> · record kept in the ledger</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className={`pill ${TONE[i.status]}`}>{CLOSING_LABELS[i.status]}</span>
          {editable && !wireStep && (
            <select className="input" style={{ width: "auto" }} aria-label={`Status of ${i.title}`} value="" onChange={(e) => e.target.value && void setStatus(e.target.value as ClosingStatus)}>
              <option value="">Change…</option>
              {(Object.keys(CLOSING_LABELS) as ClosingStatus[]).filter((s) => s !== i.status).map((s) => <option key={s} value={s}>{CLOSING_LABELS[s]}</option>)}
            </select>
          )}
          {editable && SIGNABLE.includes(i.key) && (
            <>
              {can("queue") && <button className="btn small" onClick={() => setSigning(!signing)} aria-expanded={signing}>Prepare for signature</button>}
              <button className="btn small ghost" onClick={() => void envelope()}>{i.envelope_id ? "Envelope" : "Link envelope"}</button>
            </>
          )}
        </div>
      </div>
      {signing && <SignatureDraft dealId={dealId} item={i} onDone={() => { setSigning(false); onChange(); }} />}
    </li>
  );
}

/** Queue a DocuSign envelope as a draft. It's created only after a partner approves it in Approvals, and a person sends it from DocuSign. */
function SignatureDraft({ dealId, item, onDone }: { dealId: string; item: ClosingItem; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [signers, setSigners] = useState([{ name: "", email: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const form = new FormData();
    form.append("file", file);
    form.append("itemKey", item.key);
    form.append("signers", JSON.stringify(signers.filter((s) => s.email.trim())));
    try {
      await api(`/deals/${dealId}/closing/signatures/uploads`, { form });
      toast("good", "Queued for approval. Once approved, the draft envelope appears in DocuSign for you to send.");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="section" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={`Prepare ${item.title} for signature`}>
      <Field label="Document (PDF or Word)" required><input className="input" type="file" required accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      {signers.map((s, idx) => (
        <div className="grid-2" key={idx}>
          <Field label={`Signer ${idx + 1} name`} required><input className="input" required value={s.name} onChange={(e) => setSigners(signers.map((x, j) => (j === idx ? { ...x, name: e.target.value } : x)))} /></Field>
          <Field label={`Signer ${idx + 1} email`} required><input className="input" type="email" required value={s.email} onChange={(e) => setSigners(signers.map((x, j) => (j === idx ? { ...x, email: e.target.value } : x)))} /></Field>
        </div>
      ))}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <button type="button" className="btn small ghost" onClick={() => setSigners([...signers, { name: "", email: "" }])}>Add a signer</button>
        <button className="btn primary" disabled={busy || !file} aria-busy={busy}>Queue draft for approval</button>
      </div>
    </form>
  );
}

function AddItem({ dealId, categories, onDone }: { dealId: string; categories: Record<string, string>; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("documents");
  const [required, setRequired] = useState(false);
  const submit = async () => {
    try {
      await api(`/deals/${dealId}/closing/items`, { body: { title, category, required } });
      toast("good", "Item added.");
      setTitle("");
      onDone();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="add-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="add-h">Add an item</h2>
      <div className="form-grid">
        <Field label="What's needed" required><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="E.g. side letter on information rights" /></Field>
        <Field label="Section">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </Field>
      </div>
      <label className="check-row"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /><span>Required before closing</span></label>
      <div className="row"><button className="btn">Add</button></div>
    </form>
  );
}
