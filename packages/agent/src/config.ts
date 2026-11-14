import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "./model";
import { ClaudeModel, DEFAULT_CLAUDE_MODEL } from "./models/anthropic";
import { OpenAICompatibleModel } from "./models/openai-compatible";
import { assertTimezone } from "./time";

export interface Config {
  allow: string[];
  dbFile: string;
  home: string;
  /** Human-readable name of the model in use, for the startup banner. */
  modelLabel: string;
  provider: Provider;
  stateFile: string;
  timezone: string;
}

export type Provider = "anthropic" | "openai" | "openrouter";

const PROVIDERS: readonly Provider[] = ["anthropic", "openai", "openrouter"];
const isProvider = (value: string): value is Provider => PROVIDERS.includes(value as Provider);

const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** OpenRouter's id for the same model wxagent uses by default with Anthropic. */
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-opus-5.5";

type Env = Record<string, string | undefined>;

/** Thrown for configuration the user has to fix; the CLI prints the message as-is. */
export class ConfigError extends Error {}

export const homeDir = (env: Env = process.env): string =>
  env.WXAGENT_HOME || join(homedir(), ".wxagent");

/** Load `.env` from the current directory and from the wxagent home, if present. */
export const loadEnvFiles = (env: Env = process.env): void => {
  for (const file of [join(process.cwd(), ".env"), join(homeDir(env), ".env")]) {
    if (existsSync(file)) {
      // Variables already set in the environment win over the file.
      process.loadEnvFile(file);
    }
  }
};

const modelLabel = (provider: Provider, env: Env): string => {
  if (provider === "openrouter") {
    return `${env.WXAGENT_MODEL || DEFAULT_OPENROUTER_MODEL} @ OpenRouter`;
  }
  if (provider === "openai") {
    return `${env.WXAGENT_MODEL} @ ${env.OPENAI_BASE_URL || OPENAI_BASE_URL}`;
  }
  return env.WXAGENT_MODEL || DEFAULT_CLAUDE_MODEL;
};

export const loadConfig = (env: Env = process.env): Config => {
  const home = homeDir(env);
  const provider = (env.WXAGENT_PROVIDER || "anthropic").toLowerCase();
  if (!isProvider(provider)) {
    throw new ConfigError(
      `WXAGENT_PROVIDER 只能是 anthropic、openrouter 或 openai，现在是 "${provider}"。`
    );
  }
  if (provider === "openai" && !env.WXAGENT_MODEL) {
    throw new ConfigError("使用 openai 兼容接口时必须设置 WXAGENT_MODEL（模型名）。");
  }
  const timezone = env.WXAGENT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    assertTimezone(timezone);
  } catch {
    throw new ConfigError(`WXAGENT_TIMEZONE "${timezone}" 不是有效的时区名（例如 Asia/Shanghai）。`);
  }
  return {
    home,
    stateFile: join(home, "wechat.json"),
    dbFile: join(home, "wxagent.db"),
    provider,
    modelLabel: modelLabel(provider, env),
    timezone,
    allow: (env.WXAGENT_ALLOW ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
};

export const createModel = (config: Config, env: Env = process.env): Model => {
  if (config.provider === "openrouter") {
    return new OpenAICompatibleModel({
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY,
      model: env.WXAGENT_MODEL || DEFAULT_OPENROUTER_MODEL,
    });
  }
  if (config.provider === "openai") {
    return new OpenAICompatibleModel({
      baseUrl: env.OPENAI_BASE_URL || OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      model: env.WXAGENT_MODEL as string,
    });
  }
  return new ClaudeModel({ model: env.WXAGENT_MODEL || DEFAULT_CLAUDE_MODEL });
};
