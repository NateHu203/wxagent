import { describe, expect, it } from "vitest";
import { ConfigError, createModel, loadConfig } from "../src/config";
import { ClaudeModel } from "../src/models/anthropic";
import { OpenAICompatibleModel } from "../src/models/openai-compatible";

describe("loadConfig", () => {
  it("defaults to Claude and keeps data under the wxagent home", () => {
    const config = loadConfig({ WXAGENT_HOME: "/data/wx", WXAGENT_TIMEZONE: "Asia/Shanghai" });
    expect(config).toMatchObject({
      provider: "anthropic",
      modelLabel: "claude-opus-5-5",
      stateFile: "/data/wx/wechat.json",
      dbFile: "/data/wx/wxagent.db",
      timezone: "Asia/Shanghai",
      allow: [],
    });
    expect(createModel(config, { ANTHROPIC_API_KEY: "test" })).toBeInstanceOf(ClaudeModel);
  });

  it("supports an OpenAI-compatible provider and an allow list", () => {
    const env = {
      WXAGENT_PROVIDER: "openai",
      WXAGENT_MODEL: "deepseek-chat",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      WXAGENT_ALLOW: " a@im.wechat, b@im.wechat ,",
    };
    const config = loadConfig(env);
    expect(config.modelLabel).toBe("deepseek-chat @ https://api.deepseek.com/v1");
    expect(config.allow).toEqual(["a@im.wechat", "b@im.wechat"]);
    expect(createModel(config, env)).toBeInstanceOf(OpenAICompatibleModel);
  });

  it("explains configuration mistakes", () => {
    expect(() => loadConfig({ WXAGENT_PROVIDER: "gemini" })).toThrow(ConfigError);
    expect(() => loadConfig({ WXAGENT_PROVIDER: "openai" })).toThrow(/WXAGENT_MODEL/);
    expect(() => loadConfig({ WXAGENT_TIMEZONE: "Mars/Olympus" })).toThrow(/时区/);
  });
});
