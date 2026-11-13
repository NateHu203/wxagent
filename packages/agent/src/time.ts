import { Cron } from "croner";

const WEEKDAYS = "日一二三四五六";
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

interface Parts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  weekday: number;
  year: number;
}

/** The wall-clock fields of `date` in `timezone`. */
const partsIn = (date: Date, timezone: string): Parts => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const fields = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(fields.weekday ?? ""),
  };
};

const asUtc = (p: Parts): number => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);

const pad = (value: number): string => String(value).padStart(2, "0");

/** Throws `RangeError` for a name `Intl` does not know. */
export const assertTimezone = (timezone: string): void => {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
};

/** `2026-11-12 21:05 星期四`, in `timezone`. */
export const formatLocal = (date: Date, timezone: string): string => {
  const p = partsIn(date, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} 星期${WEEKDAYS[p.weekday]}`;
};

/** `今天 周四 21:05`, `明天 …`, or `11月20日 周五 09:00`, relative to `now`. */
export const formatFriendly = (date: Date, now: Date, timezone: string): string => {
  const p = partsIn(date, timezone);
  const today = partsIn(now, timezone);
  const days = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(today.year, today.month - 1, today.day)) /
      86_400_000
  );
  const day = ["今天", "明天", "后天"][days] ?? `${p.month}月${p.day}日`;
  return `${day} 周${WEEKDAYS[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
};

/**
 * Parse a wall-clock `YYYY-MM-DD HH:MM` in `timezone` into an instant.
 * Returns `undefined` when the text is not in that format or names a time
 * that does not exist (e.g. Feb 30, or inside a DST gap).
 */
export const parseLocal = (text: string, timezone: string): Date | undefined => {
  const match = LOCAL_TIME.exec(text.trim());
  if (!match) {
    return;
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls impossible fields over (Feb 30 -> Mar 2, 25:00 -> next day).
  const rolled = new Date(wanted);
  if (
    rolled.getUTCMonth() !== month - 1 ||
    rolled.getUTCDate() !== day ||
    rolled.getUTCHours() !== hour ||
    rolled.getUTCMinutes() !== minute
  ) {
    return;
  }
  // The zone's offset at the target is unknown up front: guess with the
  // offset at `wanted`-as-UTC, then correct once.
  let instant = wanted;
  for (let pass = 0; pass < 2; pass++) {
    instant = wanted - (asUtc(partsIn(new Date(instant), timezone)) - instant);
  }
  return asUtc(partsIn(new Date(instant), timezone)) === wanted ? new Date(instant) : undefined;
};

/**
 * The next time a standard 5-field crontab (minute hour day month weekday,
 * Sunday = 0) fires after `after`. Throws on an invalid expression.
 */
export const nextCronRun = (expression: string, timezone: string, after: Date): Date => {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw new Error(`expected 5 crontab fields, got "${expression}"`);
  }
  const next = new Cron(expression.trim(), { timezone, paused: true }).nextRun(after);
  if (!next) {
    throw new Error(`"${expression}" never fires`);
  }
  return next;
};
