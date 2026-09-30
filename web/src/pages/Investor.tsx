import { useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../api";
import type { InvestorPortal } from "../types";
import { ErrorState, Loading, Notice, PageHead, usd } from "../ui";
import { LetterView, NetAndGross, StatementTable, irr, longDate, quarterLabel, x2 } from "./lp/shared";

/**
 * What an investor sees from its private link: the fund's approved reports
 * with its own capital account, its capital call and distribution notices,
 * and its tax documents. No account needed, and nothing about any other
 * investor.
 */
export default function Investor() {
  const { token } = useParams();
  const { data, error, reload } = useApi<InvestorPortal>(`/investor/${token}`);
  const [pick, setPick] = useState(0);
  if (error) return <main className="portal" id="main"><PageHead title="Your investor reports" /><ErrorState error={error} retry={() => void reload()} /></main>;
  if (!data) return <main className="portal" id="main"><Loading what="Loading your reports" /></main>;
  const r = data.reports[pick];
  return (
    <main className="portal" id="main">
      <PageHead eyebrow={data.firm} title={`${data.fund.name}: ${data.investor.name}`} lead={`Commitment ${usd(data.investor.commitment)}, admitted ${longDate(data.investor.admittedOn)}. This page is private to you: please don't forward the link.`} />
      <Notice>We never ask for payment or bank details through this page or by email alone. If wire instructions ever seem to change, call us on a number you already have before sending anything.</Notice>
      {data.reports.length === 0 ? <Notice>No reports yet. They appear here once approved.</Notice> : (
        <>
          {data.reports.length > 1 && (
            <nav className="row" aria-label="Reports">
              {data.reports.map((x, i) => <button key={x.id} className={`btn small ${i === pick ? "primary" : "ghost"}`} aria-pressed={i === pick} onClick={() => setPick(i)}>{quarterLabel(x.period)}</button>)}
            </nav>
          )}
          {r && (
            <>
              <section className="panel panel-pad section" aria-labelledby="iv-acc">
                <div className="spread">
                  <h2 id="iv-acc">Your capital account, {quarterLabel(r.period)}</h2>
                  <a className="btn small" href={`/api/investor/${token}/reports/${r.id}/statement.csv`} download>Download (CSV)</a>
                </div>
                {r.statement ? <StatementTable caption="Your capital account" s={r.statement} /> : <Notice>You weren't an investor in this quarter.</Notice>}
                {r.returns && <p className="small" style={{ margin: 0 }}>Your returns since you joined, after fees, expenses and carried interest: TVPI {x2(r.returns.tvpi)}, DPI {x2(r.returns.dpi)}, IRR {irr(r.returns.irr)}.</p>}
              </section>
              <section className="panel panel-pad section" aria-labelledby="iv-letter">
                <h2 id="iv-letter">Report for {quarterLabel(r.period)}</h2>
                <p className="small muted" style={{ margin: 0 }}>As of {longDate(r.asOf)}{r.approvedAt ? `, approved ${longDate(r.approvedAt)}` : ""}.</p>
                <LetterView letter={r.letter} />
              </section>
              <section className="panel panel-pad section" aria-labelledby="iv-perf">
                <h2 id="iv-perf">The fund's performance</h2>
                <div className="stats">
                  <div className="stat"><b className="num">{usd(r.summary.commitments)}</b><span>Committed</span></div>
                  <div className="stat"><b className="num">{usd(r.summary.called)}</b><span>Called ({r.summary.calledPct.toFixed(1)}%)</span></div>
                  <div className="stat"><b className="num">{usd(r.summary.distributed)}</b><span>Distributed</span></div>
                  <div className="stat"><b className="num">{usd(r.summary.nav)}</b><span>Net asset value</span></div>
                </div>
                <NetAndGross net={r.performance.net} gross={r.performance.gross} note={r.performance.marketingNote} />
              </section>
              <section className="panel panel-pad section" aria-labelledby="iv-sch">
                <h2 id="iv-sch">Schedule of investments</h2>
                <div className="table-wrap">
                  <table className="t">
                    <caption className="sr-only">Schedule of investments</caption>
                    <thead><tr><th scope="col">Company</th><th scope="col" className="num">Cost</th><th scope="col" className="num">Realized</th><th scope="col" className="num">Fair value</th><th scope="col" className="num">Multiple</th><th scope="col">Basis</th></tr></thead>
                    <tbody>{r.schedule.map((x) => <tr key={x.companyId}><th scope="row">{x.company}</th><td className="num">{usd(x.cost)}</td><td className="num">{usd(x.realized)}</td><td className="num">{usd(x.fairValue)}</td><td className="num">{x2(x.moic)}</td><td className="small">{x.basis}</td></tr>)}</tbody>
                  </table>
                </div>
                <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{[...r.fund.termsText, ...r.notes].map((n, i) => <li key={i}>{n}</li>)}</ul>
              </section>
            </>
          )}
        </>
      )}
      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="iv-calls">
          <h2 id="iv-calls">Your capital calls</h2>
          {data.calls.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet.</p> : (
            <ul className="timeline small">
              {data.calls.map((c) => (
                <li key={c.number}>
                  <span>{longDate(c.dueDate)}</span>
                  <span><strong>Call {c.number}: {usd(c.amount)}</strong>{c.purpose ? ` · ${c.purpose}` : ""}<br /><span className="muted">{c.received >= c.amount - 0.005 ? `Received ${longDate(c.receivedOn)}` : c.received ? `${usd(c.received)} received` : "Not yet received"}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel panel-pad section" aria-labelledby="iv-dist">
          <h2 id="iv-dist">Your distributions</h2>
          {data.distributions.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet.</p> : (
            <ul className="timeline small">
              {data.distributions.map((d) => (
                <li key={d.number}>
                  <span>{longDate(d.paidOn)}</span>
                  <span><strong>{usd(d.net)}</strong> net{d.carry ? ` (${usd(d.gross)} less ${usd(d.carry)} carried interest)` : ""}<br /><span className="muted">{d.kind}{d.company ? ` · ${d.company}` : ""} · {d.status}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="panel panel-pad section" aria-labelledby="iv-tax">
        <h2 id="iv-tax">Tax documents</h2>
        {data.taxDocuments.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet. Schedules K-1 are due by March 15 (September 15 with an extension).</p> : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.taxDocuments.map((t, i) => <li key={i}>{t.year} {t.kind}: {t.status}{t.deliveredOn ? `, ${longDate(t.deliveredOn)}` : ""}</li>)}</ul>
        )}
      </section>
    </main>
  );
}
