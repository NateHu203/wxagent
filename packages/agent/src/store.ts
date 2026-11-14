import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  cron TEXT,                              -- recurring: 5-field crontab; NULL for one-off
  next_at INTEGER NOT NULL,               -- epoch ms of the next (or only) firing
  status TEXT NOT NULL DEFAULT 'active',  -- active | done | cancelled
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, next_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                     -- user | assistant
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user ON messages (user_id, id);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface Reminder {
  content: string;
  /** Crontab for a recurring reminder; `undefined` for a one-off. */
  cron?: string;
  id: number;
  nextAt: Date;
  status: "active" | "done" | "cancelled";
  userId: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface OutboxItem {
  createdAt: Date;
  id: number;
  text: string;
  userId: string;
}

type Row = Record<string, unknown>;

const toReminder = (row: Row): Reminder => ({
  id: Number(row.id),
  userId: String(row.user_id),
  content: String(row.content),
  ...(row.cron ? { cron: String(row.cron) } : {}),
  nextAt: new Date(Number(row.next_at)),
  status: row.status as Reminder["status"],
});

/** SQLite storage: reminders, chat history, and messages waiting to be delivered. */
export class Store {
  private readonly db: DatabaseSync;

  /** `path` is a file, or `":memory:"`. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      // Chat history and reminders are private: owner-only, like the login file.
      chmodSync(path, 0o600);
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  addReminder(input: { content: string; cron?: string; nextAt: Date; userId: string }): Reminder {
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO reminders (user_id, content, cron, next_at, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(input.userId, input.content, input.cron ?? null, input.nextAt.getTime(), Date.now());
    return this.getReminder(Number(lastInsertRowid)) as Reminder;
  }

  getReminder(id: number): Reminder | undefined {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
    return row ? toReminder(row) : undefined;
  }

  activeReminders(userId: string): Reminder[] {
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE status = 'active' AND user_id = ? ORDER BY next_at, id"
      )
      .all(userId)
      .map(toReminder);
  }

  /** Active reminders whose time has come. */
  dueReminders(now: Date): Reminder[] {
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE status = 'active' AND next_at <= ? ORDER BY next_at, id"
      )
      .all(now.getTime())
      .map(toReminder);
  }

  setReminderStatus(id: number, status: Reminder["status"]): void {
    this.db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(status, id);
  }

  rescheduleReminder(id: number, nextAt: Date): void {
    this.db.prepare("UPDATE reminders SET next_at = ? WHERE id = ?").run(nextAt.getTime(), id);
  }

  appendTurn(userId: string, turn: ChatTurn): void {
    this.db
      .prepare("INSERT INTO messages (user_id, role, text, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, turn.role, turn.text, Date.now());
  }

  /** The latest `limit` turns for this user, oldest first. */
  history(userId: string, limit: number): ChatTurn[] {
    return this.db
      .prepare("SELECT role, text FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit)
      .reverse()
      .map((row) => ({ role: row.role as ChatTurn["role"], text: String(row.text) }));
  }

  clearHistory(userId: string): void {
    this.db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId);
  }

  addToOutbox(userId: string, text: string): void {
    this.db
      .prepare("INSERT INTO outbox (user_id, text, created_at) VALUES (?, ?, ?)")
      .run(userId, text, Date.now());
  }

  outbox(userId: string): OutboxItem[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE user_id = ? ORDER BY id")
      .all(userId)
      .map((row) => ({
        id: Number(row.id),
        userId: String(row.user_id),
        text: String(row.text),
        createdAt: new Date(Number(row.created_at)),
      }));
  }

  removeFromOutbox(id: number): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }
}
