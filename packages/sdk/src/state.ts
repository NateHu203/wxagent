import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WeChatCredentials } from "./types";

const STATE_FILE_VERSION = 1;
// The file holds the bot token and per-user context tokens.
const STATE_FILE_MODE = 0o600;

interface PersistedState {
  contextTokens?: Record<string, string>;
  credentials?: WeChatCredentials;
  cursor?: string;
  version: typeof STATE_FILE_VERSION;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const parseCredentials = (value: unknown): WeChatCredentials | undefined => {
  if (value === undefined) {
    return;
  }
  if (
    !isRecord(value) ||
    typeof value.botToken !== "string" ||
    !value.botToken ||
    typeof value.baseUrl !== "string" ||
    !URL.canParse(value.baseUrl) ||
    !optionalString(value.botId) ||
    !optionalString(value.ownerId)
  ) {
    throw new Error("credentials are malformed");
  }
  return {
    botToken: value.botToken,
    baseUrl: value.baseUrl,
    ...(value.botId ? { botId: value.botId } : {}),
    ...(value.ownerId ? { ownerId: value.ownerId } : {}),
  };
};

const parseState = (json: unknown): PersistedState => {
  if (!isRecord(json) || json.version !== STATE_FILE_VERSION) {
    throw new Error(`expected version ${STATE_FILE_VERSION}`);
  }
  if (!optionalString(json.cursor)) {
    throw new Error("cursor is not a string");
  }
  const tokens = json.contextTokens ?? {};
  if (!isRecord(tokens) || Object.values(tokens).some((token) => typeof token !== "string")) {
    throw new Error("contextTokens is malformed");
  }
  return {
    version: STATE_FILE_VERSION,
    credentials: parseCredentials(json.credentials),
    cursor: json.cursor,
    contextTokens: tokens as Record<string, string>,
  };
};

const readStateFile = async (file: string): Promise<PersistedState | undefined> => {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    return parseState(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `WeChat state file ${file} is unreadable (${(error as Error).message}). Delete it to log in again.`,
      { cause: error }
    );
  }
};

/**
 * The bot's mutable state: login credentials, the inbound cursor, and each
 * user's latest `context_token`. Optionally mirrored to a JSON file (mode
 * 0600) so a restart does not need a new QR scan.
 */
export class BotState {
  credentials: WeChatCredentials | undefined;
  /** The `getupdates` cursor; `""` before the first poll. */
  cursor = "";
  private readonly contextTokens = new Map<string, string>();
  private dirty = false;
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly file?: string) {}

  /** A missing file is fine; a malformed one throws. */
  static async open(file?: string): Promise<BotState> {
    const state = new BotState(file);
    const persisted = file ? await readStateFile(file) : undefined;
    if (persisted) {
      state.credentials = persisted.credentials;
      state.cursor = persisted.cursor ?? "";
      for (const [userId, token] of Object.entries(persisted.contextTokens ?? {})) {
        state.contextTokens.set(userId, token);
      }
    }
    return state;
  }

  /** Switching to a different bot token drops the old bot's cursor and tokens. */
  setCredentials(next: WeChatCredentials): void {
    if (this.credentials && this.credentials.botToken !== next.botToken) {
      this.cursor = "";
      this.contextTokens.clear();
    }
    this.credentials = { ...next };
    this.dirty = true;
  }

  setCursor(cursor: string): void {
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.dirty = true;
    }
  }

  contextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  setContextToken(userId: string, token: string): void {
    if (this.contextTokens.get(userId) !== token) {
      this.contextTokens.set(userId, token);
      this.dirty = true;
    }
  }

  /** Forget the login (and everything tied to it). */
  clear(): void {
    this.credentials = undefined;
    this.cursor = "";
    this.contextTokens.clear();
    this.dirty = true;
  }

  /** Write the state file when one is configured and something changed. */
  save(): Promise<void> {
    const { file } = this;
    if (!(file && this.dirty)) {
      return this.writes;
    }
    this.dirty = false;
    const snapshot: PersistedState = {
      version: STATE_FILE_VERSION,
      credentials: this.credentials,
      cursor: this.cursor,
      contextTokens: Object.fromEntries(this.contextTokens),
    };
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        // Write to a sibling temp file, then rename, so a crash never leaves
        // a truncated state file behind.
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: STATE_FILE_MODE });
        await rename(temp, file);
      })
      .catch((error: unknown) => {
        // Retry on the next save.
        this.dirty = true;
        throw error;
      });
    return this.writes;
  }
}
