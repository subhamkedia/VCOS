import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Connector } from "../types";
import { ErrorState, Field, Loading, Notice, PageHead, Time, useConfirm, useToast } from "../ui";
import { useVocab } from "../vocab";
import { FeedForm } from "./Sourcing";

const CATEGORY_ORDER = ["data vendor", "public", "crm", "email", "documents", "meetings"];
const CATEGORY_LABEL: Record<string, string> = {
  "data vendor": "Data vendors", public: "Public sources", crm: "CRM", email: "Email", documents: "Documents", meetings: "Meetings",
};

export default function Connections() {
  const [params] = useSearchParams();
  const { data, error, reload } = useApi<Connector[]>("/connections");
  const connected = params.get("connected");
  const failed = params.get("failed");
  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Connections"
        lead="The tools VC OS reads from. Keys are encrypted and stay with your firm. Nothing is sent from your accounts: email connections can only create drafts, and every draft or CRM note waits for approval."
      />
      {connected && <Notice tone="good">Connected {data?.find((c) => c.id === connected)?.name ?? connected}.</Notice>}
      {failed && <Notice tone="bad">Couldn't connect {failed}: {params.get("detail")}</Notice>}
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading /> : CATEGORY_ORDER.map((cat) => {
        const list = data.filter((c) => c.category === cat);
        if (!list.length) return null;
        return (
          <section className="section" key={cat} aria-labelledby={`cat-${cat.replace(" ", "-")}`}>
            <h2 id={`cat-${cat.replace(" ", "-")}`}>{CATEGORY_LABEL[cat]}</h2>
            <div className="cards">
              {list.map((c) => <ConnectorCard key={c.id} c={c} onChange={reload} />)}
            </div>
          </section>
        );
      })}
    </>
  );
}

function statusOf(c: Connector): { tone: string; label: string } {
  if (c.status === "connected") return { tone: "good", label: "Connected" };
  if (c.status === "error") return { tone: "bad", label: "Needs attention" };
  if (c.status === "available") return { tone: "info", label: "Ready, no key needed" };
  return { tone: "quiet", label: "Not connected" };
}

