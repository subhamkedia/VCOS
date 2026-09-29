import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceRecord } from "./types.js";

/**
 * Transcript files exported from Granola, Zoom, Teams, Meet or Otter
 * (.txt, .md or .vtt). Synced meeting tools live in their own connectors
 * (zoom.ts, teams.ts, google-meet.ts, granola.ts, fireflies.ts) and go
 * through modules/meetings, which matches each meeting to a company.
 *
 * Transcripts are confidential by default and marked as the founder's own
 * words (self-reported) by the extractor, line by line.
 */

/** Strip WebVTT cue numbers and timestamps, keep "Speaker: text" lines. */
export function vttToText(vtt: string): string {
  return vtt
    .replace(/^WEBVTT.*$/m, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^NOTE\b/.test(l))
    .map((l) => l.replace(/<v\s+([^>]+)>/g, "$1: ").replace(/<\/v>/g, "").trim())
    .join("\n");
}

export async function transcriptFromFile(
  file: string,
  opts: { company: string; date?: string; title?: string; companyDomain?: string },
): Promise<SourceRecord> {
  return transcriptRecord(path.basename(file), await readFile(file, "utf8"), opts);
}

/** A transcript from text already in memory (an upload). `.vtt` files are cleaned to speaker lines. */
export function transcriptRecord(
  fileName: string,
  raw: string,
  opts: { company: string; date?: string; title?: string; companyDomain?: string },
): SourceRecord {
  const file = fileName;
  const text = file.toLowerCase().endsWith(".vtt") ? vttToText(raw) : raw.trim();
  if (text.length < 20) throw new Error(`${fileName} has almost no text.`);
  return {
    evidence: {
      kind: "transcript",
      source: "transcript-file",
      uri: `file:${path.basename(file)}`,
      title: opts.title ?? path.basename(file),
      content: text,
      occurredAt: opts.date,
      accessScope: "confidential",
    },
    subject: { type: "company", name: opts.company, domain: opts.companyDomain, source: "transcript-file" },
    extract: true,
  };
}
