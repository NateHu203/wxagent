import type { InboundMessage, Logger } from "@wxagent/sdk";
import type { Messenger } from "../src/agent";
import type { Model, ModelRequest } from "../src/model";

export const TZ = "Asia/Shanghai";
export const USER = "o_me@im.wechat";
/** Thursday 2026-11-12 21:00 in Shanghai. */
export const NOW = new Date("2026-11-12T13:00:00Z");

export const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export const inbound = (text: string, overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `m-${Math.random()}`,
  from: USER,
  text,
  raw: {},
  ...overrides,
});

/** A messenger that replays `incoming` and records what was sent. */
export class FakeMessenger implements Messenger {
  failSends = false;
  readonly sent: { text: string; userId: string }[] = [];
  readonly typing: boolean[] = [];

  constructor(private readonly incoming: InboundMessage[] = []) {}

  async *messages(): AsyncGenerator<InboundMessage> {
    yield* this.incoming;
  }

  async sendText(userId: string, text: string): Promise<void> {
    if (this.failSends) {
      throw new Error("WeChat refused the send");
    }
    this.sent.push({ userId, text });
  }

  async setTyping(_userId: string, typing: boolean): Promise<void> {
    this.typing.push(typing);
  }
}

/** A model driven by a function, recording every request. */
export class FakeModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly respond: (request: ModelRequest) => string | Promise<string>) {}

  async reply(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    return await this.respond(request);
  }
}