export function ConnectorCard({ c, onChange }: { c: Connector; onChange: () => void }) {
  const { can } = useSession();
  const v = useVocab();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = statusOf(c);
  const manage = can("manage_connections");

  const run = async (fn: () => Promise<{ ok?: boolean; detail?: string } | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "ok" in r) setMsg({ tone: r.ok ? "good" : "bad", text: r.detail ?? "" });
      setOpen(false);
      onChange();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/connections/${c.id}/oauth`, { body: {} });
      window.location.href = url;
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
      setBusy(false);
    }
  };

  const live = c.status === "connected" || c.status === "error";
  return (
    <article className="panel panel-pad section" style={{ gap: 10 }}>
      <div className="spread">
        <h3>{c.name}</h3>
        <span className={`pill ${s.tone}`}>{s.label}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>{c.description}</p>
      <div className="row small muted">
        <span className="pill outline">{v.scope(c.scope)}</span>
        <span>{v.scopeHelp(c.scope)}</span>
      </div>
      {c.accountLabel && <div className="small">Account: <strong>{c.accountLabel}</strong></div>}
      {c.lastError && <div className="small" style={{ color: "var(--bad)" }}>{c.lastError}</div>}
      {c.lastCheckedAt && !c.lastError && <div className="small muted">Checked <Time at={c.lastCheckedAt} /></div>}
      {msg && <Notice tone={msg.tone}>{msg.text || (msg.tone === "good" ? "Done." : "Failed.")}</Notice>}

      {manage && (
        <div className="section" style={{ gap: 8 }}>
          {c.auth.kind === "api_key" && open && (
            <form className="section" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void run(() => api(`/connections/${c.id}/keys`, { body: { values } })); }}>
              {c.auth.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.help}>
                  <input className="input mono" id={`${c.id}-${f.key}`} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} required />
                </Field>
              ))}
              <div className="row">
                <button className="btn primary small" disabled={busy} aria-busy={busy}>{busy ? "Checking…" : "Save and test"}</button>
                <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </form>
          )}
          <div className="row">
            {c.auth.kind === "api_key" && !open && <button type="button" className="btn small" onClick={() => setOpen(true)}>{live ? "Replace key" : "Add API key"}</button>}
            {c.auth.kind === "oauth" && (c.auth.available
              ? <button type="button" className="btn small" disabled={busy} onClick={() => void connectOAuth()}>{live ? "Reconnect" : `Connect with ${c.auth.provider === "google" ? "Google" : "Microsoft"}`}</button>
              : <span className="small muted">Needs the server's {c.auth.provider === "google" ? "Google" : "Microsoft"} app (ask your administrator).</span>)}
            {(c.auth.kind === "none" || c.auth.kind === "platform") && !live && (
              <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => api(`/connections/${c.id}/enable`, { body: {} }))}>Turn on</button>
            )}
            {live && <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => api(`/connections/${c.id}/test`, { body: {} }))}>Test</button>}
            {live && c.auth.kind !== "none" && c.auth.kind !== "platform" && (
              <button type="button" className="btn ghost small danger" disabled={busy} onClick={() => void (async () => {
                const ok = await confirm({ title: `Disconnect ${c.name}?`, body: "VC OS deletes the stored credentials. Feeds using it stop until you connect again. What it already found stays in your ledger.", confirm: "Disconnect", danger: true });
                if (ok) await run(async () => { await api(`/connections/${c.id}`, { method: "DELETE" }); toast("good", `${c.name} disconnected.`); });
              })()}>Disconnect</button>
            )}
            {c.docsUrl && <a className="btn ghost small" href={c.docsUrl} target="_blank" rel="noreferrer">Docs<span className="sr-only"> (opens in a new tab)</span></a>}
          </div>
        </div>
      )}
    </article>
  );
}

const SETUP_GROUPS: { title: string; lead: string; ids: string[] }[] = [
  { title: "Websites to follow", lead: "Portfolio and cohort pages of accelerators, incubators, venture studios, VCs and CVCs. Add as many as you like; each is checked on its own schedule.", ids: ["websites"] },
  { title: "Directories and filings", lead: "Public sources of new companies.", ids: ["yc", "sec-edgar"] },
  { title: "Your pipeline and inbox", lead: "Companies already coming to you.", ids: ["affinity", "gmail", "outlook"] },
  { title: "Fill in what you find", lead: "Data vendors that enrich companies your feeds found. Needs your own account.", ids: ["harmonic", "pitchbook", "crunchbase", "dealroom"] },
];

/** The setup step: sources grouped by what they're for, each with its feeds. */
export function SourcesSetup() {
  const { data, error, reload } = useApi<Connector[]>("/connections");
  const { data: feeds, reload: reloadFeeds } = useApi<{ id: string; connector_id: string; name: string; cadence: string }[]>("/feeds");
  const [adding, setAdding] = useState<string | null>(null);
  if (error) return <ErrorState error={error} retry={() => void reload()} />;
  if (!data) return <Loading />;
  return (
    <div className="section" style={{ gap: 24 }}>
      {SETUP_GROUPS.map((g) => {
        const list = g.ids.map((id) => data.find((c) => c.id === id)).filter((c): c is Connector => Boolean(c?.sourcing));
        return (
          <section key={g.title} className="section" aria-label={g.title}>
            <div><h2>{g.title}</h2><p className="muted small" style={{ margin: "4px 0 0" }}>{g.lead}</p></div>
            <div className="cards">
              {list.map((c) => {
                const mine = (feeds ?? []).filter((f) => f.connector_id === c.id);
                const ready = c.status === "connected" || c.status === "available";
                return (
                  <div key={c.id} className="section" style={{ gap: 6 }}>
                    <ConnectorCard c={c} onChange={reload} />
                    {mine.length > 0 && (
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }} aria-label={`${c.name} feeds`}>
                        {mine.map((f) => <li key={f.id}>{f.name} <span className="muted">({f.cadence})</span></li>)}
                      </ul>
                    )}
                    {ready && (adding === c.id
                      ? <div className="panel panel-pad"><FeedForm connector={c} onDone={() => { setAdding(null); void reloadFeeds(); }} /></div>
                      : <button type="button" className="btn small" onClick={() => setAdding(c.id)}>
                          {c.id === "websites" ? (mine.length ? "Add another website" : "Add a website") : c.sourcing!.mode === "enrich" ? "Enrich sourced companies" : `Add a ${c.name} feed`}
                        </button>)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
