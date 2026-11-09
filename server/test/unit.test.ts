import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  hashPassword,
  hashToken,
  newEnrollmentCode,
  newToken,
  normalizeEnrollmentCode,
  verifyPassword,
} from "../src/auth.js";
import { categorize, type AppRule } from "../src/categorize.js";
import { detectImage } from "../src/images.js";
import { renderInstaller } from "../src/routes/public.js";
import { clippedDuration, dateRange, dayStart, localDateString, parseDate, parseTzOffset } from "../src/time.js";

const rule = (pattern: string, category: AppRule["category"], id = pattern): AppRule => ({ id, pattern, category });

describe("categorize", () => {
  const rules = [rule("code", "productive"), rule("youtube", "unproductive"), rule("slack", "neutral")];
  it("matches app names case-insensitively", () => {
    expect(categorize(rules, "Code.exe", "")).toBe("productive");
  });
  it("prefers an app match over a title match", () => {
    expect(categorize(rules, "Code", "YouTube - Watching")).toBe("productive");
  });
  it("falls back to the title", () => {
    expect(categorize(rules, "firefox", "Funny cats - YouTube")).toBe("unproductive");
  });
  it("first rule by order wins", () => {
    expect(categorize([rule("fire", "unproductive"), rule("firefox", "productive")], "firefox", "")).toBe("unproductive");
  });
  it("is neutral with no match and idle when idle", () => {
    expect(categorize(rules, "terminal", "bash")).toBe("neutral");
    expect(categorize(rules, "code", "", true)).toBe("idle");
  });
  it("ignores blank patterns", () => {
    expect(categorize([rule("  ", "productive")], "x", "y")).toBe("neutral");
  });
});

