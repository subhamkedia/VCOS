import { useState } from "react";
import type { LpFundView } from "../../types";
import { Notice, Select, usd } from "../../ui";
import { StatementTable, irr, longDate, x2 } from "./shared";

/**
 * Capital accounts, ILPA style: each investor's statement for the quarter,
 * the year and inception to date, rolling from the beginning balance to the
 * ending one, and the returns each investor has earned from its own cash
 * flows.
 */
export default function Accounts({ data }: { data: LpFundView }) {
  const st = data.statements;
  const [who, setWho] = useState<string>("all");
  if (!st.statements.length) return <Notice>Add investors and call capital to see capital accounts.</Notice>;
  const one = st.statements.find((s) => s.partnerId === who);
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="acc-h">
        <div className="spread">
          <h2 id="acc-h">Capital account statement, as of {longDate(data.asOf)}</h2>
          <div style={{ minWidth: 240 }}>
            <label className="sr-only" htmlFor="acc-who">Whose account</label>
            <Select id="acc-who" value={who} onChange={(v) => setWho(v ?? "all")} options={[{ id: "all", label: "All partners" }, ...st.statements.map((s) => ({ id: s.partnerId, label: s.name }))]} />
          </div>
        </div>
        <StatementTable caption={one ? `${one.name}'s capital account` : "All partners' capital accounts"} s={one ?? st.total} />
        {!one && <p className="small muted" style={{ margin: 0 }}>All partners together. The general partner's accrued carried interest ({usd(Math.max(0, st.gpCarry.accrued))}) is held in its own account, so the fund's NAV is {usd(st.nav)}.</p>}
        {one && !one.feePaying && <p className="small muted" style={{ margin: 0 }}>This commitment pays no management fee or carried interest.</p>}
      </section>
      <section className="panel panel-pad section" aria-labelledby="ret-h">
        <h2 id="ret-h">Returns by investor</h2>
        <div className="table-wrap">
          <table className="t">
            <caption className="sr-only">Net returns by investor</caption>
            <thead><tr><th scope="col">Investor</th><th scope="col" className="num">Paid in</th><th scope="col" className="num">Distributed</th><th scope="col" className="num">Capital account</th><th scope="col" className="num">DPI</th><th scope="col" className="num">TVPI</th><th scope="col" className="num">Net IRR</th></tr></thead>
            <tbody>
              {data.investors.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.name}</th>
                  <td className="num">{usd(i.contributed)}</td><td className="num">{usd(i.distributed)}</td><td className="num">{usd(i.balance)}</td>
                  <td className="num">{x2(i.returns?.dpi)}</td><td className="num">{x2(i.returns?.tvpi)}</td><td className="num">{irr(i.returns?.irr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: 0 }}>From each investor's own contributions and distributions, and its capital account as the ending value: after fees, expenses and carried interest.</p>
      </section>
    </>
  );
}
