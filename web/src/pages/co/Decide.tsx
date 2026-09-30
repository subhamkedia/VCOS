import { api } from "../../api";
import { usePrompt } from "../../ui";
import { person } from "../lp/shared";
import { useRun } from "../Compliance";

/** Approve or deny someone else's request. Denials, and approvals with a warning, need a note. */
export function Decide({ path, who, what, noteToApprove, onChange }: { path: string; who: string; what: string; noteToApprove?: string; onChange: () => void }) {
  const prompt = usePrompt();
  const run = useRun(onChange);
  const decide = async (approve: boolean) => {
    const needNote = !approve || Boolean(noteToApprove);
    const note = await prompt({
      title: `${approve ? "Approve" : "Deny"} ${person(who)}'s ${what}?`,
      label: approve ? (noteToApprove ?? "Note (optional)") : "Why it's denied",
      confirm: approve ? "Approve" : "Deny", required: needNote, danger: !approve, multiline: true,
    });
    if (note === null) return;
    await run(() => api(path, { body: { approve, note: note || undefined } }), approve ? "Approved." : "Denied.");
  };
  return (
    <span className="row">
      <button className="btn small primary" onClick={() => void decide(true)}>Approve</button>
      <button className="btn small ghost" onClick={() => void decide(false)}>Deny</button>
    </span>
  );
}

export const REQ_TONE: Record<string, string> = { pending: "warn", logged: "info", approved: "good", denied: "bad" };
