import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, useApi } from "../api";
import type { PortalInfo } from "../types";
import { ErrorState, Field, Loading, Notice, PageHead, useToast } from "../ui";

const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What a founder sees from the link their investor sent: no account, no
 * other data. Report the month's numbers, or connect the books so they
 * don't have to be typed again.
 */
export default function Portal() {
  const { token } = useParams();
  const toast = useToast();
  const { data, error, reload } = useApi<PortalInfo>(`/portal/${token}`);
  const [period, setPeriod] = useState(lastMonth());
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="portal"><PageHead title="Report your numbers" /><ErrorState error={error} retry={() => void reload()} /></div>;
  if (!data) return <div className="portal"><Loading what="Loading" /></div>;
  const req = data.requests.find((r) => r.period === period) ?? data.requests[0];
  const asked = new Set(req?.metrics ?? []);
  const fields = data.metrics.filter((m) => !m.plan);
  const ordered = [...fields.filter((m) => asked.has(m.id)), ...fields.filter((m) => !asked.has(m.id))];
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
      await api(`/portal/${token}/kpis`, { body: { period, values: clean, note } });
      setSent(period);
      setValues({});
      setNote("");
      toast("good", "Thank you, sent.");
      void reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="portal" id="main">
      <PageHead eyebrow={data.firm} title={`${data.company}: report your numbers`} lead="Only you and your investor see these. It takes a couple of minutes; no account needed." />
      {data.requests.length > 0 && (
        <Notice>{data.firm} asked for {data.requests.map((r) => `${monthName(r.period)} (by ${new Date(`${r.dueOn}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })})`).join(", ")}.</Notice>
      )}
      {sent && <Notice tone="good">Your {monthName(sent)} numbers were sent. You can close this page, or report another month.</Notice>}

      <section className="panel panel-pad section" aria-labelledby="books-h">
        <h2 id="books-h">Connect your books instead</h2>
        <p className="small muted" style={{ margin: 0 }}>Read-only: monthly revenue, expenses and cash from your income statement and balance sheet, once a month. You can disconnect at any time from QuickBooks or Xero.</p>
        <div className="row">
          {data.accounting.map((a) => a.connected ? (
            <span key={a.provider} className="pill good">{a.name} connected</span>
          ) : a.available ? (
            <a key={a.provider} className="btn" href={`/api/portal/${token}/connect/${a.provider}`}>Connect {a.name}</a>
          ) : null)}
          {!data.accounting.some((a) => a.available || a.connected) && <span className="small muted">Not available yet: report below.</span>}
        </div>
      </section>

      <form className="panel panel-pad section" aria-labelledby="form-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2 id="form-h">Report a month</h2>
        <Field label="Month" required><input className="input" type="month" required value={period} max={lastMonth()} onChange={(e) => setPeriod(e.target.value)} style={{ maxWidth: 220 }} /></Field>
        <div className="form-grid">
          {ordered.map((m) => (
            <Field key={m.id} label={`${m.label}${asked.has(m.id) ? "" : " (optional)"}`} hint={m.percent ? "Percent" : m.count ? "Number" : "US dollars"}>
              <input className="input num" inputMode="decimal" value={values[m.id] ?? ""} onChange={(e) => setValues({ ...values, [m.id]: e.target.value })} />
            </Field>
          ))}
        </div>
        <Field label="Anything to add" hint="Wins, lowlights, asks: where could we help?"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="row"><button className="btn primary" disabled={busy} aria-busy={busy}>Send</button></div>
      </form>
    </main>
  );
}

/** Where QuickBooks or Xero sends the founder back. */
export function PortalConnected() {
  const [q] = useSearchParams();
  const error = q.get("error");
  return (
    <main className="portal" id="main">
      <PageHead title={error ? "Not connected" : "Connected"} />
      {error ? <Notice tone="bad">{error}</Notice> : (
        <Notice tone="good">{q.get("provider")} is connected{q.get("books") ? ` (${q.get("books")})` : ""} for {q.get("company")}. Your investor will see monthly revenue, expenses and cash from now on. You can close this page.</Notice>
      )}
    </main>
  );
}
