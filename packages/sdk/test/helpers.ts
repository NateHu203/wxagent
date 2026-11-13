import { vi } from "vitest";

export const BOT_TOKEN = "bot-token-secret";
export const BASE_URL = "https://ilink.test";
export const USER_ID = "o9cq80user@im.wechat";

/** One request the fake iLink server received. */
export interface ILinkCall {
  body: Record<string, unknown> | undefined;
  headers: Headers;
  method: string;
  /** Path without the leading slash, e.g. `ilink/bot/getupdates`. */
  path: string;
  signal: AbortSignal | undefined;
  url: URL;
}

export type ILinkHandler = (call: ILinkCall) => Response | Promise<Response>;

/** Resolves only when the request is aborted: an idle long-poll. */
export const hang = (call: ILinkCall): Promise<Response> =>
  new Promise((_, reject) => {
    const { signal } = call;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * Replace `globalThis.fetch` with an in-memory iLink. Each path maps to a
 * handler, or to a queue of handlers consumed in order (the last one repeats).
 * Unknown paths fail the request with HTTP 404.
 */
export const mockILink = (routes: Record<string, ILinkHandler | ILinkHandler[]>) => {
  const calls: ILinkCall[] = [];
  const queues = new Map(
    Object.entries(routes).map(([path, handler]) => [
      path,
      Array.isArray(handler) ? [...handler] : [handler],
    ])
  );
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: ILinkCall = {
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      headers: request.headers,
      method: request.method,
      path: url.pathname.slice(1),
      // The caller's own signal keeps its abort reason (e.g. TimeoutError).
      signal: init?.signal ?? request.signal,
      url,
    };
    calls.push(call);
    const queue = queues.get(call.path);
    const handler = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!handler) {
      return new Response("not found", { status: 404 });
    }
    return await handler(call);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as typeof fetch);
  return { calls, callsTo: (path: string) => calls.filter((call) => call.path === path) };
};

export const ok =
  (body: Record<string, unknown> = {}): ILinkHandler =>
  () =>
    Response.json({ ret: 0, ...body });

/** A raw JSON body, for asserting lossless uint64 parsing. */
export const rawJson =
  (body: string): ILinkHandler =>
  () =>
    new Response(body, { headers: { "Content-Type": "application/json" } });

/** An inbound text message as `getupdates` returns it. */
export const inboundText = (text: string, overrides: Record<string, unknown> = {}) => ({
  from_user_id: USER_ID,
  to_user_id: "bot@im.bot",
  create_time_ms: 1_762_000_000_000,
  message_type: 1,
  message_state: 2,
  context_token: "ctx-1",
  item_list: [{ type: 1, text_item: { text } }],
  ...overrides,
});
