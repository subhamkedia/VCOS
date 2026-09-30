import { ModuleSources } from "./ModuleSources";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { RaiseSummary } from "../types";
import { ErrorState, Loading, Notice, PageHead, useToast, usd } from "../ui";

/** Every raise with how far it's come: closed, weighted pipeline, coverage of the target. */
export default function Fundraising() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const { data, error, reload } = useApi<{ raises: RaiseSummary[] }>("/fundraising");
  const head = (
    <>
    <PageHead
      title="Fundraising & IR"
      lead="Raise the fund and look after its investors, from the first meeting to the final close. Nothing is sent without approval."
    />
    <ModuleSources module="fundraising" />
    </>
  );
  if (error) return <>{head}<ErrorState error={error} retry={() => void reload()} /></>;
  if (!data) return <>{head}<Loading what="Loading your raises" /></>;
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string; name: string }>("/fundraising/raises", { body: {} });
      toast("good", `${r.name} started from your firm profile.`);
      nav(`/fundraising/${r.id}`);
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {head}
      {can("decide_deals") && (
        <section className="panel panel-pad section" aria-labelledby="start-h">
          <h2 id="start-h">Start a raise</h2>
          <p className="small" style={{ margin: 0 }}>The fund's name, target, hard cap and closing dates come from your <Link to="/settings/fund">firm profile</Link>. Set the offering's exemptions and minimum on the raise once it's started.</p>
          <div className="row"><button className="btn primary" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start a raise from the firm profile"}</button></div>
        </section>
      )}
      {data.raises.length === 0 ? <Notice>No raises yet.</Notice> : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Raises</caption>
            <thead><tr><th scope="col">Raise</th><th scope="col" className="num">Target</th><th scope="col" className="num">Closed</th><th scope="col" className="num">Weighted pipeline</th><th scope="col" className="num">Coverage</th><th scope="col">Follow-ups due</th></tr></thead>
            <tbody>
              {data.raises.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/fundraising/${r.id}`)}>
                  <th scope="row"><Link to={`/fundraising/${r.id}`} onClick={(e) => e.stopPropagation()}><strong>{r.name}</strong></Link><div className="small muted">{r.status === "open" ? "Open" : "Closed"} · {r.prospects} live prospects</div></th>
                  <td className="num">{usd(r.targetUsd)}{r.hardCapUsd ? <div className="small muted">cap {usd(r.hardCapUsd)}</div> : null}</td>
                  <td className="num">{usd(r.closedUsd)}</td>
                  <td className="num">{usd(r.weightedUsd)}</td>
                  <td className="num">{r.coverage === null ? "—" : `${(r.coverage * 100).toFixed(0)}%`}</td>
                  <td>{r.followUpsDue ? <span className="pill warn">{r.followUpsDue}</span> : <span className="small muted">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
