import type { Db } from "../../lib/db.js";
import { sha256 } from "../../lib/text.js";
import { newToken, type DataRoomRef } from "../../ledger/platform.js";
import {
  acknowledgeLink, activities, docs, getDoc, getProspect, getRaise, insertActivity, insertDoc, insertLink, insertView, links, revokeLinks, setDocStatus, views,
} from "../../ledger/fundraising.js";
import { FUNDRAISING_LABELS } from "../../ledger/labels.js";
import { queue } from "../outbox/index.js";
import { marketingGate } from "../compliance/gate.js";
import { FundraisingInvalid, firmName, longDate, mailChannel, raiseOr404, text, today } from "./common.js";

/**
 * The data room. Documents are versioned; nothing is visible to an investor
 * until a second person approves it (for marketing material, that's the
 * Marketing Rule review). Each prospect gets its own private, expiring,
 * revocable link; it must acknowledge confidentiality before it sees the
 * documents, and every view and download is recorded, which is also the
 * best signal of how engaged a prospect is.
 */

export const DATA_ROOM_DAYS = 60;
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", txt: "text/plain", md: "text/markdown",
};

export async function uploadDoc(db: Db, raiseId: string, file: { name: string; bytes: Uint8Array }, input: Record<string, unknown>, by: string) {
  await raiseOr404(db, raiseId);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!TYPES[ext]) throw new FundraisingInvalid("Upload a PDF, PowerPoint, Word, Excel, CSV or text file.");
  if (!file.bytes.byteLength) throw new FundraisingInvalid("The file is empty.");
  if (file.bytes.byteLength > MAX_BYTES) throw new FundraisingInvalid("Files up to 25 MB.");
  const category = String(input.category ?? "other");
  if (!(category in FUNDRAISING_LABELS.docCategories)) throw new FundraisingInvalid("Pick what the document is.");
  const title = text(input.title) ?? file.name.replace(/\.[^.]+$/, "");
  // Legal documents aren't advertising; the deck, track record, DDQ and financials are reviewed as marketing.
  const marketing = input.marketing === undefined ? !["lpa", "subscription", "legal", "ppm"].includes(category) : input.marketing === true || input.marketing === "true";
  return insertDoc(db, { raiseId, title, category, fileName: file.name, mimeType: TYPES[ext]!, content: file.bytes, sha256: sha256(Buffer.from(file.bytes).toString("base64")), marketing }, by);
}

export async function approveDoc(db: Db, docId: string, by: string, checklist?: Record<string, unknown>) {
  const d = await getDoc(db, docId);
  if (!d) throw new FundraisingInvalid("No such document.");
  if (d.status !== "draft") throw new FundraisingInvalid(`This document is already ${FUNDRAISING_LABELS.docStatus[d.status]!.toLowerCase()}.`);
  if (d.uploaded_by === by) throw new FundraisingInvalid("Someone other than the person who uploaded it reviews a document before investors see it.");
  // Compliance: the Marketing Rule review of an advertisement (required of a registered adviser).
  try {
    await marketingGate(db, d, checklist, by);
  } catch (err) {
    throw new FundraisingInvalid((err as Error).message);
  }
  await setDocStatus(db, docId, "approved", by);
}

export async function archiveDoc(db: Db, docId: string, by: string) {
  if (!(await getDoc(db, docId))) throw new FundraisingInvalid("No such document.");
  await setDocStatus(db, docId, "archived", by);
}

export async function downloadDocInternal(db: Db, docId: string) {
  const d = await getDoc(db, docId);
  if (!d) throw new FundraisingInvalid("No such document.");
  return { fileName: d.file_name, mimeType: d.mime_type, content: d.content };
}

/** A private link for one prospect. Optionally drafts the email with it in the firm's mailbox. */
export async function shareDataRoom(db: Db, prospectId: string, input: { draftEmail?: unknown }, by: string, appUrl: string) {
  const p = await getProspect(db, prospectId);
  if (!p) throw new FundraisingInvalid("No such prospect.");
  if (p.stage === "declined") throw new FundraisingInvalid("This prospect declined; move it back to a live stage first.");
  const approved = (await docs(db, p.raise_id)).filter((d) => d.status === "approved");
  if (!approved.length) throw new FundraisingInvalid("No documents are approved for investors yet.");
  const token = newToken();
  const row = await insertLink(db, prospectId, sha256(token), DATA_ROOM_DAYS, by);
  const url = `${appUrl.replace(/\/$/, "")}/data-room/${token}`;
  await insertActivity(db, { prospectId, occurredOn: today(), kind: "data_room", summary: `Data room link created, valid until ${longDate(row.expires_at.slice(0, 10))}` }, by);
  let outboxId: string | null = null;
  const channel = await mailChannel(db);
  if (input.draftEmail !== false && channel && p.emails.length) {
    const r = (await getRaise(db, p.raise_id))!;
    const firm = await firmName(db);
    outboxId = await queue(db, channel, {
      to: p.emails,
      subject: `${r.name}: data room`,
      body: [`Dear ${p.contact_name ?? p.name},`, "", `Thank you for your interest in ${r.name}. The data room is at this private link, valid for ${DATA_ROOM_DAYS} days:`, "", url, "",
        "It's for you and your colleagues evaluating the fund; please don't forward it outside your organization.", "", "With thanks,", firm].join("\n"),
    }, { summary: `Data room link: ${p.name}`, proposedBy: by });
  }
  return { url, expiresAt: row.expires_at, outboxId };
}

