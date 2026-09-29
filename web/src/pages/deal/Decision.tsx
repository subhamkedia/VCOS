import { useState } from "react";
import { api } from "../../api";
import { useSession } from "../../app";
import { Field, Notice, Select, dateOnly, useConfirm, useToast } from "../../ui";
import type { TabProps } from "../Deal";

const REASON_LABELS: Record<string, string> = {
  team: "Team", market_size: "Market size", timing: "Timing", competition: "Competition", technology_risk: "Technology risk",
  traction: "Traction", valuation: "Valuation", capital_intensity: "Capital intensity", thesis_fit: "Thesis fit", deal_dynamics: "Deal dynamics", other: "Other",
};

/**
 * Pass, or send to IC. Both are recorded as decisions with the reason and
 * the state of diligence at that moment: judgment is data.
 */
export default function Decision({ data, onChange }: TabProps) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [reason, setReason] = useState<string | undefined>();
  const [why, setWhy] = useState("");
  const [icWhy, setIcWhy] = useState("");
  const decided = !["screening", "diligence"].includes(data.deal.stage);
  const r = data.readiness;
  const decide = async (body: object, title: string, verb: string, danger = false) => {
    const ok = await confirm({ title, body: "This is recorded with your name and the state of diligence right now.", confirm: verb, danger });
    if (!ok) return;
    try {
      await api(`/deals/${data.deal.id}/decision`, { body });
      toast("good", "Decision recorded.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <>
      {data.decisions.length > 0 && (
        <section className="panel panel-pad section" aria-labelledby="hist-h">
          <h2 id="hist-h">Decisions on {data.deal.company_name}</h2>
          <ul className="timeline small">
            {data.decisions.map((d) => (
              <li key={d.id}>
                <span className="muted">{dateOnly(d.created_at)}</span>
                <span><strong>{d.kind === "pass" ? "Passed" : d.kind === "advance" ? "Sent to IC" : d.kind.replace(/_/g, " ")}</strong>{d.reason_code ? ` · ${REASON_LABELS[d.reason_code] ?? d.reason_code}` : ""} · {d.actor.replace(/^human:/, "")}<br />{d.rationale}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {decided ? <Notice>This deal has a decision. To look again later, start a new deal on the company from Diligence.</Notice> : !can("decide_deals") ? <Notice>Partners and admins make the call. You can see the readiness and the history here.</Notice> : (
        <div className="grid-2">
          <form className="panel panel-pad section" onSubmit={(e) => { e.preventDefault(); void decide({ kind: "advance", rationale: icWhy || undefined }, `Send ${data.deal.company_name} to IC?`, "Send to IC"); }} aria-labelledby="ic-h">
            <h2 id="ic-h">Send to IC</h2>
            {r.ready ? <Notice tone="good">Diligence is complete: every required item is done, with no red flags or serious conflicts.</Notice> : (
              <Notice tone="warn">Not complete: {r.requiredOpen.length} required {r.requiredOpen.length === 1 ? "item" : "items"} open{r.redFlags.length ? `, ${r.redFlags.length} red ${r.redFlags.length === 1 ? "flag" : "flags"}` : ""}{r.highContradictions ? `, ${r.highContradictions} serious ${r.highContradictions === 1 ? "conflict" : "conflicts"}` : ""}. Say why it should go anyway.</Notice>
            )}
            <Field label={r.ready ? "Notes for IC" : "Why now"} required={!r.ready}>
              <textarea className="input" required={!r.ready} minLength={r.ready ? undefined : 10} value={icWhy} onChange={(e) => setIcWhy(e.target.value)} />
            </Field>
            <div className="row"><button className="btn primary">Send to IC</button></div>
          </form>
          <form className="panel panel-pad section" onSubmit={(e) => { e.preventDefault(); void decide({ kind: "pass", reasonCode: reason, rationale: why }, `Pass on ${data.deal.company_name}?`, "Pass", true); }} aria-labelledby="pass-h">
            <h2 id="pass-h">Pass</h2>
            <p className="small muted" style={{ margin: 0 }}>Pass reasons are data: they show where your funnel loses deals and which theses you keep passing on.</p>
            <Field label="Main reason" required><Select id="pass-reason" value={reason} onChange={setReason} placeholder="Choose" options={data.passReasons.map((id) => ({ id, label: REASON_LABELS[id] ?? id }))} /></Field>
            <Field label="Why, in a sentence or two" required><textarea className="input" required minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
            <div className="row"><button className="btn danger" disabled={!reason}>Pass</button></div>
          </form>
        </div>
      )}
    </>
  );
}
