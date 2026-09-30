import { Link } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { LiquidityOverview } from "../types";
import { ErrorState, Loading, Notice, PageHead, usePrompt, usd } from "../ui";
import { longDate } from "./lp/shared";
import { Listed, Receivables, useRun } from "./exits/shared";

const STAGE_TONE: Record<string, string> = { exploring: "info", preparing: "info", marketing: "warn", offers: "warn", signed: "warn" };

/**
 * Exits and liquidity across the portfolio: processes under way, what's due
 * back from escrows and earnouts, listed shares and when they can be sold,
 * cash not yet distributed, QSBS dates to wait for, and the cash back
 * expected each year. Each fund's term and tail are a click away.
 */
export default function Liquidity() {
  const { can } = useSession();
  const prompt = usePrompt();
  const { data, error, reload } = useApi<LiquidityOverview>("/portfolio/liquidity");
  const run = useRun(() => void reload());
  const head = <PageHead eyebrow={<Link to="/portfolio">Portfolio</Link>} title="Exits and liquidity" lead="Sales and listings under way, money still due, listed shares, and the cash back you can expect, for the fund and its investors." />;
  if (error) return <>{head}<ErrorState error={error} retry={() => void reload()} /></>;
  if (!data) return <>{head}<Loading what="Loading liquidity" /></>;
  const L = data.labels;
  const distribute = async (u: LiquidityOverview["undistributed"][number]) => {
    const amount = await prompt({ title: `Distribute proceeds from ${u.name}`, label: "Amount, in dollars (a draft in LP Reporting for a second person to approve)", confirm: "Prepare draft", initial: String(Math.round((u.receivedUsd - u.distributedUsd) * 100) / 100), required: true });
    if (amount) await run(() => api(`/portfolio/companies/${u.companyId}/distribute`, { body: { amountUsd: amount } }), "Draft prepared in LP Reporting.");
  };
  const maxYear = Math.max(1, ...data.forecast.map((f) => f.total));
  return (
    <>
      {head}
      <section className="panel panel-pad section" aria-labelledby="lq-h">
        <h2 id="lq-h">At a glance</h2>
        <div className="stats">
          <div className="stat"><b className="num">{data.processes.length}</b><span>Exit processes under way</span></div>
          <div className="stat"><b className="num">{usd(data.totals.pendingUsd)}</b><span>Escrows and earnouts, expected</span></div>
          <div className="stat"><b className="num">{usd(data.totals.listedUsd)}</b><span>Listed shares</span></div>
          <div className="stat"><b className="num">{usd(data.totals.undistributedUsd)}</b><span>Received, not yet distributed</span></div>
        </div>
      </section>

      <section className="panel panel-pad section" aria-labelledby="pr-h">
        <h2 id="pr-h">Processes under way</h2>
        {data.processes.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None. Start one from a company's Exit and liquidity tab.</p> : (
          <ul className="timeline small">
            {data.processes.map((x) => (
              <li key={x.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><Link to={`/portfolio/${x.company_id}?tab=exit`}><strong>{x.company_name}</strong></Link>: {L.kinds[x.kind]}{x.counterparty ? ` with ${x.counterparty}` : ""}{x.our_expected_usd ? `, ${usd(x.our_expected_usd)} to us` : ""}{x.expected_close ? `, closing ${longDate(x.expected_close)}` : ""}</span>
                <span className={`pill ${STAGE_TONE[x.stage] ?? "info"}`}>{L.stages[x.stage]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.undistributed.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="ud-h">
          <h2 id="ud-h">Cash to distribute</h2>
          <ul className="timeline small">
            {data.undistributed.map((u) => (
              <li key={u.companyId} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span><strong>{u.name}</strong>: {usd(u.receivedUsd)} received, {usd(u.distributedUsd)} distributed</span>
                {can("work_deals") && <button className="btn small" onClick={() => void distribute(u)}>Prepare distribution</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel panel-pad section" aria-labelledby="rv-h">
        <h2 id="rv-h">Escrows, holdbacks and earnouts</h2>
        <Receivables rows={data.receivables} labels={L} onChange={() => void reload()} showCompany />
      </section>

      {data.listed.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="li-h">
          <h2 id="li-h">Listed shares</h2>
          {data.listed.map((l) => <Listed key={l.holding.id} v={l} labels={L} onChange={() => void reload()} />)}
        </section>
      )}

      <section className="panel panel-pad section" aria-labelledby="fc-h">
        <h2 id="fc-h">Expected cash back</h2>
        <p className="small muted" style={{ margin: 0 }}>Escrows and earnouts at their expected amounts, listed shares once they can be sold, and planned exits at their likelihood (from each company's exit plan).</p>
        {data.forecast.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing forecast. Add exit plans to companies to see the years ahead.</p> : (
          <div className="table-wrap">
            <table className="t">
              <caption className="sr-only">Expected cash back by year</caption>
              <thead><tr><th scope="col">Year</th><th scope="col" className="num">Escrows and earnouts</th><th scope="col" className="num">Listed shares</th><th scope="col" className="num">Planned exits</th><th scope="col" className="num">Total</th><th scope="col"><span className="sr-only">Chart</span></th></tr></thead>
              <tbody>
                {data.forecast.map((y) => (
                  <tr key={y.year}>
                    <th scope="row">{y.year}</th>
                    <td className="num">{usd(y.receivables)}</td><td className="num">{usd(y.publicShares)}</td><td className="num">{usd(y.exits)}</td><td className="num"><strong>{usd(y.total)}</strong></td>
                    <td style={{ minWidth: 80 }}><div className="meter" aria-hidden="true"><span className="deployed" style={{ width: `${(y.total / maxYear) * 100}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.qsbsSoon.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="qs-h">
          <h2 id="qs-h">QSBS dates to wait for</h2>
          <Notice>Selling before these dates gives up part of investors' QSBS exclusion. Check with tax counsel before a sale.</Notice>
          <ul className="timeline small">
            {data.qsbsSoon.map((q, i) => <li key={i}><span>{longDate(q.next.on)}</span><span><Link to={`/portfolio/${q.companyId}?tab=exit`}><strong>{q.company}</strong></Link> ({q.label}): {q.exclusionPct}% excluded today, {q.next.pct}% from then</span></li>)}
          </ul>
        </section>
      )}

      <section className="panel panel-pad section" aria-labelledby="fl-h">
        <h2 id="fl-h">Funds: term and wind-down</h2>
        {data.funds.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Set funds up in <Link to="/lp-reporting">LP Reporting</Link> to track their term, extensions and tail.</p> : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.funds.map((f) => <li key={f.id}><Link to={`/portfolio/funds/${f.id}`}>{f.name}</Link></li>)}</ul>
        )}
      </section>
    </>
  );
}
