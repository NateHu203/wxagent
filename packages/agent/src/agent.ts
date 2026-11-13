import type { InboundMessage, Logger } from "@wxagent/sdk";
import type { Model } from "./model";
import type { Store } from "./store";
import { formatFriendly, formatLocal } from "./time";
import type { Tool, ToolContext } from "./tools";

export const DEFAULT_SYSTEM_PROMPT = `你是用户在微信里的个人助理，通过微信聊天和用户交流。

回复方式：
- 像微信聊天一样说话：简短、自然、口语化，一般不超过几句话。
- 只用纯文本。微信不渲染 Markdown，不要用 **加粗**、# 标题、表格或代码块。

提醒：
- 用户要设置、查看或取消提醒时，用对应的工具，不要假装已经完成。
- 每条用户消息开头的方括号里是当前时间和时区，推算「明天」「半小时后」这类时间时以它为准。
- 只说钟点且今天这个时间已过，就按明天算；只给日期没给钟点，用 09:00。
- 用户想设提醒但没说时间，或时间说不清时，先追问，不要猜。
- 工具执行成功后，用一句话告诉用户结果，包括提醒的时间。`;

const FAILURE_REPLY = "出错了，稍后再试一次。";
/** Long replies are split so each WeChat message stays readable. */
const MAX_MESSAGE_CHARS = 2000;
const SEEN_IDS_LIMIT = 500;

/** The part of `WeChatBot` the agent needs; handy for tests and other transports. */
export interface Messenger {
  messages(): AsyncIterable<InboundMessage>;
  sendText(userId: string, text: string): Promise<unknown>;
  setTyping(userId: string, typing: boolean): Promise<void>;
}

export interface AgentOptions {
  /** Only these user ids may talk to the agent. Default: everyone. */
  allow?: string[];
  bot: Messenger;
  /** How many earlier turns the model sees. Default 20. */
  historyLimit?: number;
  logger: Logger;
  model: Model;
  /** Injectable clock, for tests. */
  now?: () => Date;
  store: Store;
  systemPrompt?: string;
  /** IANA timezone, e.g. `Asia/Shanghai`. */
  timezone: string;
  tools?: Tool[];
}

/** Split on line breaks where possible so chunks do not cut a sentence. */
export const splitMessage = (text: string, limit = MAX_MESSAGE_CHARS): string[] => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const breakAt = rest.lastIndexOf("\n", limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
};

/**
 * Connects a WeChat bot to a model: every inbound message becomes one model
 * turn with the user's recent history and the registered tools.
 */
export class Agent {
  private readonly greeted = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  private readonly tools: Map<string, Tool>;

  constructor(private readonly options: AgentOptions) {
    this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  }

  /** Process messages until the bot's stream ends, then wait for in-flight replies. */
  async run(): Promise<void> {
    for await (const message of this.options.bot.messages()) {
      this.enqueue(message);
    }
    await Promise.all(this.queues.values());
  }

  /** Send text to a user, split into several messages when it is long. */
  async deliver(userId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.options.bot.sendText(userId, chunk);
    }
  }

  // One conversation at a time per user, so replies never interleave; other
  // users are not blocked while a model call is in flight.
  private enqueue(message: InboundMessage): void {
    const previous = this.queues.get(message.from) ?? Promise.resolve();
    const next = previous.then(() => this.handle(message));
    this.queues.set(message.from, next);
    void next.finally(() => {
      if (this.queues.get(message.from) === next) {
        this.queues.delete(message.from);
      }
    });
  }

  private async handle(message: InboundMessage): Promise<void> {
    const { allow, bot, logger, store } = this.options;
    const userId = message.from;
    // A crash before the cursor was saved replays the last batch.
    if (this.seen.has(message.id)) {
      return;
    }
    this.seen.add(message.id);
    if (this.seen.size > SEEN_IDS_LIMIT) {
      this.seen.delete(this.seen.values().next().value as string);
    }
    if (!this.greeted.has(userId)) {
      // Shows the id to put in an allow list.
      this.greeted.add(userId);
      logger.info(`message from WeChat user ${userId}`);
    }
    if (allow?.length && !allow.includes(userId)) {
      logger.warn(`ignoring a message from ${userId} (not in the allow list)`);
      return;
    }

    try {
      await this.flushOutbox(userId);
      await bot.setTyping(userId, true);
      const reply = await this.respond(userId, message.text);
      store.appendTurn(userId, { role: "user", text: message.text });
      store.appendTurn(userId, { role: "assistant", text: reply });
      await this.deliver(userId, reply);
    } catch (error) {
      logger.error(`failed to answer ${userId}`, error);
      await this.deliver(userId, FAILURE_REPLY).catch(() => undefined);
    } finally {
      await bot.setTyping(userId, false);
    }
  }

  private async respond(userId: string, text: string): Promise<string> {
    const { historyLimit = 20, model, store, systemPrompt, timezone } = this.options;
    const now = this.options.now?.() ?? new Date();
    const context: ToolContext = { userId, now, timezone };
    return await model.reply({
      system: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      history: store.history(userId, historyLimit),
      message: `[当前时间 ${formatLocal(now, timezone)}，时区 ${timezone}]\n${text}`,
      tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      runTool: (name, input) => this.runTool(name, input, context),
    });
  }

  // Failures go back to the model as text so it can correct itself or tell the user.
  private async runTool(name: string, input: unknown, context: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `错误：没有名为 ${name} 的工具。`;
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return "错误：工具参数必须是一个对象。";
    }
    try {
      return await tool.run(input as Record<string, unknown>, context);
    } catch (error) {
      this.options.logger.warn(`tool ${name} failed`, error);
      return `错误：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Reminders that could not be delivered earlier go out now that the user is here. */
  private async flushOutbox(userId: string): Promise<void> {
    const { store } = this.options;
    const now = this.options.now?.() ?? new Date();
    for (const item of store.outbox(userId)) {
      const sentAt = formatFriendly(item.createdAt, now, this.options.timezone);
      await this.deliver(userId, `${item.text}\n（${sentAt} 没能送达，现在补发）`);
      store.removeFromOutbox(item.id);
    }
  }
}
