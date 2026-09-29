import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { CompanyRow, Feed, Meeting, MeetingStatus } from "../types";
import { ErrorState, Field, Loading, Notice, PageHead, Seg, Time, useToast } from "../ui";
import { SourceViewer } from "./Company";

const TABS: { id: MeetingStatus; label: string }[] = [
  { id: "needs_review", label: "Needs you" },
  { id: "matched", label: "Matched" },
  { id: "internal", label: "Internal" },
  { id: "ignored", label: "Ignored" },
];

const METHOD_LABELS: Record<string, string> = {
  email_domain: "by email domain", known_contact: "by a known contact", same_conference: "through the calendar invite",
  person: "by a person", internal: "everyone is from your firm",
};

/**
 * Every call from the firm's meeting tools, matched to the company it was
 * with. Most match on their own; the ones that don't wait here, with the
 * matcher's reasons and suggestions. A decision here is remembered.
 */
export default function Meetings() {
  const { can } = useSession();
  const [status, setStatus] = useState<MeetingStatus>("needs_review");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const { data, error, reload } = useApi<Meeting[]>(`/meetings?status=${status}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  const { data: counts, reload: reloadCounts } = useApi<Record<MeetingStatus, number>>("/meetings/counts");
  const { data: syncs, reload: reloadSyncs } = useApi<Feed[]>("/meetings/syncs");
  const [reading, setReading] = useState<string | null>(null);
  const refresh = () => {
    void reload();
    void reloadCounts();
  };
  const tabs = TABS.map((t) => ({ ...t, label: counts && counts[t.id] ? `${t.label} (${counts[t.id]})` : t.label }));

  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Meetings"
        lead="Calls from your connected meeting tools, each filed under the company it was with. Their notes and transcripts become confidential sources on that company. When VC OS isn't sure, it asks here, and remembers your answer."
      />
      <SyncPanel syncs={syncs} onRun={() => { void reloadSyncs(); refresh(); }} canRun={can("triage_meetings")} />
      <div className="spread">
        <Seg label="Which meetings" options={tabs} value={status} onChange={setStatus} />
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
          <input className="input" type="search" style={{ maxWidth: 260 }} aria-label="Search meetings by title or attendee" placeholder="Title or attendee" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn">Search</button>
          {search && <button type="button" className="btn ghost" onClick={() => { setQ(""); setSearch(""); }}>Clear</button>}
        </form>
      </div>
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading what="Loading meetings" /> : data.length === 0 ? (
        <Notice tone={status === "needs_review" ? "good" : "info"}>
          {status === "needs_review" ? "Nothing needs you. Every synced meeting is matched, internal or ignored." : search ? `No ${status.replace("_", " ")} meetings match “${search}”.` : syncs?.length ? "None yet." : <>No meeting tools connected yet. <Link to="/connections">Connect Google Calendar, Outlook, Zoom, Granola or Fireflies</Link>.</>}
        </Notice>
      ) : (
        <ul className="section" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={`${TABS.find((t) => t.id === status)!.label} meetings`}>
          {data.map((m) => (
            <li key={m.id}>
              <MeetingCard m={m} canTriage={can("triage_meetings")} onChange={refresh} onRead={() => setReading(m.evidence_id)} />
            </li>
          ))}
        </ul>
      )}
      {reading && <SourceViewer id={reading} onClose={() => setReading(null)} />}
    </>
  );
}

function SyncPanel({ syncs, onRun, canRun }: { syncs: Feed[] | null; onRun: () => void; canRun: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!syncs?.length) return null;
  const run = async (f: Feed) => {
    setBusy(f.id);
    try {
      const r = await api<{ ok: boolean; error?: string; stats: { new: number; matched: number; needsReview: number } }>(`/meetings/syncs/${f.id}/run`, { body: {} });
      toast(r.ok ? "good" : "bad", r.ok ? `${f.connector}: ${r.stats.new} new, ${r.stats.matched} matched, ${r.stats.needsReview} for you.` : `${f.connector}: ${r.error}`);
      onRun();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel table-wrap" aria-label="Meeting tools">
      <table className="t">
        <caption className="sr-only">Connected meeting tools and their last sync</caption>
        <thead><tr><th scope="col">Tool</th><th scope="col">Syncs</th><th scope="col">Last sync</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {syncs.map((f) => (
            <tr key={f.id}>
              <td>{f.connector}</td>
              <td className="small">{f.cadence === "hourly" ? "Every hour" : f.cadence}</td>
              <td className="small">
                {f.last_run ? (
                  <>
                    <span className={`status-dot ${f.last_run.status === "done" ? "good" : f.last_run.status === "failed" ? "bad" : "info"}`} aria-hidden="true" />{" "}
                    {f.last_run.status === "failed" ? <span style={{ color: "var(--bad)" }}>Failed: {f.last_run.error}</span> : <Time at={f.last_run.finished_at} />}
                  </>
                ) : <span className="muted">Not yet</span>}
              </td>
              <td>{canRun && <button className="btn small" disabled={busy === f.id} aria-busy={busy === f.id} onClick={() => void run(f)}>{busy === f.id ? "Syncing…" : "Sync now"}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const external = (m: Meeting) => m.attendees.filter((a) => !a.self);

function MeetingCard({ m, canTriage, onChange, onRead }: { m: Meeting; canTriage: boolean; onChange: () => void; onRead: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "choose" | "new">("none");
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const assign = (body: object, name: string) => act(() => api(`/meetings/${m.id}/assign`, { body }), `Filed under ${name}. Next time, calls with these people match on their own.`);
  const mark = (status: string, done: string) => act(() => api(`/meetings/${m.id}/mark`, { body: { status } }), done);
  const titleId = `m-${m.id}`;
  return (
    <article className="panel panel-pad section" style={{ gap: 8 }} aria-labelledby={titleId}>
      <div className="spread">
        <div>
          <h3 id={titleId}>{m.title}</h3>
          <div className="small muted">
            {m.started_at ? new Date(m.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No date"} · {m.sourceName}
            {m.has_words ? " · notes or transcript" : " · no transcript"}
          </div>
        </div>
        <div className="row">
          {m.status === "matched" && m.company_id && <Link className="pill good" to={`/companies/${m.company_id}`}>{m.company_name}</Link>}
          {m.has_words && m.evidence_id && <button className="btn ghost small" onClick={onRead}>Read</button>}
        </div>
      </div>
      {external(m).length > 0 && (
        <ul className="row small" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }} aria-label="People outside your firm">
          {external(m).map((a, i) => <li key={a.email ?? `${a.name}-${i}`} className="pill outline">{a.name ?? a.email}{a.name && a.email ? ` · ${a.email}` : ""}</li>)}
        </ul>
      )}
      {m.status === "matched" && m.match.method && <div className="small muted">Matched {METHOD_LABELS[m.match.method] ?? m.match.method}{m.matched_by?.startsWith("human:") ? ` (${m.matched_by.slice(6)})` : ""}.{m.extracted ? " Facts extracted." : m.has_words ? " Facts are extracted when Claude is configured." : ""}</div>}
      {m.status !== "matched" && m.match.reasons?.length ? <p className="small" style={{ margin: 0 }}>{m.match.reasons.join(" ")}</p> : null}

      {canTriage && m.status === "needs_review" && (
        <div className="section" style={{ gap: 8 }}>
          <div className="row">
            {(m.match.candidates ?? []).map((c) => (
              <button key={c.entityId} className="btn small primary" disabled={busy} title={c.why} onClick={() => void assign({ companyId: c.entityId }, c.name)}>It's {c.name}</button>
            ))}
            {m.match.newDomain && <button className="btn small" disabled={busy} onClick={() => setMode("new")}>New company at {m.match.newDomain}</button>}
            <button className="btn small" disabled={busy} onClick={() => setMode(mode === "choose" ? "none" : "choose")} aria-expanded={mode === "choose"}>Choose a company</button>
            <button className="btn small ghost" disabled={busy} onClick={() => void mark("internal", "Marked internal.")}>Internal</button>
            <button className="btn small ghost danger" disabled={busy} onClick={() => void mark("ignored", "Ignored.")}>Ignore</button>
          </div>
          {mode === "choose" && <ChooseCompany onPick={(c) => void assign({ companyId: c.id }, c.name)} onNew={() => setMode("new")} />}
          {mode === "new" && <NewCompany domain={m.match.newDomain} onCreate={(name, domain) => void assign({ newCompany: { name, domain } }, name)} onCancel={() => setMode("none")} />}
        </div>
      )}
      {canTriage && m.status !== "needs_review" && (
        <div className="row">
          <button className="btn small ghost" disabled={busy} onClick={() => void mark("needs_review", "Moved back to review.")}>{m.status === "matched" ? "Wrong company?" : "Undo"}</button>
        </div>
      )}
    </article>
  );
}

function ChooseCompany({ onPick, onNew }: { onPick: (c: { id: string; name: string }) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const { data } = useApi<CompanyRow[]>(q.trim().length >= 2 ? `/companies?q=${encodeURIComponent(q.trim())}` : null);
  return (
    <div className="panel panel-pad section" style={{ gap: 8 }}>
      <Field label="Company">
        <input className="input" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type two letters or more" aria-describedby="choose-hint" />
      </Field>
      <div id="choose-hint" className="sr-only">Results appear below as you type.</div>
      <ul className="row" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-live="polite">
        {(data ?? []).slice(0, 8).map((c) => <li key={c.id}><button className="btn small" onClick={() => onPick(c)}>{c.name}{c.domain ? ` · ${c.domain}` : ""}</button></li>)}
        {q.trim().length >= 2 && data?.length === 0 && <li className="small muted">No company matches. <button className="btn ghost small" onClick={onNew}>Create it</button></li>}
      </ul>
    </div>
  );
}

function NewCompany({ domain, onCreate, onCancel }: { domain?: string; onCreate: (name: string, domain?: string) => void; onCancel: () => void }) {
  const guess = domain ? domain.split(".")[0]!.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
  const [name, setName] = useState(guess);
  const [dom, setDom] = useState(domain ?? "");
  return (
    <form className="panel panel-pad section" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim(), dom.trim() || undefined); }}>
      <div className="grid-2">
        <Field label="Company name" required><input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Website"><input className="input" value={dom} placeholder="acme.com" onChange={(e) => setDom(e.target.value)} /></Field>
      </div>
      <div className="row"><button className="btn primary small">Create and file</button><button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