export async function revokeDataRoom(db: Db, prospectId: string, by: string) {
  if (!(await getProspect(db, prospectId))) throw new FundraisingInvalid("No such prospect.");
  return { revoked: await revokeLinks(db, prospectId, by) };
}

/** Who opened what: per prospect, documents viewed and the last time. */
export async function engagement(db: Db, raiseId: string) {
  const v = await views(db, raiseId);
  const ls = await links(db, raiseId);
  const by = new Map<string, { views: number; downloads: number; docs: Set<string>; last: string | null }>();
  for (const x of v) {
    const e = by.get(x.prospect_id) ?? { views: 0, downloads: 0, docs: new Set<string>(), last: null };
    if (x.action === "view") e.views++; else e.downloads++;
    e.docs.add(x.doc_id);
    e.last = !e.last || x.viewed_at > e.last ? x.viewed_at : e.last;
    by.set(x.prospect_id, e);
  }
  return {
    byProspect: [...by.entries()].map(([prospectId, e]) => ({ prospectId, views: e.views, downloads: e.downloads, documents: e.docs.size, lastViewedAt: e.last })),
    links: ls,
    recent: v.slice(0, 50),
  };
}

// ---------------------------------------------------------------------------
// What the prospect sees (the server finds the firm from the token, then calls these on the firm's Db)
// ---------------------------------------------------------------------------

async function refOk(db: Db, ref: DataRoomRef) {
  const p = await getProspect(db, ref.prospectId);
  if (!p) throw new FundraisingInvalid("No such link: it may have expired.");
  const r = (await getRaise(db, p.raise_id))!;
  const acknowledged = (await links(db, r.id)).find((l) => l.id === ref.id)?.acknowledged_at ?? null;
  return { p, r, acknowledged };
}

/** The latest approved version of each document. */
async function visible(db: Db, raiseId: string) {
  const out = new Map<string, Awaited<ReturnType<typeof docs>>[number]>();
  for (const d of await docs(db, raiseId)) if (d.status === "approved" && !out.has(d.title)) out.set(d.title, d);
  return [...out.values()];
}

export async function dataRoomView(db: Db, ref: DataRoomRef) {
  const { p, r, acknowledged } = await refOk(db, ref);
  const firm = await firmName(db);
  const ds = acknowledged ? await visible(db, r.id) : [];
  return {
    firm, raise: r.name, investor: p.name, acknowledged: Boolean(acknowledged),
    notice: `These materials are confidential and provided only to evaluate an investment in ${r.name}. They are not an offer to sell or a solicitation of an offer to buy any security; an offer is made only through the fund's definitive documents.`,
    documents: ds.map((d) => ({ id: d.id, title: d.title, category: FUNDRAISING_LABELS.docCategories[d.category] ?? "Document", version: d.version, fileName: d.file_name, sizeBytes: d.size_bytes, updatedAt: d.approved_at })),
  };
}

export async function acknowledgeDataRoom(db: Db, ref: DataRoomRef) {
  const { p } = await refOk(db, ref);
  await acknowledgeLink(db, ref.id);
  if (!(await activities(db, { prospectId: p.id })).some((a) => a.kind === "data_room" && a.summary.startsWith("Opened"))) {
    await insertActivity(db, { prospectId: p.id, occurredOn: today(), kind: "data_room", summary: "Opened the data room and acknowledged confidentiality" }, "investor");
  }
}

export async function openDoc(db: Db, ref: DataRoomRef, docId: string, action: "view" | "download") {
  const { p, r, acknowledged } = await refOk(db, ref);
  if (!acknowledged) throw new FundraisingInvalid("Acknowledge the confidentiality notice first.");
  const d = (await visible(db, r.id)).find((x) => x.id === docId);
  if (!d) throw new FundraisingInvalid("No such document.");
  const full = (await getDoc(db, docId))!;
  await insertView(db, ref.id, docId, action);
  await insertActivity(db, { prospectId: p.id, occurredOn: today(), kind: "data_room", summary: `${action === "download" ? "Downloaded" : "Viewed"} ${d.title}` }, "investor");
  return { fileName: d.file_name, mimeType: d.mime_type, content: full.content };
}
