import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceKind } from "../ledger/repository.js";
import type { SourceRecord } from "./types.js";

/**
 * Decks and data-room documents. Two routes in:
 *
 * - Files you have: a PDF, text or Markdown file (`pnpm ingest document`).
 * - DocSend: DocSend has no API for viewers of a shared link, so download
 *   the deck (or print it to PDF) and ingest the file with `--url` set to
 *   the DocSend link. The link is kept as the source.
 * - Google Drive: see gdrive.ts, which uses the same text extraction.
 *
 * Documents from founders are confidential by default. A deck's claims are
 * self-reported: the extractor labels them per line.
 */

export async function pdfToText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p.replace(/[ \t]+/g, " ").trim());
  return pages.map((p, i) => `[page ${i + 1}]\n${p}`).join("\n\n").trim();
}

export function isDocSendUrl(url: string | undefined): boolean {
  return Boolean(url && /(^|\.)docsend\.com\//i.test(url.replace(/^https?:\/\//, "")));
}

export function documentKind(fileName: string, mimeType?: string): EvidenceKind {
  const n = fileName.toLowerCase();
  if (/deck|pitch|presentation/.test(n) || mimeType === "application/vnd.google-apps.presentation") return "deck";
  if (n.endsWith(".pdf") && /investor|seed|series|fundrais/.test(n)) return "deck";
  return "document";
}

export function documentRecord(input: {
  text: string;
  fileName: string;
  source: string;
  uri: string;
  company: string;
  companyDomain?: string;
  date?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}): SourceRecord {
  if (input.text.replace(/\[page \d+\]/g, "").trim().length < 40) {
    throw new Error(`${input.fileName} has almost no extractable text (is it a scanned image? OCR is not built yet)`);
  }
  return {
    evidence: {
      kind: documentKind(input.fileName, input.mimeType),
      source: input.source,
      uri: input.uri,
      title: input.fileName,
      content: input.text,
      mimeType: "text/plain",
      occurredAt: input.date,
      accessScope: "confidential",
      metadata: { fileName: input.fileName, originalMimeType: input.mimeType, ...input.metadata },
    },
    subject: { type: "company", name: input.company, domain: input.companyDomain, source: input.source },
    extract: true,
  };
}

/** A PDF, .txt or .md file already in memory (an upload). */
export async function documentFromBytes(
  fileName: string,
  bytes: Uint8Array,
  opts: { company: string; companyDomain?: string; date?: string; url?: string },
): Promise<SourceRecord> {
  const lower = fileName.toLowerCase();
  let text: string;
  if (lower.endsWith(".pdf")) text = await pdfToText(bytes);
  else if (/\.(txt|md|markdown)$/.test(lower)) text = new TextDecoder().decode(bytes).trim();
  else throw new Error(`Unsupported file type: ${fileName}. Use PDF, .txt or .md (export slides to PDF first).`);
  const docsend = isDocSendUrl(opts.url);
  return documentRecord({
    text, fileName, source: docsend ? "docsend" : "document", uri: opts.url ?? `upload:${fileName}`,
    company: opts.company, companyDomain: opts.companyDomain, date: opts.date,
    mimeType: lower.endsWith(".pdf") ? "application/pdf" : "text/plain",
  });
}

/** Ingest a local PDF, .txt or .md file. `url` records where it came from (a DocSend link, a data room). */
export async function documentFromFile(
  file: string,
  opts: { company: string; companyDomain?: string; date?: string; url?: string },
): Promise<SourceRecord> {
  const name = path.basename(file);
  const lower = name.toLowerCase();
  let text: string;
  if (lower.endsWith(".pdf")) text = await pdfToText(new Uint8Array(await readFile(file)));
  else if (/\.(txt|md|markdown)$/.test(lower)) text = (await readFile(file, "utf8")).trim();
  else throw new Error(`Unsupported file type: ${name}. Use PDF, .txt or .md (export slides to PDF first).`);
  const docsend = isDocSendUrl(opts.url);
  return documentRecord({
    text, fileName: name, source: docsend ? "docsend" : "document", uri: opts.url ?? `file:${name}`,
    company: opts.company, companyDomain: opts.companyDomain, date: opts.date,
    mimeType: lower.endsWith(".pdf") ? "application/pdf" : "text/plain",
  });
}
