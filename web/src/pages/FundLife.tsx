import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { FundLifeView } from "../types";
import { ErrorState, Field, Loading, MoneyInput, Notice, NumberInput, PageHead, Select, usePrompt, usd } from "../ui";
import { longDate, person } from "./lp/shared";
import { useRun } from "./exits/shared";

const today = () => new Date().toISOString().slice(0, 10);
const STAGE_TONE: Record<string, string> = { harvesting: "good", final_years: "warn", extended: "warn", past_term: "bad" };

/** A fund's term, extensions, what it still holds, options for the tail, a continuation vehicle, and the wind-down. */
export default function FundLife() {
  const { id } = useParams();
  const { can } = useSession();
  const { data, error, reload } = useApi<FundLifeView>(`/portfolio/funds/${id}/life`);
  const refresh = () => void reload();
  if (error) return <ErrorState error={error} retry={refresh} />;
  if (!data) return <Loading what="Loading the fund" />;
  const L = data.labels;
  const l = data.life;
  return (
    <>
      <PageHead eyebrow={<Link to="/portfolio/liquidity">Exits and liquidity</Link>} title={`${data.fund.name}: term and wind-down`} lead={`Began ${longDate(data.fund.inception)}; a ${data.termYears}-year term${l.extensionYearsUsed ? `, extended ${l.extensionYearsUsed} year${l.extensionYearsUsed === 1 ? "" : "s"}` : ""}.`} />
      <section className="panel panel-pad section" aria-labelledby="lf-h">
        <div className="spread"><h2 id="lf-h">The fund's life</h2><span className={`pill ${STAGE_TONE[l.stage]}`}>{L.lifeStage[l.stage]}</span></div>
        <div className="stats">
          <div className="stat"><b className="num">{longDate(l.termEnds)}</b><span>Term ends</span></div>
          <div className="stat"><b className="num">{longDate(l.endsOn)}</b><span>Ends, with extensions</span></div>
          <div className="stat"><b className="num">{l.monthsLeft}</b><span>Months left</span></div>
          <div className="stat"><b className="num">{l.extensionYearsLeft}</b><span>Extension years left</span></div>
          <div className="stat"><b className="num">{usd(data.residualNavUsd)}</b><span>Still held ({data.residual.length} companies)</span></div>
        </div>
        {!data.configured && <Notice>The term comes from the firm profile. {can("decide_deals") ? "Set it from the LPA below." : "A partner can set it from the LPA."}</Notice>}
        {data.extensions.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.extensions.map((e) => <li key={e.id}>{e.years} year{e.years === 1 ? "" : "s"}, by {L.approvedVia[e.approved_via]!.toLowerCase()}{e.fee_change ? `; fee: ${e.fee_change}` : ""}{e.note ? `; ${e.note}` : ""} <span className="muted">({person(e.created_by)}, {longDate(e.created_at)})</span></li>)}</ul>}
        {can("decide_deals") && <Term data={data} onChange={refresh} />}
        {can("decide_deals") && l.extensionYearsLeft > 0 && <Extend data={data} onChange={refresh} />}
      </section>

      <section className="panel panel-pad section" aria-labelledby="rs-h">
        <h2 id="rs-h">What it still holds</h2>
        {data.residual.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing: every holding is realized.</p> : (
          <ul className="timeline small">{data.residual.map((r) => <li key={r.companyId} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}><span><Link to={`/portfolio/${r.companyId}?tab=exit`}>{r.name}</Link></span><span className="num">{usd(r.value)}</span></li>)}</ul>
        )}
        {l.stage === "harvesting" ? (
          <details><summary className="small">Options for the tail, for the fund's last years</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.options.map((o) => <li key={o.key}><strong>{o.title}.</strong> {o.detail}</li>)}</ul></details>
        ) : (
          <>
            <h3>Options for the tail</h3>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.options.map((o) => <li key={o.key}><strong>{o.title}.</strong> {o.detail}</li>)}</ul>
          </>
        )}
      </section>

      <section className="panel panel-pad section" aria-labelledby="cv-h">
        <h2 id="cv-h">Continuation vehicle</h2>
        {data.continuation.length === 0 && <p className="small muted" style={{ margin: 0 }}>None started.</p>}
        {data.continuation.map((c) => <Cv key={c.id} c={c} data={data} onChange={refresh} />)}
        {can("decide_deals") && <StartCv data={data} onChange={refresh} />}
      </section>

      <WindDown data={data} onChange={refresh} />
    </>
  );
}

