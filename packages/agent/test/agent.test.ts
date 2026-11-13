import { beforeEach, describe, expect, it } from "vitest";
import { Agent, splitMessage } from "../src/agent";
import { Store } from "../src/store";
import { reminderTools } from "../src/tools";
import { FakeMessenger, FakeModel, inbound, NOW, quiet, TZ, USER } from "./helpers";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

const agentFor = (bot: FakeMessenger, model: FakeModel, extra: { allow?: string[] } = {}) =>
  new Agent({
    bot,
    model,
    store,
    logger: quiet,
    timezone: TZ,
    now: () => NOW,
    tools: reminderTools(store),
    ...extra,
  });

describe("Agent", () => {
  it("answers a message with the model's reply and remembers the exchange", async () => {
    const bot = new FakeMessenger([inbound("你好"), inbound("我刚才说了什么？")]);
    const model = new FakeModel((request) => `回复：${request.message.split("\n")[1]}`);

    await agentFor(bot, model).run();

    expect(bot.sent.map((m) => m.text)).toEqual(["回复：你好", "回复：我刚才说了什么？"]);
    expect(bot.sent[0]?.userId).toBe(USER);
    expect(model.requests[0]?.message).toBe("[当前时间 2026-11-12 21:00 星期四，时区 Asia/Shanghai]\n你好");
    expect(model.requests[0]?.history).toEqual([]);
    // The second turn sees the first, without the time prefix.
    expect(model.requests[1]?.history).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "回复：你好" },
    ]);
    expect(bot.typing).toEqual([true, false, true, false]);
  });

  it("lets the model create a reminder through a tool", async () => {
    const bot = new FakeMessenger([inbound("明天下午3点提醒我交作业")]);
    const model = new FakeModel(async (request) => {
      expect(request.tools.map((tool) => tool.name)).toEqual([
        "create_reminder",
        "list_reminders",
        "cancel_reminders",
      ]);
      const result = await request.runTool("create_reminder", {
        content: "交作业",
        fire_at: "2026-11-13 15:00",
        cron: null,
      });
      return `好的。${result}`;
    });

    await agentFor(bot, model).run();

    expect(store.activeReminders(USER).map((r) => r.content)).toEqual(["交作业"]);
    expect(bot.sent[0]?.text).toContain("明天 周五 15:00");
  });

  it("reports tool failures to the model as text instead of throwing", async () => {
    const bot = new FakeMessenger([inbound("x")]);
    const results: string[] = [];
    const model = new FakeModel(async (request) => {
      results.push(await request.runTool("create_reminder", { content: "x", fire_at: null, cron: null }));
      results.push(await request.runTool("no_such_tool", {}));
      results.push(await request.runTool("list_reminders", "not an object"));
      return "ok";
    });
    await agentFor(bot, model).run();
    expect(results[0]).toMatch(/^错误：.*恰好/);
    expect(results[1]).toMatch(/^错误：没有名为 no_such_tool/);
    expect(results[2]).toMatch(/^错误：工具参数/);
  });

  it("tells the user when the model call fails, and does not record the turn", async () => {
    const bot = new FakeMessenger([inbound("你好")]);
    const model = new FakeModel(() => {
      throw new Error("401 invalid x-api-key");
    });
    await agentFor(bot, model).run();
    expect(bot.sent.map((m) => m.text)).toEqual(["出错了，稍后再试一次。"]);
    expect(store.history(USER, 10)).toEqual([]);
    expect(bot.typing.at(-1)).toBe(false);
  });

  it("delivers queued reminders first when the user writes again", async () => {
    store.addToOutbox(USER, "⏰ 交作业");
    const bot = new FakeMessenger([inbound("在吗")]);
    await agentFor(bot, new FakeModel(() => "在的")).run();
    expect(bot.sent[0]?.text).toMatch(/^⏰ 交作业\n（.*没能送达，现在补发）$/);
    expect(bot.sent[1]?.text).toBe("在的");
    expect(store.outbox(USER)).toEqual([]);
  });

  it("handles a replayed message only once", async () => {
    const bot = new FakeMessenger([inbound("你好", { id: "dup" }), inbound("你好", { id: "dup" })]);
    const model = new FakeModel(() => "hi");
    await agentFor(bot, model).run();
    expect(model.requests).toHaveLength(1);
  });

  it("ignores users outside the allow list", async () => {
    const bot = new FakeMessenger([inbound("hi", { from: "stranger" }), inbound("hi")]);
    const model = new FakeModel(() => "hello");
    await agentFor(bot, model, { allow: [USER] }).run();
    expect(bot.sent).toEqual([{ userId: USER, text: "hello" }]);
  });

  it("keeps each user's history separate", async () => {
    const bot = new FakeMessenger([inbound("我是A"), inbound("我是B", { from: "other" })]);
    const model = new FakeModel(() => "ok");
    await agentFor(bot, model).run();
    expect(store.history(USER, 10).map((t) => t.text)).toEqual(["我是A", "ok"]);
    expect(store.history("other", 10).map((t) => t.text)).toEqual(["我是B", "ok"]);
  });
});

describe("splitMessage", () => {
  it("leaves short text alone and splits long text at line breaks", () => {
    expect(splitMessage("短消息")).toEqual(["短消息"]);
    const long = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    expect(splitMessage(long, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitMessage("c".repeat(250), 100).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });
});
