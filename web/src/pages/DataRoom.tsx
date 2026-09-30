import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, useApi } from "../api";
import type { DataRoomPublic } from "../types";
import { ErrorState, Loading, Notice, PageHead, useToast } from "../ui";
import { longDate } from "./lp/shared";

/** What a prospective investor sees from its private data room link: no account, only approved documents. */
export default function DataRoom() {
  const { token } = useParams();
  const toast = useToast();
  const { data, error, reload } = useApi<DataRoomPublic>(`/data-room/${token}`);
  const [agreed, setAgreed] = useState(false);
  if (error) return <main className="portal" id="main"><PageHead title="Data room" /><ErrorState error={error} retry={() => void reload()} /></main>;
  if (!data) return <main className="portal" id="main"><Loading what="Loading the data room" /></main>;
  const acknowledge = async () => {
    try {
      await api(`/data-room/${token}/acknowledge`, { body: {} });
      void reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const href = (id: string, download: boolean) => `/api/data-room/${token}/docs/${id}${download ? "?download=1" : ""}`;
  return (
    <main className="portal" id="main">
      <PageHead eyebrow={data.firm} title={`${data.raise}: data room`} lead={`Prepared for ${data.investor}.`} />
      <Notice>{data.notice}</Notice>
      {!data.acknowledged ? (
        <form className="panel panel-pad section" onSubmit={(e) => { e.preventDefault(); void acknowledge(); }} aria-labelledby="ack-h">
          <h2 id="ack-h">Before you open the documents</h2>
          <label className="row small"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required /> I'll keep these materials confidential and use them only to evaluate an investment in {data.raise}.</label>
          <div className="row"><button className="btn primary" disabled={!agreed}>Open the data room</button></div>
        </form>
      ) : data.documents.length === 0 ? <Notice>No documents yet.</Notice> : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Documents</caption>
            <thead><tr><th scope="col">Document</th><th scope="col">Kind</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {data.documents.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.title} <span className="small muted">v{d.version}</span></th>
                  <td className="small">{d.category}</td>
                  <td className="small">{longDate(d.updatedAt)}</td>
                  <td><div className="row"><a className="btn small" href={href(d.id, false)} target="_blank" rel="noopener">View</a><a className="btn small ghost" href={href(d.id, true)} download>Download</a></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Opening a document is recorded and shared with {data.firm}.</p>
    </main>
  );
}
