import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../api";
import type { ExecutionRow, IcPhase, Investment, TermSheetStatus } from "../types";
import { ErrorState, Loading, Notice, PageHead, Seg, Time, dateOnly, usd } from "../ui";
import { Progress, STAGE_LABELS, STAGE_TONE } from "./Diligence";

export const PHASE_LABELS: Record<IcPhase, string> = {
  pre_vote: "Independent votes", discussion: "In discussion", post_vote: "Final votes", decided: "Decided", cancelled: "Cancelled",
};
export const TERM_STATUS_LABELS: Record<TermSheetStatus, string> = {
  draft: "Draft", proposed: "Proposed", negotiating: "Negotiating", signed: "Signed", superseded: "Superseded",
};
export const SECURITY_LABELS: Record<string, string> = {
  preferred: "Priced round (preferred)", safe_post: "Post-money SAFE", safe_pre: "Pre-money SAFE", note: "Convertible note",
};

/** Deals from IC to close, and the investments closed so far. */
export default function Execution() {
  const nav = useNavigate();
  const [view, setView] = useState<"active" | "closed">("active");
  const { data, error, reload } = useApi<ExecutionRow[]>("/execution");
  const inv = useApi<Investment[]>(view === "closed" ? "/investments" : null);
  const active = (data ?? []).filter((d) => d.stage !== "closed");
  return (
    <>
      <PageHead
        eyebrow="Module"
        title="Investment Execution"
        lead="From IC to a closed investment: independent committee votes, term sheets checked against NVCA and your house terms, the round and your returns modelled in code, and a closing checklist with signature, sanctions and wire controls. VC OS never sends a document or moves money."
      />
      <Seg label="Which deals" options={[{ id: "active", label: "In progress" }, { id: "closed", label: "Closed investments" }]} value={view} onChange={setView} />
      {view === "active" ? (
        error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading what="Loading deals" /> : active.length === 0 ? (
          <Notice>No deals at IC or closing. Send a deal to IC from its Decision tab in <Link to="/diligence">Diligence</Link>.</Notice>
        ) : (
          <div className="panel table-wrap">
            <table className="t">
              <caption className="sr-only">Deals from IC to close</caption>
              <thead>
                <tr><th scope="col">Company</th><th scope="col">Stage</th><th scope="col">IC</th><th scope="col">Term sheet</th><th scope="col">Closing</th><th scope="col">Our check</th><th scope="col">Last change</th></tr>
              </thead>
              <tbody>
                {active.map((d) => (
                  <tr key={d.id} className="click" onClick={() => nav(`/execution/${d.id}`)}>
                    <td><Link to={`/execution/${d.id}`} onClick={(e) => e.stopPropagation()}><strong>{d.company_name}</strong></Link></td>
                    <td><span className={`pill ${STAGE_TONE[d.stage]}`}>{STAGE_LABELS[d.stage]}</span></td>
                    <td className="small">{d.ic ? (d.ic.outcome ? <span className={`pill ${d.ic.outcome === "approved" ? "good" : "bad"}`}>{d.ic.outcome === "approved" ? "Approved" : "Declined"}</span> : PHASE_LABELS[d.ic.phase]) : <span className="muted">Not scheduled</span>}</td>
                    <td className="small">{d.termSheet ? `v${d.termSheet.version} · ${TERM_STATUS_LABELS[d.termSheet.status]}` : <span className="muted">—</span>}</td>
                    <td style={{ minWidth: 150 }}>
                      {d.closing ? (
                        <>
                          <Progress done={d.closing.done} total={d.closing.total} label={`${d.company_name} closing`} />
                          {d.closing.redFlags > 0 && <span className="pill bad">{d.closing.redFlags} red {d.closing.redFlags === 1 ? "flag" : "flags"}</span>}
                        </>
                      ) : <span className="muted small">Not started</span>}
                    </td>
                    <td className="num">{usd(d.our_check_usd)}</td>
                    <td className="small muted"><Time at={d.updated_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : inv.error ? <ErrorState error={inv.error} retry={() => void inv.reload()} /> : !inv.data ? <Loading what="Loading investments" /> : inv.data.length === 0 ? (
        <Notice>No closed investments yet. They appear here, and in Portfolio, when a deal closes.</Notice>
      ) : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Closed investments</caption>
            <thead>
              <tr><th scope="col">Company</th><th scope="col">Closed</th><th scope="col">Instrument</th><th scope="col">Invested</th><th scope="col">Ownership (fully diluted)</th><th scope="col">Post-money</th><th scope="col">Board</th></tr>
            </thead>
            <tbody>
              {inv.data.map((i) => (
                <tr key={i.id} className="click" onClick={() => nav(`/execution/${i.deal_id}`)}>
                  <td><Link to={`/execution/${i.deal_id}`} onClick={(e) => e.stopPropagation()}><strong>{i.company_name}</strong></Link><div className="small muted">{i.fund_name}</div></td>
                  <td className="small">{dateOnly(i.close_date)}</td>
                  <td className="small">{i.series_name ?? SECURITY_LABELS[i.security]}</td>
                  <td className="num">{usd(i.amount_usd)}</td>
                  <td className="num">{i.ownership_fd_pct === null ? "—" : `${i.ownership_fd_pct.toFixed(2)}%`}</td>
                  <td className="num">{usd(i.post_money_usd)}</td>
                  <td className="small">{i.board_role === "seat" ? "Seat" : i.board_role === "observer" ? "Observer" : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
