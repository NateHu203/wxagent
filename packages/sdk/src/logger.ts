import type { Logger } from "./types";

const detail = (error: unknown): string => {
  if (error === undefined) {
    return "";
  }
  if (!(error instanceof Error)) {
    return `: ${String(error)}`;
  }
  // `fetch failed` alone says nothing; the reason (ENOTFOUND, ECONNRESET…) is in the cause.
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const reason = cause?.code ?? cause?.message;
  return `: ${error.message}${reason === undefined ? "" : ` (${String(reason)})`}`;
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
