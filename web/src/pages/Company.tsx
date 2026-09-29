import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Claim, CompanyProfile, Evidence } from "../types";
import { Field, FitBadge, Loading, Notice, PageHead, Seg, dateOnly } from "../ui";

const SOURCE_TYPE: Record<string, { label: string; tone: string }> = {
  primary: { label: "Primary", tone: "good" },
  third_party: { label: "Third party", tone: "info" },
  self_reported: { label: "Self-reported", tone: "warn" },
  inference: { label: "Inference", tone: "quiet" },
  internal: { label: "Internal", tone: "quiet" },
};

const fmt = (c: Claim) => {
  const v = c.value;
  if (typeof v === "number" && c.predicate.endsWith("_year")) return String(v);
  if (typeof v === "number") return c.predicate.startsWith("funding.") || c.predicate.startsWith("revenue.") ? `$${v.toLocaleString("en-US")}` : v.toLocaleString("en-US");
  if (typeof v === "string") return v.replace(/_/g, " ");
  return JSON.stringify(v);
};

export default function Company() {
  const { id } = useParams();
  const [view, setView] = useState<"all" | "shareable">("all");
  const { data, error, reload } = useApi<CompanyProfile>(`/companies/${id}${view === "shareable" ? "?shareable=1" : ""}`);
  const [source, setSource] = useState<{ id: string; claim?: string } | null>(null);
  const [adding, setAdding] = useState(false);

  if (error) return <Notice tone="bad">{error.status === 404 ? "No such company in your firm." : error.message}</Notice>;
  if (!data) return <Loading />;

  const byPred = new Map<string, Claim[]>();
  for (const c of data.claims) byPred.set(c.predicate, [...(byPred.get(c.predicate) ?? []), c]);
  const conflictIds = new Set(data.contradictions.flatMap((x) => x.claim_ids));
  const description = data.claims.find((c) => c.predicate === "company.description");

  return (
    <>
      <PageHead
        eyebrow={<Link to="/companies">Companies</Link>}
        title={data.entity.name}
        lead={description ? String(description.value) : undefined}
        actions={
          <>
            <Seg options={[{ id: "all", label: "Everything" }, { id: "shareable", label: "Shareable only" }]} value={view} onChange={(v) => { setView(v); setSource(null); }} />
            <button className="btn" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add a source"}</button>
          </>
        }
      />
      {view === "shareable" && <Notice>Showing only public-source claims: what a memo to co-investors or an LP letter may cite. Vendor, internal and confidential data is filtered out by the database.</Notice>}
      {adding && <div className="panel panel-pad"><UploadForm company={data.entity.name} domain={data.identifiers.find((i) => i.kind === "domain")?.value} onDone={() => { setAdding(false); void reload(); }} /></div>}

      <div className="row small">
        {data.identifiers.map((i) => <span key={i.kind + i.value} className="pill outline mono">{i.kind}: {i.value}</span>)}
        {data.aliases.filter((a) => a.alias !== data.entity.name).map((a) => <span key={a.alias} className="pill outline">also "{a.alias}"</span>)}
      </div>

      <div className="grid-2">
        <section className="panel panel-pad section">
          <div className="spread"><h2>Thesis fit</h2>{data.fit && <FitBadge score={data.fit.fit_score} verdict={data.fit.fit_verdict} />}</div>
          {data.shareable ? <p className="muted small">Hidden in the shareable view: fit is your firm's internal judgment.</p> : !data.fit?.fit ? <p className="muted small">Not scored: add your thesis under Firm settings.</p> : (
            <ul className="does small" style={{ margin: 0, paddingLeft: 18 }}>
              {data.fit.fit.reasons.map((r) => (
                <li key={r.criterion}>
                  <span className={`pill ${r.result === "pass" ? "good" : r.result === "fail" ? "bad" : "quiet"}`}>{r.criterion}</span> {r.detail}
                </li>
              ))}
              <li className="muted">
                {data.fit.feed_name ? `Scored when ${data.fit.feed_name} found it, ` : "Scored now, "}against thesis version {data.fit.thesis_version} ({data.fit.fit.method}).
              </li>
            </ul>
          )}
        </section>
        <section className="panel panel-pad section">
          <h2>Open contradictions</h2>
          {data.contradictions.length === 0 ? <p className="muted small">None. Sources agree, or there's only one source per fact so far.</p> : data.contradictions.map((x) => (
            <div key={x.id} className="small">
              <span className={`pill ${x.severity === "high" ? "bad" : x.severity === "medium" ? "warn" : "quiet"}`}>{x.severity}</span> {x.detail}
            </div>
          ))}
        </section>
      </div>

      <section className="section">
        <h2>What the ledger knows</h2>
        {data.claims.length === 0 ? <Notice>No claims {view === "shareable" ? "from public sources" : "yet"}.</Notice> : (
          <div className="panel table-wrap">
            <table className="t">
              <thead><tr><th>Fact</th><th>Value</th><th>Source</th><th>As of</th><th>Scope</th></tr></thead>
              <tbody>
                {[...byPred].sort(([a], [b]) => a.localeCompare(b)).flatMap(([pred, list]) => list.map((c, i) => (
                  <tr key={c.id} style={conflictIds.has(c.id) ? { background: "var(--warn-soft)" } : undefined}>
                    <td className="mono small">{i === 0 ? pred : ""}</td>
                    <td>
                      <strong>{fmt(c)}</strong>
                      {c.cited_text && (
                        <div className="small" style={{ marginTop: 4 }}>
                          <span className="quote">“{c.cited_text}”</span>{" "}
                          <button className="btn ghost small" onClick={() => setSource({ id: c.evidence_id, claim: c.id })}>Show in source</button>
                        </div>
                      )}
                    </td>
                    <td className="small">
                      <span className={`pill ${SOURCE_TYPE[c.source_type]?.tone ?? "quiet"}`}>{SOURCE_TYPE[c.source_type]?.label ?? c.source_type}</span>
                      <div className="muted">{c.evidence.title ?? c.evidence.source}</div>
                    </td>
                    <td className="small num">{dateOnly(c.as_of)}</td>
                    <td><span className="pill outline">{c.access_scope}</span></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Sources</h2>
        <div className="panel table-wrap">
          <table className="t">
            <thead><tr><th>Source</th><th>Kind</th><th>Date</th><th>Claims</th><th /></tr></thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.title ?? s.uri ?? s.source}</td>
                  <td className="small">{s.source} · {s.kind.replace("_", " ")}</td>
                  <td className="small num">{dateOnly(s.occurred_at)}</td>
                  <td className="num">{s.claims}</td>
                  <td><button className="btn ghost small" onClick={() => setSource({ id: s.id })}>Read</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {source && <SourceViewer id={source.id} claimId={source.claim} onClose={() => setSource(null)} />}
      </section>

      {data.decisions.length > 0 && (
        <section className="section">
          <h2>Decisions</h2>
          {data.decisions.map((d) => (
            <div key={d.id} className="small">
              <strong>{d.kind}</strong> {d.reason_code && <span className="pill outline">{d.reason_code}</span>} {d.rationale} <span className="muted">by {d.actor}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** The raw source, with every cited span highlighted. */
function SourceViewer({ id, claimId, onClose }: { id: string; claimId?: string; onClose: () => void }) {
  const { data } = useApi<Evidence>(`/evidence/${id}`);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data) box.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [data, claimId]);
  if (!data) return <Loading what="Loading source" />;
  const spans = [...data.spans].sort((a, b) => a.span_start - b.span_start);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.span_start < pos) continue;
    parts.push(data.content.slice(pos, s.span_start));
    parts.push(
      <mark key={s.id} title={s.predicate} style={s.id === claimId ? { outline: "2px solid var(--warn)" } : undefined}>
        {data.content.slice(s.span_start, s.span_end)}
      </mark>,
    );
    pos = s.span_end;
  }
  parts.push(data.content.slice(pos));
  return (
    <div className="panel panel-pad section" ref={box}>
      <div className="spread">
        <div>
          <h3>{data.title ?? data.uri}</h3>
          <div className="small muted">{data.source} · {data.kind} · <span className="pill outline">{data.access_scope}</span></div>
        </div>
        <button className="btn small" onClick={onClose}>Close</button>
      </div>
      <pre className="evidence">{parts}</pre>
    </div>
  );
}

/** Upload a deck, data-room document or call transcript. Claims are extracted when Claude is configured on the server. */
export function UploadForm({ company, domain, onDone }: { company?: string; domain?: string; onDone: (entityId?: string) => void }) {
  const { can } = useSession();
  const [kind, setKind] = useState<"document" | "transcript">("document");
  const [name, setName] = useState(company ?? "");
  const [dom, setDom] = useState(domain ?? "");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can("upload")) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    form.set("company", name);
    form.set("kind", kind);
    if (dom) form.set("domain", dom);
    if (url) form.set("url", url);
    try {
      const r = await api<{ entityId: string; claims: number; extractionAvailable: boolean; duplicate: boolean }>("/uploads", { form });
      if (r.duplicate) setMsg({ tone: "good", text: "Already in the ledger: this exact file was added before." });
      else if (!r.extractionAvailable) setMsg({ tone: "good", text: "Stored. Claims will be extracted once Claude is configured on the server." });
      onDone(r.entityId);
    } catch (x) {
      setMsg({ tone: "bad", text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="section" onSubmit={submit}>
      <Seg options={[{ id: "document", label: "Deck or document" }, { id: "transcript", label: "Call transcript" }]} value={kind} onChange={setKind} />
      <div className="grid-2">
        <Field label="Company"><input className="input" id="upload-company" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Company website (optional)" hint="Helps match the right company."><input className="input" id="upload-domain" value={dom} placeholder="acme.com" onChange={(e) => setDom(e.target.value)} /></Field>
      </div>
      <Field label="File" hint={kind === "document" ? "PDF, .txt or .md, up to 25 MB. Export slides to PDF first." : ".vtt, .txt or .md from Zoom, Meet, Teams or Granola."}>
        <input className="input" id="upload-file" type="file" accept={kind === "document" ? ".pdf,.txt,.md" : ".vtt,.txt,.md"} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      {kind === "document" && (
        <Field label="Link (optional)" hint="For a DocSend deck, paste the DocSend link: it's kept as the source.">
          <input className="input" id="upload-url" value={url} placeholder="https://docsend.com/view/…" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="row"><button className="btn primary" disabled={busy || !file}>{busy ? "Reading…" : "Add to ledger"}</button></div>
    </form>
  );
}
