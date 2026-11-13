import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ApiTarget,
  getTypingTicket,
  getUpdates,
  isTimeoutError,
  notifyStart,
  notifyStop,
  sendMessage,
  sendTyping,
} from "./api";
import { WeChatApiError, WeChatContextTokenError, WeChatSessionPausedError } from "./errors";
import { consoleLogger } from "./logger";
import {
  DEFAULT_BASE_URL,
  DEFAULT_LOGIN_TIMEOUT_MS,
  loginWithQrCode,
  type QrCodeHandler,
  type VerifyCodeHandler,
} from "./login";
import { BotState } from "./state";
import {
  type InboundMessage,
  type Logger,
  type MessageItem,
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
  type WeChatCredentials,
  type WeixinMessage,
} from "./types";

/** After a session-expired (-14) response, Tencent's client stops calling iLink for an hour. */
export const SESSION_PAUSE_MS = 60 * 60 * 1000;
const LIFECYCLE_TIMEOUT_MS = 10_000;
/** Used until the server suggests its own `longpolling_timeout_ms`. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
// Let the server answer at the very end of its own long-poll window before
// the client-side timeout fires.
const LONG_POLL_GRACE_MS = 5000;
/** How long a `getconfig` typing ticket is reused (Tencent's client refreshes within a day). */
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

/** Retry policy for failed `getupdates` calls (Tencent's client uses the same). */
export interface PollTimings {
  backoffDelayMs: number;
  maxConsecutiveFailures: number;
  retryDelayMs: number;
}

export const DEFAULT_POLL_TIMINGS: PollTimings = {
  backoffDelayMs: 30_000,
  maxConsecutiveFailures: 3,
  retryDelayMs: 2000,
};

export interface ConnectOptions {
  /** iLink API origin used with an explicit `botToken`. */
  baseUrl?: string;
  /** Skip the QR login and use this token from a previous one. */
  botToken?: string;
  logger?: Logger;
  /** Give up on the QR login after this long. Default 8 minutes. */
  loginTimeoutMs?: number;
  /** Show the QR code to scan; defaults to logging its URL. */
  onQrCode?: QrCodeHandler;
  /** Ask for the number WeChat shows when it requires verification. */
  onVerifyCode?: VerifyCodeHandler;
  pollTimings?: PollTimings;
  /** Cancels the login. */
  signal?: AbortSignal;
  /**
   * JSON file that keeps the login, the inbound cursor and each user's latest
   * `context_token` across restarts (mode 0600). Without it a restart needs a
   * new QR scan.
   */
  stateFile?: string;
}

interface TypingTicket {
  expiresAt: number;
  ticket: string;
}

const textOf = (items: MessageItem[] = []): string =>
  items
    .filter((item) => item.type === MessageItemType.TEXT)
    .map((item) => item.text_item?.text ?? "")
    .filter(Boolean)
    .join("\n");

const messageId = (message: WeixinMessage, from: string): string => {
  if (message.message_id) {
    return message.message_id;
  }
  const position = message.seq ?? message.create_time_ms;
  return position === undefined ? randomUUID() : `${from}:${position}`;
};

/** Sleep that resolves early (instead of rejecting) when `signal` aborts. */
const waitFor = async (ms: number, signal: AbortSignal): Promise<void> => {
  await sleep(ms, undefined, { signal }).catch(() => undefined);
};

// A business-level rejection (not HTTP, not an expired session) of a send
// that carried no context token is attributed to the missing token.
const isContextRejection = (error: unknown): error is WeChatApiError =>
  error instanceof WeChatApiError && error.status === undefined && !error.sessionExpired;

/**
 * A WeChat bot connected through Tencent's iLink bot API.
 *
 * ```ts
 * const bot = await WeChatBot.connect({ stateFile: "wechat.json" });
 * for await (const message of bot.messages()) {
 *   await bot.sendText(message.from, `You said: ${message.text}`);
 * }
 * ```
 */
