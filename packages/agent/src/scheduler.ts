import type { Logger } from "@wxagent/sdk";
import type { Reminder, Store } from "./store";
import { formatFriendly, nextCronRun } from "./time";

/** A one-off reminder delivered later than this (e.g. after a restart) says so. */
const LATE_THRESHOLD_MS = 2 * 60 * 1000;
const DEFAULT_TICK_MS = 15_000;

export interface SchedulerOptions {
  /** Deliver a reminder; a rejection means the user did not get it. */
  deliver(userId: string, text: string): Promise<void>;
  logger: Logger;
  store: Store;
  /** How often to look for due reminders. Default 15 s. */
  tickMs?: number;
  timezone: string;
}

/**
 * Fires due reminders. The database is the source of truth: every tick asks
 * it what is due, so reminders survive restarts and ones that came due while
 * the process was down fire as soon as it is back.
 */
export class ReminderScheduler {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? DEFAULT_TICK_MS);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fire everything due at `now`. Overlapping calls are skipped. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const reminder of this.options.store.dueReminders(now)) {
        await this.fire(reminder, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async fire(reminder: Reminder, now: Date): Promise<void> {
    const { store, timezone, logger } = this.options;
    // Advance or finish the reminder before delivering, so a crash mid-send
    // cannot make it fire twice.
    if (reminder.cron) {
      try {
        store.rescheduleReminder(reminder.id, nextCronRun(reminder.cron, timezone, now));
      } catch (error) {
        logger.error(`reminder #${reminder.id} has an invalid schedule; cancelling it`, error);
        store.setReminderStatus(reminder.id, "cancelled");
        return;
      }
    } else {
      store.setReminderStatus(reminder.id, "done");
    }

    let text = `⏰ ${reminder.content}`;
    if (!reminder.cron && now.getTime() - reminder.nextAt.getTime() > LATE_THRESHOLD_MS) {
      text += `\n（原定 ${formatFriendly(reminder.nextAt, now, timezone)}，延迟送达）`;
    }
    try {
      await this.options.deliver(reminder.userId, text);
    } catch (error) {
      // Kept for the next time the user writes: iLink may refuse a send when
      // the user has not messaged the bot recently.
      logger.warn(`could not deliver reminder #${reminder.id}; queued until the user writes`, error);
      store.addToOutbox(reminder.userId, text);
    }
  }
}
