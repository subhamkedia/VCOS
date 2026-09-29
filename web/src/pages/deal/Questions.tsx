import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Question, Workstream } from "../../types";
import { Field, Notice, Seg, Select, TagInput, usePrompt, useToast } from "../../ui";
import type { TabProps } from "../Deal";

const ORIGIN: Record<Question["origin"], string> = {
  gap: "Missing", unverified: "Needs proof", contradiction: "Sources disagree", pilot: "Pilot", risk: "Risk", custom: "Yours",
};
const STATUS_TONE: Record<Question["status"], string> = { open: "info", asked: "warn", answered: "good", dropped: "quiet" };
const STATUS_LABEL: Record<Question["status"], string> = { open: "Open", asked: "Asked", answered: "Answered", dropped: "Dropped" };

/**
 * Questions for the founders: from what's missing, what only the company
 * has said, where sources disagree, and pilots that haven't converted.
 * Pick some and VC OS drafts the email for approval; it never sends.
 */
export default function Questions({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const [show, setShow] = useState<"open" | "all">("open");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emailing, setEmailing] = useState(false);
  const list = data.questions.filter((q) => show === "all" || q.status === "open" || q.status === "asked");
  const founders = useMemo(() => {
    const emails = new Set<string>();
    for (const m of data.meetings) for (const a of m.attendees) if (!a.self && a.email) emails.add(a.email);
    return [...emails];
  }, [data.meetings]);
  const [to, setTo] = useState<string[]>(founders.slice(0, 2));
  const patch = async (q: Question, body: object, done?: string) => {
    try {
      await api(`/deals/${data.deal.id}/questions/${q.id}`, { method: "PATCH", body });
      if (done) toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const answer = async (q: Question) => {
    const a = await prompt({ title: "Record the answer", label: q.text, confirm: "Save answer", initial: q.answer ?? "", required: true, multiline: true });
    if (a) await patch(q, { status: "answered", answer: a }, "Answer saved. Log it as a note too if it's a fact the ledger should know.");
  };
  const email = async () => {
    try {
      const r = await api<{ channel: string }>(`/deals/${data.deal.id}/questions/email`, { body: { to, questionIds: [...picked] } });
      toast("good", `Draft queued for approval (${r.channel === "gmail_draft" ? "Gmail" : "Outlook"}). Nothing is sent until someone approves it, and then only as a draft in your mailbox.`);
      setPicked(new Set());
      setEmailing(false);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <>
      <div className="spread">
        <Seg label="Which questions" options={[{ id: "open", label: "Open and asked" }, { id: "all", label: "Everything" }]} value={show} onChange={setShow} />
        {can("queue") && <button className="btn primary" disabled={!picked.size} onClick={() => setEmailing(!emailing)} aria-expanded={emailing}>Draft email with {picked.size || "selected"} {picked.size === 1 ? "question" : "questions"}</button>}
      </div>
      {emailing && (
        <section className="panel panel-pad section" aria-label="Email to the founders">
          <Field label="To" hint={founders.length ? "Suggested from people outside your firm in meetings with this company." : "Add the founders' email addresses."}>
            <TagInput id="q-to" value={to} onChange={setTo} placeholder="founder@company.com" suggestions={founders.filter((f) => !to.includes(f))} />
          </Field>
          <p className="small muted" style={{ margin: 0 }}>VC OS writes the email and puts it in <Link to="/approvals">Approvals</Link>. Once a partner approves it, it appears as a draft in your mailbox for you to send.</p>
          <div className="row"><button className="btn primary small" disabled={!to.length} onClick={() => void email()}>Queue draft for approval</button><button className="btn ghost small" onClick={() => setEmailing(false)}>Cancel</button></div>
        </section>
      )}
      {list.length === 0 ? <Notice tone="good">No open questions.</Notice> : (
        <ul className="panel" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Questions">
          {list.map((q) => (
            <li key={q.id} className="item" style={{ gridTemplateColumns: "28px minmax(0,1fr) auto" }}>
              <input type="checkbox" aria-label={`Include in email: ${q.text}`} checked={picked.has(q.id)} disabled={q.status === "answered" || q.status === "dropped"} onChange={() => toggle(q.id)} style={{ marginTop: 5 }} />
              <div>
                <p style={{ margin: 0 }}>{q.text}</p>
                <div className="row small" style={{ marginTop: 4 }}>
                  <span className={`pill ${STATUS_TONE[q.status]}`}>{STATUS_LABEL[q.status]}</span>
                  <span className="pill outline">{ORIGIN[q.origin]}</span>
                  <span className="muted">{data.workstreams.find((w) => w.id === q.workstream)?.label}</span>
                </div>
                {q.answer && <p className="small" style={{ marginTop: 6 }}><strong>Answer:</strong> {q.answer}</p>}
              </div>
              {can("work_deals") && (
                <div className="actions">
                  {q.status !== "answered" && <button className="btn small" onClick={() => void answer(q)}>Answered</button>}
                  {q.status === "open" && <button className="btn ghost small" onClick={() => void patch(q, { status: "asked" })}>Mark asked</button>}
                  {q.status !== "dropped" ? <button className="btn ghost small" onClick={() => void patch(q, { status: "dropped" })}>Drop</button> : <button className="btn ghost small" onClick={() => void patch(q, { status: "open" })}>Reopen</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {can("work_deals") && <AddQuestion data={data} onChange={onChange} />}
    </>
  );
}

function AddQuestion({ data, onChange }: TabProps) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [ws, setWs] = useState<Workstream | undefined>("traction");
  return (
    <form className="panel panel-pad section" onSubmit={(e) => {
      e.preventDefault();
      void api(`/deals/${data.deal.id}/questions`, { body: { workstream: ws, text } }).then(() => { setText(""); onChange(); toast("good", "Question added."); }).catch((x: Error) => toast("bad", x.message));
    }}>
      <h2>Add your own question</h2>
      <div className="grid-2">
        <Field label="Question" required><input className="input" required value={text} onChange={(e) => setText(e.target.value)} placeholder="Can we see the robot on a live pour?" /></Field>
        <Field label="Workstream"><Select id="q-ws" value={ws} onChange={setWs} options={data.workstreams} /></Field>
      </div>
      <div className="row"><button className="btn small primary">Add question</button></div>
    </form>
  );
}
