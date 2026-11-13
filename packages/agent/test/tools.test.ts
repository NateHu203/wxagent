import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { parseLocal } from "../src/time";
import { reminderTools, type Tool, type ToolContext } from "../src/tools";
import { NOW, TZ, USER } from "./helpers";

let store: Store;
let tools: Record<string, Tool>;
const context: ToolContext = { userId: USER, now: NOW, timezone: TZ };

beforeEach(() => {
  store = new Store(":memory:");
  tools = Object.fromEntries(reminderTools(store).map((tool) => [tool.name, tool]));
});

const create = (input: Record<string, unknown>) => tools.create_reminder?.run(input, context);

describe("create_reminder", () => {
  it("creates a one-off reminder at the user's local time", async () => {
    const result = await create({ content: "交作业", fire_at: "2026-11-13 15:00", cron: null });
    expect(result).toBe("已创建：#1 交作业 （明天 周五 15:00）");
    const [reminder] = store.activeReminders(USER);
    expect(reminder?.nextAt).toEqual(parseLocal("2026-11-13 15:00", TZ));
    expect(reminder?.cron).toBeUndefined();
  });

  it("creates a recurring reminder and reports its next run", async () => {
    const result = await create({ content: "吃药", fire_at: null, cron: "0 8 * * *" });
    expect(result).toContain("重复");
    expect(result).toContain("明天 周五 08:00");
    expect(store.activeReminders(USER)[0]?.cron).toBe("0 8 * * *");
  });

  it("rejects past times, bad formats, bad cron and ambiguous input", () => {
    expect(() => create({ content: "x", fire_at: "2026-11-12 20:00", cron: null })).toThrow(/过去/);
    expect(() => create({ content: "x", fire_at: "明天", cron: null })).toThrow(/有效/);
    expect(() => create({ content: "x", fire_at: null, cron: "nope" })).toThrow();
    expect(() => create({ content: "x", fire_at: null, cron: null })).toThrow(/恰好/);
    expect(() =>
      create({ content: "x", fire_at: "2026-11-13 15:00", cron: "0 8 * * *" })
    ).toThrow(/恰好/);
    expect(() => create({ content: " ", fire_at: "2026-11-13 15:00", cron: null })).toThrow();
    expect(store.activeReminders(USER)).toEqual([]);
  });
});

describe("list_reminders and cancel_reminders", () => {
  it("lists only this user's active reminders, soonest first", async () => {
    await create({ content: "later", fire_at: "2026-11-20 09:00", cron: null });
    await create({ content: "sooner", fire_at: "2026-11-13 09:00", cron: null });
    store.addReminder({ userId: "someone-else", content: "theirs", nextAt: new Date(NOW.getTime() + 1) });

    const listing = await tools.list_reminders?.run({}, context);
    expect(listing?.split("\n").map((line) => line.split(" ")[1])).toEqual(["sooner", "later"]);
    expect(await tools.list_reminders?.run({}, { ...context, userId: "nobody" })).toBe(
      "用户目前没有提醒。"
    );
  });

  it("cancels the user's own reminders and reports the rest as missing", async () => {
    await create({ content: "交作业", fire_at: "2026-11-13 15:00", cron: null });
    const theirs = store.addReminder({
      userId: "someone-else",
      content: "theirs",
      nextAt: new Date(NOW.getTime() + 1),
    });

    const result = await tools.cancel_reminders?.run({ ids: [1, theirs.id, 99] }, context);

    expect(result).toBe(`#1 交作业 已取消\n#${theirs.id} 没找到\n#99 没找到`);
    expect(store.getReminder(1)?.status).toBe("cancelled");
    expect(store.getReminder(theirs.id)?.status).toBe("active");
  });
});
