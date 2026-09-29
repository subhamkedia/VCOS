import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { DealFlags, DealRun, ResearchSource, SourceResult } from "../../types";
import { Field, MoneyInput, Notice, Select, Time, useToast, usd } from "../../ui";
import { useVocab } from "../../vocab";
import { Progress } from "../Diligence";
import type { TabProps } from "../Deal";

const STATUS: Record<SourceResult["status"], { tone: string; label: string }> = {
  ok: { tone: "good", label: "Read" }, empty: { tone: "quiet", label: "Nothing found" }, skipped: { tone: "outline", label: "Skipped" }, failed: { tone: "bad", label: "Failed" },
};

export default function Overview({ data, onChange, go }: TabProps & { go: (t: "checklist" | "questions" | "conflicts" | "calls" | "memo" | "decision") => void }) {
  const r = data.readiness;
  return (
    <>
      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="ready-h">
          <div className="spread">
            <h2 id="ready-h">Ready for IC?</h2>
            <span className={`pill ${r.ready ? "good" : "warn"}`}>{r.ready ? "Ready" : "Not yet"}</span>
          </div>
          <Progress done={r.complete} total={r.total} label="Checklist items complete" />
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {r.requiredOpen.length > 0 && <li>{r.requiredOpen.length} required {r.requiredOpen.length === 1 ? "item" : "items"} open: {r.requiredOpen.slice(0, 4).map((i) => i.title).join(", ")}{r.requiredOpen.length > 4 ? "…" : ""}</li>}
            {r.redFlags.length > 0 && <li style={{ color: "var(--bad)" }}>Red flags: {r.redFlags.map((i) => i.title).join(", ")}</li>}
            {r.highContradictions > 0 && <li>{r.highContradictions} high-severity {r.highContradictions === 1 ? "conflict" : "conflicts"} between sources</li>}
            {r.ready && <li>Every required item is done, with no red flags or serious conflicts.</li>}
          </ul>
          <table className="t small ws-table">
            <caption className="sr-only">Progress by workstream</caption>
            <tbody>
              {r.byWorkstream.map((w) => (
                <tr key={w.id}><th scope="row">{w.label}</th><td><Progress done={w.complete} total={w.total} label={w.label} /></td></tr>
              ))}
            </tbody>
          </table>
          <div className="row"><button className="btn small" onClick={() => go("checklist")}>Open checklist</button><button className="btn small ghost" onClick={() => go("questions")}>Questions for the founders</button></div>
        </section>
        <RoundPanel data={data} onChange={onChange} />
      </div>
      <Gather data={data} onChange={onChange} />
      <div className="grid-2">
        <Flags data={data} onChange={onChange} />
        <Activity data={data} />
      </div>
    </>
  );
}

