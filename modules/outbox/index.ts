import { z } from "zod";
import type { Db } from "../../lib/db.js";
import {
  completeOutboxItem, decideOutboxItem, insertOutboxItem, listOutbox, type OutboxChannel, type OutboxItem, type OutboxStatus,
} from "../../ledger/repository.js";
import { affinityCreateNote } from "../../connectors/affinity.js";
import { gmailCreateDraft } from "../../connectors/gmail.js";
import { outlookCreateDraft } from "../../connectors/outlook.js";

/**
 * The approval outbox. Agents and workflows call `queue*`; nothing leaves
 * the system until a person approves the item, and the approval is recorded
 * before the action runs. Email channels create drafts in your own mailbox;
 * there is no channel that sends.
 *
 * The web app's approval screen and `pnpm outbox` both call these functions.
 */

const draft = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
  threadId: z.string().optional(),
});

export const PAYLOADS = {
  affinity_note: z.object({ organizationId: z.number().int().positive(), content: z.string().min(1).max(20_000) }),
  gmail_draft: draft,
  outlook_draft: draft,
} satisfies Record<OutboxChannel, z.ZodType>;

export type Payload<C extends OutboxChannel> = z.infer<(typeof PAYLOADS)[C]>;

export async function queue<C extends OutboxChannel>(
  db: Db,
  channel: C,
  payload: Payload<C>,
  opts: { summary: string; proposedBy: string; entityId?: string },
): Promise<string> {
  const parsed = PAYLOADS[channel].parse(payload) as Record<string, unknown>;
  return insertOutboxItem(db, { channel, payload: parsed, summary: opts.summary, proposedBy: opts.proposedBy, entityId: opts.entityId });
}

export type Executor = (payload: Record<string, unknown>) => Promise<{ id: string }>;

export const EXECUTORS: Record<OutboxChannel, Executor> = {
  affinity_note: (p) => affinityCreateNote(Number(p.organizationId), String(p.content)),
  gmail_draft: (p) => gmailCreateDraft(PAYLOADS.gmail_draft.parse(p)),
  outlook_draft: (p) => outlookCreateDraft(PAYLOADS.outlook_draft.parse(p)),
};

export const pending = (db: Db, status: OutboxStatus = "pending") => listOutbox(db, status);

/**
 * A person approves an item; then it runs once. The approval is saved first,
 * so a crash mid-call leaves an 'approved' item to inspect, never a silent send.
 */
export async function approve(
  db: Db,
  id: string,
  decidedBy: string,
  executors: Record<OutboxChannel, Executor> = EXECUTORS,
): Promise<OutboxItem & { outcome: { ok: boolean; detail: string } }> {
  const item = await decideOutboxItem(db, id, true, decidedBy);
  try {
    const payload = PAYLOADS[item.channel].parse(item.payload) as Record<string, unknown>;
    const result = await executors[item.channel](payload);
    await completeOutboxItem(db, id, { ok: true, result });
    return { ...item, status: "done", outcome: { ok: true, detail: `created ${item.channel.replace("_", " ")} ${result.id}` } };
  } catch (err) {
    const error = (err as Error).message;
    await completeOutboxItem(db, id, { ok: false, error });
    return { ...item, status: "failed", outcome: { ok: false, detail: error } };
  }
}

export async function reject(db: Db, id: string, decidedBy: string): Promise<OutboxItem> {
  return decideOutboxItem(db, id, false, decidedBy);
}
