import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../../lib/db.js";
import type { Llm } from "../../lib/llm.js";
import { config } from "../../lib/config.js";
import { getEntity, getEvidence, insertClaim, detectContradictions, audit, type ClaimInput } from "../../ledger/repository.js";
import { PREDICATES } from "../../ledger/predicates.js";
import type { SourceType } from "../../ledger/contradictions.js";
import { EXTRACTABLE, EXTRACTOR_VERSION, systemPrompt, userPrompt } from "./prompt.js";

export { EXTRACTOR_VERSION } from "./prompt.js";

/** Documents longer than this are split on paragraph boundaries, one call per chunk. */
export const CHUNK_CHARS = 60_000;

export interface ProposedClaim {
  predicate: string;
  rawValue: string;
  asOf?: string;
  sourceType: SourceType;
  statement: string;
  spanStart?: number;
  spanEnd?: number;
  citedText?: string;
  /** The model that answered, from the API response. Recorded in `extracted_by`. */
  model?: string;
}

export interface Rejection {
  line: string;
  reason: string;
}

export interface ExtractionResult {
  claimIds: string[];
  proposed: ProposedClaim[];
  rejected: Rejection[];
  contradictions: { id: string; severity: string; detail: string }[];
}

const ALLOWED_SOURCE_TYPES: SourceType[] = ["self_reported", "third_party", "primary"];
const EXTRACTABLE_IDS = new Set(EXTRACTABLE.map((p) => p.id));

