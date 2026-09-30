import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { ClosePreview, CompanyExits, ExLabels, ExitProcess } from "../../types";
import { ErrorState, Field, Loading, MoneyInput, Notice, NumberInput, Select, useConfirm, usePrompt, usd } from "../../ui";
import { longDate, person } from "../lp/shared";
import { Listed, Receivables, useRun } from "../exits/shared";
import type { PfTabProps } from "../PortfolioCompany";

const today = () => new Date().toISOString().slice(0, 10);
const STAGE_TONE: Record<string, string> = { exploring: "info", preparing: "info", marketing: "warn", offers: "warn", signed: "warn", closed: "good", abandoned: "quiet" };

/**
 * The exit side of a holding: the plan and how ready the company is, exit
 * processes with bids and the fund's consent, the closing, what's left to
 * collect, listed shares, QSBS, and the money back so far.
 */
export default function Exit({ data, onChange }: PfTabProps) {
  const q = useApi<CompanyExits>(`/portfolio/companies/${data.company.id}/exits`);
  if (q.error) return <ErrorState error={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="Loading exits" />;
  const x = q.data;
  const refresh = () => { void q.reload(); onChange(); };
  const open = x.processes.filter((p) => p.stage !== "closed" && p.stage !== "abandoned");
  // Once sold, listed or wound down, there's no private stake left to plan an exit for.
  const active = data.valueBasis === "mark" || data.valueBasis === "cost";
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="vx-h">
        <h2 id="vx-h">Where the value is</h2>
        <div className="stats">
          <div className="stat"><b className="num">{usd(x.receivedUsd)}</b><span>Received</span></div>
          <div className="stat"><b className="num">{usd(data.value.privateUsd)}</b><span>Private shares{data.value.privateShares ? ` (${data.value.privateShares.toLocaleString("en-US")})` : ""}</span></div>
          <div className="stat"><b className="num">{usd(data.value.pendingUsd)}</b><span>Escrows and earnouts, expected</span></div>
          <div className="stat"><b className="num">{usd(data.value.publicUsd)}</b><span>Listed shares</span></div>
        </div>
      </section>
      {open.map((p) => <Process key={p.id} p={p} labels={x.labels} onChange={refresh} />)}
      {active && <Start companyId={data.company.id} labels={x.labels} onChange={refresh} />}
      {x.receivables.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="rc-h">
          <h2 id="rc-h">Escrows, holdbacks and earnouts</h2>
          <Receivables rows={x.receivables} labels={x.labels} onChange={refresh} />
        </section>
      )}
      {x.listed.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="ls-h">
          <h2 id="ls-h">Listed shares</h2>
          {x.listed.map((l) => <Listed key={l.holding.id} v={l} labels={x.labels} onChange={refresh} />)}
        </section>
      )}
      {active && <Plan data={x} companyId={data.company.id} onChange={refresh} />}
      <Qsbs data={x} companyId={data.company.id} onChange={refresh} />
      {x.processes.some((p) => p.stage === "closed" || p.stage === "abandoned") && (
        <section className="panel panel-pad section" aria-labelledby="past-h">
          <h2 id="past-h">Past processes</h2>
          <ul className="timeline small">
            {x.processes.filter((p) => p.stage === "closed" || p.stage === "abandoned").map((p) => (
              <li key={p.id}><span>{longDate(p.closed_on ?? p.expected_close)}</span><span><strong>{x.labels.kinds[p.kind]}</strong>{p.counterparty ? ` with ${p.counterparty}` : ""}: {x.labels.stages[p.stage]}{p.abandoned_reason ? ` (${p.abandoned_reason})` : ""}</span></li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel panel-pad section" aria-labelledby="mb-h">
        <h2 id="mb-h">Money back</h2>
        {x.realizations.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p> : (
          <ul className="timeline small">
            {x.realizations.map((r) => <li key={r.id}><span>{longDate(r.occurred_on)}</span><span><strong>{x.labels.realizationKinds[r.kind]}</strong>: {usd(r.amount_usd)}{r.shares ? ` (${r.shares.toLocaleString("en-US")} shares${r.price_usd ? ` at $${r.price_usd.toFixed(2)}` : ""})` : ""}{r.note ? ` · ${r.note}` : ""}</span></li>)}
          </ul>
        )}
        <Distribute companyId={data.company.id} received={x.receivedUsd} onChange={refresh} />
      </section>
    </>
  );
}

function Process({ p, labels, onChange }: { p: CompanyExits["processes"][number]; labels: ExLabels; onChange: () => void }) {
  const { can } = useSession();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const run = useRun(onChange);
  const [bid, setBid] = useState<{ bidder: string; kind?: string; valueUsd?: number; consideration: string }>({ bidder: "", consideration: "" });
  const consent = async () => {
    let choice = "approve";
    let rationale = "";
    const ok = await confirm({
      title: "The fund's decision as a shareholder",
      confirm: "Record decision",
      body: (
        <div className="section">
          <label className="field"><span>Decision</span>
            <select className="input" defaultValue="approve" onChange={(e) => { choice = e.target.value; }}>
              {Object.entries(labels.consent).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="field"><span>Why: price against our mark and the alternatives, the terms, the fund's position</span><textarea className="input" required onChange={(e) => { rationale = e.target.value; }} /></label>
        </div>
      ),
    });
    if (ok) await run(() => api(`/portfolio/exits/${p.id}/consent`, { body: { choice, rationale } }), "Decision recorded.");
  };
  const move = async (stage: string) => {
    if (stage === "abandoned") {
      const reason = await prompt({ title: "Abandon this process?", label: "Why: price, terms, a buyer walked, the market", confirm: "Abandon", required: true, danger: true, multiline: true });
      if (reason) await run(() => api(`/portfolio/exits/${p.id}`, { method: "PATCH", body: { stage, abandonedReason: reason } }), "Abandoned.");
      return;
    }
    await run(() => api(`/portfolio/exits/${p.id}`, { method: "PATCH", body: { stage } }), "Moved on.");
  };
  const stages = ["exploring", "preparing", "marketing", "offers", "signed"].filter((s) => s !== p.stage);
  return (
    <section className="panel panel-pad section" aria-labelledby={`ex-${p.id}`}>
      <div className="spread">
        <h2 id={`ex-${p.id}`}>{labels.kinds[p.kind]}{p.counterparty ? ` · ${p.counterparty}` : ""}</h2>
        <span className={`pill ${STAGE_TONE[p.stage]}`}>{labels.stages[p.stage]}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {p.equity_value_usd ? `Equity value ${usd(p.equity_value_usd)}. ` : ""}{p.our_expected_usd ? `Expected to us ${usd(p.our_expected_usd)}. ` : ""}{p.expected_close ? `Expected to close ${longDate(p.expected_close)}.` : ""}
      </p>
      {p.needsConsent && (
        p.consent_decision_id
          ? <Notice tone="good">The fund consented{p.consents[0] ? `: ${person(p.consents[0].actor)}, "${p.consents[0].rationale}"` : ""}.</Notice>
          : <Notice tone="warn">The fund's consent isn't recorded. {p.consents[0] ? `Last decision: ${labels.consent[(p.consents[0].value as { choice: string }).choice]} by ${person(p.consents[0].actor)}.` : ""}</Notice>
      )}
      {p.bids.length > 0 && (
        <ul className="timeline small">
          {p.bids.map((b) => <li key={b.id}><span>{longDate(b.received_on)}</span><span><strong>{b.bidder}</strong>: {labels.bidKinds[b.kind]} at {usd(b.value_usd)}{b.consideration ? ` · ${b.consideration}` : ""}</span></li>)}
        </ul>
      )}
      <div className="row">
        {can("work_deals") && <Select id={`st-${p.id}`} value={undefined} placeholder="Move to…" onChange={(v) => v && void move(v)} options={[...stages.map((s) => ({ id: s, label: labels.stages[s]! })), { id: "abandoned", label: labels.stages.abandoned! }]} />}
        {can("decide_deals") && p.needsConsent && <button className="btn small" onClick={() => void consent()}>Record the fund's decision</button>}
      </div>
      {can("work_deals") && (
        <details>
          <summary className="small">Log a bid</summary>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/portfolio/exits/${p.id}/bids`, { body: bid }); setBid({ bidder: "", consideration: "" }); }, "Bid logged."); }}>
            <Field label="Bidder" required><input className="input" required value={bid.bidder} onChange={(e) => setBid({ ...bid, bidder: e.target.value })} /></Field>
            <Field label="Kind" required><Select id={`bk-${p.id}`} value={bid.kind} onChange={(v) => setBid({ ...bid, kind: v })} options={Object.entries(labels.bidKinds).map(([id, label]) => ({ id, label }))} /></Field>
            <Field label="Value (equity)" required><MoneyInput id={`bv-${p.id}`} value={bid.valueUsd} onChange={(v) => setBid({ ...bid, valueUsd: v })} /></Field>
            <Field label="Consideration" hint="Cash, stock, escrow, earnout"><input className="input" value={bid.consideration} onChange={(e) => setBid({ ...bid, consideration: e.target.value })} /></Field>
            <div className="row" style={{ alignSelf: "end" }}><button className="btn small" disabled={!bid.kind || !bid.valueUsd}>Log bid</button></div>
          </form>
        </details>
      )}
      {can("work_deals") && <Close p={p} labels={labels} onChange={onChange} />}
    </section>
  );
}

interface CloseForm {
  closedOn: string; totalUsd?: number; stockUsd?: number; escrowPct?: number; escrowMonths?: number; adjustmentEscrowPct?: number; holdbackPct?: number; expenseFundUsd?: number;
  earnoutMax?: number; earnoutPct?: number; earnoutDue: string; earnoutWhat: string; stockTicker: string; stockShares?: number;
  ticker: string; shares?: number; sharesOutstanding?: number; pricePerShare?: number; lockupDays?: number; amountUsd?: number;
}

/** The closing: preview what will be recorded, then a partner records it. */
function Close({ p, labels, onChange }: { p: ExitProcess; labels: ExLabels; onChange: () => void }) {
  const { can } = useSession();
  const confirm = useConfirm();
  const run = useRun(onChange);
  const [f, setF] = useState<CloseForm>({ closedOn: today(), earnoutDue: "", earnoutWhat: "", stockTicker: "", ticker: "", escrowMonths: 12, lockupDays: 180 });
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<CloseForm>) => { setF({ ...f, ...patch }); setPreview(null); };
  const payload = () => ({
    ...f,
    earnouts: f.earnoutMax ? [{ description: f.earnoutWhat || "Earnout", maxUsd: f.earnoutMax, probabilityPct: f.earnoutPct ?? 0, dueOn: f.earnoutDue }] : [],
  });
  const check = async () => {
    setErr(null);
    try {
      setPreview(await api<ClosePreview>(`/portfolio/exits/${p.id}/close/preview`, { body: payload() }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const record = async () => {
    if (!(await confirm({ title: `Record the closing of this ${labels.kinds[p.kind]!.toLowerCase()}?`, body: "Money back, what's left to collect and listed shares are recorded, and the company's status changes. This can't be undone; corrections are new entries.", confirm: "Record closing" }))) return;
    await run(() => api(`/portfolio/exits/${p.id}/close`, { body: payload() }), "Closing recorded.");
  };
  const num = (id: string, label: string, k: keyof CloseForm, opts: { money?: boolean; prefix?: string; suffix?: string; hint?: string; required?: boolean } = {}) => (
    <Field label={label} hint={opts.hint} required={opts.required}>
      {opts.money ? <MoneyInput id={`${id}-${p.id}`} value={f[k] as number | undefined} onChange={(v) => set({ [k]: v })} /> : <NumberInput id={`${id}-${p.id}`} prefix={opts.prefix} suffix={opts.suffix} value={f[k] as number | undefined} onChange={(v) => set({ [k]: v })} />}
    </Field>
  );
  return (
    <details>
      <summary className="small">Record the closing</summary>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <div className="form-grid">
          <Field label="Closing date" required><input className="input" type="date" required value={f.closedOn} onChange={(e) => set({ closedOn: e.target.value })} /></Field>
          {p.kind === "acquisition" && (
            <>
              {num("ct", "Our total consideration", "totalUsd", { money: true, required: true, hint: "From the funds flow, before anything is held back" })}
              {num("cs", "Of which in the buyer's shares", "stockUsd", { money: true })}
              {num("ce", "Indemnity escrow", "escrowPct", { suffix: "%" })}
              {num("cm", "Escrow released after", "escrowMonths", { suffix: "months" })}
              {num("ca", "Price adjustment escrow", "adjustmentEscrowPct", { suffix: "%" })}
              {num("ch", "Holdback", "holdbackPct", { suffix: "%" })}
              {num("cx", "Expense fund", "expenseFundUsd", { money: true })}
              {num("co", "Earnout, at most", "earnoutMax", { money: true })}
              {f.earnoutMax ? <>
                {num("cp", "Earnout likelihood", "earnoutPct", { suffix: "%" })}
                <Field label="Earnout decided by" required><input className="input" type="date" required value={f.earnoutDue} onChange={(e) => set({ earnoutDue: e.target.value })} /></Field>
                <Field label="Earnout target"><input className="input" value={f.earnoutWhat} onChange={(e) => set({ earnoutWhat: e.target.value })} /></Field>
              </> : null}
              {f.stockUsd ? <>
                <Field label="Buyer's ticker" required><input className="input" required value={f.stockTicker} onChange={(e) => set({ stockTicker: e.target.value })} /></Field>
                {num("cq", "Buyer's shares received", "stockShares", { required: true })}
              </> : null}
            </>
          )}
          {p.kind === "ipo" && (
            <>
              <Field label="Ticker" required><input className="input" required value={f.ticker} onChange={(e) => set({ ticker: e.target.value })} /></Field>
              {num("is", "Our shares after conversion", "shares", { hint: "Blank: from the investment records" })}
              {num("io", "Shares outstanding", "sharesOutstanding")}
              {num("ip", "IPO price", "pricePerShare", { prefix: "$" })}
              {num("il", "Lock-up", "lockupDays", { suffix: "days" })}
            </>
          )}
          {p.kind === "wind_down" && num("wa", "Returned to the fund", "amountUsd", { money: true, hint: "Zero writes it off" })}
          {["secondary", "tender", "buyback"].includes(p.kind) && (
            <>
              {num("ss", "Shares sold", "shares", { required: true })}
              {num("sp", "Price per share", "pricePerShare", { prefix: "$", required: true })}
            </>
          )}
        </div>
        <div className="row"><button className="btn small">Preview</button></div>
      </form>
      {err && <Notice tone="bad">{err}</Notice>}
      {preview && (
        <div className="section">
          {preview.split && (
            <>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{preview.split.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              {preview.gainUsd !== undefined && preview.gainUsd !== null && <p className="small" style={{ margin: 0 }}>Expected gain over cost: <strong>{usd(preview.gainUsd)}</strong>.</p>}
            </>
          )}
          {preview.window && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{preview.window.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}
          {preview.proceedsUsd !== undefined && <p className="small" style={{ margin: 0 }}>Proceeds {usd(preview.proceedsUsd)}{preview.costBasisUsd ? ` on a cost of ${usd(preview.costBasisUsd)}: gain ${usd(preview.gainUsd ?? 0)}` : ""}{preview.remainingShares !== null && preview.remainingShares !== undefined ? `; ${preview.remainingShares.toLocaleString("en-US")} shares left` : ""}.</p>}
          {preview.amountUsd !== undefined && <p className="small" style={{ margin: 0 }}>{usd(preview.amountUsd)} back on a cost of {usd(preview.cost?.invested)}.</p>}
          {preview.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
          {can("decide_deals") ? <div className="row"><button className="btn small primary" onClick={() => void record()}>Record the closing</button></div> : <p className="small muted" style={{ margin: 0 }}>A partner records the closing.</p>}
        </div>
      )}
    </details>
  );
}

function Start({ companyId, labels, onChange }: { companyId: string; labels: ExLabels; onChange: () => void }) {
  const { can } = useSession();
  const run = useRun(onChange);
  const [f, setF] = useState<{ kind?: string; counterparty: string; expectedClose: string; equityValueUsd?: number; ourExpectedUsd?: number }>({ counterparty: "", expectedClose: "" });
  if (!can("work_deals")) return null;
  return (
    <form className="panel panel-pad section" aria-labelledby="sx-h" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/portfolio/companies/${companyId}/exits`, { body: { ...f, expectedClose: f.expectedClose || undefined } }); setF({ counterparty: "", expectedClose: "" }); }, "Started."); }}>
      <h2 id="sx-h">Start an exit process</h2>
      <div className="form-grid">
        <Field label="Kind" required><Select id="sx-k" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={Object.entries(labels.kinds).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Buyer, exchange or counterparty"><input className="input" value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></Field>
        <Field label="Expected close"><input className="input" type="date" value={f.expectedClose} onChange={(e) => setF({ ...f, expectedClose: e.target.value })} /></Field>
        <Field label="Equity value"><MoneyInput id="sx-ev" value={f.equityValueUsd} onChange={(v) => setF({ ...f, equityValueUsd: v })} /></Field>
        <Field label="Expected to the fund"><MoneyInput id="sx-ou" value={f.ourExpectedUsd} onChange={(v) => setF({ ...f, ourExpectedUsd: v })} /></Field>
      </div>
      <div className="row"><button className="btn" disabled={!f.kind}>Start</button></div>
    </form>
  );
}

function Plan({ data, companyId, onChange }: { data: CompanyExits; companyId: string; onChange: () => void }) {
  const { can } = useSession();
  const run = useRun(onChange);
  const p = data.plan;
  const [f, setF] = useState({
    path: p?.path, targetYear: p?.target_year ?? undefined, lowUsd: p?.low_usd ?? undefined, baseUsd: p?.base_usd ?? undefined, highUsd: p?.high_usd ?? undefined,
    probabilityPct: p?.probability_pct ?? undefined, buyers: (p?.buyers ?? []).join(", "), readiness: p?.readiness ?? {}, note: p?.note ?? "",
  });
  const done = data.readiness.filter((r) => f.readiness[r.key]).length;
  return (
    <form className="panel panel-pad section" aria-labelledby="pl-h" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/portfolio/companies/${companyId}/exit-plan`, { method: "PUT", body: f }), "Plan saved."); }}>
      <div className="spread"><h2 id="pl-h">Exit plan</h2><span className="small muted">{done} of {data.readiness.length} ready{p ? ` · updated by ${person(p.updated_by)}` : ""}</span></div>
      <fieldset disabled={!can("work_deals")} className="section" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Plan</legend>
        <div className="form-grid">
          <Field label="Likely path" required><Select id="pl-p" value={f.path} onChange={(v) => setF({ ...f, path: v })} options={Object.entries(data.labels.paths).map(([id, label]) => ({ id, label }))} /></Field>
          <Field label="Around"><NumberInput id="pl-y" value={f.targetYear} onChange={(v) => setF({ ...f, targetYear: v })} placeholder="2028" /></Field>
          <Field label="Likelihood" hint="Feeds the liquidity forecast"><NumberInput id="pl-pr" suffix="%" value={f.probabilityPct} onChange={(v) => setF({ ...f, probabilityPct: v })} /></Field>
          <Field label="Low case, to the fund"><MoneyInput id="pl-lo" value={f.lowUsd} onChange={(v) => setF({ ...f, lowUsd: v })} /></Field>
          <Field label="Base case, to the fund"><MoneyInput id="pl-ba" value={f.baseUsd} onChange={(v) => setF({ ...f, baseUsd: v })} /></Field>
          <Field label="High case, to the fund"><MoneyInput id="pl-hi" value={f.highUsd} onChange={(v) => setF({ ...f, highUsd: v })} /></Field>
        </div>
        <Field label="Likely buyers" hint="Comma-separated"><input className="input" value={f.buyers} onChange={(e) => setF({ ...f, buyers: e.target.value })} /></Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small"><strong>Readiness</strong></legend>
          {data.readiness.map((r) => (
            <label key={r.key} className="check-row small"><input type="checkbox" checked={Boolean(f.readiness[r.key])} onChange={(e) => setF({ ...f, readiness: { ...f.readiness, [r.key]: e.target.checked } })} /><span>{r.label}</span></label>
          ))}
        </fieldset>
        <Field label="Notes"><textarea className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </fieldset>
      {can("work_deals") && <div className="row"><button className="btn primary" disabled={!f.path}>Save plan</button></div>}
    </form>
  );
}

function Qsbs({ data, companyId, onChange }: { data: CompanyExits; companyId: string; onChange: () => void }) {
  const { can } = useSession();
  const confirm = useConfirm();
  const run = useRun(onChange);
  const review = async (lot: CompanyExits["qsbs"][number]) => {
    const checks: Record<string, boolean | undefined> = { ...(lot.review?.checks ?? {}) };
    let note = lot.review?.note ?? "";
    const ok = await confirm({
      title: `QSBS review: ${lot.label}`,
      confirm: "Save review",
      body: (
        <div className="section">
          <p className="small" style={{ margin: 0 }}>Tick what's confirmed; leave blank what isn't known yet. Confirm with tax counsel.</p>
          {data.qsbsChecks.map((c) => (
            <label key={c.key} className="field"><span className="small">{c.label}</span>
              <select className="input" defaultValue={checks[c.key] === undefined ? "" : checks[c.key] ? "yes" : "no"} onChange={(e) => { checks[c.key] = e.target.value === "" ? undefined : e.target.value === "yes"; }}>
                <option value="">Not known yet</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </label>
          ))}
          <label className="field"><span>Note (required if a requirement fails)</span><textarea className="input" defaultValue={note} onChange={(e) => { note = e.target.value; }} /></label>
        </div>
      ),
    });
    if (ok) await run(() => api(`/portfolio/companies/${companyId}/investments/${lot.investmentId}/qsbs`, { body: { checks: Object.fromEntries(Object.entries(checks).filter(([, v]) => v !== undefined)), note: note || undefined } }), "Review saved.");
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="qs-h">
      <h2 id="qs-h">QSBS</h2>
      <p className="small muted" style={{ margin: 0 }}>Section 1202: stock issued after July 4, 2025 excludes 50% of the gain after three years, 75% after four and 100% after five (up to $15 million or ten times basis per investor); earlier stock needs five years (up to $10 million). It passes through to the fund's partners.</p>
      <div className="table-wrap">
        <table className="t">
          <caption className="sr-only">QSBS by investment</caption>
          <thead><tr><th scope="col">Investment</th><th scope="col">Review</th><th scope="col">If sold today</th><th scope="col">Next step up</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.qsbs.map((l) => (
              <tr key={l.investmentId}>
                <th scope="row">{l.label}<div className="small muted">{l.fund} · basis {usd(l.basisUsd)}</div></th>
                <td>{l.review ? <span className={`pill ${l.review.status === "eligible" ? "good" : l.review.status === "not_eligible" ? "bad" : "warn"}`}>{data.labels.qsbsStatus[l.review.status]}</span> : <span className="small muted">Not reviewed</span>}</td>
                <td className="num">{l.result.exclusionPct}% excluded</td>
                <td className="small">{l.result.next ? `${l.result.next.pct}% on ${longDate(l.result.next.on)}` : "—"}</td>
                <td>{can("work_deals") && <button className="btn small ghost" onClick={() => void review(l)}>Review</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Distribute({ companyId, received, onChange }: { companyId: string; received: number; onChange: () => void }) {
  const { can } = useSession();
  const prompt = usePrompt();
  const run = useRun(onChange);
  if (!can("work_deals") || received <= 0) return null;
  const go = async () => {
    const amount = await prompt({ title: "Distribute proceeds to investors", label: "Amount to distribute, in dollars (a draft in LP Reporting for a second person to approve)", confirm: "Prepare draft", required: true });
    if (amount) await run(() => api(`/portfolio/companies/${companyId}/distribute`, { body: { amountUsd: amount } }), "Draft prepared in LP Reporting.");
  };
  return <div className="row"><button className="btn small" onClick={() => void go()}>Distribute proceeds</button></div>;
}
