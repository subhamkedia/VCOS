import { Link } from "react-router-dom";
import { useRef, useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { Activity, Prospect, ProspectStage } from "../../types";
import { Field, MoneyInput, Notice, NumberInput, Seg, Select, actor, usd, useToast } from "../../ui";
import type { FrTabProps } from "../Raise";
import { longDate } from "../lp/shared";

const LIVE: ProspectStage[] = ["identified", "contacted", "meeting", "diligence", "soft_circle", "committed"];
const TONE: Record<ProspectStage, string> = { identified: "outline", contacted: "outline", meeting: "info", diligence: "info", soft_circle: "warn", committed: "good", closed: "good", declined: "quiet" };
type View = "live" | "closed" | "declined";

/** The LP pipeline: who's at which stage, what's next, and how well the pipeline covers the target. */
export default function Pipeline({ data, onChange }: FrTabProps) {
  const { can } = useSession();
  const [view, setView] = useState<View>("live");
  const [open, setOpen] = useState<string | null>(null);
  const p = data.pipeline;
  const L = data.labels;
  const rows = data.prospects.filter((x) => view === "live" ? LIVE.includes(x.stage) : x.stage === view)
    .sort((a, b) => LIVE.indexOf(b.stage) - LIVE.indexOf(a.stage) || a.name.localeCompare(b.name));
  const cover = p.coverage === null ? 0 : Math.min(100, p.coverage * 100);
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="cov-h">
        <h2 id="cov-h">Coverage of the target</h2>
        <div className="stats">
          <div className="stat"><b className="num">{usd(p.target)}</b><span>Target</span></div>
          <div className="stat"><b className="num">{usd(p.closed)}</b><span>Closed</span></div>
          <div className="stat"><b className="num">{usd(p.committed)}</b><span>Committed, not closed</span></div>
          <div className="stat"><b className="num">{usd(p.softCircled)}</b><span>Soft-circled</span></div>
          <div className="stat"><b className="num">{usd(p.weighted)}</b><span>Weighted pipeline</span></div>
          <div className="stat"><b className="num">{p.coverage === null ? "—" : `${(p.coverage * 100).toFixed(0)}%`}</b><span>Closed plus weighted, of target</span></div>
        </div>
        <div className="meter" role="img" aria-label={`${cover.toFixed(0)}% of the target covered by closed commitments and the weighted pipeline`}>
          <span className="deployed" style={{ width: `${p.target ? Math.min(100, (p.closed / p.target) * 100) : 0}%` }} />
          <span className="committed" style={{ width: `${Math.max(0, cover - (p.target ? (p.closed / p.target) * 100 : 0))}%` }} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>Weighted: each prospect's firmest amount (committed, else soft-circled, else the ask) times its odds, by default from its stage.</p>
        {data.issues.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.issues.map((i, k) => <li key={k} style={{ color: i.severity === "block" ? "var(--bad)" : "var(--warn)" }}>{i.message}</li>)}</ul>}
      </section>
      {can("decide_deals") && <Settings data={data} onChange={onChange} />}
      <Seg label="Which prospects" value={view} onChange={setView} options={[{ id: "live", label: "Live" }, { id: "closed", label: "Closed" }, { id: "declined", label: "Declined" }]} />
      {rows.length === 0 ? <Notice>{view === "live" ? "No live prospects yet: add them below, or import a list." : "None."}</Notice> : (
        <div className="panel table-wrap">
          <table className="t">
            <caption className="sr-only">Prospects</caption>
            <thead><tr><th scope="col">Investor</th><th scope="col">Stage</th><th scope="col" className="num">Amount</th><th scope="col">Next step</th><th scope="col">Data room</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <th scope="row"><strong>{x.name}</strong><div className="small muted">{[x.contact_name, x.source ? `via ${x.source}` : null].filter(Boolean).join(" · ")}</div></th>
                  <td><span className={`pill ${TONE[x.stage]}`}>{L.stages[x.stage]}</span>{x.stage === "declined" && x.decline_reason ? <div className="small muted">{x.decline_reason}</div> : null}</td>
                  <td className="num">{usd(x.committed_usd ?? x.soft_circle_usd ?? x.ask_usd)}<div className="small muted">{x.committed_usd ? "committed" : x.soft_circle_usd ? "soft-circled" : x.ask_usd ? "ask" : ""}</div></td>
                  <td className="small">{x.next_step ?? <span className="muted">None set</span>}{x.next_step_on && <div className={x.overdue ? "" : "muted"} style={x.overdue ? { color: "var(--bad)" } : undefined}>{x.overdue ? "Overdue: " : "By "}{longDate(x.next_step_on)}</div>}</td>
                  <td className="small">{x.engagement ? `${x.engagement.documents} docs · last ${longDate(x.engagement.lastViewedAt)}` : x.dataRoom ? (x.dataRoom.acknowledged_at ? "Opened" : "Link sent") : <span className="muted">—</span>}</td>
                  <td><button className="btn small ghost" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? "Close" : "Open"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ProspectPanel key={open} data={data} prospect={data.prospects.find((x) => x.id === open)!} onChange={onChange} />}
      {can("work_deals") && <div className="grid-2"><AddProspect data={data} onChange={onChange} /><ImportProspects data={data} onChange={onChange} /></div>}
    </>
  );
}

