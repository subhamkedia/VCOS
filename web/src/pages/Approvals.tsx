import { useState } from "react";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { OutboxItem } from "../types";
import { ErrorState, Loading, Notice, PageHead, Seg, Time, useToast } from "../ui";

const CHANNEL: Record<string, string> = { affinity_note: "Affinity note", gmail_draft: "Gmail draft", outlook_draft: "Outlook draft" };

export default function Approvals() {
  const { can } = useSession();
  const [status, setStatus] = useState<"pending" | "done" | "rejected" | "failed">("pending");
  const { data, error, reload } = useApi<OutboxItem[]>(`/outbox?status=${status}`);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      const r = await api<{ outcome?: { ok: boolean; detail: string } }>(`/outbox/${id}/${approve ? "approve" : "reject"}`, { body: {} });
      if (r.outcome) toast(r.outcome.ok ? "good" : "bad", r.outcome.ok ? `Approved: ${r.outcome.detail}.` : `Approved, but it failed: ${r.outcome.detail}`);
      else toast("good", "Rejected. Nothing was created.");
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
    void reload();
  };
  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Approvals"
        lead="Everything VC OS wants to write outside itself waits here: CRM notes and email drafts. Approving creates the note or the draft in your own mailbox. Nothing is ever sent for you."
        actions={<Seg options={[{ id: "pending", label: "Waiting" }, { id: "done", label: "Done" }, { id: "rejected", label: "Rejected" }, { id: "failed", label: "Failed" }]} value={status} onChange={setStatus} />}
      />
      {!can("approve_outbox") && status === "pending" && <Notice>Partners and admins approve these. You can see what's waiting.</Notice>}
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading /> : data.length === 0 ? (
        <Notice>{status === "pending" ? "Nothing waiting for approval." : `No ${status} items.`}</Notice>
      ) : data.map((i) => (
        <article key={i.id} className="panel panel-pad section" style={{ gap: 8 }}>
          <div className="spread">
            <div><span className="pill info">{CHANNEL[i.channel] ?? i.channel}</span> <strong>{i.summary}</strong></div>
            <span className="small muted">Proposed by {i.proposed_by.replace(/^(agent|human):/, "")} · <Time at={i.created_at} /></span>
          </div>
          {"to" in i.payload && <div className="small">To: {(i.payload.to as string[]).join(", ")} · Subject: {String(i.payload.subject)}</div>}
          <pre className="evidence" style={{ maxHeight: 220 }}>{String(i.payload.body ?? i.payload.content ?? JSON.stringify(i.payload, null, 2))}</pre>
          {i.error && <Notice tone="bad">{i.error}</Notice>}
          {i.decided_by && <div className="small muted">Decided by {i.decided_by.replace(/^human:/, "")}</div>}
          {status === "pending" && can("approve_outbox") && (
            <div className="row">
              <button className="btn primary small" disabled={busy === i.id} aria-busy={busy === i.id} onClick={() => void decide(i.id, true)}>{i.channel.endsWith("_draft") ? "Approve: create draft" : "Approve: add note"}</button>
              <button className="btn small danger" disabled={busy === i.id} onClick={() => void decide(i.id, false)}>Reject</button>
            </div>
          )}
        </article>
      ))}
    </>
  );
}
