import Anthropic from "@anthropic-ai/sdk";
import { EMPTY_REPLY, MAX_MODEL_CALLS, type Model, type ModelRequest } from "../model";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export interface ClaudeModelOptions {
  /** Defaults to a client that reads credentials from the environment. */
  client?: Anthropic;
  /** Thinking depth. Chat and reminders are light work, so the default is `low`. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  model?: string;
}

const textOf = (content: Anthropic.Beta.BetaContentBlock[]): string =>
  content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

/** Claude through the official Anthropic SDK. */
export class ClaudeModel implements Model {
  private readonly client: Anthropic;
  private readonly effort: NonNullable<ClaudeModelOptions["effort"]>;
  private readonly model: string;

  constructor(options: ClaudeModelOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.effort = options.effort ?? "low";
  }

  async reply(request: ModelRequest): Promise<string> {
    const tools: Anthropic.Beta.BetaTool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema },
      strict: true,
    }));
    // Earlier turns are replayed as plain text; within this turn the model's
    // own content blocks (thinking included) go back unchanged.
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...request.history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: request.message },
    ];

    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16_000,
        system: request.system,
        tools,
        messages,
        output_config: { effort: this.effort },
        // If a safety classifier declines a request, retry it server-side on
        // Anthropic's recommended fallback model instead of failing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      if (response.stop_reason === "refusal") {
        return EMPTY_REPLY;
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason !== "tool_use") {
        return textOf(response.content) || EMPTY_REPLY;
      }

      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use"
      );
      const results = await Promise.all(
        calls.map(
          async (block): Promise<Anthropic.Beta.BetaToolResultBlockParam> => ({
            type: "tool_result",
            tool_use_id: block.id,
            content: await request.runTool(block.name, block.input),
          })
        )
      );
      messages.push({ role: "user", content: results });
    }
    return EMPTY_REPLY;
  }
}