function Settings({ data, onChange }: FrTabProps) {
  const toast = useToast();
  const r = data.raise;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ exemption: r.exemption, offering: r.offering, minCommitmentUsd: r.min_commitment_usd ?? undefined, hardCapUsd: r.hard_cap_usd ?? undefined, equalizationRatePct: r.equalization_rate_pct, vcoc: r.vcoc, finalCloseDeadline: r.final_close_deadline ?? "" });
  const save = async () => {
    try {
      await api(`/fundraising/raises/${r.id}`, { method: "PATCH", body: f });
      toast("good", "Saved.");
      setEdit(false);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  if (!edit) return <div className="row"><button className="btn small" onClick={() => setEdit(true)}>Offering terms</button></div>;
  const L = data.labels;
  return (
    <form className="panel panel-pad section" aria-labelledby="set-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="set-h">Offering terms</h2>
      <p className="small muted" style={{ margin: 0 }}>Confirm these with fund counsel: they decide who may invest and what each closing is checked against.</p>
      <div className="form-grid">
        <Field label="Investment Company Act exemption"><Select id="s-ex" value={f.exemption} onChange={(v) => setF({ ...f, exemption: v ?? "3c1" })} options={Object.entries(L.exemptions).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Regulation D"><Select id="s-of" value={f.offering} onChange={(v) => setF({ ...f, offering: v ?? "506b" })} options={Object.entries(L.offerings).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="Minimum commitment"><MoneyInput id="s-min" value={f.minCommitmentUsd} onChange={(v) => setF({ ...f, minCommitmentUsd: v })} /></Field>
        <Field label="Hard cap"><MoneyInput id="s-cap" value={f.hardCapUsd} onChange={(v) => setF({ ...f, hardCapUsd: v })} /></Field>
        <Field label="Equalization interest" hint="The LPA's rate on catch-up capital at later closings"><NumberInput id="s-eq" value={f.equalizationRatePct} onChange={(v) => setF({ ...f, equalizationRatePct: v ?? 0 })} suffix="%" /></Field>
        <Field label="Final closing deadline"><input className="input" type="date" value={f.finalCloseDeadline} onChange={(e) => setF({ ...f, finalCloseDeadline: e.target.value })} /></Field>
      </div>
      <label className="row small"><input type="checkbox" checked={f.vcoc} onChange={(e) => setF({ ...f, vcoc: e.target.checked })} /> The fund operates as a venture capital operating company (VCOC), so the 25% benefit plan test doesn't bind</label>
      <div className="row"><button className="btn primary">Save</button><button type="button" className="btn ghost" onClick={() => setEdit(false)}>Cancel</button></div>
    </form>
  );
}

function ProspectPanel({ data, prospect: x, onChange }: FrTabProps & { prospect: Prospect }) {
  const { can } = useSession();
  const toast = useToast();
  const L = data.labels;
  const log = useApi<Activity[]>(`/fundraising/prospects/${x.id}/activity`);
  const [stage, setStage] = useState<ProspectStage>(x.stage);
  const [f, setF] = useState({ askUsd: x.ask_usd ?? undefined, softCircleUsd: x.soft_circle_usd ?? undefined, probability: x.probability === null ? undefined : Math.round(x.probability * 100), nextStep: x.next_step ?? "", nextStepOn: x.next_step_on ?? "", declineReason: "" });
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("note");
  const [link, setLink] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast("good", done);
      onChange();
      void log.reload();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const editable = can("work_deals") && x.stage !== "closed";
  return (
    <section className="panel panel-pad section" aria-labelledby="pp-h">
      <div className="spread">
        <h2 id="pp-h">{x.name}</h2>
        {can("queue") && x.stage !== "declined" && x.stage !== "closed" && (
          <button className="btn small" onClick={() => void run(async () => { const r = await api<{ url: string; outboxId: string | null }>(`/fundraising/prospects/${x.id}/data-room`, { body: {} }); setLink(r.url); }, "Data room link created; the email is waiting in Approvals if a mailbox is connected.")}>Share the data room</button>
        )}
      </div>
      {link && <Notice tone="good">Private link, shown once: <span className="token-url">{link}</span></Notice>}
      <p className="small muted" style={{ margin: 0 }}>{L.stages[x.stage]} · {x.emails.join(", ") || "no email"}{x.jurisdiction ? ` · ${x.jurisdiction}` : ""}</p>
      {editable && (
        <form className="section" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/fundraising/prospects/${x.id}`, { method: "PATCH", body: { ...f, stage } }), "Saved."); }}>
          <div className="form-grid">
            <Field label="Stage"><Select id="p-stage" value={stage} onChange={(v) => setStage(v ?? x.stage)} options={(Object.keys(L.stages) as ProspectStage[]).filter((s) => s !== "closed").map((id) => ({ id, label: L.stages[id]! }))} /></Field>
            <Field label="Ask"><MoneyInput id="p-ask" value={f.askUsd} onChange={(v) => setF({ ...f, askUsd: v })} /></Field>
            <Field label="Soft-circled"><MoneyInput id="p-soft" value={f.softCircleUsd} onChange={(v) => setF({ ...f, softCircleUsd: v })} /></Field>
            <Field label="Odds" hint="Blank: the stage's default"><NumberInput id="p-odds" value={f.probability} onChange={(v) => setF({ ...f, probability: v })} suffix="%" /></Field>
            <Field label="Next step"><input className="input" value={f.nextStep} onChange={(e) => setF({ ...f, nextStep: e.target.value })} /></Field>
            <Field label="By"><input className="input" type="date" value={f.nextStepOn} onChange={(e) => setF({ ...f, nextStepOn: e.target.value })} /></Field>
          </div>
          {stage === "declined" && <Field label="Why they declined" required><input className="input" required value={f.declineReason} onChange={(e) => setF({ ...f, declineReason: e.target.value })} /></Field>}
          <div className="row"><button className="btn primary">Save</button></div>
        </form>
      )}
      {editable && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/fundraising/prospects/${x.id}/activity`, { body: { kind, summary: note } }); setNote(""); }, "Logged."); }}>
          <div style={{ minWidth: 140 }}><label className="sr-only" htmlFor="a-kind">What happened</label><Select id="a-kind" value={kind} onChange={(v) => setKind(v ?? "note")} options={["note", "meeting", "call", "email"].map((id) => ({ id, label: L.activityKinds[id]! }))} /></div>
          <label className="sr-only" htmlFor="a-sum">Summary</label>
          <input id="a-sum" className="input" style={{ flex: 1, minWidth: 180 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was said or agreed" required />
          <button className="btn">Log</button>
        </form>
      )}
      <h3>History</h3>
      {log.error ? <Notice tone="bad">{log.error.message}</Notice> : !log.data ? <p className="small muted">Loading…</p> : (
        <ul className="timeline small">{log.data.map((a) => <li key={a.id}><span>{longDate(a.occurred_on)}</span><span><strong>{L.activityKinds[a.kind]}</strong> · {a.summary} <span className="muted">({actor(a.actor)})</span></span></li>)}</ul>
      )}
    </section>
  );
}