export class WeChatBot {
  private pausedUntil = 0;
  private readonly shutdown = new AbortController();
  private readonly typingTickets = new Map<string, TypingTicket>();

  private constructor(
    private readonly state: BotState,
    private readonly target: ApiTarget,
    private readonly log: Logger,
    private readonly timings: PollTimings
  ) {}

  /**
   * Resolve credentials (explicit `botToken`, else the state file, else an
   * interactive QR login), then announce the client to iLink.
   */
  static async connect(options: ConnectOptions = {}): Promise<WeChatBot> {
    const log = options.logger ?? consoleLogger;
    const state = await BotState.open(options.stateFile);
    const saved = state.credentials;
    let credentials: WeChatCredentials;
    if (options.botToken) {
      // Keep what the login recorded (bot / owner ids) for the same token.
      const extras = saved?.botToken === options.botToken ? saved : {};
      credentials = {
        ...extras,
        botToken: options.botToken,
        baseUrl: options.baseUrl ?? saved?.baseUrl ?? DEFAULT_BASE_URL,
      };
    } else {
      credentials =
        saved ??
        (await loginWithQrCode({
          baseUrl: options.baseUrl,
          logger: log,
          onQrCode: options.onQrCode,
          onVerifyCode: options.onVerifyCode,
          signal: options.signal,
          timeoutMs: options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
        }));
    }
    state.setCredentials(credentials);
    await state.save();

    const target = { baseUrl: credentials.baseUrl, botToken: credentials.botToken };
    try {
      await notifyStart(target, { signal: options.signal, timeoutMs: LIFECYCLE_TIMEOUT_MS });
    } catch (error) {
      options.signal?.throwIfAborted();
      log.warn("notifystart failed; continuing", error);
    }
    return new WeChatBot(state, target, log, options.pollTimings ?? DEFAULT_POLL_TIMINGS);
  }

  /** The login this bot runs on; `ownerId` is the WeChat user who scanned the QR code. */
  get credentials(): WeChatCredentials {
    return { ...(this.state.credentials as WeChatCredentials) };
  }

  /**
   * True when a `context_token` is cached for this user, i.e. they have
   * messaged the bot before. iLink ties sends to the user's latest message.
   */
  canReach(userId: string): boolean {
    return this.state.contextToken(userId) !== undefined;
  }

