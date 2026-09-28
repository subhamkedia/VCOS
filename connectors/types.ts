import type { EvidenceInput } from "../ledger/repository.js";
import type { SourceType } from "../ledger/contradictions.js";
import type { Candidate } from "../agents/resolver/resolve.js";

/** A claim a connector can read straight off structured data, no model needed. */
export interface StructuredClaim {
  predicate: string;
  value: unknown;
  asOf?: string;
  confidence?: number;
  /** Exact text in the evidence that states it, when there is one. */
  citedText?: string;
}

/**
 * What every connector produces. The ingest pipeline resolves the subject,
 * stores the evidence, writes structured claims, and optionally runs the
 * extractor over unstructured text. Connectors never touch the database.
 */
export interface SourceRecord {
  evidence: EvidenceInput;
  subject?: Candidate;
  claims?: StructuredClaim[];
  /** Who is asserting the structured claims. */
  sourceType?: SourceType;
  /** Run the LLM extractor over the evidence text. */
  extract?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
