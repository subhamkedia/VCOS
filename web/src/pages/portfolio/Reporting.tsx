import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Chips, Field, Notice, dateOnly, useConfirm, useToast } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { monthLabel, person } from "./shared";

const DEFAULT = ["revenue.monthly", "expenses.monthly", "cash.balance", "burn.monthly", "team.headcount", "customers.paying.count", "revenue.arr"];
const REQ_TONE: Record<string, string> = { open: "info", received: "good", cancelled: "quiet" };
const REQ_LABEL: Record<string, string> = { open: "Waiting", received: "Received", cancelled: "Cancelled" };

/**
 * How the company reports: who at the company sends the numbers, monthly
 * requests (queued as email drafts in your mailbox), and the founder portal,
 * a link with no login where the founder reports numbers or connects the
 * books. Ask for a handful of metrics: short requests get answered.
 */
export default function Reporting({ data, onChange }: PfTabProps) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const live = data.portalLinks.filter((l) => !l.revokedAt && l.expiresAt > new Date().toISOString());
  const makeLink = async () => {
    try {
      setLink(await api<{ url: string; expiresAt: string }>(`/portfolio/companies/${data.company.id}/portal`, { body: {} }));
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const revoke = async () => {
    if (!(await confirm({ title: "Turn off every portal link for this company?", body: "Links already sent stop working. Accounting connections stay; the founder can disconnect them in QuickBooks or Xero.", confirm: "Turn off links", danger: true }))) return;
    try {
      await api(`/portfolio/companies/${data.company.id}/portal/revoke`, { body: {} });
      setLink(null);
      toast("good", "Links turned off.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const remove = async (id: string, name: string) => {
    if (!(await confirm({ title: `Remove ${name}?`, body: "They'll no longer get KPI requests.", confirm: "Remove", danger: true }))) return;
    try {
      await api(`/portfolio/companies/${data.company.id}/contacts/${id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast("good", "Link copied.");
    } catch {
      toast("bad", "Couldn't copy: select the link and copy it.");
    }
  };
  return (
    <>
      <div className="grid-2">
        <section className="panel panel-pad section" aria-labelledby="ct-h">
          <h2 id="ct-h">Contacts</h2>
          {data.contacts.length === 0 ? <Notice>Add the person who sends the numbers (usually the CEO or CFO).</Notice> : (
            <ul className="timeline small">
              {data.contacts.map((c) => (
                <li key={c.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                  <span><strong>{c.name}</strong>{c.role ? `, ${c.role}` : ""}<br /><span className="muted">{c.email}</span>{c.reporting && <> · <span className="pill info">Gets requests</span></>}</span>
                  {can("work_deals") && <button className="btn small ghost" onClick={() => void remove(c.id, c.name)} aria-label={`Remove ${c.name}`}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {can("work_deals") && <AddContact companyId={data.company.id} onDone={onChange} />}
        </section>
        <section className="panel panel-pad section" aria-labelledby="pl-h">
          <h2 id="pl-h">Founder portal</h2>
          <p className="small muted" style={{ margin: 0 }}>A private link, no login: the founder reports the month's numbers or connects QuickBooks or Xero (read only). It shows them only what they report; never your marks, ratings or notes. Links expire after 45 days.</p>
          {link && (
            <div className="section" style={{ gap: 6 }}>
              <Notice tone="good">Link created. It's shown once: copy it now.</Notice>
              <input className="input mono" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Portal link" />
              <div className="row"><button className="btn small" onClick={() => void copy(link.url)}>Copy link</button></div>
            </div>
          )}
          <p className="small" style={{ margin: 0 }}>{live.length} active {live.length === 1 ? "link" : "links"}{live[0] ? `, last opened ${live.find((l) => l.lastUsedAt)?.lastUsedAt ? dateOnly(live.find((l) => l.lastUsedAt)!.lastUsedAt) : "never"}` : ""}.</p>
          {data.accounting.length > 0 && <p className="small" style={{ margin: 0 }}>Books connected: {data.accounting.map((a) => `${a.provider === "quickbooks" ? "QuickBooks Online" : "Xero"}${a.external_name ? ` (${a.external_name})` : ""}`).join(", ")}.</p>}
          {can("work_deals") && (
            <div className="row">
              <button className="btn" onClick={() => void makeLink()}>New link</button>
              {live.length > 0 && <button className="btn ghost" onClick={() => void revoke()}>Turn off links</button>}
            </div>
          )}
        </section>
      </div>

      {can("queue") && <NewRequest data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="rq-h">
        <h2 id="rq-h">Requests</h2>
        {data.requests.length === 0 ? <Notice>No requests yet.</Notice> : (
          <ul className="timeline small">
            {data.requests.map((r) => (
              <li key={r.id}>
                <span>{monthLabel(r.period)}</span>
                <span className="row" style={{ justifyContent: "space-between" }}>
                  <span>{r.metrics.length} metrics, due {dateOnly(r.due_on)} · to {r.recipients.join(", ")} · {person(r.created_by)}{r.status === "open" && r.due_on < new Date().toISOString().slice(0, 10) ? <span className="pill bad" style={{ marginLeft: 6 }}>Overdue</span> : null}</span>
                  <span className={`pill ${REQ_TONE[r.status]}`}>{REQ_LABEL[r.status]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AddContact({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [reporting, setReporting] = useState(true);
  const save = async () => {
    try {
      await api(`/portfolio/companies/${companyId}/contacts`, { body: { name, email, role, reporting } });
      toast("good", "Contact added.");
      setName("");
      setEmail("");
      setRole("");
      onDone();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <form className="section" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Add a contact">
      <div className="form-grid">
        <Field label="Name" required><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email" required><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role"><input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="CEO" /></Field>
      </div>
      <label className="check-row"><input type="checkbox" checked={reporting} onChange={(e) => setReporting(e.target.checked)} /><span>Sends the numbers (gets KPI requests)</span></label>
      <div className="row"><button className="btn small">Add contact</button></div>
    </form>
  );
}

function NewRequest({ data, onChange }: PfTabProps) {
  const toast = useToast();
  const last = new Date();
  last.setUTCDate(1);
  last.setUTCMonth(last.getUTCMonth() - 1);
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 14);
  const [period, setPeriod] = useState(last.toISOString().slice(0, 7));
  const [dueOn, setDueOn] = useState(due.toISOString().slice(0, 10));
  const [metrics, setMetrics] = useState<string[]>(DEFAULT);
  const [result, setResult] = useState<{ outboxId: string | null; link: string; email: { to: string[]; subject: string; body: string } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setErr(null);
    try {
      const r = await api<{ outboxId: string | null; link: string; email: { to: string[]; subject: string; body: string } }>(`/portfolio/companies/${data.company.id}/requests`, { body: { period, dueOn, metrics } });
      setResult(r);
      toast("good", r.outboxId ? "Request drafted: approve it in Approvals, then send it from your mailbox." : "Request created. Copy the email below.");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="nr-h" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h2 id="nr-h">Ask for numbers</h2>
      <div className="form-grid">
        <Field label="Month" required><input className="input" type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
        <Field label="Due" required><input className="input" type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
      </div>
      <fieldset className="section" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
        <legend className="small"><strong>Metrics</strong> <span className="muted">(keep it short)</span></legend>
        <Chips options={data.options.reportable} value={metrics} onChange={setMetrics} />
      </fieldset>
      <p className="small muted" style={{ margin: 0 }}>Goes to {data.contacts.filter((c) => c.reporting).map((c) => c.email).join(", ") || "the contacts marked to get requests (add one above)"}, with a fresh portal link, as an email draft for you to approve and send.</p>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={!metrics.length}>Draft request</button></div>
      {result && !result.outboxId && (
        <div className="section" style={{ gap: 6 }}>
          <Notice>No mailbox is connected, so nothing was drafted. Copy this into an email to {result.email.to.join(", ")}:</Notice>
          <textarea className="input mono" readOnly rows={10} value={`Subject: ${result.email.subject}\n\n${result.email.body}`} aria-label="Request email" />
        </div>
      )}
    </form>
  );
}
