import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, Select, dateOnly, useToast } from "../../ui";
import type { PfTabProps } from "../PortfolioCompany";
import { person } from "./shared";

const KIND_LABEL: Record<string, string> = { regular: "Regular meeting", special: "Special meeting", annual: "Annual meeting", written_consent: "Written consent" };
const RES_LABEL: Record<string, string> = {
  financing: "Financing", sale: "Sale of the company", recapitalization: "Recapitalization", down_round: "Down round", budget: "Budget or plan",
  option_grants: "Option grants", executive: "Executive hire or change", auditor: "Auditor", other: "Other",
};
const OUTCOME_LABEL: Record<string, string> = { approved: "Approved", rejected: "Rejected", deferred: "Deferred" };

/**
 * Board meetings the firm sits in on, with what was resolved. A director
 * appointed by the fund owes duties to all stockholders, so when a meeting
 * decides a sale, financing or recapitalization (where preferred and common
 * can want different things), the record says how the conflict was handled
 * (In re Trados, Del. Ch. 2013).
 */
export default function Board({ data, onChange }: PfTabProps) {
  const { can } = useSession();
  return (
    <>
      {can("work_deals") && <AddMeeting data={data} onChange={onChange} />}
      <section className="panel panel-pad section" aria-labelledby="bm-h">
        <h2 id="bm-h">Meetings</h2>
        {data.board.length === 0 ? <Notice>No board meetings recorded.</Notice> : (
          <ul className="timeline">
            {data.board.map((m) => (
              <li key={m.id}>
                <span className="small">{dateOnly(m.held_on)}</span>
                <span className="small">
                  <strong>{KIND_LABEL[m.kind] ?? m.kind}</strong> · we attended as {m.our_role === "none" ? "guests" : m.our_role}{m.attendees.length ? ` · ${m.attendees.join(", ")}` : ""}
                  {m.resolutions.length > 0 && <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{m.resolutions.map((r, i) => <li key={i}>{r.title} <span className="muted">({RES_LABEL[r.kind] ?? r.kind}, {OUTCOME_LABEL[r.outcome] ?? r.outcome})</span></li>)}</ul>}
                  {m.conflict_review && <><br /><strong>Conflicts:</strong> {m.conflict_review}</>}
                  {m.notes && <><br />{m.notes}</>}
                  <br /><span className="muted">Recorded by {person(m.created_by)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AddMeeting({ data, onChange }: PfTabProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [heldOn, setHeldOn] = useState("");
  const [kind, setKind] = useState<string | undefined>("regular");
  const [ourRole, setOurRole] = useState<string | undefined>(data.investments.some((i) => i.board_role === "seat") ? "director" : "observer");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [conflict, setConflict] = useState("");
  const [res, setRes] = useState<{ title: string; kind: string; outcome: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const needsConflict = res.some((r) => data.options.conflictKinds.includes(r.kind));
  if (!open) return <div className="row"><button className="btn primary" onClick={() => setOpen(true)}>Record a board meeting</button></div>;
  const save = async () => {
    setErr(null);
    try {
      await api(`/portfolio/companies/${data.company.id}/board`, { body: { heldOn, kind, ourRole, attendees, notes, resolutions: res, conflictReview: conflict || undefined } });
      toast("good", "Meeting recorded.");
      setOpen(false);
      setRes([]);
      setNotes("");
      setConflict("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="add-bm-h" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="add-bm-h">Record a board meeting</h2>
      <div className="form-grid">
        <Field label="Date" required><input className="input" type="date" required value={heldOn} onChange={(e) => setHeldOn(e.target.value)} /></Field>
        <Field label="Type"><Select id="bm-kind" value={kind} onChange={setKind} options={Object.entries(KIND_LABEL).map(([id, label]) => ({ id, label }))} /></Field>
        <Field label="We attended as"><Select id="bm-role" value={ourRole} onChange={setOurRole} options={[{ id: "director", label: "Director" }, { id: "observer", label: "Observer" }, { id: "none", label: "Guests" }]} /></Field>
        <Field label="Attendees" hint="Separated by commas"><input className="input" value={attendees} onChange={(e) => setAttendees(e.target.value)} /></Field>
      </div>
      <fieldset className="section" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
        <legend><strong>Resolutions</strong></legend>
        {res.map((r, i) => (
          <div className="form-grid" key={i}>
            <Field label={`Resolution ${i + 1}`}><input className="input" required value={r.title} onChange={(e) => setRes(res.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></Field>
            <Field label="Kind"><Select id={`bm-rk-${i}`} value={r.kind} onChange={(v) => setRes(res.map((x, j) => (j === i ? { ...x, kind: v ?? "other" } : x)))} options={data.options.resolutionKinds.map((id) => ({ id, label: RES_LABEL[id] ?? id }))} /></Field>
            <Field label="Outcome"><Select id={`bm-ro-${i}`} value={r.outcome} onChange={(v) => setRes(res.map((x, j) => (j === i ? { ...x, outcome: v ?? "approved" } : x)))} options={Object.entries(OUTCOME_LABEL).map(([id, label]) => ({ id, label }))} /></Field>
          </div>
        ))}
        <div><button type="button" className="btn small" onClick={() => setRes([...res, { title: "", kind: "other", outcome: "approved" }])}>Add a resolution</button></div>
      </fieldset>
      {needsConflict && (
        <Field label="How the board handled the conflict" required hint="Preferred and common can want different things in a sale, financing or recapitalization. Say how the decision was made fairly: independent directors, a separate common vote, a fairness opinion, recusal.">
          <textarea className="input" required minLength={20} value={conflict} onChange={(e) => setConflict(e.target.value)} />
        </Field>
      )}
      <Field label="Notes" hint="Kept internal."><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row"><button className="btn primary">Save</button><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
