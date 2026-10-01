import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Claim, CompanyProfile, DealListRow, Evidence } from "../types";
import { ErrorState, Field, FitBadge, Loading, Notice, PageHead, Seg, actor, dateOnly, useToast } from "../ui";
import { useVocab } from "../vocab";

const SOURCE_TYPE_TONE: Record<string, string> = { primary: "good", third_party: "info", self_reported: "warn", inference: "quiet", internal: "quiet" };
const SEVERITY_TONE: Record<string, string> = { high: "bad", medium: "warn", low: "quiet" };

export default function Company() {
  const { id } = useParams();
  const v = useVocab();
  const [view, setView] = useState<"all" | "shareable">("all");
  const { data, error, reload } = useApi<CompanyProfile>(`/companies/${id}${view === "shareable" ? "?shareable=1" : ""}`);
  const [source, setSource] = useState<{ id: string; claim?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const { can } = useSession();
  const { data: open } = useApi<DealListRow[]>("/deals?stages=screening,diligence,ic");
  const deal = open?.find((d) => d.company_id === id);
  const nav = useNavigate();
  const toast = useToast();
  const startDeal = async () => {
    try {
      const r = await api<{ id: string }>("/deals", { body: { companyId: id } });
      nav(`/diligence/${r.id}`);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };

  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading what="Loading company" />;

  const conflictIds = new Set(data.contradictions.flatMap((x) => x.claim_ids));
  const description = data.claims.find((c) => c.predicate === "company.description");
  // Group facts into sections (Company, Team, Funding…), then by fact within each.
  const sections = new Map<string, { label: string; facts: Map<string, Claim[]> }>();
  for (const g of v.groups) sections.set(g.id, { label: g.label, facts: new Map() });
  for (const c of data.claims) {
    const g = v.groupOf(c.predicate);
    if (!sections.has(g.id)) sections.set(g.id, { label: g.label, facts: new Map() });
    const facts = sections.get(g.id)!.facts;
    facts.set(c.predicate, [...(facts.get(c.predicate) ?? []), c]);
  }

  return (
    <>
      <PageHead
        eyebrow={<Link to="/companies">Companies</Link>}
        title={data.entity.name}
        lead={description?.display}
        actions={
          <>
            <Seg label="Which facts to show" options={[{ id: "all", label: "Everything" }, { id: "shareable", label: "Shareable only" }]} value={view} onChange={(x) => { setView(x); setSource(null); }} />
            <button className="btn" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Close" : "Add a source"}</button>
            {deal ? <Link className="btn primary" to={`/diligence/${deal.id}`}>Open diligence</Link>
              : can("work_deals") && !data.shareable && <button className="btn primary" onClick={() => void startDeal()}>Start diligence</button>}
          </>
        }
      />
      {view === "shareable" && <Notice>Showing only facts from public sources: what a memo to co-investors or an LP letter may cite. Vendor, internal and confidential facts are filtered out by the database, and thesis fit is hidden.</Notice>}
      {adding && <div className="panel panel-pad"><UploadForm company={data.entity.name} domain={data.identifiers.find((i) => i.kind === "domain")?.value} onDone={() => { setAdding(false); void reload(); }} /></div>}

      <ul className="row small" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Identifiers">
        {data.identifiers.map((i) => <li key={i.kind + i.value}><span className="pill outline">{v.identifier(i.kind)}: <span className="mono">{i.value}</span></span></li>)}
        {data.aliases.filter((a) => a.alias !== data.entity.name).map((a) => <li key={a.alias}><span className="pill outline">Also known as “{a.alias}”</span></li>)}
      </ul>

      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="fit-h">
          <div className="spread"><h2 id="fit-h">Thesis fit</h2>{data.fit && <FitBadge score={data.fit.fit_score} verdict={data.fit.fit_verdict} />}</div>
          {data.shareable ? <p className="muted small" style={{ margin: 0 }}>Hidden in the shareable view: fit is your firm's internal judgment.</p>
            : !data.fit?.fit ? <p className="muted small" style={{ margin: 0 }}>Not scored: add your thesis under Firm settings.</p> : (
              <ul className="does small" style={{ margin: 0, paddingLeft: 18 }}>
                {data.fit.fit.reasons.map((r) => (
                  <li key={r.criterion}>
                    <span className={`pill ${r.result === "pass" ? "good" : r.result === "fail" ? "bad" : "quiet"}`}>{v.criterion(r.criterion)}</span> {r.detail}
                  </li>
                ))}
                <li className="muted">
                  {data.fit.feed_name ? `Scored when “${data.fit.feed_name}” found it, ` : "Scored now, "}against version {data.fit.thesis_version} of your thesis.
                </li>
              </ul>
            )}
        </section>
        <section className="panel panel-pad section" aria-labelledby="conflicts-h">
          <h2 id="conflicts-h">Where sources disagree</h2>
          {data.contradictions.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing open. Sources agree, or each fact has one source so far.</p> : data.contradictions.map((x) => (
            <div key={x.id} className="small">
              <span className={`pill ${SEVERITY_TONE[x.severity]}`}>{v.severity(x.severity)}</span> {x.detail}
            </div>
          ))}
        </section>
      </div>

      <section className="section" aria-labelledby="facts-h">
        <h2 id="facts-h">What the ledger knows</h2>
        {data.claims.length === 0 ? <Notice>No facts {view === "shareable" ? "from public sources" : "yet"}.</Notice> : (
          <div className="panel table-wrap">
            <table className="t claim-group">
              <caption className="sr-only">Facts about {data.entity.name}, grouped by topic, with their sources</caption>
              <thead><tr><th scope="col">Fact</th><th scope="col">Value</th><th scope="col">Source</th><th scope="col">As of</th><th scope="col">Access</th></tr></thead>
              {[...sections.values()].filter((s) => s.facts.size).map((s) => (
                <tbody key={s.label}>
                  <tr><th scope="rowgroup" colSpan={5}>{s.label}</th></tr>
                  {[...s.facts].map(([pred, list]) => list.map((c, i) => (
                    <tr key={c.id} style={conflictIds.has(c.id) ? { background: "var(--warn-soft)" } : undefined}>
                      <td>{i === 0 ? <span title={v.predicateHelp(pred)}>{c.label}</span> : <span className="sr-only">{c.label}</span>}</td>
                      <td>
                        <strong>{c.display}</strong>
                        {conflictIds.has(c.id) && <span className="pill warn" style={{ marginLeft: 6 }}>disagrees</span>}
                        {c.cited_text && (
                          <div className="small" style={{ marginTop: 4 }}>
                            <q className="quote">{c.cited_text}</q>{" "}
                            <button className="btn ghost small" onClick={() => setSource({ id: c.evidence_id, claim: c.id })}>Show in source</button>
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <span className={`pill ${SOURCE_TYPE_TONE[c.source_type] ?? "quiet"}`} title={v.sourceTypeHelp(c.source_type)}>{v.sourceType(c.source_type)}</span>
                        <div className="muted">{c.evidence.title ?? v.source(c.evidence.source)}</div>
                      </td>
                      <td className="small num">{dateOnly(c.as_of)}</td>
                      <td><span className="pill outline" title={v.scopeHelp(c.access_scope)}>{v.scope(c.access_scope)}</span></td>
                    </tr>
                  )))}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="sources-h">
        <h2 id="sources-h">Sources</h2>
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Sources for {data.entity.name}</caption>
            <thead><tr><th scope="col">Source</th><th scope="col">From</th><th scope="col">Date</th><th scope="col">Facts</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.title ?? s.uri ?? v.source(s.source)}</td>
                  <td className="small">{v.source(s.source)}{v.kind(s.kind) !== v.source(s.source) ? ` · ${v.kind(s.kind)}` : ""}</td>
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
        <section className="section" aria-labelledby="decisions-h">
          <h2 id="decisions-h">Decisions</h2>
          {data.decisions.map((d) => (
            <div key={d.id} className="small">
              <strong>{v.decision(d.kind)}</strong>{" "}
              {d.reason_code && <span className="pill outline">{v.passReason(d.reason_code)}</span>} {d.rationale}{" "}
              <span className="muted">by {actor(d.actor)}, {dateOnly(d.created_at)}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** The raw source, with every cited span highlighted. */
export function SourceViewer({ id, claimId, onClose }: { id: string; claimId?: string; onClose: () => void }) {
  const v = useVocab();
  const { data, error } = useApi<Evidence>(`/evidence/${id}`);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data) box.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [data, claimId]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading what="Loading source" />;
  const spans = [...data.spans].sort((a, b) => a.span_start - b.span_start);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.span_start < pos) continue;
    parts.push(<Fragment key={`t${pos}`}>{data.content.slice(pos, s.span_start)}</Fragment>);
    parts.push(
      <mark key={s.id} title={v.predicate(s.predicate)} style={s.id === claimId ? { outline: "2px solid var(--warn)" } : undefined}>
        {data.content.slice(s.span_start, s.span_end)}
      </mark>,
    );
    pos = s.span_end;
  }
  parts.push(<Fragment key="end">{data.content.slice(pos)}</Fragment>);
  return (
    <section className="panel panel-pad section" ref={box} aria-label={`Source: ${data.title ?? data.uri}`}>
      <div className="spread">
        <div>
          <h3>{data.title ?? data.uri}</h3>
          <div className="small muted">{v.source(data.source)}{v.kind(data.kind) !== v.source(data.source) ? ` · ${v.kind(data.kind)}` : ""} · <span className="pill outline">{v.scope(data.access_scope)}</span></div>
        </div>
        <button className="btn small" onClick={onClose}>Close</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Highlighted text is what a fact cites. Hover a highlight to see which fact.</p>
      <pre className="evidence">{parts}</pre>
    </section>
  );
}

/** Add a deck, data-room document, call transcript or public web page. Facts are extracted when Claude is configured on the server. */
export function UploadForm({ company, domain, onDone }: { company?: string; domain?: string; onDone: (entityId?: string) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<"document" | "transcript" | "web">("document");
  const [name, setName] = useState(company ?? "");
  const [dom, setDom] = useState(domain ?? "");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can("upload")) return <Notice>Your role can't add sources.</Notice>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const done = (r: { entityId: string | null; claims: number; extractionAvailable: boolean; duplicate: boolean }, what: string) => {
      toast("good", r.duplicate ? `Already in the ledger: this exact ${what} was added before.`
        : r.extractionAvailable ? `Added. ${r.claims} fact${r.claims === 1 ? "" : "s"} extracted.` : "Stored. Facts are extracted once Claude is configured on the server.");
      onDone(r.entityId ?? undefined);
    };
    if (kind === "web") {
      setBusy(true);
      setErr(null);
      try {
        done(await api("/web-pages", { body: { url, company: name, domain: dom || undefined } }), "page");
      } catch (x) {
        setErr((x as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return setErr("Files up to 25 MB.");
    setBusy(true);
    setErr(null);
    const form = new FormData();
    form.set("file", file);
    form.set("company", name);
    form.set("kind", kind);
    if (dom) form.set("domain", dom);
    if (url) form.set("url", url);
    try {
      done(await api("/uploads", { form }), "file");
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="section" onSubmit={submit}>
      <Seg label="Kind of source" options={[{ id: "document", label: "Deck or document" }, { id: "transcript", label: "Call transcript" }, { id: "web", label: "Web page" }]} value={kind} onChange={setKind} />
      <div className="grid-2">
        <Field label="Company" required><input className="input" id="upload-company" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Company website" hint="Helps match the right company."><input className="input" id="upload-domain" value={dom} placeholder="acme.com" onChange={(e) => setDom(e.target.value)} /></Field>
      </div>
      {kind === "web" ? (
        <Field label="Page link" required hint="A public page about the company: a press article, a filing, a blog post. Kept as public evidence.">
          <input className="input" id="upload-page" type="url" required value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      ) : (
        <Field label="File" required hint={kind === "document" ? "PDF, .txt or .md, up to 25 MB. Export slides to PDF first." : ".vtt, .txt or .md from Zoom, Meet, Teams or Granola."}>
          <input className="input" id="upload-file" type="file" accept={kind === "document" ? ".pdf,.txt,.md" : ".vtt,.txt,.md"} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      {kind === "document" && (
        <Field label="Link" hint="For a DocSend deck, paste the DocSend link: it's kept as the source.">
          <input className="input" id="upload-url" type="url" value={url} placeholder="https://docsend.com/view/…" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={busy || (kind === "web" ? !url : !file)} aria-busy={busy}>{busy ? "Reading…" : "Add to ledger"}</button></div>
    </form>
  );
}
