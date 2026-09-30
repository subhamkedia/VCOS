import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, Select, usePrompt, useToast } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";

const TONE = { open: "warn", mitigated: "info", closed: "good" } as const;

/** The conflicts register: found in the records (cross-fund deals, related-party charges, LPAC consents) or added by hand. */
export default function Conflicts({ data, onChange }: CoTabProps) {
  const { can } = useSession();
  const run = useRun(onChange);
  const prompt = usePrompt();
  const toast = useToast();
  const L = data.labels;
  const [f, setF] = useState<{ kind?: string; title: string; detail: string; mitigation: string }>({ title: "", detail: "", mitigation: "" });
  const detect = async () => {
    try {
      const r = await api<{ added: number }>("/compliance/conflicts/detect", { body: {} });
      toast("good", r.added ? `Found ${r.added} new in the records.` : "Nothing new in the records.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const move = async (id: string, status: "mitigated" | "closed", current: string | null) => {
    const m = await prompt({ title: status === "closed" ? "Close this conflict?" : "Record the mitigation", label: "How it's mitigated: disclosure, LPAC consent, recusal, or a change to the deal", confirm: status === "closed" ? "Close" : "Save", initial: current ?? "", required: !current, multiline: true });
    if (m === null) return;
    await run(() => api(`/compliance/conflicts/${id}`, { method: "PATCH", body: { status, mitigation: m || undefined } }), status === "closed" ? "Closed." : "Saved.");
  };
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="cf-h">
        <div className="spread">
          <h2 id="cf-h">Conflicts register</h2>
          {can("work_deals") && <button className="btn small" onClick={() => void detect()}>Check the records</button>}
        </div>
        {data.conflicts.length === 0 ? <Notice>None recorded. "Check the records" looks for companies held by more than one fund, related-party charges and LPAC conflict consents.</Notice> : data.conflicts.map((c) => (
          <article key={c.id} className="section" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div className="spread"><h3 style={{ margin: 0 }}>{c.title}</h3><span className={`pill ${TONE[c.status]}`}>{L.conflictStatus[c.status]}</span></div>
            <p className="small muted" style={{ margin: 0 }}>{L.conflictKinds[c.kind]} · raised by {person(c.created_by)} on {longDate(c.created_at)}{c.closed_by ? ` · closed by ${person(c.closed_by)}` : ""}</p>
            <p style={{ margin: 0 }}>{c.detail}</p>
            {c.mitigation && <p className="small" style={{ margin: 0 }}><strong>Mitigation:</strong> {c.mitigation}</p>}
            {c.status !== "closed" && can("decide_deals") && (
              <div className="row">
                {c.status === "open" && <button className="btn small" onClick={() => void move(c.id, "mitigated", c.mitigation)}>Record mitigation</button>}
                <button className="btn small ghost" onClick={() => void move(c.id, "closed", c.mitigation)}>Close</button>
              </div>
            )}
          </article>
        ))}
      </section>
      {can("work_deals") && (
        <form className="panel panel-pad section" aria-labelledby="ac-h" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/compliance/conflicts", { body: f }); setF({ title: "", detail: "", mitigation: "" }); }, "Added."); }}>
          <h2 id="ac-h">Add a conflict</h2>
          <div className="form-grid">
            <Field label="Kind" required><Select id="ac-k" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={Object.entries(L.conflictKinds).map(([id, label]) => ({ id, label }))} /></Field>
            <Field label="Title" required><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          </div>
          <Field label="What's in conflict" required hint="Who's on each side, and what could go wrong"><textarea className="input" required value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></Field>
          <Field label="Mitigation, if any"><input className="input" value={f.mitigation} onChange={(e) => setF({ ...f, mitigation: e.target.value })} /></Field>
          <div className="row"><button className="btn primary" disabled={!f.kind}>Add</button></div>
        </form>
      )}
    </>
  );
}
