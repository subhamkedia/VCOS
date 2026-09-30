import { useState } from "react";
import { api, useApi } from "../api";
import { useSession } from "../app";
import type { OutboxItem } from "../types";
import { ErrorState, Loading, Notice, PageHead, Seg, Time, actor, useToast } from "../ui";
import { useVocab } from "../vocab";

const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/** What approving the item would create, in the words a person reviews. */
function Payload({ p }: { p: Record<string, unknown> }) {
  if (Array.isArray(p.documents)) {
    const docs = p.documents as { name: string; bytes?: number }[];
    const signers = (p.signers ?? []) as { name: string; email: string }[];
    return (
      <div className="small section" style={{ gap: 4 }}>
        <div>Subject: {String(p.subject)}</div>
        <div>Signers: {signers.map((s) => `${s.name} (${s.email})`).join(", ")}</div>
        <div>Documents: {docs.map((d) => (d.bytes ? `${d.name} (${kb(d.bytes)})` : d.name)).join(", ")}</div>
      </div>
    );
  }
  return (
    <>
      {Array.isArray(p.to) && <div className="small">To: {(p.to as string[]).join(", ")} · Subject: {String(p.subject)}</div>}
      <pre className="evidence mail" style={{ maxHeight: 260 }}>{String(p.body ?? p.content ?? "")}</pre>
    </>
  );
}

export default function Approvals() {
  const { can } = useSession();
  const v = useVocab();
  const [status, setStatus] = useState<"pending" | "done" | "rejected" | "failed">("pending");
  const { data, error, reload } = useApi<OutboxItem[]>(`/outbox?status=${status}`);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      const r = await api<{ outcome?: { ok: boolean; detail: string } }>(`/outbox/${id}/${approve ? "approve" : "reject"}`, { body: {} });
      if (r.outcome) toast(r.outcome.ok ? "good" : "bad", r.outcome.ok ? `Approved. ${r.outcome.detail}.` : `Approved, but it failed: ${r.outcome.detail}`);
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
        title="Approvals"
        lead="Everything VC OS wants to write outside itself waits here: CRM notes, email drafts and signature envelopes. Approving creates the note or the draft; nothing is ever sent for you."
        actions={<Seg options={[{ id: "pending", label: "Waiting" }, { id: "done", label: "Done" }, { id: "rejected", label: "Rejected" }, { id: "failed", label: "Failed" }]} value={status} onChange={setStatus} />}
      />
      {!can("approve_outbox") && status === "pending" && <Notice>Partners and admins approve these. You can see what's waiting.</Notice>}
      {error ? <ErrorState error={error} retry={() => void reload()} /> : !data ? <Loading /> : data.length === 0 ? (
        <Notice>{status === "pending" ? "Nothing waiting for approval." : `No ${status} items.`}</Notice>
      ) : data.map((i) => (
        <article key={i.id} className="panel panel-pad section" style={{ gap: 8 }}>
          <div className="spread">
            <div><span className="pill info">{v.channel(i.channel)}</span> <strong>{i.summary}</strong></div>
            <span className="small muted">Proposed by {actor(i.proposed_by)} · <Time at={i.created_at} /></span>
          </div>
          <Payload p={i.payload} />
          {i.error && <Notice tone="bad">{i.error}</Notice>}
          {i.decided_by && <div className="small muted">Decided by {actor(i.decided_by)}</div>}
          {status === "pending" && can("approve_outbox") && (
            <div className="row">
              <button className="btn primary small" disabled={busy === i.id} aria-busy={busy === i.id} onClick={() => void decide(i.id, true)}>{v.approveLabel(i.channel)}</button>
              <button className="btn small danger" disabled={busy === i.id} onClick={() => void decide(i.id, false)}>Reject</button>
            </div>
          )}
        </article>
      ))}
    </>
  );
}
