import { api } from "../../api";
import { Notice } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";

/** Each person's annual acknowledgement of the firm's policies, and the Marketing Rule reviews on record. */
export default function Attestations({ data, onChange }: CoTabProps) {
  const run = useRun(onChange);
  const L = data.labels;
  const a = data.attestations;
  const mine = a.missing.filter((m) => m.person === data.person);
  const others = a.missing.filter((m) => m.person !== data.person);
  return (
    <>
      <section className="panel panel-pad section" aria-labelledby="at-h">
        <h2 id="at-h">{a.year} attestations</h2>
        {mine.length === 0 ? <Notice tone="good">You've acknowledged every policy for {a.year}.</Notice> : (
          <>
            <p className="small" style={{ margin: 0 }}>Confirm you've read, understood and will follow each policy, and that you've reported everything it requires.</p>
            <div className="row">
              {mine.map((m) => <button key={m.policy} className="btn primary small" onClick={() => void run(() => api("/compliance/attestations", { body: { policy: m.policy, year: a.year } }), "Recorded.")}>I acknowledge the {L.policies[m.policy]!.toLowerCase()}</button>)}
            </div>
          </>
        )}
        {data.reviewer && (
          <>
            <h3>Team</h3>
            {others.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Everyone else is done.</p> : (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {[...new Set(others.map((m) => m.person))].map((p) => <li key={p}><strong>{person(p)}</strong>: {others.filter((m) => m.person === p).map((m) => L.policies[m.policy]).join(", ")} outstanding</li>)}
              </ul>
            )}
            {a.done.length > 0 && <p className="small muted" style={{ margin: 0 }}>{a.done.length} acknowledgement{a.done.length === 1 ? "" : "s"} on record this year.</p>}
          </>
        )}
      </section>
      <section className="panel panel-pad section" aria-labelledby="mr-h">
        <h2 id="mr-h">Marketing Rule reviews</h2>
        <p className="small muted" style={{ margin: 0 }}>Kept when a partner approves marketing material for the data room: {data.marketingChecklist.length} checks, from net beside gross to fair and balanced.</p>
        {data.marketingReviews.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet.</p> : (
          <ul className="timeline small">
            {data.marketingReviews.map((r) => <li key={r.id}><span>{longDate(r.created_at)}</span><span><strong>{r.title}</strong> <span className="muted">reviewed by {person(r.reviewer)}</span></span></li>)}
          </ul>
        )}
      </section>
    </>
  );
}
