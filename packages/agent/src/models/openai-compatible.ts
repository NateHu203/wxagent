import { EMPTY_REPLY, MAX_MODEL_CALLS, type Model, type ModelRequest } from "../model";

export interface OpenAICompatibleOptions {
  apiKey?: string;
  /** e.g. `https://api.deepseek.com/v1` or `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  /** Per-request timeout. Default 120 s. */
  timeoutMs?: number;
}

interface ToolCall {
  function: { arguments: string; name: string };
  id: string;
}

interface WireMessage {
  content: string | null;
  role: "system" | "user" | "assistant" | "tool";
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ChatCompletion {
  choices?: { message?: WireMessage }[];
}

const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return;
  }
};

/**
 * Any service that speaks the OpenAI Chat Completions API with function
 * calling: DeepSeek, Qwen, Moonshot, a local Ollama, and so on.
 */
export class OpenAICompatibleModel implements Model {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async reply(request: ModelRequest): Promise<string> {
    const messages: WireMessage[] = [
      { role: "system", content: request.system },
      ...request.history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: request.message },
    ];
    const tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));

    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const message = await this.complete(messages, tools);
      if (!message?.tool_calls?.length) {
        return message?.content?.trim() || EMPTY_REPLY;
      }
      messages.push(message);
      for (const toolCall of message.tool_calls) {
        const input = parseArguments(toolCall.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content:
            input === undefined
              ? "错误：工具参数不是合法的 JSON。"
              : await request.runTool(toolCall.function.name, input),
        });
      }
    }
    return EMPTY_REPLY;
  }

  private async complete(messages: WireMessage[], tools: unknown[]): Promise<WireMessage | undefined> {
    const { apiKey, baseUrl, model, timeoutMs = 120_000 } = this.options;
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Model request failed: HTTP ${response.status} from ${baseUrl}`);
    }
    return ((await response.json()) as ChatCompletion).choices?.[0]?.message;
  }
}
