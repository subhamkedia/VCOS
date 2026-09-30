import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../app";
import type { ExLabels, InKindPreview, ListedView, Receivable } from "../../types";
import { Field, Notice, NumberInput, Seg, useConfirm, usePrompt, useToast, usd } from "../../ui";
import { longDate } from "../lp/shared";

const today = () => new Date().toISOString().slice(0, 10);

/** Run an action, toast the result, and refresh. */
export function useRun(onChange: () => void) {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      onChange();
      return true;
    } catch (e) {
      toast("bad", (e as Error).message);
      return false;
    }
  };
}

const REC_TONE: Record<string, string> = { pending: "warn", partial: "info", released: "good", earned: "good", claimed: "bad", forfeited: "bad" };

/** Escrows, holdbacks and earnouts: what a sale left to collect, and when. */
export function Receivables({ rows, labels, onChange, showCompany }: { rows: Receivable[]; labels: ExLabels; onChange: () => void; showCompany?: boolean }) {
  const { can } = useSession();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const run = useRun(onChange);
  const settle = async (r: Receivable) => {
    const left = r.amount_usd - r.settled_usd;
    const f = { amount: String(left), on: today(), final: true, note: "" };
    const ok = await confirm({
      title: `Record ${labels.receivableKinds[r.kind]!.toLowerCase()} settlement`,
      confirm: "Record",
      body: (
        <div className="section">
          <p className="small" style={{ margin: 0 }}>{r.description}: {usd(left)} outstanding.</p>
          <label className="field"><span>Amount received, in dollars</span><input className="input" inputMode="decimal" defaultValue={f.amount} onChange={(e) => { f.amount = e.target.value; }} /></label>
          <label className="field"><span>Received on</span><input className="input" type="date" defaultValue={f.on} onChange={(e) => { f.on = e.target.value; }} /></label>
          <label className="check-row small"><input type="checkbox" defaultChecked onChange={(e) => { f.final = e.target.checked; }} /><span>This settles it: nothing more will come</span></label>
          <label className="field"><span>Note (required if less than the full amount)</span><textarea className="input" onChange={(e) => { f.note = e.target.value; }} /></label>
        </div>
      ),
    });
    if (ok) await run(() => api(`/portfolio/receivables/${r.id}/settle`, { body: { amountUsd: Number(f.amount.replace(/[$,]/g, "")), on: f.on, final: f.final, note: f.note || undefined } }), "Recorded.");
  };
  const revise = async (r: Receivable) => {
    const pct = await prompt({ title: `Expected share of ${r.description}`, label: "Percent you now expect to receive", confirm: "Next", initial: String(r.expected_pct), required: true });
    if (pct === null) return;
    const note = await prompt({ title: "What changed?", label: "A claim notice, results against the target, a new date", confirm: "Save", required: true, multiline: true });
    if (note) await run(() => api(`/portfolio/receivables/${r.id}`, { method: "PATCH", body: { expectedPct: pct, note } }), "Updated.");
  };
  if (!rows.length) return <p className="small muted" style={{ margin: 0 }}>Nothing outstanding.</p>;
  return (
    <div className="table-wrap">
      <table className="t">
        <caption className="sr-only">Escrows, holdbacks and earnouts</caption>
        <thead><tr>{showCompany && <th scope="col">Company</th>}<th scope="col">Item</th><th scope="col">Due</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Expected now</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {showCompany && <td><Link to={`/portfolio/${r.company_id}?tab=exit`}>{r.company_name}</Link></td>}
              <th scope="row">{labels.receivableKinds[r.kind]}<div className="small muted">{r.description}{r.note ? ` · ${r.note}` : ""}</div></th>
              <td className="small">{longDate(r.due_on)}{r.overdue && <div><span className="pill bad">Overdue</span></div>}</td>
              <td className="num">{usd(r.amount_usd)}{r.settled_usd > 0 && <div className="small muted">{usd(r.settled_usd)} received</div>}</td>
              <td className="num">{usd(r.valueUsd)}<div className="small muted">{r.expected_pct}%</div></td>
              <td><span className={`pill ${REC_TONE[r.status] ?? "info"}`}>{labels.receivableStatus[r.status]}</span></td>
              <td>
                {(r.status === "pending" || r.status === "partial") && (
                  <div className="row">
                    {can("decide_deals") && <button className="btn small" onClick={() => void settle(r)}>Record settlement</button>}
                    {can("work_deals") && <button className="btn small ghost" onClick={() => void revise(r)}>Revise odds</button>}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One listed holding: when it can be sold, its value, prices, and selling or distributing it. */
export function Listed({ v, labels, onChange }: { v: ListedView; labels: ExLabels; onChange: () => void }) {
  const { can } = useSession();
  const h = v.holding;
  const open = today() >= v.window.earliestSale;
  const pct = h.shares_outstanding ? (v.sharesLeft / h.shares_outstanding) * 100 : null;
  return (
    <article className="section" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div className="spread">
        <h3 style={{ margin: 0 }}>{h.ticker}{h.exchange ? <span className="muted small"> · {h.exchange}</span> : null}{h.company_name ? <span className="muted small"> · {h.company_name}</span> : null}</h3>
        <span className={`pill ${open ? "good" : "warn"}`}>{open ? "Can be sold" : `Locked until ${longDate(v.window.earliestSale)}`}</span>
      </div>
      <div className="stats">
        <div className="stat"><b className="num">{v.sharesLeft.toLocaleString("en-US")}</b><span>Shares held{pct !== null ? ` (${pct < 0.1 ? "under 0.1" : pct.toFixed(1)}% of the company)` : ""}</span></div>
        <div className="stat"><b className="num">{v.lastPrice ? `$${v.lastPrice.close.toFixed(2)}` : "—"}</b><span>{v.lastPrice ? `Close, ${longDate(v.lastPrice.date)}` : "No price yet"}</span></div>
        <div className="stat"><b className="num">{usd(v.valueUsd)}</b><span>Value</span></div>
        {v.window.volumeLimit && <div className="stat"><b className="num">{v.window.volumeLimit.toLocaleString("en-US")}</b><span>Most in 3 months ({v.soldLast3Months.toLocaleString("en-US")} sold)</span></div>}
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {v.window.steps.map((s, i) => <li key={i}>{s}</li>)}
        {v.window.reporting.map((s, i) => <li key={`r${i}`}>{s}</li>)}
        {h.affiliate && <li>The fund is an affiliate: file Form 144 with each sale over 5,000 shares or $50,000 in three months.</li>}
      </ul>
      {can("work_deals") && <Prices ticker={h.ticker} onChange={onChange} />}
      {can("decide_deals") && open && <Sell v={v} onChange={onChange} />}
      {can("work_deals") && today() >= v.window.lockupEnds && <InKind v={v} labels={labels} onChange={onChange} />}
    </article>
  );
}

function Prices({ ticker, onChange }: { ticker: string; onChange: () => void }) {
  const run = useRun(onChange);
  const [f, setF] = useState<{ date: string; close?: number; volume?: number }>({ date: today() });
  const upload = async (file: File | undefined) => {
    if (file) await run(async () => api(`/portfolio/prices/${ticker}`, { body: { csv: await file.text() } }), "Prices imported.");
  };
  return (
    <details>
      <summary className="small">Add closing prices</summary>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/portfolio/prices/${ticker}`, { body: { prices: [f] } }), "Price recorded."); }}>
        <Field label="Date" required><input className="input" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Close" required><NumberInput id={`px-${ticker}`} prefix="$" value={f.close} onChange={(v) => setF({ ...f, close: v })} /></Field>
        <Field label="Volume"><NumberInput id={`pv-${ticker}`} value={f.volume} onChange={(v) => setF({ ...f, volume: v })} /></Field>
        <div className="row" style={{ alignSelf: "end" }}><button className="btn small" disabled={!f.close}>Record</button></div>
      </form>
      <Field label="Or a CSV of prices" hint="Date and Close columns (Volume optional), as brokers and market data sites export them"><input className="input" type="file" accept=".csv,text/csv" onChange={(e) => void upload(e.target.files?.[0])} /></Field>
    </details>
  );
}

function Sell({ v, onChange }: { v: ListedView; onChange: () => void }) {
  const run = useRun(onChange);
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState<{ shares?: number; priceUsd?: number; on: string }>({ on: today() });
  const submit = async () => {
    if (!(await confirm({ title: `Record the sale of ${(f.shares ?? 0).toLocaleString("en-US")} ${v.holding.ticker}?`, body: "Record it once the trade has settled. It can't be edited; a correction is a new entry.", confirm: "Record sale" }))) return;
    await run(async () => {
      const r = await api<{ form144: string | null }>(`/portfolio/listed/${v.holding.id}/sell`, { body: f });
      if (r.form144) toast("info", r.form144);
    }, "Sale recorded.");
  };
  return (
    <details>
      <summary className="small">Record a sale</summary>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Shares sold" required><NumberInput id={`ss-${v.holding.id}`} value={f.shares} onChange={(x) => setF({ ...f, shares: x })} /></Field>
        <Field label="Average price" required><NumberInput id={`sp-${v.holding.id}`} prefix="$" value={f.priceUsd} onChange={(x) => setF({ ...f, priceUsd: x })} /></Field>
        <Field label="Trade date" required><input className="input" type="date" required value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></Field>
        <div className="row" style={{ alignSelf: "end" }}><button className="btn small primary" disabled={!f.shares || !f.priceUsd}>Record sale</button></div>
      </form>
    </details>
  );
}

function InKind({ v, labels, onChange }: { v: ListedView; labels: ExLabels; onChange: () => void }) {
  const run = useRun(onChange);
  const [f, setF] = useState<{ shares?: number; on: string; method: "close" | "average"; days?: number }>({ on: today(), method: "close", days: 5 });
  const [preview, setPreview] = useState<InKindPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = async () => {
    setErr(null);
    try {
      setPreview(await api<InKindPreview>(`/portfolio/listed/${v.holding.id}/in-kind/preview`, { body: f }));
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    }
  };
  return (
    <details>
      <summary className="small">Distribute shares in kind</summary>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <div className="form-grid">
          <Field label="Shares to distribute" required><NumberInput id={`ik-${v.holding.id}`} value={f.shares} onChange={(x) => { setF({ ...f, shares: x }); setPreview(null); }} /></Field>
          <Field label="Distribution date" required><input className="input" type="date" required value={f.on} onChange={(e) => { setF({ ...f, on: e.target.value }); setPreview(null); }} /></Field>
          {f.method === "average" && <Field label="Trading days"><NumberInput id={`ikd-${v.holding.id}`} value={f.days} onChange={(x) => { setF({ ...f, days: x }); setPreview(null); }} /></Field>}
        </div>
        <div className="field"><span>Value per share, as the LPA says</span><Seg label="Pricing method" value={f.method} onChange={(m) => { setF({ ...f, method: m }); setPreview(null); }} options={[{ id: "close", label: labels.priceMethods.close! }, { id: "average", label: labels.priceMethods.average! }]} /></div>
        <div className="row"><button className="btn small" disabled={!f.shares}>Preview</button></div>
      </form>
      {err && <Notice tone="bad">{err}</Notice>}
      {preview && (
        <div className="section">
          <p className="small" style={{ margin: 0 }}>{preview.priceSteps.join(" ")} {preview.shares.toLocaleString("en-US")} shares = <strong>{usd(preview.grossUsd)}</strong> from {preview.fund}{preview.carryUsd ? `, of which ${usd(preview.carryUsd)} carried interest` : ""}.</p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{preview.allocation.map((a) => <li key={a.id}>{a.name}: {a.shares.toLocaleString("en-US")} shares</li>)}</ul>
          {preview.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
          <div className="row"><button className="btn small primary" onClick={() => void run(async () => { await api(`/portfolio/listed/${v.holding.id}/in-kind`, { body: f }); setPreview(null); }, "Prepared in LP Reporting. The shares leave the books when a second person approves it.")}>Prepare the distribution</button></div>
        </div>
      )}
    </details>
  );
}
