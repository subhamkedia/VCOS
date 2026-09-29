import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { Connector } from "../types";
import { Field, Loading, Notice, PageHead, when } from "../ui";
import { FeedForm } from "./Sourcing";

const CATEGORY_ORDER = ["data vendor", "public", "crm", "email", "documents", "meetings"];
const CATEGORY_LABEL: Record<string, string> = {
  "data vendor": "Data vendors", public: "Public sources", crm: "CRM", email: "Email", documents: "Documents", meetings: "Meetings",
};
const SCOPE_NOTE: Record<string, string> = {
  vendor: "Vendor data: stays inside your firm, never shared",
  public: "Public: may appear in shareable documents",
  internal: "Internal to your firm",
  confidential: "Confidential: never in shareable documents",
};

export default function Connections() {
  const [params] = useSearchParams();
  const { data, reload } = useApi<Connector[]>("/connections");
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
      {!data ? <Loading /> : CATEGORY_ORDER.map((cat) => {
        const list = data.filter((c) => c.category === cat);
        if (!list.length) return null;
        return (
          <section className="section" key={cat}>
            <h2>{CATEGORY_LABEL[cat]}</h2>
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
        <span className="pill outline">{c.scope}</span>
        <span>{SCOPE_NOTE[c.scope]}</span>
      </div>
      {c.accountLabel && <div className="small">Account: <strong>{c.accountLabel}</strong></div>}
      {c.lastError && <div className="small" style={{ color: "var(--bad)" }}>{c.lastError}</div>}
      {c.lastCheckedAt && !c.lastError && <div className="small muted">Checked {when(c.lastCheckedAt)}</div>}
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
                <button className="btn primary small" disabled={busy}>{busy ? "Checking…" : "Save and test"}</button>
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
              <button type="button" className="btn ghost small danger" disabled={busy} onClick={() => void run(() => api(`/connections/${c.id}`, { method: "DELETE" }))}>Disconnect</button>
            )}
            {c.docsUrl && <a className="btn ghost small" href={c.docsUrl} target="_blank" rel="noreferrer">Docs</a>}
          </div>
        </div>
      )}
    </article>
  );
}

/** The onboarding step: sources that can feed sourcing, with a feed form for each connected one. */
export function SourcesSetup() {
  const { data, reload } = useApi<Connector[]>("/connections");
  const { data: feeds, reload: reloadFeeds } = useApi<{ connector_id: string; name: string; cadence: string }[]>("/feeds");
  const [adding, setAdding] = useState<string | null>(null);
  if (!data) return <Loading />;
  const sourcing = data.filter((c) => c.sourcing);
  return (
    <div className="section">
      {feeds && feeds.length > 0 && (
        <Notice tone="good">
          {feeds.length} feed{feeds.length === 1 ? "" : "s"} set up: {feeds.map((f) => `${f.name} (${f.cadence})`).join("; ")}
        </Notice>
      )}
      <div className="cards">
        {sourcing.map((c) => (
          <div key={c.id} className="section" style={{ gap: 6 }}>
            <ConnectorCard c={c} onChange={reload} />
            {(c.status === "connected" || c.status === "available") && (
              adding === c.id
                ? <div className="panel panel-pad"><FeedForm connector={c} onDone={() => { setAdding(null); void reloadFeeds(); }} /></div>
                : <button type="button" className="btn small" onClick={() => setAdding(c.id)}>
                    {c.sourcing!.mode === "enrich" ? "Enrich sourced companies" : `Add a ${c.name} feed`}
                  </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
