import { asString, request, requestJson } from "./http.js";
import { accessToken, googleConfigured } from "./oauth.js";
import { documentRecord, pdfToText } from "./documents.js";
import type { FetchLike, SourceRecord } from "./types.js";

/**
 * Google Drive, read-only (drive.readonly scope). Finds decks and data-room
 * files and turns them into confidential evidence. Google Docs and Slides
 * are exported as plain text; PDFs are downloaded and their text extracted.
 */
const DRIVE = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function auth(fetchImpl?: FetchLike) {
  return { Authorization: `Bearer ${await accessToken("google", fetchImpl)}` };
}

/** Escape a value for Drive's query language. */
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Files whose name or content mention `text`, newest first. Folders and trashed files excluded. */
export async function driveSearch(text: string, opts: { max?: number; fetchImpl?: FetchLike } = {}): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `(name contains ${q(text)} or fullText contains ${q(text)}) and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.min(opts.max ?? 20, 100)),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await requestJson<{ files?: Record<string, unknown>[] }>("drive", `${DRIVE}/files?${params}`, {
    headers: await auth(opts.fetchImpl), fetchImpl: opts.fetchImpl,
  });
  return (res.files ?? []).map((f) => ({
    id: String(f.id), name: String(f.name), mimeType: String(f.mimeType),
    modifiedTime: asString(f.modifiedTime), webViewLink: asString(f.webViewLink),
  }));
}

export async function driveFile(id: string, fetchImpl?: FetchLike): Promise<DriveFile> {
  const f = await requestJson<Record<string, unknown>>(
    "drive", `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`,
    { headers: await auth(fetchImpl), fetchImpl },
  );
  return { id: String(f.id), name: String(f.name), mimeType: String(f.mimeType), modifiedTime: asString(f.modifiedTime), webViewLink: asString(f.webViewLink) };
}

/** Text content of a Drive file. Throws for types we can't read yet (images, spreadsheets). */
export async function driveText(file: DriveFile, fetchImpl?: FetchLike): Promise<string> {
  const headers = await auth(fetchImpl);
  const exportAs = EXPORTABLE[file.mimeType];
  if (exportAs) {
    const res = await request("drive", `${DRIVE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`, { headers, fetchImpl });
    return (await res.text()).trim();
  }
  const res = await request("drive", `${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`, { headers, fetchImpl });
  if (file.mimeType === "application/pdf") return pdfToText(new Uint8Array(await res.arrayBuffer()));
  if (file.mimeType.startsWith("text/")) return (await res.text()).trim();
  throw new Error(`Can't read ${file.name} (${file.mimeType}). Supported: Google Docs, Google Slides, PDF, text.`);
}

export async function driveRecord(fileId: string, opts: { company: string; companyDomain?: string; fetchImpl?: FetchLike }): Promise<SourceRecord> {
  const file = await driveFile(fileId, opts.fetchImpl);
  return documentRecord({
    text: await driveText(file, opts.fetchImpl),
    fileName: file.name,
    source: "gdrive",
    uri: file.webViewLink ?? `gdrive:file:${file.id}`,
    company: opts.company,
    companyDomain: opts.companyDomain,
    date: file.modifiedTime,
    mimeType: file.mimeType,
    metadata: { driveFileId: file.id },
  });
}

export async function driveCheck(fetchImpl?: FetchLike): Promise<string> {
  const about = await requestJson<{ user?: { emailAddress?: string } }>("drive", `${DRIVE}/about?fields=user`, { headers: await auth(fetchImpl), fetchImpl });
  return `signed in as ${about.user?.emailAddress ?? "unknown"}`;
}

export const driveConfigured = googleConfigured;