/** Split text into chunks on paragraph boundaries, keeping each chunk's offset. */
export function chunk(text: string, size = CHUNK_CHARS): { offset: number; text: string }[] {
  if (text.length <= size) return [{ offset: 0, text }];
  const out: { offset: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      if (para > start + size / 2) end = para;
      else if (line > start + size / 2) end = line;
    }
    out.push({ offset: start, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

/**
 * Turn a Citations-API response into proposed claims. Text blocks are
 * joined into lines; each CLAIM line takes the char_location citations of
 * the blocks that overlap it. Offsets are shifted by the chunk offset so
 * they index into the full evidence content.
 */
export function parseCitedResponse(msg: Anthropic.Message, chunkOffset: number): { proposed: ProposedClaim[]; rejected: Rejection[] } {
  let text = "";
  const spans: { from: number; to: number; citations: Anthropic.TextCitation[] }[] = [];
  for (const block of msg.content) {
    if (block.type !== "text") continue;
    const from = text.length;
    text += block.text;
    if (block.citations?.length) spans.push({ from, to: text.length, citations: block.citations });
  }

  const proposed: ProposedClaim[] = [];
  const rejected: Rejection[] = [];
  let pos = 0;
  for (const rawLine of text.split("\n")) {
    const lineStart = pos;
    const lineEnd = pos + rawLine.length;
    pos = lineEnd + 1;
    const line = rawLine.trim();
    if (!line || line === "NONE") continue;
    if (!line.startsWith("CLAIM")) {
      rejected.push({ line, reason: "not a CLAIM line" });
      continue;
    }
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 6) {
      rejected.push({ line, reason: "expected 6 fields" });
      continue;
    }
    const [, predicate = "", rawValue = "", asOf = "", sourceType = "", ...rest] = parts;
    const statement = rest.join(" | ");

    if (!EXTRACTABLE_IDS.has(predicate)) {
      rejected.push({ line, reason: `unknown or non-extractable predicate "${predicate}"` });
      continue;
    }
    if (!ALLOWED_SOURCE_TYPES.includes(sourceType as SourceType)) {
      rejected.push({ line, reason: `bad source_type "${sourceType}"` });
      continue;
    }
    if (asOf && !/^\d{4}-\d{2}(-\d{2})?$/.test(asOf)) {
      rejected.push({ line, reason: `bad as_of "${asOf}"` });
      continue;
    }

    const cite = spans
      .filter((s) => s.from < lineEnd && s.to > lineStart)
      .flatMap((s) => s.citations)
      .find((c): c is Anthropic.CitationCharLocation => c.type === "char_location");
    if (!cite) {
      rejected.push({ line, reason: "no citation: every claim must point at the source text" });
      continue;
    }

    proposed.push({
      predicate,
      rawValue,
      asOf: asOf ? (asOf.length === 7 ? `${asOf}-01` : asOf) : undefined,
      sourceType: sourceType as SourceType,
      statement,
      spanStart: chunkOffset + cite.start_char_index,
      spanEnd: chunkOffset + cite.end_char_index,
      citedText: cite.cited_text,
    });
  }
  return { proposed, rejected };
}

/** "Turner => paid_pilot" -> { customer, rung }; everything else passes through. */
export function toClaimValue(predicate: string, raw: string): unknown {
  if (predicate === "pilot.status") {
    const [customer, rung] = raw.split("=>").map((s) => s.trim());
    return { customer, rung };
  }
  return raw;
}

/**
 * Re-anchor a citation if the API's offsets and our stored text disagree
 * (for example after whitespace normalization). Returns null if the quote
 * isn't in the evidence at all: then the claim is rejected.
 */
export function anchor(content: string, p: ProposedClaim): { start: number; end: number; text: string } | null {
  if (p.spanStart === undefined || p.spanEnd === undefined || !p.citedText) return null;
  const at = content.slice(p.spanStart, p.spanEnd);
  if (at.trim() === p.citedText.trim()) {
    const lead = at.length - at.trimStart().length;
    const trail = at.length - at.trimEnd().length;
    return { start: p.spanStart + lead, end: p.spanEnd - trail, text: at.trim() };
  }
  const quote = p.citedText.trim();
  const idx = content.indexOf(quote);
  return idx >= 0 ? { start: idx, end: idx + quote.length, text: quote } : null;
}

/**
 * Extract claims about `subjectId` from one piece of evidence and write
 * them to the ledger. Every claim carries the exact span it came from.
 * Invalid lines are returned in `rejected`, never written.
 */
export async function extractClaims(db: Db, llm: Llm, evidenceId: string, subjectId: string): Promise<ExtractionResult> {
  const evidence = await getEvidence(db, evidenceId);
  if (!evidence) throw new Error(`No evidence ${evidenceId}`);
  const subject = await getEntity(db, subjectId);
  if (!subject) throw new Error(`No entity ${subjectId}`);

  const date = evidence.occurred_at ? new Date(evidence.occurred_at).toISOString().slice(0, 10) : null;
  const proposed: ProposedClaim[] = [];
  const rejected: Rejection[] = [];

  for (const part of chunk(evidence.content)) {
    const msg = await llm.create({
      model: config.extractionModel,
      max_tokens: 4096,
      system: systemPrompt(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: part.text },
              title: evidence.title ?? `${evidence.kind} from ${evidence.source}`,
              citations: { enabled: true },
            },
            { type: "text", text: userPrompt(subject.name, { kind: evidence.kind, title: evidence.title, date }) },
          ],
        },
      ],
    });
    const parsed = parseCitedResponse(msg, part.offset);
    proposed.push(...parsed.proposed.map((p) => ({ ...p, model: msg.model || config.extractionModel })));
    rejected.push(...parsed.rejected);
  }

  const claimIds: string[] = [];
  for (const p of proposed) {
    const span = anchor(evidence.content, p);
    if (!span) {
      rejected.push({ line: `${p.predicate} | ${p.rawValue}`, reason: "cited text not found in evidence" });
      continue;
    }
    const input: ClaimInput = {
      subjectId: subject.id,
      predicate: p.predicate,
      value: toClaimValue(p.predicate, p.rawValue),
      unit: PREDICATES.get(p.predicate)?.unit,
      asOf: p.asOf ?? date ?? undefined,
      evidenceId: evidence.id,
      spanStart: span.start,
      spanEnd: span.end,
      citedText: span.text,
      sourceType: p.sourceType,
      extractedBy: `${EXTRACTOR_VERSION}/${p.model ?? config.extractionModel}`,
    };
    try {
      claimIds.push(await insertClaim(db, input));
    } catch (err) {
      rejected.push({ line: `${p.predicate} | ${p.rawValue}`, reason: (err as Error).message });
    }
  }

  await audit(db, EXTRACTOR_VERSION, "extract.run", evidence.id, {
    subject: subject.id, written: claimIds.length, rejected: rejected.length,
  });
  const contradictions = await detectContradictions(db, subject.id);
  return { claimIds, proposed, rejected, contradictions };
}
