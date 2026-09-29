import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config, requireKey } from "../lib/config.js";
import type { SourceRecord } from "./types.js";

/**
 * Meeting transcripts. Two routes:
 *
 * 1. Files: transcripts exported from Granola, Zoom, Teams or Meet
 *    (.txt, .md or .vtt). Works today with no credentials.
 * 2. Granola's hosted MCP server (mcp.granola.ai/mcp, OAuth). This client
 *    passes a bearer token from GRANOLA_TOKEN. Granola documents tools such
 *    as `get_meeting_transcript` and `get_meetings`; `listGranolaTools()`
 *    prints the live list so you can confirm names and arguments.
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

async function granolaClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(config.granolaMcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${requireKey("granolaToken")}` } },
  });
  const client = new Client({ name: "vc-os", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function listGranolaTools(): Promise<{ name: string; description?: string }[]> {
  const client = await granolaClient();
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  } finally {
    await client.close();
  }
}

export async function granolaTranscript(
  meetingId: string,
  opts: { company: string; date?: string; title?: string; companyDomain?: string; tool?: string; argName?: string },
): Promise<SourceRecord> {
  const client = await granolaClient();
  try {
    const res = await client.callTool({
      name: opts.tool ?? "get_meeting_transcript",
      arguments: { [opts.argName ?? "meeting_id"]: meetingId },
    });
    const blocks = (res.content ?? []) as { type: string; text?: string }[];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    if (!text) throw new Error(`Granola returned no transcript text for ${meetingId}`);
    return {
      evidence: {
        kind: "transcript",
        source: "granola",
        uri: `granola:meeting:${meetingId}`,
        title: opts.title ?? `Granola meeting ${meetingId}`,
        content: text,
        occurredAt: opts.date,
        accessScope: "confidential",
      },
      subject: { type: "company", name: opts.company, domain: opts.companyDomain, source: "granola" },
      extract: true,
    };
  } finally {
    await client.close();
  }
}