/** Pull everything every connected source knows about the company. */
function Gather({ data, onChange }: TabProps) {
  const { can } = useSession();
  const v = useVocab();
  const toast = useToast();
  const { data: sources } = useApi<ResearchSource[]>("/research-sources");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<DealRun | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = live ?? data.runs.find((r) => r.kind === "diligence:gather") ?? null;
  const inProgress = running || last?.status === "running";
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const poll = async (runId: string) => {
    const view = await api<{ runs: DealRun[] }>(`/deals/${data.deal.id}`);
    const run = view.runs.find((r) => r.id === runId) ?? null;
    setLive(run);
    if (run && run.status === "running") timer.current = setTimeout(() => void poll(runId), 1500);
    else {
      setRunning(false);
      const s = run?.stats.sources ?? [];
      toast(run?.status === "done" ? "good" : "bad", run?.status === "done" ? `Read ${s.filter((x) => x.status === "ok").length} sources: ${s.reduce((a, x) => a + x.claims, 0)} new facts.` : `Research stopped: ${run?.error ?? "unknown error"}`);
      onChange();
    }
  };
  const start = async () => {
    setRunning(true);
    try {
      const { runId } = await api<{ runId: string }>(`/deals/${data.deal.id}/gather`, { body: {} });
      void poll(runId);
    } catch (e) {
      toast("bad", (e as Error).message);
      setRunning(false);
    }
  };
  const results = last?.stats.sources ?? [];
  const ready = (sources ?? []).filter((s) => s.ready);
  return (
    <section className="panel panel-pad section" aria-labelledby="gather-h">
      <div className="spread">
        <div>
          <h2 id="gather-h">Everything we can find</h2>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            Your meeting tools, CRM, email and Drive, the data vendors you connected, and public sources: the company's website, news, patents, SBIR and federal awards, job boards and SEC filings. {sources ? `${ready.length} of ${sources.length} research sources are ready.` : ""}
          </p>
        </div>
        {can("work_deals") && <button className="btn primary" onClick={() => void start()} disabled={inProgress} aria-busy={inProgress}>{inProgress ? "Gathering…" : last ? "Gather again" : "Gather everything"}</button>}
      </div>
      <div aria-live="polite">
        {last ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>{last.status === "running" ? "Running now" : "Last run"} <Time at={last.started_at} /> by {last.triggered_by.replace(/^human:/, "")}.</p>
            {results.length > 0 && (
              <div className="table-wrap">
                <table className="t small">
                  <caption className="sr-only">What each source returned</caption>
                  <thead><tr><th scope="col">Source</th><th scope="col">Result</th><th scope="col">Items</th><th scope="col">New facts</th><th scope="col">Detail</th></tr></thead>
                  <tbody>
                    {results.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td><span className={`pill ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span></td>
                        <td className="num">{s.records || "—"}</td>
                        <td className="num">{s.claims || "—"}</td>
                        <td className="muted">{s.detail ?? ""}{s.status === "skipped" && s.detail === "Not connected" && <> · <Link to="/connections">Connect</Link></>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : <Notice>Not run yet. It reads each source once and files what it finds on {data.deal.company_name}; run it again any time.</Notice>}
      </div>
      {data.sources.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          In the ledger now: {data.sources.map((s) => `${v.source(s.source)} (${s.claims} ${s.claims === 1 ? "fact" : "facts"})`).join(", ")}.
        </p>
      )}
    </section>
  );
}

/** The round's terms (facts, into the ledger) and the firm's check (a decision), with the math done in code. */
function RoundPanel({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const v = useVocab();
  const [editing, setEditing] = useState(false);
  const [raise, setRaise] = useState<number | undefined>();
  const [pre, setPre] = useState<number | undefined>();
  const [stage, setStage] = useState<string | undefined>();
  const [lead, setLead] = useState("");
  const [source, setSource] = useState<"term_sheet" | "founder" | "other">("founder");
  const [check, setCheck] = useState<number | undefined>(data.round.ourCheckUsd ?? undefined);
  const [busy, setBusy] = useState(false);
  const m = data.round.math;
  const saveTerms = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/deals/${data.deal.id}/round`, { body: { raiseUsd: raise, preMoneyUsd: pre, stage, leadInvestor: lead.trim() || undefined, source } });
      toast("good", "Terms recorded in the ledger.");
      setEditing(false);
      onChange();
    } catch (x) {
      toast("bad", (x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveCheck = async () => {
    try {
      await api(`/deals/${data.deal.id}`, { method: "PATCH", body: { ourCheckUsd: check ?? null } });
      toast("good", "Check size saved.");
      onChange();
    } catch (x) {
      toast("bad", (x as Error).message);
    }
  };
  const checks = Object.entries(m.checks).filter(([, c]) => c);
  return (
    <section className="panel panel-pad section" aria-labelledby="round-h">
      <h2 id="round-h">The round and your fund</h2>
      {data.round.raise.length ? (
        <dl className="kv">
          {data.round.raise.map((r) => <div key={r.id} style={{ display: "contents" }}><dt>{r.label}</dt><dd>{r.display} <span className="pill outline" title={v.sourceTypeHelp(r.source_type)}>{v.sourceType(r.source_type)}</span></dd></div>)}
        </dl>
      ) : <p className="small muted" style={{ margin: 0 }}>No terms yet. Record them from the term sheet or what the founders said.</p>}
      {can("work_deals") && (editing ? (
        <form className="section" style={{ gap: 8 }} onSubmit={saveTerms}>
          <div className="grid-2">
            <Field label="Round size"><MoneyInput id="round-raise" value={raise} onChange={setRaise} /></Field>
            <Field label="Pre-money valuation"><MoneyInput id="round-pre" value={pre} onChange={setPre} /></Field>
            <Field label="Stage"><Select id="round-stage" value={stage} onChange={setStage} placeholder="Choose" options={[["pre_seed", "Pre-seed"], ["seed", "Seed"], ["series_a", "Series A"], ["series_b", "Series B"], ["series_c", "Series C"], ["series_d_plus", "Series D or later"], ["other", "Other"]].map(([id, label]) => ({ id: id!, label: label! }))} /></Field>
            <Field label="Lead investor"><input className="input" id="round-lead" value={lead} onChange={(e) => setLead(e.target.value)} /></Field>
          </div>
          <Field label="Where the terms come from" hint="A term sheet counts as a primary source; what founders say is self-reported.">
            <Select id="round-source" value={source} onChange={(x) => setSource(x ?? "founder")} options={[{ id: "term_sheet", label: "Term sheet" }, { id: "founder", label: "The founders" }, { id: "other", label: "Somewhere else" }]} />
          </Field>
          <div className="row"><button className="btn primary small" disabled={busy} aria-busy={busy}>Record terms</button><button type="button" className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : <div className="row"><button className="btn small" onClick={() => setEditing(true)}>{data.round.raise.length ? "Record new terms" : "Record terms"}</button></div>)}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <Field label="Your intended check" hint="The firm's decision, not a fact about the company.">
          <MoneyInput id="our-check" value={check} onChange={setCheck} />
        </Field>
        {can("work_deals") && <button className="btn small" onClick={() => void saveCheck()} disabled={check === (data.round.ourCheckUsd ?? undefined)}>Save</button>}
      </div>
      {(m.postMoneyUsd || m.ownershipPct !== undefined) && (
        <dl className="kv">
          {m.postMoneyUsd !== undefined && <><dt>Post-money</dt><dd>{usd(m.postMoneyUsd)}</dd></>}
          {m.ownershipPct !== undefined && <><dt>Entry ownership</dt><dd>{m.ownershipPct.toFixed(1)}%</dd></>}
          {m.totalExposureUsd !== undefined && <><dt>Check plus planned reserves</dt><dd>{usd(m.totalExposureUsd)}{m.exposurePctOfFund !== undefined ? ` (${m.exposurePctOfFund.toFixed(1)}% of the fund)` : ""}</dd></>}
        </dl>
      )}
      {checks.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }} aria-label="Checks against your fund">
          {checks.map(([k, c]) => <li key={k}><span className={`pill ${c!.ok ? "good" : "warn"}`}>{c!.ok ? "Fits" : "Check"}</span> {c!.detail}</li>)}
        </ul>
      )}
    </section>
  );
}

function Flags({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const set = async (k: keyof DealFlags, on: boolean) => {
    try {
      await api(`/deals/${data.deal.id}`, { method: "PATCH", body: { flags: { [k]: on } } });
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <fieldset className="panel panel-pad section" style={{ margin: 0 }}>
      <legend className="sr-only">Extra checklist sections</legend>
      <h2 aria-hidden="true">Extra checklist sections</h2>
      <p className="small muted" style={{ margin: 0 }}>Suggested from what the ledger says about the company. Change them if they're wrong.</p>
      {(Object.keys(data.flagLabels) as (keyof DealFlags)[]).map((k) => (
        <label key={k} className="check-row">
          <input type="checkbox" checked={Boolean(data.flags[k])} disabled={!can("work_deals")} onChange={(e) => void set(k, e.target.checked)} />
          <span><strong className="small">{data.flagLabels[k].label}</strong><br /><span className="small muted">{data.flagLabels[k].help}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

const ACTION_LABELS: Record<string, string> = {
  "deal.start": "started diligence", "deal.update": "updated the deal", "deal.item": "updated a checklist item", "deal.note": "logged a note",
  "deal.question.add": "added a question", "deal.question.update": "updated a question", "memo.draft": "drafted a memo", "decision.pass": "passed",
  "decision.advance": "sent it to IC", "contradiction.explained": "explained a conflict", "contradiction.resolved": "settled a conflict", "meeting.match": "matched a meeting",
  "claim.insert": "added a fact", "contradiction.open": "found a conflict",
};

function Activity({ data }: { data: TabProps["data"] }) {
  const items = data.activity.filter((a) => a.actor.startsWith("human:") || a.action.startsWith("contradiction.")).slice(0, 12);
  return (
    <section className="panel panel-pad section" aria-labelledby="act-h">
      <h2 id="act-h">Recent activity</h2>
      {items.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p> : (
        <ul className="timeline small">
          {items.map((a, i) => (
            <li key={i}><span className="muted"><Time at={a.at} /></span><span><strong>{a.actor.startsWith("human:") ? a.actor.slice(6) : "VC OS"}</strong> {ACTION_LABELS[a.action] ?? a.action.replace(/[._]/g, " ")}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}
