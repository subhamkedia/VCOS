import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, NumberInput, Notice, Select } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";

/** The adviser's regulatory status, which decides what the calendar holds. */
export default function Profile({ data, onChange }: CoTabProps) {
  const { can } = useSession();
  const run = useRun(onChange);
  const p = data.profile;
  const [f, setF] = useState({ adviserStatus: p.adviser_status, ccoEmail: p.cco_email ?? "", fiscalYearEnd: p.fiscal_year_end, requireScreening: p.require_screening, giftLimitUsd: p.gift_limit_usd as number | undefined });
  const edit = can("manage_firm");
  return (
    <form className="panel panel-pad section" aria-labelledby="pf-h" onSubmit={(e) => { e.preventDefault(); void run(() => api("/compliance/profile", { method: "PUT", body: f }), "Saved."); }}>
      <h2 id="pf-h">Regulatory profile</h2>
      {!edit && <Notice>An admin sets this.</Notice>}
      <fieldset disabled={!edit} className="section" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Profile</legend>
        <div className="form-grid">
          <Field label="Adviser status" required hint="Most venture managers are exempt reporting advisers; registered advisers add Form PF, the audit, the annual review and code of ethics reports"><Select id="pf-st" value={f.adviserStatus} onChange={(v) => setF({ ...f, adviserStatus: v ?? "era" })} options={Object.entries(data.labels.adviserStatus).map(([id, label]) => ({ id, label }))} /></Field>
          <Field label="Chief compliance officer's email"><input className="input" type="email" value={f.ccoEmail} onChange={(e) => setF({ ...f, ccoEmail: e.target.value })} /></Field>
          <Field label="Fiscal year end" hint="MM-DD"><input className="input" pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" value={f.fiscalYearEnd} onChange={(e) => setF({ ...f, fiscalYearEnd: e.target.value })} /></Field>
          <Field label="Gift limit" hint="Gifts and entertainment above this go to a reviewer"><NumberInput id="pf-gl" prefix="$" value={f.giftLimitUsd} onChange={(v) => setF({ ...f, giftLimitUsd: v })} /></Field>
        </div>
        <label className="check-row small"><input type="checkbox" checked={f.requireScreening} onChange={(e) => setF({ ...f, requireScreening: e.target.checked })} /><span>Deals can't close until they've had a regulatory screening</span></label>
      </fieldset>
      {p.updated_by && <p className="small muted" style={{ margin: 0 }}>Last changed by {person(p.updated_by)} on {longDate(p.updated_at)}</p>}
      {edit && <div className="row"><button className="btn primary">Save</button></div>}
    </form>
  );
}
