import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  silentLogger,
  WeChatApiError,
  WeChatBot,
  WeChatContextTokenError,
  WeChatLoginError,
  WeChatSessionPausedError,
} from "../src/index";
import { BASE_URL, BOT_TOKEN, hang, inboundText, mockILink, ok, rawJson, USER_ID } from "./helpers";

const FAST = { backoffDelayMs: 5, maxConsecutiveFailures: 3, retryDelayMs: 1 };
const connect = (extra: Parameters<typeof WeChatBot.connect>[0] = {}) =>
  WeChatBot.connect({
    botToken: BOT_TOKEN,
    baseUrl: BASE_URL,
    logger: silentLogger,
    pollTimings: FAST,
    ...extra,
  });
const lifecycle = { "ilink/bot/msg/notifystart": ok(), "ilink/bot/msg/notifystop": ok() };
const tempFile = async () => join(await mkdtemp(join(tmpdir(), "wxagent-")), "state.json");

/** Collect `count` inbound messages, then close the bot. */
const take = async (bot: WeChatBot, count: number) => {
  const seen = [];
  for await (const message of bot.messages()) {
    seen.push(message);
    if (seen.length === count) {
      await bot.close();
    }
  }
  return seen;
};

describe("connect", () => {
  it("uses an explicit token without a QR login and sends the iLink headers", async () => {
    const ilink = mockILink(lifecycle);
    const bot = await connect();
    const [start] = ilink.callsTo("ilink/bot/msg/notifystart");
    expect(start?.url.origin).toBe(BASE_URL);
    expect(start?.headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
    expect(start?.headers.get("authorizationtype")).toBe("ilink_bot_token");
    expect(start?.headers.get("ilink-app-id")).toBe("bot");
    expect(start?.body?.base_info).toMatchObject({ bot_agent: "wxagent" });
    expect(bot.credentials.botToken).toBe(BOT_TOKEN);
    await bot.close();
    expect(ilink.callsTo("ilink/bot/msg/notifystop")).toHaveLength(1);
  });

  it("runs the QR login, follows a refresh, and saves credentials with mode 0600", async () => {
    const stateFile = await tempFile();
    const ilink = mockILink({
      ...lifecycle,
      "ilink/bot/get_bot_qrcode": [
        () => Response.json({ qrcode: "qr-1", qrcode_img_content: "https://qr/1" }),
        () => Response.json({ qrcode: "qr-2", qrcode_img_content: "https://qr/2" }),
      ],
      "ilink/bot/get_qrcode_status": [
        () => Response.json({ status: "wait" }),
        () => Response.json({ status: "expired" }),
        () => Response.json({ status: "scaned" }),
        () =>
          Response.json({
            status: "confirmed",
            bot_token: "fresh-token",
            ilink_bot_id: "bot@im.bot",
            ilink_user_id: USER_ID,
            baseurl: "https://ilink-region.test",
          }),
      ],
    });
    const shown: string[] = [];
    const bot = await WeChatBot.connect({
      baseUrl: BASE_URL,
      logger: silentLogger,
      stateFile,
      onQrCode: (url) => {
        shown.push(url);
      },
    });
    expect(shown).toEqual(["https://qr/1", "https://qr/2"]);
    expect(bot.credentials).toEqual({
      botToken: "fresh-token",
      baseUrl: "https://ilink-region.test",
      botId: "bot@im.bot",
      ownerId: USER_ID,
    });
    expect(ilink.callsTo("ilink/bot/msg/notifystart")[0]?.url.origin).toBe(
      "https://ilink-region.test"
    );
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);

    // A second connect reuses the saved login: no new QR code.
    const again = await WeChatBot.connect({ logger: silentLogger, stateFile });
    expect(again.credentials.botToken).toBe("fresh-token");
    expect(ilink.callsTo("ilink/bot/get_bot_qrcode")).toHaveLength(2);
  });

  it("fails the login when WeChat wants a verification number and no handler is given", async () => {
    mockILink({
      "ilink/bot/get_bot_qrcode": () =>
        Response.json({ qrcode: "qr", qrcode_img_content: "https://qr" }),
      "ilink/bot/get_qrcode_status": () => Response.json({ status: "need_verifycode" }),
    });
    await expect(
      WeChatBot.connect({ baseUrl: BASE_URL, logger: silentLogger, onQrCode: () => undefined })
    ).rejects.toBeInstanceOf(WeChatLoginError);
  });

  it("rejects a malformed state file instead of silently logging in again", async () => {
    const stateFile = await tempFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(stateFile, '{"version":1,"credentials":{"botToken":""}}');
    await expect(WeChatBot.connect({ logger: silentLogger, stateFile })).rejects.toThrow(
      /unreadable/
    );
  });
});

