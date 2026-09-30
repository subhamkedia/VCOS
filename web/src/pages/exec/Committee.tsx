import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../../api";
import { useSession } from "../../app";
import type { IcMeeting, IcTally, IcVote, Role } from "../../types";
import { Chips, Field, Notice, Select, dateOnly, useConfirm, usePrompt, useToast } from "../../ui";
import { useVocab } from "../../vocab";
import { PHASE_LABELS } from "../Execution";
import { person, type ExecTabProps } from "../ExecutionDeal";

const VOTE_LABELS: Record<IcVote["vote"], string> = { yes: "Yes", no: "No", abstain: "Abstain", recused: "Recused" };
const VOTE_TONE: Record<IcVote["vote"], string> = { yes: "good", no: "bad", abstain: "quiet", recused: "outline" };
const STEPS: IcMeeting["phase"][] = ["pre_vote", "discussion", "post_vote", "decided"];

/**
 * The IC meeting. Each member votes on their own before discussion, and no
 * one sees another's vote until the chair opens discussion: that keeps the
 * first vote independent of the senior voice in the room. Final votes come
 * after discussion; the firm's approval rule is applied in code.
 */
export default function Committee({ data, onChange }: ExecTabProps) {
  const { can } = useSession();
  const current = data.meetings.find((m) => m.phase !== "decided" && m.phase !== "cancelled");
  const past = data.meetings.filter((m) => m !== current);
  return (
    <>
      {current ? <Meeting m={current} data={data} onChange={onChange} /> : data.deal.stage === "ic" ? (
        can("decide_deals") ? <Schedule data={data} onChange={onChange} /> : <Notice>A partner schedules the IC meeting. The memo and diligence are on the <Link to={`/diligence/${data.deal.id}?tab=memo`}>Diligence</Link> side.</Notice>
      ) : data.meetings.length === 0 ? <Notice>This deal hasn't been to IC in VC OS.</Notice> : null}
      {past.map((m) => <Meeting key={m.id} m={m} data={data} onChange={onChange} />)}
    </>
  );
}

function Schedule({ data, onChange }: ExecTabProps) {
  const { me } = useSession();
  const toast = useToast();
  const team = useApi<{ members: { user_id: string; email: string; name: string | null; role: Role }[] }>("/team");
  const [members, setMembers] = useState<string[] | null>(null);
  const [chair, setChair] = useState<string | undefined>(me.user.email);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const options = (team.data?.members ?? []).map((m) => ({ id: m.email, label: m.name ? `${m.name} (${m.email})` : m.email }));
  const picked = members ?? (team.data?.members ?? []).filter((m) => m.role !== "analyst").map((m) => m.email);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/deals/${data.deal.id}/ic`, { body: { members: picked, chair, scheduledFor: date ? new Date(date).toISOString() : undefined } });
      toast("good", "IC meeting set up. Members can vote now.");
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad section" aria-labelledby="sched-h" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="sched-h">Set up the IC meeting</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Members vote on their own first, and no one sees another's vote until you open discussion. Then everyone votes again. The rule is <strong>{data.icRule.toLowerCase()}</strong> (change it in <Link to="/settings/fund">Firm settings</Link>).
      </p>
      {team.error ? <Notice tone="bad">{team.error.message}</Notice> : !team.data ? <p className="small muted">Loading your team…</p> : (
        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <legend className="small"><strong>Voting members</strong></legend>
          <Chips options={options} value={picked} onChange={setMembers} />
        </fieldset>
      )}
      <div className="grid-2">
        <Field label="Chair" hint="Opens discussion, calls the final vote and closes the meeting.">
          <Select id="ic-chair" value={chair} onChange={setChair} options={options.filter((o) => picked.includes(o.id))} />
        </Field>
        <Field label="Meeting time"><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="row"><button className="btn primary" disabled={busy || picked.length === 0 || !chair} aria-busy={busy}>Open voting</button></div>
    </form>
  );
}

function Meeting({ m, data, onChange }: { m: IcMeeting } & ExecTabProps) {
  const v = useVocab();
  const { me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [reason, setReason] = useState<string | undefined>();
  const [why, setWhy] = useState("");
  const [notes, setNotes] = useState("");
  const self = `human:${me.user.email.toLowerCase()}`;
  const open = m.phase !== "decided" && m.phase !== "cancelled";
  const round = m.phase === "pre_vote" ? "pre" : m.phase === "post_vote" ? "post" : null;
  const recused = m.preVotes.concat(m.postVotes).some((v) => v.member === self && v.vote === "recused");
  const mine = round ? m.voted[round].includes(self) : false;
  const run = async (path: string, body: object, done: string) => {
    try {
      await api(path, { body });
      toast("good", done);
      onChange();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  const advance = async () => {
    const next = m.phase === "pre_vote" ? "Open discussion" : m.phase === "discussion" ? "Call the final vote" : "Close the meeting";
    const body = m.phase === "pre_vote" ? "Everyone's independent votes become visible to the committee." : m.phase === "discussion" ? "Members cast their final votes." : `The ${m.ruleLabel.toLowerCase()} rule is applied to the final votes and the result is recorded.`;
    if (!(await confirm({ title: `${next}?`, body, confirm: next }))) return;
    await run(`/ic/${m.id}/advance`, { notes: notes || undefined, passReason: reason, passRationale: why || undefined }, m.phase === "post_vote" ? "Decision recorded." : "Moved on.");
  };
  const recuse = async () => {
    const r = await prompt({ title: "Recuse yourself?", label: "What's the conflict?", confirm: "Recuse", required: true });
    if (r) await run(`/ic/${m.id}/recuse`, { reason: r }, "Recusal recorded.");
  };
  const cancel = async () => {
    if (await confirm({ title: "Cancel this IC meeting?", body: "Votes cast so far are kept on the record. You can set up a new meeting.", confirm: "Cancel meeting", danger: true })) {
      await run(`/ic/${m.id}/cancel`, {}, "Meeting cancelled.");
    }
  };
  const step = STEPS.indexOf(m.phase);
  const declining = m.phase === "post_vote" && m.postTally?.outcome === "declined";
  return (
    <section className="panel panel-pad section" aria-labelledby={`m-${m.id}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id={`m-${m.id}`}>IC meeting{m.scheduled_for ? `, ${dateOnly(m.scheduled_for)}` : ""}</h2>
        {m.outcome ? <span className={`pill ${m.outcome === "approved" ? "good" : "bad"}`}>{m.outcome === "approved" ? "Approved" : "Declined"}</span> : <span className="pill info">{PHASE_LABELS[m.phase]}</span>}
      </div>
      {m.phase !== "cancelled" && (
        <ol className="phases" aria-label="Meeting steps">
          {STEPS.map((s, i) => <li key={s} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : i === step ? "now" : ""}>{PHASE_LABELS[s]}</li>)}
        </ol>
      )}
      <dl className="kv">
        <dt>Rule</dt><dd>{m.ruleLabel}</dd>
        <dt>Chair</dt><dd>{person(m.chair)}</dd>
        <dt>Members</dt><dd>{m.members.map(person).join(", ")}</dd>
      </dl>

      {round && (
        <p className="small" style={{ margin: 0 }} aria-live="polite">
          {round === "pre" ? "Independent votes" : "Final votes"} in: {m.voted[round].length} of {m.members.length}
          {m.members.filter((x) => !m.voted[round].includes(x)).length > 0 && <span className="muted"> · waiting for {m.members.filter((x) => !m.voted[round].includes(x)).map(person).join(", ")}</span>}
        </p>
      )}

      {round && m.isMember && !mine && !recused && <VoteForm meetingId={m.id} round={round} rule={m.rule} onDone={onChange} />}
      {round && mine && <Notice tone="good">Your {round === "pre" ? "independent" : "final"} vote is in.{round === "pre" && " Others' votes stay hidden until the chair opens discussion."}</Notice>}

      {m.phase === "pre_vote" && m.preVotes.length > 0 && <Votes title="Your independent vote" votes={m.preVotes} />}
      {m.phase !== "pre_vote" && m.preVotes.length > 0 && <Votes title="Independent votes (before discussion)" votes={m.preVotes} tally={m.preTally} />}
      {m.postVotes.length > 0 && <Votes title="Final votes (after discussion)" votes={m.postVotes} tally={m.phase === "post_vote" || m.phase === "decided" ? m.postTally : null} />}
      {m.shifts.length > 0 && (
        <div>
          <h3>What discussion changed</h3>
          <ul className="small" style={{ margin: 0 }}>
            {m.shifts.map((s) => <li key={s.member}>{person(s.member)}: {VOTE_LABELS[s.from as IcVote["vote"]]} ({s.conviction[0] ?? "—"}/5) → {VOTE_LABELS[s.to as IcVote["vote"]]} ({s.conviction[1] ?? "—"}/5)</li>)}
          </ul>
        </div>
      )}
      {m.notes && <div><h3>Notes</h3><p className="small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{m.notes}</p></div>}

      {open && m.isChair && (
        <div className="section" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <h3>Chair</h3>
          {declining && (
            <>
              <Notice tone="warn">On the final votes the committee declines ({m.postTally!.detail}). Record the main reason; it goes in your pass data.</Notice>
              <div className="grid-2">
                <Field label="Main reason" required><Select id={`reason-${m.id}`} value={reason} onChange={setReason} placeholder="Choose" options={data.passReasons.map((id) => ({ id, label: v.passReason(id) }))} /></Field>
                <Field label="In a sentence"><input className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
              </div>
            </>
          )}
          <Field label="Meeting notes" hint="Kept with the meeting; optional."><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <div className="row">
            <button type="button" className="btn primary" disabled={declining && !reason} onClick={() => void advance()}>
              {m.phase === "pre_vote" ? "Open discussion" : m.phase === "discussion" ? "Call the final vote" : "Close the meeting"}
            </button>
            <button type="button" className="btn danger" onClick={() => void cancel()}>Cancel meeting</button>
          </div>
        </div>
      )}
      {open && m.isMember && !recused && <div className="row"><button type="button" className="btn small ghost" onClick={() => void recuse()}>Recuse myself</button></div>}
      {m.phase === "decided" && m.outcome === "approved" && data.deal.stage === "approved" && <Notice tone="good">Approved. Start closing from the Closing tab.</Notice>}
    </section>
  );
}

