import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../api";
import type { InitiativeRow, KpiRequest, Mark, PortfolioOverview } from "../types";
import { ErrorState, Loading, Notice, PageHead, Seg, dateOnly, usd } from "../ui";
import { HealthPill, SEVERITY_TONE, months, monthLabel, pctFmt, person, x2 } from "./portfolio/shared";

type View = "all" | "attention" | "exited";

/**
 * The portfolio: gross performance on invested capital, the reserve pool,
 * and every company with its health, value and early warnings. The work
 * that's waiting (marks to review, requests out) sits alongside.
 */
export default function Portfolio() {
  const nav = useNavigate();
  const [view, setView] = useState<View>("all");
  const { data, error, reload } = useApi<PortfolioOverview>("/portfolio");
  const queues = useApi<{ marksToReview: Mark[]; requests: KpiRequest[]; initiatives: InitiativeRow[] }>("/portfolio/queues");
  const head = (
    <PageHead
      eyebrow="Module"
      title="Portfolio & Value Creation"
      lead="Every company the fund holds: numbers from the books and the founders, early warnings, fair value marks, reserves and follow-ons, board meetings, the help you give, and exits."
      actions={<Link className="btn small" to="/portfolio/liquidity">Exits and liquidity</Link>}
    />
  );
  if (error) return <>{head}<ErrorState error={error} retry={() => void reload()} /></>;
  if (!data) return <>{head}<Loading what="Loading the portfolio" /></>;
  const m = data.metrics;
  const rows = data.companies.filter((c) => view === "all" ? true : view === "exited" ? c.status !== "active" : c.status === "active" && (c.health?.rating ?? c.suggested) !== "on_track");
  const r = data.reserves;
  return (
    <>
      {head}
      {data.companies.length === 0 ? (
        <Notice>No investments yet. A company joins the portfolio when its deal closes in <Link to="/execution">Investment Execution</Link>.</Notice>
      ) : (
        <>
          <section className="panel panel-pad section" aria-labelledby="perf-h">
            <h2 id="perf-h">{data.fund.name}</h2>
            <div className="stats">
              <div className="stat"><b className="num">{usd(m.invested)}</b><span>Invested</span></div>
              <div className="stat"><b className="num">{usd(m.totalValue)}</b><span>Total value</span></div>
              <div className="stat"><b className="num">{x2(m.moic)}</b><span>Gross MOIC</span></div>
              <div className="stat"><b className="num">{x2(m.dpi)}</b><span>DPI</span></div>
              <div className="stat"><b className="num">{x2(m.rvpi)}</b><span>RVPI</span></div>
              <div className="stat"><b className="num">{m.irr === null ? "—" : `${(m.irr * 100).toFixed(1)}%`}</b><span>Gross IRR</span></div>
              <div className="stat"><b className="num">{m.lossRatioPct === null ? "—" : `${m.lossRatioPct.toFixed(0)}%`}</b><span>Capital below cost</span></div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>{m.basis} Net returns to LPs are in LP Reporting.</p>
          </section>

          <div className="grid-2">
            <section className="panel panel-pad section" aria-labelledby="res-h">
              <h2 id="res-h">Reserves</h2>
              {r.budget > 0 ? (
                <>
                  <div className="meter" role="img" aria-label={`${usd(r.deployed)} deployed and ${usd(r.committedRemaining)} planned of a ${usd(r.budget)} reserve budget`}>
                    <span className="deployed" style={{ width: `${Math.min(100, (r.deployed / r.budget) * 100)}%` }} />
                    <span className="committed" style={{ width: `${Math.min(100, (r.committedRemaining / r.budget) * 100)}%` }} />
                  </div>
                  <dl className="kv">
                    <dt>Budget</dt><dd>{usd(r.budget)} ({data.fund.reservesPct}% of {usd(data.fund.sizeUsd)})</dd>
                    <dt>Deployed in follow-ons</dt><dd>{usd(r.deployed)}</dd>
                    <dt>Planned, not yet deployed</dt><dd>{usd(r.committedRemaining)}</dd>
                    <dt>Unallocated</dt><dd>{r.overAllocated ? <span className="pill bad">Over by {usd(-r.unallocated)}</span> : usd(r.unallocated)}</dd>
                  </dl>
                </>
              ) : <Notice>Set the fund size and reserve percentage in <Link to="/settings/fund">Firm settings</Link> to track the reserve pool.</Notice>}
            </section>
            <section className="panel panel-pad section" aria-labelledby="work-h">
              <h2 id="work-h">Waiting on you</h2>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>{data.counts.atRisk} at risk, {data.counts.watch} to watch</li>
                <li>{data.counts.marksToReview} {data.counts.marksToReview === 1 ? "mark" : "marks"} to review</li>
                <li>{data.counts.openRequests} KPI {data.counts.openRequests === 1 ? "request" : "requests"} out{data.counts.overdueRequests ? `, ${data.counts.overdueRequests} overdue` : ""}</li>
              </ul>
              {queues.data && queues.data.marksToReview.length > 0 && (
                <ul className="timeline small">
                  {queues.data.marksToReview.map((mk) => (
                    <li key={mk.id}>
                      <span>{dateOnly(mk.as_of)}</span>
                      <span><Link to={`/portfolio/${mk.company_id}?tab=value`}>{mk.company_name}</Link>: {usd(mk.fair_value_usd)} proposed by {person(mk.prepared_by)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <Seg label="Which companies" value={view} onChange={setView} options={[{ id: "all", label: "All" }, { id: "attention", label: "Needs attention" }, { id: "exited", label: "Exited or listed" }]} />
          {rows.length === 0 ? <Notice>{view === "attention" ? "Nothing needs attention." : "None."}</Notice> : (
            <div className="panel table-wrap">
              <table className="t">
                <caption className="sr-only">Portfolio companies</caption>
                <thead>
                  <tr><th scope="col">Company</th><th scope="col">Health</th><th scope="col" className="num">Invested</th><th scope="col" className="num">Value</th><th scope="col" className="num">MOIC</th><th scope="col">Runway</th><th scope="col">Revenue</th><th scope="col">Warnings</th><th scope="col">Latest numbers</th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.companyId} className="click" onClick={() => nav(`/portfolio/${c.companyId}`)}>
                      <td><Link to={`/portfolio/${c.companyId}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></Link><div className="small muted">since {dateOnly(c.firstInvested)}{c.ownershipPct !== null ? ` · ${c.ownershipPct.toFixed(1)}%` : ""}</div></td>
                      <td>{c.status === "exited" ? <span className="pill quiet">Exited</span> : c.status === "public" ? <span className="pill info">Listed</span> : <HealthPill rating={c.health?.rating} suggested={c.suggested} labels={data.healthLabels} />}</td>
                      <td className="num">{usd(c.invested)}</td>
                      <td className="num">{usd(c.fairValue + c.realized)}<div className="small muted">{c.valueBasis === "mark" ? `mark ${dateOnly(c.mark!.asOf)}` : c.valueBasis === "cost" ? "at cost" : c.valueBasis === "public" ? "listed" : c.pendingUsd > 0 ? `${usd(c.pendingUsd)} still due` : "realized"}</div></td>
                      <td className="num">{x2(c.moic)}</td>
                      <td className="small">{c.status !== "active" ? "—" : c.notBurning ? "Not burning" : months(c.runwayMonths)}</td>
                      <td className="small num">{c.revenue !== null ? <>{usd(c.revenue)}/mo <span className="muted">{pctFmt(c.revenueMoM)}</span></> : c.arr !== null ? `${usd(c.arr)} ARR` : "—"}</td>
                      <td>{c.signals.length ? <span className={`pill ${SEVERITY_TONE[c.signals[0]!.severity]}`}>{c.signals[0]!.title}{c.signals.length > 1 ? ` +${c.signals.length - 1}` : ""}</span> : <span className="muted small">None</span>}</td>
                      <td className="small muted">{c.latestMonth ? monthLabel(c.latestMonth) : "None yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
