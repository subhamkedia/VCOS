import { useState } from "react";
import { api } from "../../api";
import { Field, NumberInput, Notice, Seg } from "../../ui";
import { longDate, person } from "../lp/shared";
import { useRun, type CoTabProps } from "../Compliance";
import { Decide, REQ_TONE } from "./Decide";

const today = () => new Date().toISOString().slice(0, 10);

/** Pay to play (Rule 206(4)-5) pre-clearance, and the gifts and entertainment log. */
export default function Gifts({ data, onChange }: CoTabProps) {
  return (
    <>
      <Contributions data={data} onChange={onChange} />
      <GiftLog data={data} onChange={onChange} />
    </>
  );
}

function Contributions({ data, onChange }: CoTabProps) {
  const run = useRun(onChange);
  const L = data.labels;
  const blank = { recipient: "", office: "", jurisdiction: "", election: "", contributeOn: today(), canVote: true, influencesGovernmentInvestor: true, amountUsd: undefined as number | undefined };
  const [f, setF] = useState(blank);
  const [last, setLast] = useState<string | null>(null);
  return (
    <section className="panel panel-pad section" aria-labelledby="pp-h">
      <h2 id="pp-h">Political contributions</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Pre-clear every contribution to a state or local candidate or official. Up to $350 per election where you can vote, $150 where you can't; above that, a contribution to someone who can influence a public pension's choice of adviser bars the firm from being paid by it for two years. The SEC proposed rescinding the rule in September 2026; it applies until it's rescinded.
      </p>
      {last && <Notice tone={/two years|Don't/.test(last) ? "bad" : /Within/.test(last) ? "good" : "warn"}>{last}</Notice>}
      {data.contributions.length > 0 && (
        <ul className="timeline small">
          {data.contributions.map((c) => (
            <li key={c.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span>
                <strong>${c.amount_usd.toLocaleString()}</strong> to {c.recipient} ({c.office}, {c.jurisdiction}, {c.election}) <span className="muted">from {person(c.person)}, planned {longDate(c.contribute_on)}</span>
                <br /><span className={c.result.timeOut ? "" : "muted"}>{c.result.message}</span>
                {c.note && <><br /><span className="muted">{person(c.decided_by)}: {c.note}</span></>}
              </span>
              {c.status === "pending" && data.reviewer && c.person !== data.person
                ? <Decide path={`/compliance/contributions/${c.id}/decide`} who={c.person} what="contribution" noteToApprove={c.result.withinDeMinimis ? undefined : "Over the de minimis: why approve?"} onChange={onChange} />
                : <span className={`pill ${REQ_TONE[c.status]}`}>{L.requestStatus[c.status]}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="section" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await api<{ result: { message: string } }>("/compliance/contributions", { body: f });
          setLast(r.result.message);
          setF(blank);
        }, "Sent for pre-clearance.");
      }}>
        <div className="form-grid">
          <Field label="Candidate or official" required><input className="input" required value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} /></Field>
          <Field label="Office" required hint="Include offices sought"><input className="input" required value={f.office} onChange={(e) => setF({ ...f, office: e.target.value })} /></Field>
          <Field label="State or city" required><input className="input" required value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} /></Field>
          <Field label="Election" required hint="Primary and general are separate elections"><input className="input" required value={f.election} onChange={(e) => setF({ ...f, election: e.target.value })} placeholder="2026 general" /></Field>
          <Field label="Amount" required><NumberInput id="pp-amt" prefix="$" value={f.amountUsd} onChange={(v) => setF({ ...f, amountUsd: v })} /></Field>
          <Field label="Date" required><input className="input" type="date" required value={f.contributeOn} onChange={(e) => setF({ ...f, contributeOn: e.target.value })} /></Field>
        </div>
        <div className="field"><span>Can you vote for them?</span><Seg label="Can you vote for them?" value={f.canVote ? "y" : "n"} onChange={(v) => setF({ ...f, canVote: v === "y" })} options={[{ id: "y", label: "Yes" }, { id: "n", label: "No" }]} /></div>
        <div className="field"><span>Can the office influence a public pension's choice of adviser?</span><Seg label="Influence over a government investor" value={f.influencesGovernmentInvestor ? "y" : "n"} onChange={(v) => setF({ ...f, influencesGovernmentInvestor: v === "y" })} options={[{ id: "y", label: "Yes or not sure" }, { id: "n", label: "No" }]} /></div>
        <div className="row"><button className="btn primary" disabled={!f.amountUsd}>Ask for pre-clearance</button></div>
      </form>
    </section>
  );
}

function GiftLog({ data, onChange }: CoTabProps) {
  const run = useRun(onChange);
  const L = data.labels;
  const blank = { direction: "received" as "given" | "received", kind: "gift" as "gift" | "entertainment", counterparty: "", description: "", valueUsd: undefined as number | undefined, occurredOn: today() };
  const [f, setF] = useState(blank);
  return (
    <section className="panel panel-pad section" aria-labelledby="gf-h">
      <h2 id="gf-h">Gifts and entertainment</h2>
      <p className="small muted" style={{ margin: 0 }}>Log what you give and receive in business. Anything over the firm's ${data.profile.gift_limit_usd.toLocaleString()} limit goes to a reviewer.</p>
      {data.gifts.length > 0 && (
        <ul className="timeline small">
          {data.gifts.map((g) => (
            <li key={g.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span>
                {L.giftKinds[g.kind]} {g.direction === "given" ? "given to" : "from"} <strong>{g.counterparty}</strong>: {g.description}, ${g.value_usd.toLocaleString()} <span className="muted">{person(g.person)}, {longDate(g.occurred_on)}</span>
                {g.over_limit && <> <span className="pill warn">Over the limit</span></>}
                {g.note && <><br /><span className="muted">{person(g.decided_by)}: {g.note}</span></>}
              </span>
              {g.status === "logged" && g.over_limit && data.reviewer && g.person !== data.person
                ? <Decide path={`/compliance/gifts/${g.id}/decide`} who={g.person} what="gift" onChange={onChange} />
                : <span className={`pill ${REQ_TONE[g.status]}`}>{L.requestStatus[g.status]}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="section" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/compliance/gifts", { body: f }); setF(blank); }, "Logged."); }}>
        <div className="row">
          <Seg label="Given or received" value={f.direction} onChange={(v) => setF({ ...f, direction: v })} options={[{ id: "received", label: "Received" }, { id: "given", label: "Given" }]} />
          <Seg label="Gift or entertainment" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ id: "gift", label: "Gift" }, { id: "entertainment", label: "Entertainment" }]} />
        </div>
        <div className="form-grid">
          <Field label={f.direction === "given" ? "Given to" : "From"} required hint="Person and organization"><input className="input" required value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></Field>
          <Field label="What" required><input className="input" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Value" required hint="An estimate is fine"><NumberInput id="gf-v" prefix="$" value={f.valueUsd} onChange={(v) => setF({ ...f, valueUsd: v })} /></Field>
          <Field label="Date"><input className="input" type="date" value={f.occurredOn} onChange={(e) => setF({ ...f, occurredOn: e.target.value })} /></Field>
        </div>
        <div className="row"><button className="btn primary" disabled={f.valueUsd === undefined}>Log it</button></div>
      </form>
    </section>
  );
}
