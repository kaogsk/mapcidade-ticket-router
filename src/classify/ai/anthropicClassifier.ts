/**
 * anthropicClassifier.ts — optional adapter for the Anthropic Messages API.
 *
 * Off unless AI_PROVIDER=anthropic AND ANTHROPIC_API_KEY is set; the SDK is
 * imported lazily so the default (fake) path never loads it. Structured output
 * through a strict tool (schema-valid input guaranteed) and the fixed rules in a
 * cached system block; the per-ticket text goes in the user message.
 */

import type { AiCallResult, AiClassifier, AiInput } from "./types.js";
import { CLASSIFIER_RULES, CLASSIFY_TOOL, validateOutput } from "./types.js";

// The tool call carries ~80–200 tokens. A low ceiling cut every answer at
// max_tokens and lost the reasoning field in the original system.
const MAX_TOKENS = 512;

export async function createAnthropicClassifier(opts: { apiKey: string; model: string; timeoutMs: number }): Promise<AiClassifier> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs });

  return {
    name: "anthropic",
    model: opts.model,
    async classify(input: AiInput): Promise<AiCallResult> {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: CLASSIFIER_RULES, cache_control: { type: "ephemeral" } }],
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
        messages: [
          {
            role: "user",
            content: `Classify this ticket.\n\nSubject: "${input.subject}"\nDescription: "${input.description}"${input.city ? `\nCity: ${input.city}` : ""}`,
          },
        ],
      });
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      const block = response.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") return { output: null, usage };
      return { output: validateOutput(block.input), usage };
    },
  };
}