describe("messages", () => {
  it("yields 1:1 text, keeps uint64 ids exact, and advances the cursor", async () => {
    const stateFile = await tempFile();
    const batch = JSON.stringify({
      ret: 0,
      get_updates_buf: "cursor-1",
      msgs: [
        inboundText("你好"),
        inboundText("from the bot itself", { message_type: 2 }),
        inboundText("group chatter", { group_id: "g1" }),
        { ...inboundText(""), item_list: [{ type: 2 }] },
      ],
    }).replace('"from_user_id"', '"message_id":7446744073709551615,"from_user_id"');
    const ilink = mockILink({ ...lifecycle, "ilink/bot/getupdates": [rawJson(batch), hang] });
    const bot = await connect({ stateFile });

    const [message, ...rest] = await take(bot, 1);

    expect(rest).toEqual([]);
    expect(message).toMatchObject({ id: "7446744073709551615", from: USER_ID, text: "你好" });
    expect(message?.timestamp).toEqual(new Date(1_762_000_000_000));
    expect(ilink.callsTo("ilink/bot/getupdates")[0]?.body?.get_updates_buf).toBe("");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    expect(saved.contextTokens).toEqual({ [USER_ID]: "ctx-1" });
  });

  it("retries after a failed poll and resumes from the saved cursor", async () => {
    const ilink = mockILink({
      ...lifecycle,
      "ilink/bot/getupdates": [
        ok({ get_updates_buf: "c1", msgs: [inboundText("one")] }),
        () => new Response("boom", { status: 500 }),
        ok({ get_updates_buf: "c2", msgs: [inboundText("two")] }),
        hang,
      ],
    });
    const bot = await connect();
    const seen = await take(bot, 2);
    expect(seen.map((m) => m.text)).toEqual(["one", "two"]);
    expect(ilink.callsTo("ilink/bot/getupdates").map((c) => c.body?.get_updates_buf)).toEqual([
      "",
      "c1",
      "c1",
    ]);
  });

  it("reports an outage once when it starts and once when it ends", async () => {
    const down = () => new Response("boom", { status: 500 });
    mockILink({
      ...lifecycle,
      "ilink/bot/getupdates": [
        down,
        down,
        down,
        down,
        ok({ get_updates_buf: "c1", msgs: [inboundText("back")] }),
        hang,
      ],
    });
    const warnings: string[] = [];
    const infos: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (message: string) => void warnings.push(message),
      info: (message: string) => void infos.push(message),
    };
    const seen = await take(await connect({ logger }), 1);
    expect(seen.map((m) => m.text)).toEqual(["back"]);
    expect(warnings.filter((w) => w.includes("getupdates"))).toHaveLength(1);
    expect(infos.filter((i) => i.includes("reconnected"))).toHaveLength(1);
  });

  it("close() ends an idle long-poll promptly", async () => {
    mockILink({ ...lifecycle, "ilink/bot/getupdates": hang });
    const bot = await connect();
    const done = take(bot, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await bot.close();
    await expect(done).resolves.toEqual([]);
  });
});

describe("sendText", () => {
  const receive = async (bot: WeChatBot) => {
    for await (const _ of bot.messages()) {
      return;
    }
  };

  it("echoes the user's latest context_token", async () => {
    const ilink = mockILink({
      ...lifecycle,
      "ilink/bot/getupdates": [ok({ msgs: [inboundText("hi")] }), hang],
      "ilink/bot/sendmessage": rawJson('{"ret":0,"message_id":7446744073709551616}'),
    });
    const bot = await connect();
    expect(bot.canReach(USER_ID)).toBe(false);
    await receive(bot);
    expect(bot.canReach(USER_ID)).toBe(true);

    const sent = await bot.sendText(USER_ID, "交作业");

    expect(sent.id).toBe("7446744073709551616");
    expect(ilink.callsTo("ilink/bot/sendmessage")[0]?.body?.msg).toMatchObject({
      to_user_id: USER_ID,
      message_type: 2,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "交作业" } }],
    });
    await bot.close();
  });

  it("reports a rejected send without a context token as WeChatContextTokenError", async () => {
    mockILink({ ...lifecycle, "ilink/bot/sendmessage": ok({ ret: -2, errmsg: "no context" }) });
    const bot = await connect();
    await expect(bot.sendText(USER_ID, "hi")).rejects.toBeInstanceOf(WeChatContextTokenError);
  });

  it("keeps HTTP failures as WeChatApiError", async () => {
    mockILink({ ...lifecycle, "ilink/bot/sendmessage": () => new Response("", { status: 502 }) });
    const bot = await connect();
    await expect(bot.sendText(USER_ID, "hi")).rejects.toMatchObject({
      name: "WeChatApiError",
      status: 502,
    });
  });

  it("pauses after a session-expired response and then fails fast", async () => {
    const ilink = mockILink({ ...lifecycle, "ilink/bot/sendmessage": ok({ ret: -14 }) });
    const bot = await connect();
    await expect(bot.sendText(USER_ID, "hi")).rejects.toBeInstanceOf(WeChatApiError);
    await expect(bot.sendText(USER_ID, "hi")).rejects.toBeInstanceOf(WeChatSessionPausedError);
    expect(ilink.callsTo("ilink/bot/sendmessage")).toHaveLength(1);
  });
});

describe("setTyping", () => {
  it("fetches a ticket once and never throws", async () => {
    const ilink = mockILink({
      ...lifecycle,
      "ilink/bot/getconfig": ok({ typing_ticket: "ticket-1" }),
      "ilink/bot/sendtyping": [ok(), () => new Response("", { status: 500 })],
    });
    const bot = await connect();
    await bot.setTyping(USER_ID, true);
    await bot.setTyping(USER_ID, false);
    expect(ilink.callsTo("ilink/bot/getconfig")).toHaveLength(1);
    expect(ilink.callsTo("ilink/bot/sendtyping").map((c) => c.body?.status)).toEqual([1, 2]);
  });
});
