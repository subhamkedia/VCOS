import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, Select, dateOnly, useToast } from "../../ui";
import { SourceViewer } from "../Company";
import type { TabProps } from "../Deal";

/**
 * Every meeting with the company from the firm's meeting tools (matched
 * automatically), and the team's own notes: reference calls, customer
 * calls, expert calls and site visits. Both become confidential sources
 * the extractor reads.
 */
export default function Calls({ data, onChange }: TabProps) {
  const [reading, setReading] = useState<string | null>(null);
  const kindLabel = (k: string) => data.noteKinds.find((n) => n.id === k)?.label ?? k;
  return (
    <>
      <div className="grid-2">
        <section className="section" aria-labelledby="mtg-h">
          <h2 id="mtg-h">Meetings</h2>
          {data.meetings.length === 0 ? (
            <Notice>No meetings with {data.deal.company_name} yet. Connect your calendar and notetaker under <Link to="/connections">Connections</Link>; calls are matched to companies by who attended. Unsure matches wait on the <Link to="/meetings">Meetings</Link> screen.</Notice>
          ) : (
            <ul className="panel timeline" style={{ padding: "0 14px" }}>
              {data.meetings.map((m) => (
                <li key={m.id}>
                  <span className="small muted">{dateOnly(m.started_at)}</span>
                  <span>
                    <strong>{m.title}</strong>
                    <span className="small muted"> · {m.sourceName}</span>
                    <br />
                    <span className="small">{m.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email).join(", ") || "No attendee list"}</span>
                    {m.has_words && m.evidence_id && <><br /><button className="btn ghost small" style={{ paddingLeft: 0 }} onClick={() => setReading(m.evidence_id)}>Read notes and transcript</button></>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="section" aria-labelledby="notes-h">
          <h2 id="notes-h">Your team's notes</h2>
          {data.notes.length === 0 ? <Notice>No notes yet. Log reference calls (including backchannel), customer calls, expert calls and site visits here: they count toward the checklist.</Notice> : (
            <ul className="panel timeline" style={{ padding: "0 14px" }}>
              {data.notes.map((n) => (
                <li key={n.id}>
                  <span className="small muted">{dateOnly(n.occurred_at)}</span>
                  <span>
                    <span className="pill outline">{kindLabel(n.kind)}</span> <strong>{n.title}</strong>{n.with ? <span className="small muted"> · with {String(n.with)}</span> : null}
                    <br /><span className="small">{n.excerpt}</span>
                    <br /><button className="btn ghost small" style={{ paddingLeft: 0 }} onClick={() => setReading(n.id)}>Read</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {reading && <SourceViewer id={reading} onClose={() => setReading(null)} />}
      <AddNote data={data} onChange={onChange} />
    </>
  );
}

function AddNote({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<string | undefined>("reference");
  const [title, setTitle] = useState("");
  const [who, setWho] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!can("work_deals")) return null;
  const help = data.noteKinds.find((k) => k.id === kind)?.help;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ claims: number; extracted: boolean }>(`/deals/${data.deal.id}/notes`, { body: { kind, title, with: who || undefined, date, text } });
      toast("good", r.extracted ? `Note saved. ${r.claims} ${r.claims === 1 ? "fact" : "facts"} extracted.` : "Note saved. Facts are extracted once Claude is configured on the server.");
      setTitle("");
      setWho("");
      setText("");
      onChange();
    } catch (x) {
      toast("bad", (x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" onSubmit={submit} aria-labelledby="add-note-h">
      <h2 id="add-note-h">Log a call or visit</h2>
      <div className="grid-3">
        <Field label="Kind" hint={help}><Select id="note-kind" value={kind} onChange={setKind} options={data.noteKinds} /></Field>
        <Field label="With"><input className="input" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name, role, company" /></Field>
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Title" required><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reference: Maya's former manager at Boston Dynamics" /></Field>
      <Field label="Notes" required hint="Write what was said, with numbers where you have them. Confidential: never shown outside your firm.">
        <textarea className="input" required minLength={20} style={{ minHeight: 140 }} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="row"><button className="btn primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save note"}</button></div>
    </form>
  );
}
