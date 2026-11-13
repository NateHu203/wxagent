import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_REPLY, type ModelRequest } from "../src/model";
import { ClaudeModel } from "../src/models/anthropic";
import { OpenAICompatibleModel } from "../src/models/openai-compatible";

const TOOL = {
  name: "create_reminder",
  description: "创建提醒",
  inputSchema: {
    type: "object" as const,
    properties: { content: { type: "string" } },
    required: ["content"],
    additionalProperties: false as const,
  },
};

const requestWith = (runTool: ModelRequest["runTool"]): ModelRequest => ({
  system: "你是助理",
  history: [
    { role: "user", text: "你好" },
    { role: "assistant", text: "你好呀" },
  ],
  message: "提醒我交作业",
  tools: [TOOL],
  runTool,
});

/** A fetch that answers each call with the next body and records the requests. */
const scripted = (bodies: unknown[]) => {
  const requests: { body: Record<string, unknown>; headers: Headers; url: string }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    });
    return Response.json(bodies[requests.length - 1]);
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, requests };
};

const claudeMessage = (content: unknown[], stop_reason: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

describe("ClaudeModel", () => {
  const modelWith = (fetchMock: typeof fetch) =>
    new ClaudeModel({ client: new Anthropic({ apiKey: "test", fetch: fetchMock, maxRetries: 0 }) });

  it("runs the tool loop and returns the model's blocks to it unchanged", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const toolUse = { type: "tool_use", id: "toolu_1", name: "create_reminder", input: { content: "交作业" } };
    const { fetchMock, requests } = scripted([
      claudeMessage([thinking, toolUse], "tool_use"),
      claudeMessage([{ type: "text", text: "好的，已设置。" }], "end_turn"),
    ]);
    const runTool = vi.fn(async () => "已创建：#1 交作业");

    const reply = await modelWith(fetchMock).reply(requestWith(runTool));

    expect(reply).toBe("好的，已设置。");
    expect(runTool).toHaveBeenCalledWith("create_reminder", { content: "交作业" });
    const [first, second] = requests.map((r) => r.body);
    expect(first).toMatchObject({
      model: "claude-opus-5-5",
      system: "你是助理",
      output_config: { effort: "low" },
      fallbacks: "default",
      tools: [{ name: "create_reminder", strict: true, input_schema: TOOL.inputSchema }],
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好呀" },
        { role: "user", content: "提醒我交作业" },
      ],
    });
    expect(requests[0]?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const messages = second?.messages as { content: unknown; role: string }[];
    expect(messages[3]).toEqual({ role: "assistant", content: [thinking, toolUse] });
    expect(messages[4]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "已创建：#1 交作业" }],
    });
  });

  it("turns a refusal or an empty answer into a polite fallback", async () => {
    const refused = scripted([claudeMessage([], "refusal")]);
    expect(await modelWith(refused.fetchMock).reply(requestWith(vi.fn()))).toBe(EMPTY_REPLY);
    const empty = scripted([claudeMessage([], "end_turn")]);
    expect(await modelWith(empty.fetchMock).reply(requestWith(vi.fn()))).toBe(EMPTY_REPLY);
  });

  it("stops a tool loop that never ends", async () => {
    const toolUse = { type: "tool_use", id: "toolu_1", name: "create_reminder", input: { content: "x" } };
    const { fetchMock, requests } = scripted(
      Array.from({ length: 20 }, () => claudeMessage([toolUse], "tool_use"))
    );
    expect(await modelWith(fetchMock).reply(requestWith(async () => "ok"))).toBe(EMPTY_REPLY);
    expect(requests).toHaveLength(10);
  });
});

describe("OpenAICompatibleModel", () => {
  const model = new OpenAICompatibleModel({
    baseUrl: "https://llm.test/v1/",
    apiKey: "sk-test",
    model: "deepseek-chat",
  });
  const completion = (message: unknown) => ({ choices: [{ message }] });

  it("runs the function-calling loop", async () => {
    const toolCall = {
      id: "call_1",
      type: "function",
      function: { name: "create_reminder", arguments: '{"content":"交作业"}' },
    };
    const { fetchMock, requests } = scripted([
      completion({ role: "assistant", content: null, tool_calls: [toolCall] }),
      completion({ role: "assistant", content: " 好的，已设置。 " }),
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const runTool = vi.fn(async () => "已创建：#1 交作业");

    const reply = await model.reply(requestWith(runTool));

    expect(reply).toBe("好的，已设置。");
    expect(runTool).toHaveBeenCalledWith("create_reminder", { content: "交作业" });
    expect(requests[0]?.url).toBe("https://llm.test/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(requests[0]?.body).toMatchObject({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是助理" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好呀" },
        { role: "user", content: "提醒我交作业" },
      ],
      tools: [{ type: "function", function: { name: "create_reminder", parameters: TOOL.inputSchema } }],
    });
    const messages = requests[1]?.body.messages as Record<string, unknown>[];
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "已创建：#1 交作业",
    });
  });

  it("tells the model when its tool arguments are not JSON, and surfaces HTTP errors", async () => {
    const bad = { id: "c", type: "function", function: { name: "create_reminder", arguments: "{oops" } };
    const { fetchMock, requests } = scripted([
      completion({ role: "assistant", content: null, tool_calls: [bad] }),
      completion({ role: "assistant", content: "抱歉" }),
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const runTool = vi.fn();
    await model.reply(requestWith(runTool));
    expect(runTool).not.toHaveBeenCalled();
    expect((requests[1]?.body.messages as { content: string }[]).at(-1)?.content).toMatch(/JSON/);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(model.reply(requestWith(vi.fn()))).rejects.toThrow(/HTTP 401/);
  });
});
