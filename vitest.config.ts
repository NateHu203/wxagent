import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"], restoreMocks: true },
  resolve: {
    alias: { "@wxagent/sdk": new URL("./packages/sdk/src/index.ts", import.meta.url).pathname },
  },
});
