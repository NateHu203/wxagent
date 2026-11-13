#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { consoleLogger, WeChatBot } from "@wxagent/sdk";
import qrcode from "qrcode-terminal";
import { Agent } from "./agent";
import { type Config, ConfigError, createModel, loadConfig, loadEnvFiles } from "./config";
import { ReminderScheduler } from "./scheduler";
import { Store } from "./store";
import { reminderTools } from "./tools";

const HELP = `wxagent - 住在你微信里的个人 AI 助理

用法：
  wxagent            启动助理（第一次会显示二维码，用微信扫码登录）
  wxagent login      只做扫码登录，不启动助理
  wxagent logout     删除保存的登录信息
  wxagent --help     显示这段帮助

配置（环境变量，或写在 ~/.wxagent/.env 里）：
  ANTHROPIC_API_KEY   Claude 的 API key（默认用 Claude）
  WXAGENT_MODEL       模型名，默认 claude-opus-5-5
  WXAGENT_TIMEZONE    你的时区，默认用本机时区，例如 Asia/Shanghai
  WXAGENT_ALLOW       只允许这些微信用户 id 使用，逗号分隔；默认不限制
  WXAGENT_HOME        数据目录，默认 ~/.wxagent

  换成其他模型（任何兼容 OpenAI 接口的服务）：
  WXAGENT_PROVIDER=openai  OPENAI_BASE_URL=...  OPENAI_API_KEY=...  WXAGENT_MODEL=...
`;

const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const connect = (config: Config, signal?: AbortSignal): Promise<WeChatBot> =>
  WeChatBot.connect({
    stateFile: config.stateFile,
    signal,
    onQrCode: (url) => {
      print("\n用微信扫描下面的二维码，并在手机上确认：\n");
      qrcode.generate(url, { small: true }, (code) => print(code));
      print(`二维码显示不正常的话，把这个链接转成二维码再扫：${url}\n`);
    },
    onVerifyCode: async () => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await prompt.question("请输入手机微信上显示的验证数字：");
      } finally {
        prompt.close();
      }
    },
  });

const start = async (config: Config): Promise<void> => {
  if (
    config.provider === "anthropic" &&
    !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  ) {
    consoleLogger.warn(
      "没有找到 ANTHROPIC_API_KEY。如果你没有用别的方式登录 Anthropic，收到消息时模型调用会失败。"
    );
  }
  const model = createModel(config);
  const login = new AbortController();
  process.once("SIGINT", () => login.abort(new Error("已取消")));
  const bot = await connect(config, login.signal);
  const store = new Store(config.dbFile);
  const agent = new Agent({
    bot,
    model,
    store,
    logger: consoleLogger,
    timezone: config.timezone,
    allow: config.allow,
    tools: reminderTools(store),
  });
  const scheduler = new ReminderScheduler({
    store,
    logger: consoleLogger,
    timezone: config.timezone,
    deliver: (userId, text) => agent.deliver(userId, text),
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    print("\n正在退出…");
    scheduler.stop();
    void bot.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  scheduler.start();
  print(`wxagent 已启动。模型：${config.modelLabel}，时区：${config.timezone}`);
  print("现在可以在微信里给机器人发消息了。按 Ctrl+C 退出。");
  await agent.run();
  store.close();
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "start";
  if (command === "--help" || command === "-h" || command === "help") {
    print(HELP);
    return;
  }
  if (!["start", "login", "logout"].includes(command)) {
    throw new ConfigError(`不认识的命令 "${command}"。运行 wxagent --help 查看用法。`);
  }
  loadEnvFiles();
  const config = loadConfig();
  await mkdir(config.home, { recursive: true, mode: 0o700 });

  if (command === "start") {
    await start(config);
  } else if (command === "login") {
    const bot = await connect(config);
    print(`登录成功，登录信息保存在 ${config.stateFile}`);
    await bot.close();
  } else {
    await rm(config.stateFile, { force: true });
    print("已删除保存的登录信息。提醒和聊天记录没有动。");
  }
};

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    consoleLogger.error("wxagent 异常退出", error);
  }
  process.exit(1);
});
