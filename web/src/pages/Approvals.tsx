import { useState } from "react";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { OutboxItem } from "../types";
import { Loading, Notice, PageHead, Seg, when } from "../ui";

const CHANNEL: Record<string, string> = { affinity_note: "Affinity note", gmail_draft: "Gmail draft", outlook_draft: "Outlook draft" };

export default function Approvals() {
  const { can } = useSession();
  const [status, setStatus] = useState<"pending" | "done" | "rejected" | "failed">("pending");
  const { data, reload } = useApi<OutboxItem[]>(`/outbox?status=${status}`);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const decide = async (id: string, approve: boolean) => {
    try {
      const r = await api<{ outcome?: { ok: boolean; detail: string } }>(`/outbox/${id}/${approve ? "approve" : "reject"}`, { body: {} });
      setMsg(r.outcome ? { tone: r.outcome.ok ? "good" : "bad", text: r.outcome.detail } : { tone: "good", text: "Rejected." });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
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
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!can("approve_outbox") && status === "pending" && <Notice>Partners and admins approve these. You can see what's waiting.</Notice>}
      {!data ? <Loading /> : data.length === 0 ? (
        <Notice>{status === "pending" ? "Nothing waiting for approval." : `No ${status} items.`}</Notice>
      ) : data.map((i) => (
        <article key={i.id} className="panel panel-pad section" style={{ gap: 8 }}>
          <div className="spread">
            <div><span className="pill info">{CHANNEL[i.channel] ?? i.channel}</span> <strong>{i.summary}</strong></div>
            <span className="small muted">proposed by {i.proposed_by} · {when(i.created_at)}</span>
          </div>
          {"to" in i.payload && <div className="small">To: {(i.payload.to as string[]).join(", ")} · Subject: {String(i.payload.subject)}</div>}
          <pre className="evidence" style={{ maxHeight: 220 }}>{String(i.payload.body ?? i.payload.content ?? JSON.stringify(i.payload, null, 2))}</pre>
          {i.error && <Notice tone="bad">{i.error}</Notice>}
          {i.decided_by && <div className="small muted">Decided by {i.decided_by}</div>}
          {status === "pending" && can("approve_outbox") && (
            <div className="row">
              <button className="btn primary small" onClick={() => void decide(i.id, true)}>Approve</button>
              <button className="btn small danger" onClick={() => void decide(i.id, false)}>Reject</button>
            </div>
          )}
        </article>
      ))}
    </>
  );
}
