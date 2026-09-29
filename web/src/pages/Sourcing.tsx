import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Cadence, Connector, Feed, Hit, ParamSpec } from "../types";
import { Field, FitBadge, Loading, Notice, PageHead, Seg, TagInput, when } from "../ui";

const CADENCES: { id: Cadence; label: string }[] = [
  { id: "hourly", label: "Hourly" }, { id: "daily", label: "Daily" }, { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" }, { id: "manual", label: "Manual" },
];

export default function Sourcing() {
  const { can } = useSession();
  const nav = useNavigate();
  const { data: feeds, reload: reloadFeeds } = useApi<Feed[]>("/feeds");
  const [verdict, setVerdict] = useState<"all" | "strong" | "possible" | "weak" | "excluded">("all");
  const { data: hits, reload: reloadHits } = useApi<Hit[]>(`/discovered${verdict === "all" ? "" : `?verdict=${verdict}`}`);
  const { data: connectors } = useApi<Connector[]>("/connections");
  const [adding, setAdding] = useState(false);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const newThisWeek = (hits ?? []).filter((h) => h.is_new && new Date(h.created_at).getTime() > weekAgo).length;
  const strong = (hits ?? []).filter((h) => h.fit_verdict === "strong").length;
  const usable = (connectors ?? []).filter((c) => c.sourcing && (c.status === "connected" || c.status === "available"));

  return (
    <>
      <PageHead
        eyebrow="Module · live"
        title="Sourcing"
        lead="Feeds check the sources you choose on a schedule. Every company found is resolved against your ledger and scored against your current thesis, with the reason for each point."
        actions={can("manage_feeds") && <button className="btn primary" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add a feed"}</button>}
      />
      <div className="stats">
        <div className="stat"><b className="num">{feeds?.length ?? "–"}</b><span>feeds</span></div>
        <div className="stat"><b className="num">{hits?.length ?? "–"}</b><span>companies found</span></div>
        <div className="stat"><b className="num">{newThisWeek}</b><span>new this week</span></div>
        <div className="stat"><b className="num">{strong}</b><span>strong fits</span></div>
      </div>

      {adding && (
        <div className="panel panel-pad section">
          <h2>New feed</h2>
          {usable.length ? (
            <NewFeed connectors={usable} onDone={() => { setAdding(false); void reloadFeeds(); }} />
          ) : (
            <Notice>Connect a source first. <Link to="/connections">Go to Connections</Link></Notice>
          )}
        </div>
      )}

      <section className="section">
        <h2>Feeds</h2>
        {!feeds ? <Loading /> : feeds.length === 0 ? (
          <Notice>No feeds yet. Add one to start sourcing: for example, every new YC batch weekly, or Form D filings for your sectors daily.</Notice>
        ) : (
          <div className="panel table-wrap">
            <table className="t">
              <thead><tr><th>Feed</th><th>Cadence</th><th>Last run</th><th>Next run</th><th /></tr></thead>
              <tbody>{feeds.map((f) => <FeedRow key={f.id} f={f} onChange={() => { void reloadFeeds(); void reloadHits(); }} />)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <div className="spread">
          <h2>Companies found</h2>
          <Seg
            options={[{ id: "all", label: "All" }, { id: "strong", label: "Strong" }, { id: "possible", label: "Possible" }, { id: "weak", label: "Weak" }, { id: "excluded", label: "Excluded" }]}
            value={verdict}
            onChange={setVerdict}
          />
        </div>
        {!hits ? <Loading /> : hits.length === 0 ? (
          <Notice>Nothing here yet. Run a feed, or wait for its next scheduled run.</Notice>
        ) : (
          <div className="panel table-wrap">
            <table className="t">
              <thead><tr><th>Company</th><th>Thesis fit</th><th>Why</th><th>Found by</th><th>Seen</th></tr></thead>
              <tbody>
                {hits.map((h) => (
                  <tr key={h.entity_id} className="click" onClick={() => nav(`/companies/${h.entity_id}`)}>
                    <td><strong>{h.name}</strong> {h.is_new && <span className="pill info">new</span>}</td>
                    <td><FitBadge score={h.fit_score} verdict={h.fit_verdict} /></td>
                    <td className="small">
                      {(h.fit?.reasons ?? []).map((r) => (
                        <div key={r.criterion}>
                          <span className={`pill ${r.result === "pass" ? "good" : r.result === "fail" ? "bad" : "quiet"}`}>{r.criterion}</span>{" "}
                          <span className="muted">{r.detail}</span>
                        </div>
                      ))}
                    </td>
                    <td className="small">{h.feed_name ?? "—"}</td>
                    <td className="small muted">{when(h.created_at)}</td>
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

function FeedRow({ f, onChange }: { f: Feed; onChange: () => void }) {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = f.last_run;
  return (
    <tr>
      <td>
        <strong>{f.name}</strong>
        <div className="small muted">{f.connector} · {Object.entries(f.params).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v)}`).join(" · ") || "no settings"}</div>
        {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}
      </td>
      <td>
        {can("manage_feeds") ? (
          <select className="input" style={{ width: "auto" }} value={f.cadence} aria-label="Cadence" onChange={(e) => void act(() => api(`/feeds/${f.id}`, { method: "PATCH", body: { cadence: e.target.value } }))}>
            {CADENCES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        ) : f.cadence}
        {!f.enabled && <div><span className="pill quiet">paused</span></div>}
      </td>
      <td className="small">
        {!r ? <span className="muted">never</span> : (
          <>
            <span className={`pill ${r.status === "done" ? "good" : r.status === "failed" ? "bad" : "info"}`}>{r.status === "running" ? "running" : r.status}</span>{" "}
            <span className="muted">{when(r.finished_at)}</span>
            {r.stats && r.status !== "running" && (
              <div className="muted">{r.stats.records} found · {r.stats.newCompanies} new · {r.stats.strongFits} strong{r.stats.errors ? ` · ${r.stats.errors} errors` : ""}</div>
            )}
            {r.error && <div style={{ color: "var(--bad)" }}>{r.error}</div>}
          </>
        )}
      </td>
      <td className="small muted">{f.enabled && f.next_run_at ? when(f.next_run_at) : "—"}</td>
      <td>
        {can("manage_feeds") && (
          <div className="row">
            <button className="btn small" disabled={busy} onClick={() => void act(() => api(`/feeds/${f.id}/run`, { body: {} }).then(() => new Promise((res) => setTimeout(res, 1500))))}>{busy ? "Running…" : "Run now"}</button>
            <button className="btn ghost small" disabled={busy} onClick={() => void act(() => api(`/feeds/${f.id}`, { method: "PATCH", body: { enabled: !f.enabled } }))}>{f.enabled ? "Pause" : "Resume"}</button>
            <button className="btn ghost small danger" disabled={busy} onClick={() => void act(() => api(`/feeds/${f.id}`, { method: "DELETE" }))}>Delete</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewFeed({ connectors, onDone }: { connectors: Connector[]; onDone: () => void }) {
  const [id, setId] = useState(connectors[0]!.id);
  const c = connectors.find((x) => x.id === id)!;
  return (
    <div className="section">
      <Field label="Source">
        <select className="input" id="feed-source" value={id} onChange={(e) => setId(e.target.value)}>
          {connectors.map((x) => <option key={x.id} value={x.id}>{x.name}: {x.sourcing!.summary}</option>)}
        </select>
      </Field>
      <FeedForm key={id} connector={c} onDone={onDone} />
    </div>
  );
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (spec.kind === "list") return <TagInput id={`param-${spec.name}`} value={(value as string[]) ?? []} onChange={onChange} placeholder={spec.placeholder} />;
  if (spec.kind === "boolean") {
    return (
      <label className="row small"><input type="checkbox" id={`param-${spec.name}`} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> Yes</label>
    );
  }
  return (
    <input className="input" id={`param-${spec.name}`} inputMode={spec.kind === "number" ? "numeric" : undefined} placeholder={spec.placeholder}
      value={value === undefined ? "" : String(value)} onChange={(e) => onChange(spec.kind === "number" ? e.target.value : e.target.value)} />
  );
}

/** Settings for one feed: the connector's parameters, a cadence and a name. */
export function FeedForm({ connector, onDone }: { connector: Connector; onDone: () => void }) {
  const spec = connector.sourcing!;
  const [params, setParams] = useState<Record<string, unknown>>(
    Object.fromEntries(spec.params.map((p) => [p.name, p.kind === "list" ? (Array.isArray(p.default) ? p.default : []) : p.default])),
  );
  const [cadence, setCadence] = useState<Cadence>(spec.defaultCadence);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/feeds", { body: { connectorId: connector.id, params, cadence, name: name || undefined } });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="section" onSubmit={save}>
      {spec.mode === "enrich" && <p className="small muted" style={{ margin: 0 }}>Fills in companies your other feeds found in the last 30 days, using your {connector.name} account.</p>}
      {spec.params.map((p) => (
        <Field key={p.name} label={p.label + (p.required ? "" : " (optional)")} hint={p.help}>
          <ParamInput spec={p} value={params[p.name]} onChange={(v) => setParams({ ...params, [p.name]: v })} />
        </Field>
      ))}
      <Field label="How often">
        <Seg options={CADENCES} value={cadence} onChange={setCadence} />
      </Field>
      <Field label="Name (optional)">
        <input className="input" id="feed-name" value={name} placeholder={`${connector.name}: ${spec.summary}`} onChange={(e) => setName(e.target.value)} />
      </Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <button className="btn primary small" disabled={busy}>{busy ? "Saving…" : "Save feed"}</button>
        <button type="button" className="btn ghost small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
