import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Cadence, Connector, Feed, Hit, ParamSpec } from "../types";
import { ErrorState, Field, FitBadge, Loading, Notice, PageHead, Seg, Select, TagInput, Time, useConfirm, useToast } from "../ui";
import { useVocab } from "../vocab";

const CADENCES: { id: Cadence; label: string }[] = [
  { id: "hourly", label: "Hourly" }, { id: "daily", label: "Daily" }, { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" }, { id: "manual", label: "Only when I run it" },
];
const VERDICTS = [{ id: "all", label: "All" }, { id: "strong", label: "Strong" }, { id: "possible", label: "Possible" }, { id: "weak", label: "Weak" }, { id: "excluded", label: "Excluded" }] as const;

export default function Sourcing() {
  const { can } = useSession();
  const v = useVocab();
  const { data: feeds, error: feedsError, reload: reloadFeeds } = useApi<Feed[]>("/feeds");
  const { data: hits, error: hitsError, reload: reloadHits } = useApi<Hit[]>("/discovered");
  const { data: connectors } = useApi<Connector[]>("/connections");
  const [verdict, setVerdict] = useState<(typeof VERDICTS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const newThisWeek = (hits ?? []).filter((h) => h.is_new && new Date(h.created_at).getTime() > weekAgo).length;
  const strong = (hits ?? []).filter((h) => h.fit_verdict === "strong").length;
  const usable = (connectors ?? []).filter((c) => c.sourcing && (c.status === "connected" || c.status === "available"));
  const shown = useMemo(
    () => (hits ?? []).filter((h) => (verdict === "all" || h.fit_verdict === verdict) && (!q || h.name.toLowerCase().includes(q.toLowerCase()))),
    [hits, verdict, q],
  );
  const refresh = () => {
    void reloadFeeds();
    void reloadHits();
  };

  return (
    <>
      <PageHead
        eyebrow="Module · live"
        title="Sourcing"
        lead="Feeds check the sources you choose on a schedule. Every company found is matched against your ledger and scored against your current thesis, with the reason for each point."
        actions={can("manage_feeds") && <button className="btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Close" : "Add a feed"}</button>}
      />
      <div className="stats" role="group" aria-label="Summary">
        <div className="stat"><b className="num">{feeds?.length ?? "–"}</b><span>feeds</span></div>
        <div className="stat"><b className="num">{hits?.length ?? "–"}</b><span>companies found</span></div>
        <div className="stat"><b className="num">{newThisWeek}</b><span>new this week</span></div>
        <div className="stat"><b className="num">{strong}</b><span>strong fits</span></div>
      </div>

      {adding && (
        <div className="panel panel-pad section">
          <h2>New feed</h2>
          {usable.length ? <NewFeed connectors={usable} onDone={() => { setAdding(false); refresh(); }} />
            : <Notice>Connect a source first. <Link to="/connections">Go to Connections</Link></Notice>}
        </div>
      )}

      <section className="section" aria-labelledby="feeds-h">
        <h2 id="feeds-h">Feeds</h2>
        {feedsError ? <ErrorState error={feedsError} retry={() => void reloadFeeds()} /> : !feeds ? <Loading /> : feeds.length === 0 ? (
          <Notice>No feeds yet. Add one to start sourcing: every new YC batch weekly, an accelerator's portfolio page, or Form D filings for your sectors daily.</Notice>
        ) : (
          <div className="panel table-wrap">
            <table className="t">
              <caption className="sr-only">Sourcing feeds</caption>
              <thead><tr><th scope="col">Feed</th><th scope="col">How often</th><th scope="col">Last run</th><th scope="col">Next run</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{feeds.map((f) => <FeedRow key={f.id} f={f} connector={connectors?.find((c) => c.id === f.connector_id)} onChange={refresh} />)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="found-h">
        <div className="spread">
          <h2 id="found-h">Companies found</h2>
          <div className="row">
            <input className="input" style={{ width: 220 }} type="search" aria-label="Search companies found" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
            <Seg label="Filter by thesis fit" options={VERDICTS.map((x) => ({ ...x }))} value={verdict} onChange={setVerdict} />
          </div>
        </div>
        {hitsError ? <ErrorState error={hitsError} retry={() => void reloadHits()} /> : !hits ? <Loading /> : shown.length === 0 ? (
          <Notice>{hits.length === 0 ? "Nothing here yet. Run a feed, or wait for its next scheduled run." : "No companies match this filter."}</Notice>
        ) : (
          <div className="panel table-wrap">
            <table className="t">
              <caption className="sr-only">Companies found by your feeds, best thesis fit first</caption>
              <thead><tr><th scope="col">Company</th><th scope="col">Thesis fit</th><th scope="col">Why</th><th scope="col">Found by</th><th scope="col">Seen</th><th scope="col">Where it stands</th></tr></thead>
              <tbody>
                {shown.map((h) => (
                  <tr key={h.entity_id}>
                    <td><Link to={`/companies/${h.entity_id}`}><strong>{h.name}</strong></Link> {h.is_new && <span className="pill info">New</span>}</td>
                    <td><FitBadge score={h.fit_score} verdict={h.fit_verdict} /></td>
                    <td className="small">
                      {(h.fit?.reasons ?? []).map((r) => (
                        <div key={r.criterion}>
                          <span className={`pill ${r.result === "pass" ? "good" : r.result === "fail" ? "bad" : "quiet"}`}>{v.criterion(r.criterion)}</span>{" "}
                          <span className="muted">{r.detail}</span>
                        </div>
                      ))}
                    </td>
                    <td className="small">{h.feed_name ?? "—"}</td>
                    <td className="small muted"><Time at={h.created_at} /></td>
                    <td><Triage h={h} onChange={() => void reloadHits()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** "Batches: W26, X26 · Type: Accelerator" from a feed's params, using the connector's own labels. */
function describeParams(params: Record<string, unknown>, specs: ParamSpec[] = []) {
  return Object.entries(params).map(([k, val]) => {
    const spec = specs.find((s) => s.name === k);
    const label = spec?.label ?? k;
    const shown = Array.isArray(val) ? val.join(", ") : typeof val === "boolean" ? (val ? "yes" : "no")
      : spec?.kind === "select" ? (spec.options?.find((o) => o.id === val)?.label ?? String(val)) : String(val);
    return `${label}: ${shown}`;
  }).join(" · ");
}

function FeedRow({ f, connector, onChange }: { f: Feed; connector?: Connector; onChange: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    try {
      await fn();
      if (done) toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const run = () => act("run", async () => {
    const r = await api<{ ok: boolean; stats: { records: number; newCompanies: number; strongFits: number; errors: number }; error?: string }>(`/feeds/${f.id}/run?wait=1`, { body: {} });
    if (!r.ok) throw new Error(`Run failed: ${r.error}`);
    toast("good", `${f.name}: ${r.stats.records} found, ${r.stats.newCompanies} new, ${r.stats.strongFits} strong fits${r.stats.errors ? `, ${r.stats.errors} skipped with errors` : ""}.`);
  });
  const remove = async () => {
    const ok = await confirm({ title: `Delete “${f.name}”?`, body: "The feed stops running. Companies it already found stay in your ledger.", confirm: "Delete feed", danger: true });
    if (ok) await act("delete", () => api(`/feeds/${f.id}`, { method: "DELETE" }), "Feed deleted.");
  };
  const r = f.last_run;
  const manage = can("manage_feeds");
  return (
    <tr>
      <td>
        <strong>{f.name}</strong>
        <div className="small muted">{f.connector} · {describeParams(f.params, connector?.sourcing?.params) || "no settings"}</div>
      </td>
      <td>
        {manage ? (
          <select className="input" style={{ width: "auto" }} value={f.cadence} aria-label={`How often ${f.name} runs`} onChange={(e) => void act("cadence", () => api(`/feeds/${f.id}`, { method: "PATCH", body: { cadence: e.target.value } }), "Schedule updated.")}>
            {CADENCES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        ) : CADENCES.find((c) => c.id === f.cadence)?.label}
        {!f.enabled && <div><span className="pill quiet">Paused</span></div>}
      </td>
      <td className="small">
        {!r ? <span className="muted">Never</span> : (
          <>
            <span className={`pill ${r.status === "done" ? "good" : r.status === "failed" ? "bad" : "info"}`}>{r.status === "done" ? "Done" : r.status === "failed" ? "Failed" : "Running"}</span>{" "}
            <span className="muted"><Time at={r.finished_at} /></span>
            {r.stats && r.status !== "running" && (
              <div className="muted">{r.stats.records} found · {r.stats.newCompanies} new · {r.stats.strongFits} strong{r.stats.errors ? ` · ${r.stats.errors} errors` : ""}</div>
            )}
            {r.error && <div style={{ color: "var(--bad)" }}>{r.error}</div>}
          </>
        )}
      </td>
      <td className="small muted">{f.enabled && f.next_run_at ? <Time at={f.next_run_at} /> : "—"}</td>
      <td>
        {manage && (
          <div className="row">
            <button className="btn small" disabled={Boolean(busy)} aria-busy={busy === "run"} onClick={() => void run()}>{busy === "run" ? "Running…" : "Run now"}</button>
            <button className="btn ghost small" disabled={Boolean(busy)} onClick={() => void act("pause", () => api(`/feeds/${f.id}`, { method: "PATCH", body: { enabled: !f.enabled } }), f.enabled ? "Feed paused." : "Feed resumed.")}>{f.enabled ? "Pause" : "Resume"}</button>
            <button className="btn ghost small danger" disabled={Boolean(busy)} onClick={() => void remove()}>Delete</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewFeed({ connectors, onDone }: { connectors: Connector[]; onDone: () => void }) {
  const ordered = [...connectors].sort((a, b) => (a.id === "websites" ? -1 : b.id === "websites" ? 1 : 0));
  const [id, setId] = useState(ordered[0]!.id);
  const c = ordered.find((x) => x.id === id)!;
  return (
    <div className="section">
      <Field label="Source">
        <select className="input" id="feed-source" value={id} onChange={(e) => setId(e.target.value)}>
          {ordered.map((x) => <option key={x.id} value={x.id}>{x.name}: {x.sourcing!.summary}</option>)}
        </select>
      </Field>
      <p className="small muted" style={{ margin: 0 }}>{c.description}</p>
      <FeedForm key={id} connector={c} onDone={onDone} />
    </div>
  );
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `param-${spec.name}`;
  if (spec.kind === "list") return <TagInput id={id} value={(value as string[]) ?? []} onChange={onChange} placeholder={spec.placeholder} />;
  if (spec.kind === "select") return <Select id={id} value={value as string | undefined} options={spec.options ?? []} onChange={onChange} />;
  if (spec.kind === "boolean") return <label className="row small"><input type="checkbox" id={id} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> Yes</label>;
  return (
    <input className="input" id={id} type={spec.kind === "url" ? "url" : "text"} inputMode={spec.kind === "number" ? "numeric" : undefined}
      placeholder={spec.placeholder} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Settings for one feed: the connector's parameters, a schedule and a name. */
export function FeedForm({ connector, onDone }: { connector: Connector; onDone: () => void }) {
  const toast = useToast();
  const spec = connector.sourcing!;
  const [params, setParams] = useState<Record<string, unknown>>(
    Object.fromEntries(spec.params.map((p) => [p.name, p.kind === "list" ? (Array.isArray(p.default) ? p.default : []) : p.default])),
  );
  const [cadence, setCadence] = useState<Cadence>(spec.defaultCadence);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suggestedName = connector.id === "websites" && params.orgName ? `${String(params.orgName)} portfolio` : `${connector.name}: ${spec.summary}`;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/feeds", { body: { connectorId: connector.id, params, cadence, name: name || suggestedName } });
      toast("good", `Feed “${name || suggestedName}” added. It runs ${cadence === "manual" ? "when you click Run now" : cadence}.`);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="section" onSubmit={save}>
      {spec.mode === "enrich" && <p className="small muted" style={{ margin: 0 }}>Fills in companies your other feeds found in the last 30 days, using your {connector.name} account.</p>}
      <div className="grid-2">
        {spec.params.map((p) => (
          <Field key={p.name} label={p.label} required={p.required} hint={p.help}>
            <ParamInput spec={p} value={params[p.name]} onChange={(val) => setParams({ ...params, [p.name]: val })} />
          </Field>
        ))}
      </div>
      <Field label="How often">
        <Seg label="How often" options={CADENCES} value={cadence} onChange={setCadence} />
      </Field>
      <Field label="Name">
        <input className="input" id="feed-name" value={name} placeholder={suggestedName} onChange={(e) => setName(e.target.value)} />
      </Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <button className="btn primary small" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save feed"}</button>
        <button type="button" className="btn ghost small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

const STAGE_LABEL: Record<string, string> = { screening: "Screening", diligence: "In diligence", ic: "At IC", approved: "Approved", passed: "Passed in diligence", closed: "Invested" };

/** Start diligence on a company, or pass with a reason, from where it was found. */
function Triage({ h, onChange }: { h: Hit; onChange: () => void }) {
  const { can } = useSession();
  const v = useVocab();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  if (h.deal_id) return <Link className="small" to={`/diligence/${h.deal_id}`}>{STAGE_LABEL[h.deal_stage ?? ""] ?? "Deal"}</Link>;
  const start = async () => {
    try {
      const r = await api<{ id: string }>("/deals", { body: { companyId: h.entity_id } });
      nav(`/diligence/${r.id}`);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const pass = async () => {
    let reason = "";
    let why = "";
    const ok = await confirm({
      title: `Pass on ${h.name}?`,
      confirm: "Pass",
      body: (
        <div className="section">
          <label className="field"><span>Main reason</span>
            <select className="input" defaultValue="" onChange={(e) => { reason = e.target.value; }}>
              <option value="" disabled>Choose</option>
              {v.passReasonIds.map((id) => <option key={id} value={id}>{v.passReason(id)}</option>)}
            </select>
          </label>
          <label className="field"><span>Why, in a sentence</span><textarea className="input" onChange={(e) => { why = e.target.value; }} /></label>
        </div>
      ),
    });
    if (!ok) return;
    try {
      await api(`/discovered/${h.entity_id}/pass`, { body: { reasonCode: reason, rationale: why } });
      toast("good", "Passed. The reason is on record.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <div className="row">
      {h.passed_reason && <span className="small muted">Passed: {v.passReason(h.passed_reason)}</span>}
      {can("work_deals") && <button className="btn small" onClick={() => void start()}>Start diligence</button>}
      {can("decide_deals") && !h.passed_reason && <button className="btn small ghost" onClick={() => void pass()}>Pass</button>}
    </div>
  );
}