  /**
   * Inbound 1:1 text messages, via the `getupdates` long-poll. The bot's own
   * messages, group messages and non-text items are skipped. Each batch is
   * yielded before its cursor is saved, so a crash replays messages rather
   * than losing them. Ends when `close()` is called.
   */
  async *messages(): AsyncGenerator<InboundMessage, void, void> {
    const { signal } = this.shutdown;
    let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let failures = 0;
    while (!signal.aborted) {
      const pausedMs = this.remainingPauseMs();
      if (pausedMs > 0) {
        await waitFor(pausedMs, signal);
        continue;
      }
      let response: Awaited<ReturnType<typeof getUpdates>>;
      try {
        response = await getUpdates(this.target, this.state.cursor, {
          signal,
          timeoutMs: timeoutMs + LONG_POLL_GRACE_MS,
        });
      } catch (error) {
        // An empty long-poll that ran into the client-side timeout is normal.
        if (!(signal.aborted || isTimeoutError(error))) {
          failures = await this.recoverFromPollError(error, failures);
        }
        continue;
      }
      failures = 0;
      if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
        timeoutMs = response.longpolling_timeout_ms;
      }
      for (const raw of response.msgs ?? []) {
        const inbound = this.toInbound(raw);
        if (inbound) {
          yield inbound;
        }
      }
      if (response.get_updates_buf) {
        this.state.setCursor(response.get_updates_buf);
      }
      await this.saveState();
    }
  }

  /**
   * Send a text message. iLink expects each send to echo the `context_token`
   * from the user's latest inbound message; when none is cached the send is
   * still attempted (as Tencent's client does), and a rejection surfaces as
   * `WeChatContextTokenError`.
   */
  async sendText(userId: string, text: string): Promise<{ id: string }> {
    this.assertSessionActive();
    const contextToken = this.state.contextToken(userId);
    const clientId = `wxagent:${randomUUID()}`;
    try {
      const response = await sendMessage(this.target, {
        from_user_id: "",
        to_user_id: userId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      });
      return { id: response.message_id || clientId };
    } catch (error) {
      if (error instanceof WeChatApiError && error.sessionExpired) {
        this.pauseSession();
      }
      if (!contextToken && isContextRejection(error)) {
        throw new WeChatContextTokenError(userId, { cause: error });
      }
      throw error;
    }
  }

  /** Show or hide the "typing…" hint. Failures are logged, never thrown. */
  async setTyping(userId: string, typing: boolean): Promise<void> {
    if (this.remainingPauseMs() > 0) {
      return;
    }
    try {
      const ticket = await this.typingTicket(userId);
      if (!ticket) {
        return;
      }
      await sendTyping(
        this.target,
        userId,
        ticket,
        typing ? TypingStatus.TYPING : TypingStatus.CANCEL
      );
    } catch (error) {
      this.log.warn("typing indicator failed; ignoring", error);
    }
  }

  /** Stop polling, tell iLink the client is leaving, and flush the state file. */
  async close(): Promise<void> {
    if (this.shutdown.signal.aborted) {
      return;
    }
    this.shutdown.abort();
    if (this.remainingPauseMs() === 0) {
      try {
        await notifyStop(this.target, { timeoutMs: LIFECYCLE_TIMEOUT_MS });
      } catch (error) {
        this.log.warn("notifystop failed", error);
      }
    }
    await this.saveState();
  }

  private toInbound(message: WeixinMessage): InboundMessage | undefined {
    const from = message.from_user_id;
    if (!from || message.message_type === MessageType.BOT || message.group_id) {
      return;
    }
    if (message.context_token) {
      this.state.setContextToken(from, message.context_token);
    }
    const text = textOf(message.item_list);
    if (!text) {
      return;
    }
    return {
      id: messageId(message, from),
      from,
      text,
      raw: message,
      ...(message.create_time_ms === undefined
        ? {}
        : { timestamp: new Date(message.create_time_ms) }),
    };
  }

  private remainingPauseMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  private pauseSession(): void {
    this.pausedUntil = Date.now() + SESSION_PAUSE_MS;
  }

  private assertSessionActive(): void {
    if (this.remainingPauseMs() > 0) {
      throw new WeChatSessionPausedError(new Date(this.pausedUntil));
    }
  }

  // Returns the updated consecutive-failure count.
  private async recoverFromPollError(error: unknown, failures: number): Promise<number> {
    if (error instanceof WeChatApiError && error.sessionExpired) {
      this.pauseSession();
      this.log.error(
        `WeChat session expired; pausing API calls for ${SESSION_PAUSE_MS / 60_000} minutes. Log in again to scan a new QR code.`,
        error
      );
      return 0;
    }
    const { timings } = this;
    const attempt = failures + 1;
    const backOff = attempt >= timings.maxConsecutiveFailures;
    const delayMs = backOff ? timings.backoffDelayMs : timings.retryDelayMs;
    this.log.warn(
      `getupdates failed (${attempt}/${timings.maxConsecutiveFailures}); retrying in ${delayMs} ms`,
      error
    );
    await waitFor(delayMs, this.shutdown.signal);
    return backOff ? 0 : attempt;
  }

  private async typingTicket(userId: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ticket;
    }
    const ticket = await getTypingTicket(this.target, userId, this.state.contextToken(userId));
    if (ticket) {
      this.typingTickets.set(userId, { ticket, expiresAt: Date.now() + TYPING_TICKET_TTL_MS });
    }
    return ticket;
  }

  private async saveState(): Promise<void> {
    try {
      await this.state.save();
    } catch (error) {
      this.log.warn("failed to write the state file", error);
    }
  }
}
