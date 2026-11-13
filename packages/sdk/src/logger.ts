import type { Logger } from "./types";

const detail = (error: unknown): string => {
  if (error === undefined) {
    return "";
  }
  return `: ${error instanceof Error ? error.message : String(error)}`;
};

/** Default logger: prefixed lines on stderr. */
export const consoleLogger: Logger = {
  info: (message) => console.error(`[wxagent] ${message}`),
  warn: (message, error) => console.error(`[wxagent] warn: ${message}${detail(error)}`),
  error: (message, error) => console.error(`[wxagent] error: ${message}${detail(error)}`),
};

/** Discards everything. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
