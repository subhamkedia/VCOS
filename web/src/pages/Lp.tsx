import { ModuleSources } from "./ModuleSources";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { LpOverview } from "../types";
import { ErrorState, Loading, Notice, PageHead, useToast, usd } from "../ui";
import { irr, quarterLabel, x2 } from "./lp/shared";

/**
 * LP Reporting: every fund the firm manages, with what's been called and
 * distributed, NAV, and net returns to investors. A fund is set up from the
 * firm profile's fund, so its terms match what the firm already entered.
 */
export default function Lp() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const { data, error, reload } = useApi<LpOverview>("/lp");
  const head = (
    <>
    <PageHead
      title="LP Reporting"
      lead="Your investors, capital calls and distributions, capital accounts, and quarterly reports in ILPA formats. Every number is computed in code; nothing goes to an investor until a second person approves it."
    />
    <ModuleSources module="lp" />
    </>
  );
  if (error) return <>{head}<ErrorState error={error} retry={() => void reload()} /></>;
  if (!data) return <>{head}<Loading what="Loading your funds" /></>;
  const setUp = async () => {
    setBusy(true);
    try {
      const f = await api<{ id: string; name: string }>("/lp/funds", { body: {} });
      toast("good", `${f.name} is set up. Add its investors next.`);
      nav(`/lp-reporting/${f.id}?tab=investors`);
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canSetUp = data.profileFund && !data.profileFund.exists;
  return (
    <>
      {head}
      {canSetUp && (
        <section className="panel panel-pad section" aria-labelledby="setup-h">
          <h2 id="setup-h">Set up {data.profileFund!.name}</h2>
          <p className="small" style={{ margin: 0 }}>
            The fund's economics (management fee and step-down, carried interest, hurdle, waterfall, GP commitment) come from your <Link to="/settings/fund">firm profile</Link>, and stay with the fund from then on: the LPA governs, so later profile edits don't rewrite its history.
          </p>
          {can("decide_deals")
            ? <div className="row"><button className="btn primary" disabled={busy} onClick={() => void setUp()}>{busy ? "Setting up…" : `Set up ${data.profileFund!.name}`}</button></div>
            : <p className="small muted" style={{ margin: 0 }}>A partner sets up the fund.</p>}
        </section>
      )}
      {!data.profileFund && data.funds.length === 0 && <Notice>Describe your fund in <Link to="/settings/fund">Firm settings</Link> first.</Notice>}
      {data.funds.length > 0 && (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Funds</caption>
            <thead>
              <tr><th scope="col">Fund</th><th scope="col" className="num">Committed</th><th scope="col" className="num">Called</th><th scope="col" className="num">Distributed</th><th scope="col" className="num">NAV</th><th scope="col" className="num">Net TVPI</th><th scope="col" className="num">Net IRR</th><th scope="col">Last report</th><th scope="col">Waiting for approval</th></tr>
            </thead>
            <tbody>
              {data.funds.map((f) => {
                const waiting = f.pending.calls + f.pending.distributions + f.pending.reports;
                return (
                  <tr key={f.id} className="click" onClick={() => nav(`/lp-reporting/${f.id}`)}>
                    <td><Link to={`/lp-reporting/${f.id}`} onClick={(e) => e.stopPropagation()}><strong>{f.name}</strong></Link><div className="small muted">{f.vintage ?? "—"} vintage · {f.investors} {f.investors === 1 ? "investor" : "investors"}</div></td>
                    <td className="num">{usd(f.commitments)}</td>
                    <td className="num">{usd(f.called)}<div className="small muted">{f.calledPct.toFixed(1)}%</div></td>
                    <td className="num">{usd(f.distributed)}</td>
                    <td className="num">{usd(f.nav)}</td>
                    <td className="num">{x2(f.net.tvpi)}</td>
                    <td className="num">{irr(f.net.irr)}</td>
                    <td className="small">{f.lastReport ? quarterLabel(f.lastReport) : <span className="muted">None yet</span>}</td>
                    <td>{waiting ? <span className="pill info">{waiting}</span> : <span className="small muted">Nothing</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
