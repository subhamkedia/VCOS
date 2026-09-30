import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import type { Health, KpiPoint } from "../../types";
import { Field, Notice, Select, dateOnly, useToast, usd } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { HEALTH_TONE, KpiBars, SignalList, SOURCE_LABEL, months, monthLabel, pctFmt, person, x2 } from "./shared";

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");

export default function Overview({ data, onChange, go }: PfTabProps & { go: (t: "numbers" | "reporting") => void }) {
  const s = data.summary;
  const p = data.position;
  const burnPoints: KpiPoint[] = data.burn.map((b) => ({ month: b.month, value: Math.max(0, b.value), claimId: b.claimIds[0] ?? "", sourceType: b.basis }));
  const charts: { title: string; points?: KpiPoint[]; format: (n: number) => string; planned?: KpiPoint[] }[] = [
    { title: "Monthly revenue", points: data.series.revenue, format: usd, planned: data.series.planRevenue },
    { title: "Net burn", points: burnPoints, format: usd, planned: data.series.planBurn },
    { title: "Cash", points: data.series.cash, format: usd },
    { title: "ARR", points: data.series.arr, format: usd },
    { title: "Headcount", points: data.series.headcount, format: n0 },
    { title: "Units deployed", points: data.series.units, format: n0 },
  ];
  const shown = charts.filter((c) => c.points?.length);
  const cite = (claimId: string | undefined) => {
    const c = claimId ? data.cites[claimId] : undefined;
    return c ? <span className="small muted" title={c.citedText ?? undefined}> · {SOURCE_LABEL[c.sourceType] ?? c.sourceType}</span> : null;
  };
  return (
    <>
      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="pos-h">
          <h2 id="pos-h">Our position</h2>
          {p ? (
            <div className="stats">
              <div className="stat"><b className="num">{usd(p.invested)}</b><span>Invested</span></div>
              <div className="stat"><b className="num">{usd(p.totalValue)}</b><span>{data.valueBasis === "mark" ? "Value (latest mark)" : data.valueBasis === "cost" ? "Value (at cost)" : data.valueBasis === "public" ? "Value (listed shares)" : data.value.pendingUsd > 0 ? "Realized and expected" : "Realized"}</span></div>
              <div className="stat"><b className="num">{x2(p.moic)}</b><span>Gross MOIC</span></div>
              <div className="stat"><b className="num">{p.irr === null ? "—" : `${(p.irr * 100).toFixed(1)}%`}</b><span>Gross IRR</span></div>
            </div>
          ) : null}
          <p className="small muted" style={{ margin: 0 }}>
            {data.investments.length} {data.investments.length === 1 ? "check" : "checks"}, first on {dateOnly(data.investments[0]?.close_date)}
            {data.investments.some((i) => i.board_role === "seat") ? " · board seat" : data.investments.some((i) => i.board_role === "observer") ? " · board observer" : ""}.
          </p>
        </section>
        <section className="panel panel-pad section" aria-labelledby="warn-h">
          <h2 id="warn-h">Early warnings</h2>
          <SignalList signals={data.signals} empty={s.latestMonth ? "Nothing to flag in the latest numbers." : "No numbers yet."} />
          {!s.latestMonth && (
            <div className="row">
              <button className="btn primary small" onClick={() => go("reporting")}>Ask for numbers</button>
              <button className="btn small" onClick={() => go("numbers")}>Enter them</button>
            </div>
          )}
        </section>
      </div>

      {s.latestMonth && (
        <section className="panel panel-pad section" aria-labelledby="nums-h">
          <h2 id="nums-h">Latest numbers <span className="small muted">({monthLabel(s.latestMonth)})</span></h2>
          <dl className="kv">
            {s.cash && <><dt>Cash</dt><dd>{usd(s.cash.value)} at {monthLabel(s.cash.month)}{cite(s.cash.claimId)}</dd></>}
            {s.avgBurn !== null && <><dt>Net burn (3-month average)</dt><dd>{s.avgBurn <= 0 ? "Not burning cash" : `${usd(s.avgBurn)}/mo`} <span className="small muted">({s.burnBasis})</span></dd></>}
            <dt>Runway</dt><dd>{s.notBurning ? "Not burning cash" : s.runwayMonths !== null ? <>{months(s.runwayMonths)} <span className="small muted">· cash out around {monthLabel(s.zeroCashMonth!)}</span></> : "Needs cash and burn"}</dd>
            {s.revenue && <><dt>Revenue</dt><dd>{usd(s.revenue.value)} in {monthLabel(s.revenue.month)} · {pctFmt(s.revenueMoM)} month over month{s.revenueYoY !== null ? `, ${pctFmt(s.revenueYoY)} year over year` : ""}{cite(s.revenue.claimId)}</dd></>}
            {s.arr && <><dt>ARR</dt><dd>{usd(s.arr.value)}{s.netNewArr3m !== null ? ` · ${usd(s.netNewArr3m)} added in 3 months` : ""}{cite(s.arr.claimId)}</dd></>}
            {s.burnMultiple !== null && <><dt>Burn multiple</dt><dd>{s.burnMultiple.toFixed(1)} <span className="small muted">(net burn / net new ARR; under 1 is excellent, over 3 is bad)</span></dd></>}
            {s.planRevenueVarPct !== null && <><dt>Revenue against plan</dt><dd>{pctFmt(s.planRevenueVarPct)}</dd></>}
            {s.planBurnVarPct !== null && <><dt>Burn against plan</dt><dd>{pctFmt(s.planBurnVarPct)}</dd></>}
            {s.headcount && <><dt>Headcount</dt><dd>{s.headcount.value}{cite(s.headcount.claimId)}</dd></>}
            {s.grossMargin && <><dt>Gross margin</dt><dd>{s.grossMargin.value}%</dd></>}
            {s.nrr && <><dt>Net revenue retention</dt><dd>{s.nrr.value}%</dd></>}
            {s.units && <><dt>Units deployed</dt><dd>{s.units.value}{s.uptime ? ` · ${s.uptime.value}% uptime` : ""}</dd></>}
          </dl>
          {shown.length > 0 && <div className="kpi-grid">{shown.map((c) => <KpiBars key={c.title} title={c.title} points={c.points!} format={c.format} planned={c.planned} />)}</div>}
        </section>
      )}

      {data.valueBasis !== "exited" && <Rate data={data} onChange={onChange} />}
    </>
  );
}