function AddProspect({ data, onChange }: FrTabProps) {
  const toast = useToast();
  const [f, setF] = useState<{ name: string; kind?: string; contactName: string; emails: string; askUsd?: number; source: string }>({ name: "", contactName: "", emails: "", source: "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      await api(`/fundraising/raises/${data.raise.id}/prospects`, { body: f });
      toast("good", `${f.name} added.`);
      setF({ name: "", contactName: "", emails: "", source: "" });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const kinds = [["pension", "Pension plan"], ["endowment_foundation", "Endowment or foundation"], ["insurance", "Insurance company"], ["fund_of_funds", "Fund of funds"], ["family_office", "Family office"], ["individual", "Individual"], ["corporate", "Corporation"], ["sovereign", "Sovereign wealth fund"], ["other", "Other"]];
  return (
    <form className="panel panel-pad section" aria-labelledby="ap-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="ap-h">Add a prospect</h2>
      <div className="form-grid">
        <Field label="Investor" required><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type" required><Select id="np-kind" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={kinds.map(([id, label]) => ({ id: id!, label: label! }))} /></Field>
        <Field label="Contact"><input className="input" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} /></Field>
        <Field label="Ask"><MoneyInput id="np-ask" value={f.askUsd} onChange={(v) => setF({ ...f, askUsd: v })} /></Field>
        <Field label="Introduced by"><input className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary" disabled={!f.kind}>Add</button></div>
    </form>
  );
}

function ImportProspects({ data, onChange }: FrTabProps) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [list, setList] = useState("");
  const affinity = data.sources.find((s) => s.id === "affinity");
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    try {
      const form = new FormData();
      form.append("file", f);
      const r = await api<{ added: number; skipped: unknown[] }>(`/fundraising/raises/${data.raise.id}/prospects/uploads`, { form });
      toast("good", `${r.added} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const fromAffinity = async () => {
    try {
      const r = await api<{ found: number; added: number }>(`/fundraising/raises/${data.raise.id}/prospects/affinity`, { body: { listId: list } });
      toast("good", `${r.found} in the list, ${r.added} added.`);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <section className="panel panel-pad section" aria-labelledby="ip-h">
      <h2 id="ip-h">Import prospects</h2>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void upload(); }}>
        <Field label="From a spreadsheet or CRM export (CSV)" hint="A name column; type, contact, email, ask, source and owner are read when present"><input ref={file} className="input" type="file" accept=".csv,text/csv" /></Field>
        <div className="row"><button className="btn">Import file</button></div>
      </form>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void fromAffinity(); }}>
        <Field label="From an Affinity list" hint={affinity?.ready ? "The number in the list's address" : <>Connect Affinity in <Link to="/connections?module=fundraising">Connections</Link> first</>}><input className="input" inputMode="numeric" value={list} onChange={(e) => setList(e.target.value)} disabled={!affinity?.ready} /></Field>
        <div className="row"><button className="btn" disabled={!affinity?.ready || !list}>Import list</button></div>
      </form>
    </section>
  );
}
