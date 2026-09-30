import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { InitiativeRow } from "../../types";
import { Field, Notice, Select, dateOnly, usePrompt, useToast, usd } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { person } from "./shared";
import { useVocab } from "../../vocab";

const STATUS_LABEL: Record<InitiativeRow["status"], string> = { proposed: "Proposed", in_progress: "In progress", done: "Done", dropped: "Dropped" };
const STATUS_TONE: Record<InitiativeRow["status"], string> = { proposed: "quiet", in_progress: "info", done: "good", dropped: "outline" };

/**
 * The help the firm gives: hires, customer and partner introductions,
 * fundraising, strategy, government programs. Tracked to an outcome (a
 * signed pilot, a hire made), not activity. Introductions are double
 * opt-in email drafts in your own mailbox; nothing is sent for you.
 */
export default function Help({ data, onChange }: PfTabProps) {
  const vocab = useVocab();
  const { can } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const set = async (i: InitiativeRow, status: InitiativeRow["status"]) => {
    let outcome: string | undefined;
    if (status === "done" || status === "dropped") {
      const r = await prompt({ title: status === "done" ? "What came of it?" : "Why drop it?", label: status === "done" ? "Outcome (e.g. paid pilot signed for four sites)" : "Reason", confirm: "Save", required: true, multiline: true });
      if (!r) return;
      outcome = r;
    }
    try {
      await api(`/portfolio/initiatives/${i.id}`, { method: "PATCH", body: { status, outcome } });
      toast("good", "Updated.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const done = data.initiatives.filter((i) => i.status === "done");
  return (
    <>
      {can("work_deals") && <AddInitiative data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="vc-h">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="vc-h">Help given</h2>
          {done.length > 0 && <span className="small muted">{done.length} completed{done.some((d) => d.value_usd) ? ` · ${usd(done.reduce((a, d) => a + (d.value_usd ?? 0), 0))} of value noted` : ""}</span>}
        </div>
        {data.initiatives.length === 0 ? <Notice>Nothing recorded yet.</Notice> : (
          <ul className="timeline">
            {data.initiatives.map((i) => (
              <li key={i.id} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span><strong>{i.title}</strong> <span className="small muted">· {vocab.term("portfolio", "helpKinds", i.kind)}{i.owner ? ` · ${person(i.owner)}` : ""}{i.due_on ? ` · due ${dateOnly(i.due_on)}` : ""}</span></span>
                  <span className={`pill ${STATUS_TONE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                </div>
                {i.detail && <p className="small" style={{ margin: "4px 0 0" }}>{i.detail}</p>}
                {i.outcome && <p className="small" style={{ margin: "4px 0 0" }}><strong>Outcome:</strong> {i.outcome}{i.value_usd ? ` (${usd(i.value_usd)})` : ""}</p>}
                {i.outbox_id && <p className="small muted" style={{ margin: "4px 0 0" }}>Intro draft queued for approval.</p>}
                {can("work_deals") && (i.status === "proposed" || i.status === "in_progress") && (
                  <div className="row" style={{ marginTop: 6 }}>
                    {i.status === "proposed" && <button className="btn small" onClick={() => void set(i, "in_progress")}>Start</button>}
                    <button className="btn small" onClick={() => void set(i, "done")}>Done</button>
                    <button className="btn small ghost" onClick={() => void set(i, "dropped")}>Drop</button>
                    {i.kind === "customer_intro" || i.kind === "partnership" || i.kind === "hiring" ? <Intro initiative={i} company={data.company.name} founder={data.contacts[0]?.email} onDone={onChange} /> : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AddInitiative({ data, onChange }: PfTabProps) {
  const vocab = useVocab();
  const toast = useToast();
  const [kind, setKind] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await api(`/portfolio/companies/${data.company.id}/initiatives`, { body: { kind, title, detail, owner, dueOn: due || undefined } });
      toast("good", "Added.");
      setTitle("");
      setDetail("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="add-vc-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="add-vc-h">Add help</h2>
      <div className="form-grid">
        <Field label="Kind" required><Select id="vc-kind" value={kind} onChange={setKind} options={data.options.initiativeKinds.map((id) => ({ id, label: vocab.term("portfolio", "helpKinds", id) }))} /></Field>
        <Field label="What" required><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="E.g. intro to a state DOT bridge program" /></Field>
        <Field label="Owner"><input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
        <Field label="Due"><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <Field label="Detail"><textarea className="input" value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={!kind}>Add</button></div>
    </form>
  );
}

/** A double opt-in introduction as an email draft; a person approves it in Approvals, then sends it from their mailbox. */
function Intro({ initiative, company, founder, onDone }: { initiative: InitiativeRow; company: string; founder?: string; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(founder ?? "");
  const [subject, setSubject] = useState(`Intro: ${company}`);
  const [body, setBody] = useState(`Hi both,\n\nAs promised, connecting you. ${company} ...\n\nI'll let you take it from here.`);
  if (!open) return <button className="btn small ghost" onClick={() => setOpen(true)}>Draft the intro</button>;
  const send = async () => {
    try {
      await api(`/portfolio/initiatives/${initiative.id}/intro`, { body: { to, subject, body } });
      toast("good", "Draft queued for approval. Nothing is sent until you approve it and send it from your mailbox.");
      setOpen(false);
      onDone();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <form className="section" style={{ width: "100%", gap: 8 }} onSubmit={(e) => { e.preventDefault(); void send(); }} aria-label="Draft the introduction">
      <p className="small muted" style={{ margin: 0 }}>Ask both people first (double opt-in), then draft the intro to both.</p>
      <Field label="To" hint="Both people, separated by commas" required><input className="input" required value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Subject" required><input className="input" required value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Note" required><textarea className="input" required rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="row"><button className="btn primary small">Queue draft</button><button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
