import { useState } from "react";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { ChecklistItem, ItemStatus, Workstream } from "../../types";
import { Field, Notice, Seg, usePrompt, useToast } from "../../ui";
import { Progress } from "../Diligence";
import type { TabProps } from "../Deal";

export const STATE: Record<ChecklistItem["state"], { tone: string; label: string; help: string }> = {
  missing: { tone: "quiet", label: "Nothing yet", help: "No facts or notes for this yet." },
  self_reported: { tone: "warn", label: "Company says", help: "Only the company has said it. Needs an independent source." },
  evidenced: { tone: "good", label: "Evidenced", help: "Facts or notes in the ledger cover it." },
  verified: { tone: "good", label: "Verified", help: "An independent source agrees." },
  done: { tone: "good", label: "Done", help: "Marked done by your team." },
  na: { tone: "outline", label: "Not applicable", help: "Your team marked it as not applying." },
  red_flag: { tone: "bad", label: "Red flag", help: "Your team flagged a problem." },
  in_progress: { tone: "info", label: "In progress", help: "Someone is working on it." },
  open: { tone: "quiet", label: "Open", help: "Not started." },
  manual: { tone: "quiet", label: "To check", help: "Your team checks this; VC OS can't tell from the ledger." },
  flagged: { tone: "warn", label: "Outside guardrails", help: "The math says this deal sits outside your fund's guardrails." },
};

const STATUS_OPTIONS: { id: ItemStatus | ""; label: string }[] = [
  { id: "", label: "From the ledger" }, { id: "open", label: "Open" }, { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" }, { id: "na", label: "Not applicable" }, { id: "red_flag", label: "Red flag" },
];

/** The checklist by workstream. Status comes from the ledger unless a person sets it. */
export default function Checklist({ data, onChange }: TabProps) {
  const [show, setShow] = useState<"all" | "open" | "required">("open");
  const items = data.checklist.filter((i) => show === "all" || (show === "open" ? !i.complete : i.required));
  return (
    <>
      <div className="spread">
        <Seg label="Which items" options={[{ id: "open", label: "Still open" }, { id: "required", label: "Required for IC" }, { id: "all", label: "Everything" }]} value={show} onChange={setShow} />
        <span className="small muted">{data.readiness.complete} of {data.readiness.total} complete</span>
      </div>
      {items.length === 0 && <Notice tone="good">Nothing {show === "open" ? "open" : "here"}.</Notice>}
      {data.workstreams.map((w) => {
        const mine = items.filter((i) => i.workstream === w.id);
        const all = data.checklist.filter((i) => i.workstream === w.id);
        if (!mine.length && show !== "all") return null;
        return (
          <section key={w.id} className="panel" aria-labelledby={`ws-${w.id}`}>
            <div className="ws-head">
              <h2 id={`ws-${w.id}`}>{w.label}</h2>
              <div style={{ minWidth: 140 }}><Progress done={all.filter((i) => i.complete).length} total={all.length} label={`${w.label} progress`} /></div>
            </div>
            {mine.map((i) => <Item key={i.key} item={i} dealId={data.deal.id} onChange={onChange} />)}
            <AddItem dealId={data.deal.id} workstream={w.id} onChange={onChange} />
          </section>
        );
      })}
    </>
  );
}

function Item({ item, dealId, onChange }: { item: ChecklistItem; dealId: string; onChange: () => void }) {
  const { can, me } = useSession();
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const s = STATE[item.state];
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api(`/deals/${dealId}/items/${encodeURIComponent(item.key)}`, { method: "PUT", body: patch });
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status: ItemStatus | "") => {
    if (status === "red_flag" || status === "na") {
      const note = await prompt({ title: status === "red_flag" ? `Red flag: ${item.title}` : `Not applicable: ${item.title}`, label: status === "red_flag" ? "What's the problem?" : "Why doesn't it apply?", confirm: "Save", required: true, multiline: true, danger: status === "red_flag" });
      if (!note) return;
      return save({ status, note });
    }
    return save({ status: status || null });
  };
  const titleId = `item-${item.key.replace(/[^a-z0-9]/gi, "-")}`;
  const mine = me.user.email;
  return (
    <div className="item" role="group" aria-labelledby={titleId}>
      <div><span className={`pill ${s.tone}`} title={s.help}>{s.label}</span></div>
      <div>
        <h4 id={titleId}>{item.title}{item.required && <span className="pill outline" style={{ marginLeft: 6 }} title="Must be complete before IC">Required</span>}</h4>
        <p className="small muted">{item.why}</p>
        <p className="small">{item.detail}</p>
        {item.note && <p className="small"><strong>Note:</strong> {item.note}</p>}
        {item.person && <p className="small muted">Set by {item.person.by.replace(/^human:/, "")}</p>}
        {item.assignee && <p className="small">Assigned to {item.assignee.replace(/^human:/, "")}</p>}
      </div>
      {can("work_deals") && (
        <div className="actions">
          <label className="sr-only" htmlFor={`${titleId}-status`}>Status for {item.title}</label>
          <select id={`${titleId}-status`} className="input" style={{ width: "auto" }} disabled={busy} value={item.person?.status ?? ""} onChange={(e) => void setStatus(e.target.value as ItemStatus | "")}>
            {STATUS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {item.assignee !== `human:${mine}`
            ? <button className="btn ghost small" disabled={busy} onClick={() => void save({ assignee: `human:${mine}` })}>Take it</button>
            : <button className="btn ghost small" disabled={busy} onClick={() => void save({ assignee: null })}>Unassign</button>}
          {item.custom && <button className="btn ghost small danger" disabled={busy} onClick={() => void api(`/deals/${dealId}/items/${encodeURIComponent(item.key)}`, { method: "DELETE" }).then(onChange)}>Remove</button>}
        </div>
      )}
    </div>
  );
}

function AddItem({ dealId, workstream, onChange }: { dealId: string; workstream: Workstream; onChange: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!can("work_deals")) return null;
  if (!open) return <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)" }}><button className="btn ghost small" onClick={() => setOpen(true)}>Add an item</button></div>;
  return (
    <form className="row" style={{ padding: "8px 14px", borderTop: "1px solid var(--line)" }} onSubmit={(e) => {
      e.preventDefault();
      void api(`/deals/${dealId}/items`, { body: { workstream, title } }).then(() => { setTitle(""); setOpen(false); onChange(); }).catch((x: Error) => toast("bad", x.message));
    }}>
      <Field label="New item"><input className="input" autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Visit the test site" /></Field>
      <button className="btn small primary" style={{ alignSelf: "flex-end" }}>Add</button>
      <button type="button" className="btn small ghost" style={{ alignSelf: "flex-end" }} onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

// Referenced by other tabs.
export const useTeam = () => useApi<{ members: { user_id: string; email: string; name: string | null; role: string }[] }>("/team");
