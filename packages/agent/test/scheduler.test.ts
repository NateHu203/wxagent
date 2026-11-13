import { beforeEach, describe, expect, it } from "vitest";
import { ReminderScheduler } from "../src/scheduler";
import { Store } from "../src/store";
import { parseLocal } from "../src/time";
import { NOW, quiet, TZ, USER } from "./helpers";

let store: Store;
let delivered: string[];
let failDelivery: boolean;
let scheduler: ReminderScheduler;
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

beforeEach(() => {
  store = new Store(":memory:");
  delivered = [];
  failDelivery = false;
  scheduler = new ReminderScheduler({
    store,
    logger: quiet,
    timezone: TZ,
    deliver: async (_userId, text) => {
      if (failDelivery) {
        throw new Error("no context token");
      }
      delivered.push(text);
    },
  });
});

describe("ReminderScheduler", () => {
  it("fires a one-off reminder once, when due", async () => {
    const reminder = store.addReminder({ userId: USER, content: "交作业", nextAt: minutes(10) });
    await scheduler.tick(minutes(9));
    expect(delivered).toEqual([]);
    await scheduler.tick(minutes(10));
    await scheduler.tick(minutes(11));
    expect(delivered).toEqual(["⏰ 交作业"]);
    expect(store.getReminder(reminder.id)?.status).toBe("done");
  });

  it("says so when a reminder is delivered late (e.g. after downtime)", async () => {
    store.addReminder({ userId: USER, content: "交作业", nextAt: minutes(-90) });
    await scheduler.tick(NOW);
    expect(delivered).toEqual(["⏰ 交作业\n（原定 今天 周四 19:30，延迟送达）"]);
  });

  it("keeps a recurring reminder active and moves it to the next run", async () => {
    const reminder = store.addReminder({
      userId: USER,
      content: "吃药",
      cron: "0 8 * * *",
      nextAt: parseLocal("2026-11-13 08:00", TZ) as Date,
    });
    await scheduler.tick(parseLocal("2026-11-13 08:00", TZ));
    expect(delivered).toEqual(["⏰ 吃药"]);
    expect(store.getReminder(reminder.id)).toMatchObject({
      status: "active",
      nextAt: parseLocal("2026-11-14 08:00", TZ),
    });
  });

  it("queues a reminder it could not deliver instead of losing it", async () => {
    failDelivery = true;
    const reminder = store.addReminder({ userId: USER, content: "交作业", nextAt: NOW });
    await scheduler.tick(NOW);
    expect(store.getReminder(reminder.id)?.status).toBe("done");
    expect(store.outbox(USER).map((item) => item.text)).toEqual(["⏰ 交作业"]);
  });

  it("does not fire cancelled reminders", async () => {
    const reminder = store.addReminder({ userId: USER, content: "旧的", nextAt: NOW });
    store.setReminderStatus(reminder.id, "cancelled");
    await scheduler.tick(minutes(1));
    expect(delivered).toEqual([]);
  });
});
