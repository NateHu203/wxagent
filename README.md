# wxagent

住在你微信里的个人 AI 助理，以及它背后的微信机器人 SDK。

A personal AI assistant that lives in your WeChat, plus the bot SDK underneath it. Built on Tencent's official iLink bot API (the channel behind WeChat's ClawBot), so the bot is its own contact in your WeChat and never logs in as you.

> **状态：早期版本。** 扫码登录、收发消息、设提醒和到点主动推送都已经用真实微信账号验证过。还没弄清楚的事情见下面的「已知限制」。

这个仓库有两层：

| 包 | 给谁用 | 做什么 |
|---|---|---|
| [`@wxagent/cli`](packages/agent) | 想直接用的人 | 开箱即用的助理：聊天、设提醒，模型默认 Claude，可以换 |
| [`@wxagent/sdk`](packages/sdk) | 开发者 | 微信机器人 SDK：扫码登录、收消息、发消息，零依赖 |

## 它能做什么

在微信里像跟朋友聊天一样跟它说话：

- 「明天下午3点提醒我交作业」
- 「每个工作日早上8点提醒我吃药」
- 「我有哪些提醒？」「把交作业那个取消」
- 其他任何问题，它会像普通聊天助手一样回答，并记得最近的对话

到点后它会主动给你发一条 `⏰ 交作业`。

## 快速开始

需要 Node.js 22.13 或更高版本。

```bash
npm install -g @wxagent/cli
export ANTHROPIC_API_KEY=sk-ant-...    # 或者写进 ~/.wxagent/.env，其他模型见下面的「换模型」
wxagent
```

第一次启动，终端里会显示一个二维码。用微信扫码并在手机上确认，之后你的微信里会出现一个机器人联系人，给它发消息就行。登录信息保存在 `~/.wxagent/`，下次启动不用再扫。

它不需要公网 IP，也不需要服务器：程序是主动去微信服务器取消息的，所以在自己的电脑、树莓派或任何一台能上网的机器上都能跑。要让提醒准时送达，程序需要一直开着。

其他命令：

```bash
wxagent login     # 只扫码登录
wxagent logout    # 删除保存的登录信息
wxagent --help
```

想从源码运行的话：`git clone https://github.com/NateHu203/wxagent && cd wxagent && npm install && npm run build && npm start`。

## 配置

用环境变量配置，可以写在运行目录的 `.env` 或 `~/.wxagent/.env` 里。

| 变量 | 说明 | 默认 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude 的 API key | 无 |
| `WXAGENT_MODEL` | 模型名 | `claude-opus-5-5` |
| `WXAGENT_TIMEZONE` | 你的时区，决定「明天下午3点」按哪里的时间算 | 本机时区 |
| `WXAGENT_ALLOW` | 只允许这些微信用户 id 使用，逗号分隔 | 不限制 |
| `WXAGENT_HOME` | 数据目录（登录信息、提醒、聊天记录） | `~/.wxagent` |

### 换模型

默认用 Claude。

用 [OpenRouter](https://openrouter.ai) 的话，只要两行。默认模型是 `anthropic/claude-opus-5.5`，想换就再设一个 `WXAGENT_MODEL`：

```bash
WXAGENT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

也可以换成任何兼容 OpenAI Chat Completions 接口、并且支持 function calling 的服务，比如 DeepSeek、通义千问、Moonshot，或者本地的 Ollama：

```bash
WXAGENT_PROVIDER=openai
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
WXAGENT_MODEL=deepseek-chat
```

提醒功能依赖模型调用工具，所以要选支持 function calling 的模型。

## 用 SDK 写自己的机器人

```ts
import { WeChatBot } from "@wxagent/sdk";

const bot = await WeChatBot.connect({ stateFile: "wechat.json" });

for await (const message of bot.messages()) {
  await bot.sendText(message.from, `你说：${message.text}`);
}
```

`connect` 在没有保存的登录信息时会走扫码登录，用 `onQrCode` 回调拿到二维码内容自己渲染。`bot.setTyping(userId, true)` 显示"正在输入"，`bot.close()` 优雅退出。

### 给助理加工具

助理的能力来自工具。内置的是三个提醒工具，你可以加自己的：

```ts
import { Agent, ClaudeModel, defineTool, reminderTools, Store } from "@wxagent/cli";
import { consoleLogger, WeChatBot } from "@wxagent/sdk";

const weather = defineTool({
  name: "get_weather",
  description: "查询一个城市现在的天气",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  run: async ({ city }) => `${city}：晴，18 度`, // 换成真实的天气接口
});

const store = new Store("wxagent.db");
const agent = new Agent({
  bot: await WeChatBot.connect({ stateFile: "wechat.json" }),
  model: new ClaudeModel(),
  store,
  logger: consoleLogger,
  timezone: "Asia/Shanghai",
  tools: [...reminderTools(store), weather],
});
await agent.run();
```

要接别的模型，实现 `Model` 接口的 `reply` 方法即可。

## 工作原理

```
微信 ⇄ 微信服务器 (iLink) ⇄ @wxagent/sdk ⇄ Agent ⇄ 模型 (Claude / 其他)
                               长轮询收消息        │
                                                  ├─ 工具：创建 / 查看 / 取消提醒
                                                  └─ SQLite：提醒、聊天记录、待补发消息
调度器每 15 秒查一次到期的提醒 ──> 通过 SDK 发给你
```

- **提醒不会丢。** 提醒存在 SQLite 里。程序停机期间到期的提醒，重启后立刻补发，并注明"延迟送达"。
- **发不出去的提醒会排队。** 如果微信拒绝了一次推送，这条提醒会存下来，等你下次给机器人发消息时补发。
- **每个用户的对话互不干扰。** 同一个人的消息按顺序处理，不同人之间互不阻塞。

## 已知限制

- **主动推送的时间窗口还不确定。** iLink 要求机器人发消息时带上你最近一条消息里的凭据（`context_token`）。腾讯没有公开说明它多久过期。有第三方资料说大约 24 小时，没有被证实。也就是说，隔了很多天的提醒有可能推不出去，这时它会按上面说的排队补发。保险的做法是偶尔跟机器人说句话。
- **提醒到了微信不一定弹通知。** 一次实测里，提醒按时出现在聊天中，但手机没有弹出通知，原因还没确认。弹不弹通知由微信客户端决定，程序控制不了。
- **只支持私聊文字。** 图片、语音、文件和群聊还没做。
- **iLink 没有完整的官方文档。** 这里的实现参考了腾讯开源的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）及其协议说明。腾讯没有明确说明是否欢迎 OpenClaw 以外的客户端接入，接口也可能变化。请遵守微信的使用规范，风险自担。
- **默认不限制谁能用。** 如果有其他人能给你的机器人发消息，设置 `WXAGENT_ALLOW`，免得消耗你的模型额度。

## 开发

```bash
npm install
npm test            # 47 个测试，网络全部是模拟的
npm run typecheck
npm run build
```

## 致谢

微信收发部分基于腾讯的 iLink bot API，协议细节参考了 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。本项目与腾讯、微信没有关联。

## License

[MIT](LICENSE)
