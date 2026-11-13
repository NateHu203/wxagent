import type { ToolInputSchema } from "./model";
import type { Reminder, Store } from "./store";
import { formatFriendly, nextCronRun, parseLocal } from "./time";

export interface ToolContext {
  now: Date;
  /** IANA timezone the user's times are in. */
  timezone: string;
  /** The WeChat user this turn belongs to. */
  userId: string;
}

/**
 * Something the model can do. `run` returns text for the model to read (not
 * the user); throw to report a failure to the model.
 */
export interface Tool {
  description: string;
  inputSchema: ToolInputSchema;
  name: string;
  run(input: Record<string, unknown>, context: ToolContext): string | Promise<string>;
}

/** Identity helper that types a tool definition. */
export const defineTool = (tool: Tool): Tool => tool;

const describeReminder = (reminder: Reminder, context: ToolContext): string => {
  const when = formatFriendly(reminder.nextAt, context.now, context.timezone);
  const repeat = reminder.cron ? `（重复，cron: ${reminder.cron}；下次 ${when}）` : `（${when}）`;
  return `#${reminder.id} ${reminder.content} ${repeat}`;
};

const createReminder = (store: Store) =>
  defineTool({
    name: "create_reminder",
    description:
      "创建一个提醒，到点后会把 content 推送给用户。一次性提醒填 fire_at，重复提醒填 cron，二者恰好填一个，另一个为 null。用户没说清时间时不要调用，先追问。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "到点时推送的一句话，简短，如「交作业」" },
        fire_at: {
          type: ["string", "null"],
          description: '一次性提醒的时间，用户本地时间，格式 "YYYY-MM-DD HH:MM"',
        },
        cron: {
          type: ["string", "null"],
          description:
            "重复提醒的标准 5 段 crontab（分 时 日 月 周，周日=0），按用户本地时间。如每天 8 点：0 8 * * *",
        },
      },
      required: ["content", "fire_at", "cron"],
      additionalProperties: false,
    },
    run(input, context) {
      const content = typeof input.content === "string" ? input.content.trim() : "";
      const fireAt = typeof input.fire_at === "string" ? input.fire_at : undefined;
      const cron = typeof input.cron === "string" ? input.cron.trim() : undefined;
      if (!content) {
        throw new Error("content 不能为空");
      }
      if (Boolean(fireAt) === Boolean(cron)) {
        throw new Error("fire_at 和 cron 必须恰好填一个");
      }
      let nextAt: Date;
      if (cron) {
        nextAt = nextCronRun(cron, context.timezone, context.now);
      } else {
        const parsed = parseLocal(fireAt ?? "", context.timezone);
        if (!parsed) {
          throw new Error(`fire_at "${fireAt}" 不是有效的 "YYYY-MM-DD HH:MM" 时间`);
        }
        if (parsed <= context.now) {
          throw new Error(`fire_at "${fireAt}" 已经过去了，请和用户确认时间`);
        }
        nextAt = parsed;
      }
      const reminder = store.addReminder({ userId: context.userId, content, cron, nextAt });
      return `已创建：${describeReminder(reminder, context)}`;
    },
  });

const listReminders = (store: Store) =>
  defineTool({
    name: "list_reminders",
    description: "列出用户当前所有还没触发或在重复中的提醒，带编号。",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run(_input, context) {
      const reminders = store.activeReminders(context.userId);
      return reminders.length
        ? reminders.map((reminder) => describeReminder(reminder, context)).join("\n")
        : "用户目前没有提醒。";
    },
  });

const cancelReminders = (store: Store) =>
  defineTool({
    name: "cancel_reminders",
    description: "按编号取消提醒。不确定编号时先调用 list_reminders。",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "integer" }, description: "提醒编号" } },
      required: ["ids"],
      additionalProperties: false,
    },
    run(input, context) {
      const ids = Array.isArray(input.ids) ? input.ids.map(Number) : [];
      if (!ids.length) {
        throw new Error("ids 不能为空");
      }
      const lines = ids.map((id) => {
        const reminder = Number.isInteger(id) ? store.getReminder(id) : undefined;
        if (!reminder || reminder.userId !== context.userId || reminder.status !== "active") {
          return `#${id} 没找到`;
        }
        store.setReminderStatus(id, "cancelled");
        return `#${id} ${reminder.content} 已取消`;
      });
      return lines.join("\n");
    },
  });

/** The built-in reminder tools, backed by `store`. */
export const reminderTools = (store: Store): Tool[] => [
  createReminder(store),
  listReminders(store),
  cancelReminders(store),
];