function Rate({ data, onChange }: PfTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const [rating, setRating] = useState<Health | undefined>(data.suggested);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/portfolio/companies/${data.company.id}/health`, { body: { rating, rationale: why } });
      toast("good", "Rating recorded.");
      setWhy("");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="rate-h">
      <h2 id="rate-h">Health rating</h2>
      <p className="small muted" style={{ margin: 0 }}>Your call, recorded with its reason. The signals suggest <strong>{data.options.healthLabels[data.suggested].toLowerCase()}</strong>; rate it differently if you know more.</p>
      {can("work_deals") && (
        <form className="grid-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Rating" required><Select id="pf-rating" value={rating} onChange={setRating} options={(Object.keys(data.options.healthLabels) as Health[]).map((id) => ({ id, label: data.options.healthLabels[id] }))} /></Field>
          <Field label="Why" required><input className="input" required minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="E.g. runway tight until the Series A closes" /></Field>
          <div className="row"><button className="btn primary" disabled={busy || !rating} aria-busy={busy}>Record rating</button></div>
        </form>
      )}
      {data.health.length > 0 ? (
        <ul className="timeline small">
          {data.health.map((d) => {
            const v = d.value as { rating: Health; suggested: Health };
            return (
              <li key={d.id}>
                <span>{dateOnly(d.created_at)}</span>
                <span><span className={`pill ${HEALTH_TONE[v.rating]}`}>{data.options.healthLabels[v.rating]}</span> {person(d.actor)}{v.suggested !== v.rating ? <span className="muted"> (signals suggested {data.options.healthLabels[v.suggested].toLowerCase()})</span> : null}<br />{d.rationale}</span>
              </li>
            );
          })}
        </ul>
      ) : <Notice>Not rated yet.</Notice>}
    </section>
  );
}
