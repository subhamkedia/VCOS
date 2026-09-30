import { useRef, useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { DataRoomDoc } from "../../types";
import { Field, Notice, Select, useConfirm, useToast } from "../../ui";
import type { FrTabProps } from "../Raise";
import { STATUS_TONE, longDate, person } from "../lp/shared";

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/**
 * The data room's documents. Each new version waits for a second person's
 * review before any investor can see it; marketing material (the deck, the
 * track record, the DDQ) gets the Marketing Rule review then.
 */
export default function Room({ data, onChange }: FrTabProps) {
  const { can, me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = `human:${me.user.email.toLowerCase()}`;
  const L = data.labels;
  const act = async (d: DataRoomDoc, what: "approve" | "archive") => {
    if (what === "archive" && !(await confirm({ title: `Archive ${d.title} v${d.version}?`, body: "Investors stop seeing it. It stays on record.", confirm: "Archive", danger: true }))) return;
    if (what === "approve" && !(await confirm({ title: `Approve ${d.title} v${d.version} for investors?`, body: d.marketing ? "This is marketing material: check that performance is shown net beside gross, with the time periods and the risks, and that nothing is misleading." : "Investors with a data room link will see it.", confirm: "Approve" }))) return;
    try {
      await api(`/fundraising/docs/${d.id}/${what}`, { body: {} });
      toast("good", what === "approve" ? "Approved: investors can see it." : "Archived.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const viewers = new Map(data.prospects.map((p) => [p.id, p.name]));
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="docs-h">
        <h2 id="docs-h">Documents</h2>
        {data.documents.length === 0 ? <Notice>No documents yet. Start with the deck, the LPA and the subscription agreement.</Notice> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Data room documents</caption>
              <thead><tr><th scope="col">Document</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id}>
                    <th scope="row"><a href={`/api/fundraising/docs/${d.id}/file`} download>{d.title}</a> <span className="muted small">v{d.version}</span><div className="small muted">{d.file_name} · {size(d.size_bytes)} · uploaded by {person(d.uploaded_by)}</div></th>
                    <td className="small">{L.docCategories[d.category]}{d.marketing && <div><span className="pill outline">Marketing material</span></div>}</td>
                    <td><span className={`pill ${STATUS_TONE[d.status === "draft" ? "pending" : d.status === "archived" ? "withdrawn" : "approved"]}`}>{L.docStatus[d.status]}</span>{d.approved_by && <div className="small muted">by {person(d.approved_by)}</div>}</td>
                    <td>
                      <div className="row">
                        {d.status === "draft" && can("decide_deals") && d.uploaded_by !== self && <button className="btn small primary" onClick={() => void act(d, "approve")}>Review and approve</button>}
                        {d.status === "draft" && d.uploaded_by === self && <span className="small muted">Another partner reviews it</span>}
                        {d.status !== "archived" && can("work_deals") && <button className="btn small ghost" onClick={() => void act(d, "archive")}>Archive</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {can("upload") && <Upload data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="views-h">
        <h2 id="views-h">Recent activity</h2>
        {data.dataRoomViews.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No one has opened the data room yet. Share it from a prospect in the pipeline.</p> : (
          <ul className="timeline small">
            {data.dataRoomViews.slice(0, 20).map((v, i) => <li key={i}><span>{longDate(v.viewed_at)}</span><span><strong>{viewers.get(v.prospect_id) ?? "A prospect"}</strong> {v.action === "download" ? "downloaded" : "viewed"} {v.title}</span></li>)}
          </ul>
        )}
      </section>
    </>
  );
}

function Upload({ data, onChange }: FrTabProps) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const f = file.current?.files?.[0];
    if (!f || !category) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", f);
      form.append("category", category);
      if (title) form.append("title", title);
      await api(`/fundraising/raises/${data.raise.id}/docs/uploads`, { form });
      toast("good", "Uploaded. A partner who didn't upload it reviews it before investors see it.");
      setTitle("");
      if (file.current) file.current.value = "";
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="up-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="up-h">Upload a document</h2>
      <div className="form-grid">
        <Field label="What it is" required><Select id="u-cat" value={category} onChange={setCategory} options={Object.entries(data.labels.docCategories).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Title" hint="Same title as an earlier file makes a new version"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="File" required hint="PDF, PowerPoint, Word, Excel, CSV or text, up to 25 MB"><input ref={file} className="input" type="file" required /></Field>
      </div>
      <div className="row"><button className="btn primary" disabled={busy || !category}>{busy ? "Uploading…" : "Upload"}</button></div>
    </form>
  );
}
