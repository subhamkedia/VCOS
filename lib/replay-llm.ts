import type Anthropic from "@anthropic-ai/sdk";
import type { Llm } from "./llm.js";

/**
 * A stand-in for Claude that replays scripted CLAIM lines and cites each
 * quote at its real offset in the document it's handed, the way the
 * Citations API does. For the offline demo and tests only.
 */
export function replayLlm(script: Record<string, [string, string][]>): Llm {
  return {
    async create(params) {
      const blocks = params.messages[0]!.content as Anthropic.ContentBlockParam[];
      const doc = (blocks[0] as Anthropic.DocumentBlockParam).source as { data: string };
      const key = Object.keys(script).find((k) => doc.data.includes(k));
      const lines = key ? script[key]! : [];
      const content = lines.length
        ? lines.flatMap(([header, quote]) => {
            const start = doc.data.indexOf(quote);
            return [
              { type: "text", text: header, citations: null },
              {
                type: "text",
                text: quote,
                citations: start < 0 ? null : [{ type: "char_location", cited_text: quote, document_index: 0, document_title: "doc", start_char_index: start, end_char_index: start + quote.length, file_id: null }],
              },
              { type: "text", text: "\n", citations: null },
            ];
          })
        : [{ type: "text", text: "NONE", citations: null }];
      return {
        id: "replay", type: "message", role: "assistant", model: "replay", stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }, content,
      } as unknown as Anthropic.Message;
    },
  };
}
