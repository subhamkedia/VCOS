import Anthropic from "@anthropic-ai/sdk";
import { config, requireKey } from "./config.js";

/**
 * The narrow slice of the Claude API the agents use. Agents depend on this
 * interface, not the SDK, so tests can pass a fake.
 */
export interface Llm {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export function claude(): Llm {
  const client = new Anthropic({ apiKey: requireKey("anthropicApiKey") });
  return { create: (params) => client.messages.create(params) };
}

export function hasClaude(): boolean {
  return Boolean(config.anthropicApiKey);
}

/** Concatenate the text blocks of a response. */
export function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Pull the first JSON object out of a model reply. */
export function parseJsonObject<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
