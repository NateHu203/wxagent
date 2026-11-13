import { describe, expect, it } from "vitest";
import { formatFriendly, formatLocal, nextCronRun, parseLocal } from "../src/time";
import { NOW, TZ } from "./helpers";

describe("parseLocal", () => {
  it("reads wall-clock time in the given timezone", () => {
    expect(parseLocal("2026-11-13 15:00", TZ)).toEqual(new Date("2026-11-13T07:00:00Z"));
    expect(parseLocal("2026-11-13T15:00", "America/New_York")).toEqual(
      new Date("2026-11-13T20:00:00Z")
    );
    // Summer time: New York is UTC-4 in July.
    expect(parseLocal("2026-07-01 09:30", "America/New_York")).toEqual(
      new Date("2026-07-01T13:30:00Z")
    );
  });

  it("rejects malformed, impossible and DST-gap times", () => {
    expect(parseLocal("明天下午3点", TZ)).toBeUndefined();
    expect(parseLocal("2026-02-30 09:00", TZ)).toBeUndefined();
    expect(parseLocal("2026-11-13 25:00", TZ)).toBeUndefined();
    // 02:30 does not exist on the night US clocks spring forward.
    expect(parseLocal("2026-03-08 02:30", "America/New_York")).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats the current time for the model", () => {
    expect(formatLocal(NOW, TZ)).toBe("2026-11-12 21:00 星期四");
    expect(formatLocal(NOW, "America/New_York")).toBe("2026-11-12 08:00 星期四");
  });

  it("uses 今天 / 明天 / 后天 and falls back to a date", () => {
    const at = (text: string) => formatFriendly(parseLocal(text, TZ) as Date, NOW, TZ);
    expect(at("2026-11-12 23:30")).toBe("今天 周四 23:30");
    expect(at("2026-11-13 15:00")).toBe("明天 周五 15:00");
    expect(at("2026-11-14 08:05")).toBe("后天 周六 08:05");
    expect(at("2026-11-20 09:00")).toBe("11月20日 周五 09:00");
    expect(at("2026-11-11 09:00")).toBe("11月11日 周三 09:00");
  });
});

describe("nextCronRun", () => {
  it("fires in the user's timezone with Sunday = 0", () => {
    expect(nextCronRun("0 8 * * *", TZ, NOW)).toEqual(parseLocal("2026-11-13 08:00", TZ));
    // Weekdays only: from Friday evening the next run is Monday.
    const fridayEvening = parseLocal("2026-11-13 20:00", TZ) as Date;
    expect(nextCronRun("0 8 * * 1-5", TZ, fridayEvening)).toEqual(
      parseLocal("2026-11-16 08:00", TZ)
    );
    expect(nextCronRun("0 9 * * 0", TZ, NOW)).toEqual(parseLocal("2026-11-15 09:00", TZ));
  });

  it("throws on expressions that are not 5-field crontabs", () => {
    expect(() => nextCronRun("0 8 * *", TZ, NOW)).toThrow();
    expect(() => nextCronRun("every day", TZ, NOW)).toThrow();
    expect(() => nextCronRun("0 0 8 * * *", TZ, NOW)).toThrow();
    expect(() => nextCronRun("99 8 * * *", TZ, NOW)).toThrow();
  });
});