function VoteForm({ meetingId, round, rule, onDone }: { meetingId: string; round: "pre" | "post"; rule: string; onDone: () => void }) {
  const toast = useToast();
  const [vote, setVote] = useState<"yes" | "no" | "abstain" | undefined>();
  const [conviction, setConviction] = useState(3);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/ic/${meetingId}/vote`, { body: { vote, conviction, note: note || undefined } });
      toast("good", "Vote recorded.");
      onDone();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="section" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={round === "pre" ? "Your independent vote" : "Your final vote"}>
      <h3>{round === "pre" ? "Your independent vote" : "Your final vote"}</h3>
      <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Vote</legend>
        {(["yes", "no", "abstain"] as const).map((v) => (
          <label key={v} className="row" style={{ gap: 4 }}><input type="radio" name={`vote-${meetingId}`} value={v} checked={vote === v} onChange={() => setVote(v)} required /> {VOTE_LABELS[v]}</label>
        ))}
      </fieldset>
      <Field label={`Conviction: ${conviction} of 5`} hint={rule === "champion" ? "5 means you'd champion it (or block it). Under the champion rule, one 5 carries the deal unless someone votes no with a 5." : "How strongly you hold this view: 1 is barely, 5 is you'd champion it (or block it)."}>
        <input type="range" min={1} max={5} step={1} value={conviction} onChange={(e) => setConviction(Number(e.target.value))} aria-valuetext={`${conviction} of 5`} />
      </Field>
      <Field label="Why" hint={round === "pre" ? "Your reasoning before hearing others. Visible after discussion opens." : undefined}>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="row"><button className="btn primary" disabled={!vote || busy} aria-busy={busy}>Cast vote</button></div>
    </form>
  );
}

function Votes({ title, votes, tally }: { title: string; votes: IcVote[]; tally?: IcTally | null }) {
  return (
    <div>
      <h3>{title}</h3>
      {tally && <p className="small" style={{ margin: "0 0 6px" }}><strong>{tally.outcome === "approved" ? "Carries" : tally.outcome === "declined" ? "Doesn't carry" : "No quorum"}</strong> · {tally.detail}</p>}
      <ul className="timeline small">
        {votes.map((v) => (
          <li key={v.member + v.at}>
            <span><span className={`pill ${VOTE_TONE[v.vote]}`}>{VOTE_LABELS[v.vote]}</span>{v.conviction ? <span className="muted"> {v.conviction}/5</span> : null}</span>
            <span><strong>{person(v.member)}</strong>{v.note ? ` · ${v.note}` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
