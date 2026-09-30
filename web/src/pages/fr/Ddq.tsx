import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { DdqQuestion, RaiseView } from "../../types";
import { ErrorState, Loading, Notice, Select, useToast } from "../../ui";
import { longDate, person } from "../lp/shared";

/**
 * The DDQ library, in the ILPA DDQ 2.0's sections. Answers the firm's
 * records support can be drafted from them (with the source named); a
 * second person approves every answer; only approved answers are exported.
 */
export default function Ddq({ data }: { data: RaiseView }) {
  const { can, me } = useSession();
  const toast = useToast();
  const self = `human:${me.user.email.toLowerCase()}`;
  const q = useApi<{ sections: { section: string; questions: DdqQuestion[] }[] }>("/fundraising/ddq");
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [to, setTo] = useState<string | undefined>();
  if (q.error) return <ErrorState error={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="Loading the DDQ" />;
  const all = q.data.sections.flatMap((s) => s.questions);
  const approved = all.filter((x) => x.answer?.status === "approved").length;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      void q.reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const exportAs = async (format: "markdown" | "csv") => {
    try {
      const r = await api<{ filename: string; text: string }>("/fundraising/ddq/export", { body: { prospectId: to, format } });
      const url = URL.createObjectURL(new Blob([r.text], { type: format === "csv" ? "text/csv" : "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast("good", to ? "Exported and logged on the prospect's record." : "Exported.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="ddq-h">
        <div className="spread">
          <h2 id="ddq-h">Due diligence questionnaire</h2>
          {can("work_deals") && <button className="btn small" onClick={() => void run(() => api("/fundraising/ddq/draft", { body: {} }), "Drafted what your records support. Review each before approving.")}>Draft from our records</button>}
        </div>
        <p className="small" style={{ margin: 0 }}>{approved} of {all.length} answers approved. A DDQ is marketing material: performance answers come only from approved LP reports, net beside gross. Approved answers over a year old are flagged for review.</p>
        <div className="row">
          <div style={{ minWidth: 240 }}><label className="sr-only" htmlFor="ddq-to">For which prospect</label><Select id="ddq-to" value={to} onChange={setTo} options={data.prospects.filter((p) => p.stage !== "declined").map((p) => ({ id: p.id, label: p.name }))} placeholder="Not for a prospect" /></div>
          {can("queue") && <><button className="btn small" onClick={() => void exportAs("markdown")}>Export (Markdown)</button><button className="btn small ghost" onClick={() => void exportAs("csv")}>Export (CSV)</button></>}
        </div>
      </section>
      {q.data.sections.map((s) => (
        <section key={s.section} className="panel panel-pad section" aria-labelledby={`ddq-${s.section}`}>
          <h2 id={`ddq-${s.section}`}>{s.section}</h2>
          {s.questions.map((x) => (
            <div key={x.key} className="section" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div className="spread">
                <strong>{x.question}</strong>
                <span>{x.answer ? <span className={`pill ${x.answer.status === "approved" ? (x.stale ? "warn" : "good") : "info"}`}>{x.answer.status === "approved" ? (x.stale ? "Approved, due for review" : "Approved") : "Draft"}</span> : <span className="pill outline">Unanswered</span>}</span>
              </div>
              {editing === x.key ? (
                <form className="section" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/fundraising/ddq/${x.key}`, { method: "PUT", body: { answer: text } }); setEditing(null); }, "Saved as a draft for review."); }}>
                  <label className="sr-only" htmlFor={`a-${x.key}`}>Answer</label>
                  <textarea id={`a-${x.key}`} className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} required />
                  <div className="row"><button className="btn small primary">Save</button><button type="button" className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : x.answer ? (
                <>
                  <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{x.answer.answer}</p>
                  <p className="small muted" style={{ margin: 0 }}>Source: {x.answer.sources.join("; ")} · by {person(x.answer.updated_by)}{x.answer.approved_by ? `, approved by ${person(x.answer.approved_by)} ${longDate(x.answer.approved_at)}` : ""}</p>
                </>
              ) : null}
              {editing !== x.key && (
                <div className="row">
                  {can("work_deals") && <button className="btn small ghost" onClick={() => { setEditing(x.key); setText(x.answer?.answer ?? ""); }}>{x.answer ? "Edit" : "Answer"}</button>}
                  {x.answer?.status === "draft" && can("decide_deals") && x.answer.updated_by !== self && <button className="btn small primary" onClick={() => void run(() => api(`/fundraising/ddq/${x.key}/approve`, { body: {} }), "Approved.")}>Approve</button>}
                  {x.answer?.status === "draft" && x.answer.updated_by === self && <span className="small muted">Another partner approves it</span>}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
