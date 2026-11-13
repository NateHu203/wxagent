// The smallest possible bot: repeats whatever you send it.
//   npm run build && node --experimental-strip-types examples/echo.ts
import { WeChatBot } from "@wxagent/sdk";

const bot = await WeChatBot.connect({ stateFile: "echo-state.json" });
process.once("SIGINT", () => void bot.close());

for await (const message of bot.messages()) {
  await bot.sendText(message.from, `你说：${message.text}`);
}