function Term({ data, onChange }: { data: FundLifeView; onChange: () => void }) {
  const run = useRun(onChange);
  const [f, setF] = useState<{ termYears?: number; maxExtensionYears?: number }>({ termYears: data.termYears, maxExtensionYears: data.maxExtensionYears });
  return (
    <details>
      <summary className="small">Set the term from the LPA</summary>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/portfolio/funds/${data.fund.id}/life`, { method: "PUT", body: f }), "Saved."); }}>
        <Field label="Term" required><NumberInput id="lf-t" suffix="years" value={f.termYears} onChange={(v) => setF({ ...f, termYears: v })} /></Field>
        <Field label="Extensions allowed" hint="In total"><NumberInput id="lf-x" suffix="years" value={f.maxExtensionYears} onChange={(v) => setF({ ...f, maxExtensionYears: v })} /></Field>
        <div className="row" style={{ alignSelf: "end" }}><button className="btn small">Save</button></div>
      </form>
    </details>
  );
}

function Extend({ data, onChange }: { data: FundLifeView; onChange: () => void }) {
  const run = useRun(onChange);
  const [f, setF] = useState<{ years?: number; approvedVia?: string; lpacConsentId?: string; feeChange: string; note: string }>({ years: 1, feeChange: "", note: "" });
  return (
    <details>
      <summary className="small">Record an extension</summary>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/portfolio/funds/${data.fund.id}/extensions`, { body: f }), "Extension recorded."); }}>
        <div className="form-grid">
          <Field label="Years" required><NumberInput id="ex-y" value={f.years} onChange={(v) => setF({ ...f, years: v })} /></Field>
          <Field label="Approved by" required><Select id="ex-v" value={f.approvedVia} onChange={(v) => setF({ ...f, approvedVia: v })} options={Object.entries(data.labels.approvedVia).map(([id, label]) => ({ id, label }))} /></Field>
          {f.approvedVia === "lpac" && <Field label="The LPAC's consent" required hint="Ask for it under Fundraising & IR, Investor relations"><Select id="ex-c" value={f.lpacConsentId} onChange={(v) => setF({ ...f, lpacConsentId: v })} options={data.lpacConsents.map((c) => ({ id: c.id, label: `${c.topic} (${c.status})` }))} /></Field>}
          <Field label="Management fee in the extension" hint="Many LPs expect it to fall or stop"><input className="input" value={f.feeChange} onChange={(e) => setF({ ...f, feeChange: e.target.value })} /></Field>
        </div>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="row"><button className="btn small primary" disabled={!f.approvedVia}>Record extension</button></div>
      </form>
    </details>
  );
}