describe("time", () => {
  it("computes local midnight in UTC from getTimezoneOffset", () => {
    // India (UTC+5:30): offset -330 -> midnight IST is 18:30 UTC the day before.
    expect(new Date(dayStart("2026-11-09", -330)).toISOString()).toBe("2026-11-08T18:30:00.000Z");
    // New York winter (UTC-5): offset 300.
    expect(new Date(dayStart("2026-11-09", 300)).toISOString()).toBe("2026-11-09T05:00:00.000Z");
    expect(new Date(dayStart("2026-11-09", 0)).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
  it("builds inclusive date ranges", () => {
    const [s, e] = dateRange("2026-11-01", "2026-11-03", 0);
    expect(e - s).toBe(3 * 24 * 3600 * 1000);
  });
  it("rejects invalid dates", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-2-3")).toBeNull();
    expect(() => dayStart("nope", 0)).toThrow();
  });
  it("gives today's local date", () => {
    const now = Date.parse("2026-11-08T20:00:00Z");
    expect(localDateString(now, -330)).toBe("2026-11-09");
    expect(localDateString(now, 300)).toBe("2026-11-08");
  });
  it("clips durations", () => {
    expect(clippedDuration(0, 100, 50, 200)).toBe(50);
    expect(clippedDuration(0, 10, 50, 200)).toBe(0);
  });
  it("sanitises tz offsets", () => {
    expect(parseTzOffset("-330")).toBe(-330);
    expect(parseTzOffset("abc")).toBe(0);
    expect(parseTzOffset("99999")).toBe(0);
  });
});

describe("auth helpers", () => {
  it("generates readable enrollment codes", () => {
    for (let i = 0; i < 200; i++) {
      const c = newEnrollmentCode();
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of c.replace("-", "")) expect(CODE_ALPHABET).toContain(ch);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });
  it("normalises user-typed codes", () => {
    expect(normalizeEnrollmentCode(" abcd efgh ")).toBe("ABCD-EFGH");
    expect(normalizeEnrollmentCode("abcd-efgh")).toBe("ABCD-EFGH");
  });
  it("hashes tokens deterministically", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("verifies scrypt passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("misc", () => {
  it("detects images by magic bytes", () => {
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe("image/png");
    expect(detectImage(Buffer.from("GIF89a"))).toBeNull();
  });
  it("renders installer placeholders", () => {
    expect(renderInstaller("U=__OPENV360_SERVER_URL__ R=__OPENV360_RELEASE_BASE__ U2=__OPENV360_SERVER_URL__", "https://a", "https://a/downloads"))
      .toBe("U=https://a R=https://a/downloads U2=https://a");
  });
});

import {
  DAY_ACTIVE_CAP_MS,
  FUTURE_SLACK_MS as FS,
  MAX_AGE_MS,
  MAX_SEGMENT_MS,
  filterSegments,
  filterSessions,
  utcDay,
} from "../src/ingest.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const seg = (start: number, end: number, idle = false, app = "code"): any => ({ id: uuid(start % 1e9), start, end, idle, app, title: "" });

describe("filterSessions", () => {
  it("drops future and too-old events, keeps valid ones", () => {
    const events = [
      { id: uuid(1), kind: "clock_in" as const, at: NOW - 1000 },
      { id: uuid(2), kind: "clock_out" as const, at: NOW + FS + 60_000 }, // too far future
      { id: uuid(3), kind: "clock_in" as const, at: NOW - MAX_AGE_MS - 1 }, // too old
      { id: uuid(4), kind: "clock_in" as const, at: NOW + 30_000 }, // within skew
      { id: uuid(5), kind: "clock_in" as const, at: NOW + 0.5 }, // non-integer
    ];
    const { accepted, dropped } = filterSessions(events, NOW);
    expect(accepted.map((e) => e.id)).toEqual([uuid(1), uuid(4)]);
    expect(dropped).toBe(3);
  });
});

describe("filterSegments", () => {
  it("drops end<=start, over-long, future, old and non-integer segments", () => {
    const segs = [
      seg(NOW - 10_000, NOW - 5_000), // ok, 5s
      seg(NOW - 5_000, NOW - 6_000), // end<start
      seg(NOW, NOW), // zero length
      seg(NOW - MAX_SEGMENT_MS * 2, NOW), // too long
      seg(NOW + FS + 10_000, NOW + FS + 20_000), // future
      seg(NOW - MAX_AGE_MS - 100_000, NOW - MAX_AGE_MS - 50_000), // old
      { id: uuid(9), start: NOW + 0.5, end: NOW + 1000, idle: false, app: "x", title: "" }, // non-integer
    ];
    const { accepted, dropped } = filterSegments(segs, NOW);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.start).toBe(NOW - 10_000);
    expect(dropped).toBe(6);
  });

  it("caps active time per UTC day at 26h and drops the overflow", () => {
    const day0 = utcDay(NOW) * 24 * 3600 * 1000;
    // 90 overlapping 20-min segments packed into the first 15h of the day sum to 30h of
    // reported active time — physically impossible — so the overflow past 26h is dropped.
    const segs: any[] = [];
    for (let i = 0; i < 90; i++) { const s = day0 + i * 10 * 60 * 1000; segs.push(seg(s, s + MAX_SEGMENT_MS)); }
    const now = day0 + 23 * 3600 * 1000;
    const { accepted, dropped, cappedDays } = filterSegments(segs, now);
    const total = accepted.reduce((a, s) => a + (s.end - s.start), 0);
    expect(total).toBe(DAY_ACTIVE_CAP_MS); // exactly 26h fits (20min divides evenly)
    expect(dropped).toBe(90 - DAY_ACTIVE_CAP_MS / MAX_SEGMENT_MS);
    expect(cappedDays).toEqual([utcDay(day0)]);
  });

  it("respects already-stored active time for the day", () => {
    const day0 = utcDay(NOW) * 24 * 3600 * 1000;
    const existing = new Map([[utcDay(day0), DAY_ACTIVE_CAP_MS - MAX_SEGMENT_MS]]);
    const segs = [seg(day0 + 100, day0 + 100 + MAX_SEGMENT_MS), seg(day0 + 3_600_000, day0 + 3_600_000 + MAX_SEGMENT_MS)];
    const { accepted, dropped } = filterSegments(segs, day0 + 23 * 3600 * 1000, existing);
    expect(accepted).toHaveLength(1); // only one more 20-min block fits
    expect(dropped).toBe(1);
  });

  it("never counts idle time against the active cap", () => {
    const day0 = utcDay(NOW) * 24 * 3600 * 1000;
    const existing = new Map([[utcDay(day0), DAY_ACTIVE_CAP_MS]]);
    const idle = seg(day0 + 100, day0 + 100 + MAX_SEGMENT_MS, true);
    const { accepted, dropped } = filterSegments([idle], day0 + 23 * 3600 * 1000, existing);
    expect(accepted).toHaveLength(1);
    expect(dropped).toBe(0);
  });
});