function Cv({ c, data, onChange }: { c: FundLifeView["continuation"][number]; data: FundLifeView; onChange: () => void }) {
  const { can } = useSession();
  const prompt = usePrompt();
  const run = useRun(onChange);
  const L = data.labels;
  const t = c.tally;
  const finish = async () => {
    const fairness = c.fairness_opinion ?? (await prompt({ title: "Fairness opinion", label: "Who gave it, and its conclusion", confirm: "Next", required: true, multiline: true }));
    if (!fairness) return;
    await run(() => api(`/portfolio/continuation/${c.id}/finish`, { body: { fairnessOpinion: fairness } }), "Closed.");
  };
  return (
    <article className="section" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div className="spread"><h3 style={{ margin: 0 }}>{c.name}</h3><span className={`pill ${c.status === "open" ? "warn" : c.status === "closed" ? "good" : "quiet"}`}>{c.status === "open" ? (t.closed ? "Elections closed" : "Electing") : c.status === "closed" ? "Closed" : "Abandoned"}</span></div>
      <p className="small muted" style={{ margin: 0 }}>Lead buyer {c.lead_buyer} at {c.price_pct_of_nav}% of {usd(c.reference_nav_usd)} NAV. Elections {longDate(c.launched_on)} to {longDate(c.deadline)} ({t.calendarDays} days, {t.businessDays} business days). {c.status_quo_offered ? "Status quo offered." : "No status quo option."} LPAC: {c.lpacConsent ? `${c.lpacConsent.topic} (${c.lpacConsent.status})` : "not linked"}. Fairness opinion: {c.fairness_opinion ?? "not yet"}.</p>
      {t.issues.map((i, k) => <Notice key={k} tone="warn">{i}</Notice>)}
      <div className="stats">
        <div className="stat"><b className="num">{usd(t.navRolled)}</b><span>Rolling</span></div>
        <div className="stat"><b className="num">{usd(t.navStatusQuo)}</b><span>Status quo</span></div>
        <div className="stat"><b className="num">{usd(t.navSold)}</b><span>Selling ({usd(t.cashToSellers)} cash)</span></div>
        <div className="stat"><b className="num">{usd(t.navPending)}</b><span>Not yet elected</span></div>
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {t.investors.map((i) => (
          <li key={i.id}>
            {c.names[i.id]}: {i.choice === "pending" ? "not yet elected" : L.elections[i.choice]}{i.defaulted ? " (no election: treated as selling)" : ""}
            {c.status === "open" && !t.closed && can("work_deals") && (
              <span className="row" style={{ display: "inline-flex", marginLeft: 8 }}>
                {(["roll", "sell", ...(c.status_quo_offered ? ["status_quo"] : [])] as string[]).map((ch) => <button key={ch} className="btn small ghost" onClick={() => void run(() => api(`/portfolio/continuation/${c.id}/elections`, { body: { partnerId: i.id, choice: ch } }), "Election recorded.")}>{L.elections[ch]!.split(" (")[0]}</button>)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {c.status === "open" && can("decide_deals") && (
        <div className="row">
          {t.closed && <button className="btn small primary" onClick={() => void finish()}>Close the process</button>}
          <button className="btn small ghost" onClick={() => void run(() => api(`/portfolio/continuation/${c.id}/finish`, { body: { status: "abandoned" } }), "Abandoned.")}>Abandon</button>
        </div>
      )}
    </article>
  );
}

function StartCv({ data, onChange }: { data: FundLifeView; onChange: () => void }) {
  const run = useRun(onChange);
  const [f, setF] = useState<{ name: string; leadBuyer: string; pricePctOfNav?: number; referenceNavUsd?: number; launchedOn: string; deadline: string; statusQuoOffered: boolean; lpacConsentId?: string; fairnessOpinion: string }>({
    name: "", leadBuyer: "", referenceNavUsd: data.residualNavUsd || undefined, launchedOn: today(), deadline: "", statusQuoOffered: true, fairnessOpinion: "",
  });
  return (
    <details>
      <summary className="small">Start a continuation vehicle process</summary>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/portfolio/funds/${data.fund.id}/continuation`, { body: f }), "Started. Record each investor's election as it comes in."); }}>
        <p className="small muted" style={{ margin: 0 }}>ILPA's 2023 guidance: a status quo option on unchanged terms, at least 30 calendar and 20 business days to elect, silence treated as a sale, a fairness opinion, and the conflict reviewed by the LPAC.</p>
        <div className="form-grid">
          <Field label="Vehicle" required><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Lead buyer" required><input className="input" required value={f.leadBuyer} onChange={(e) => setF({ ...f, leadBuyer: e.target.value })} /></Field>
          <Field label="Price" required hint="Percent of NAV"><NumberInput id="cv-p" suffix="%" value={f.pricePctOfNav} onChange={(v) => setF({ ...f, pricePctOfNav: v })} /></Field>
          <Field label="NAV moving" required><MoneyInput id="cv-n" value={f.referenceNavUsd} onChange={(v) => setF({ ...f, referenceNavUsd: v })} /></Field>
          <Field label="Launched" required><input className="input" type="date" required value={f.launchedOn} onChange={(e) => setF({ ...f, launchedOn: e.target.value })} /></Field>
          <Field label="Election deadline" required><input className="input" type="date" required value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></Field>
          <Field label="The LPAC's consent"><Select id="cv-c" value={f.lpacConsentId} onChange={(v) => setF({ ...f, lpacConsentId: v })} placeholder="Not yet" options={data.lpacConsents.map((c) => ({ id: c.id, label: `${c.topic} (${c.status})` }))} /></Field>
        </div>
        <label className="check-row small"><input type="checkbox" checked={f.statusQuoOffered} onChange={(e) => setF({ ...f, statusQuoOffered: e.target.checked })} /><span>Investors can keep their interest on unchanged terms (status quo)</span></label>
        <div className="row"><button className="btn small primary" disabled={!f.pricePctOfNav || !f.referenceNavUsd || !f.deadline}>Start</button></div>
      </form>
    </details>
  );
}

function WindDown({ data, onChange }: { data: FundLifeView; onChange: () => void }) {
  const prompt = usePrompt();
  const run = useRun(onChange);
  const set = async (key: string, status: "open" | "done" | "na") => {
    const note = status === "na" ? await prompt({ title: "Not needed?", label: "Why it isn't needed", confirm: "Save", required: true }) : undefined;
    if (status === "na" && !note) return;
    await run(() => api(`/portfolio/funds/${data.fund.id}/wind-down/${key}`, { method: "PUT", body: { status, note } }), "Saved.");
  };
  const done = data.windDown.filter((s) => s.status !== "open").length;
  const list = <WindDownList data={data} set={set} />;
  return (
    <section className="panel panel-pad section" aria-labelledby="wd-h">
      <div className="spread"><h2 id="wd-h">Wind-down</h2><span className="small muted">{done} of {data.windDown.length}</span></div>
      {data.life.stage === "harvesting" && done === 0 ? <details><summary className="small">The steps to close the fund</summary>{list}</details> : list}
    </section>
  );
}

function WindDownList({ data, set }: { data: FundLifeView; set: (key: string, status: "open" | "done" | "na") => Promise<void> }) {
  const { can } = useSession();
  return (
      <ul className="timeline small">
        {data.windDown.map((s) => (
          <li key={s.key} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
            <span>{s.label}{s.note ? <span className="muted"> · {s.note}</span> : null}</span>
            <span className="row">
              <span className={`pill ${s.status === "done" ? "good" : s.status === "na" ? "quiet" : "info"}`}>{data.labels.windDownStatus[s.status]}</span>
              {can("work_deals") && s.status !== "done" && <button className="btn small ghost" onClick={() => void set(s.key, "done")}>Done</button>}
              {can("work_deals") && s.status === "open" && <button className="btn small ghost" onClick={() => void set(s.key, "na")}>Not needed</button>}
              {can("work_deals") && s.status !== "open" && <button className="btn small ghost" onClick={() => void set(s.key, "open")}>Reopen</button>}
            </span>
          </li>
        ))}
      </ul>
  );
}
