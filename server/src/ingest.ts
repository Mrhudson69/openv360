// Best-effort sanity limits on agent-reported data. The client is open source and the
// device holds its own token, so a determined user with root can still forge plausible
// data; these checks reject obviously impossible or manipulated values and flag the device.
// See docs/API.md "Trust model".

export const FUTURE_SLACK_MS = 2 * 60 * 1000; // tolerate small clock skew
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // reject data older than 30 days
export const MAX_SEGMENT_MS = 20 * 60 * 1000; // agent caps at ~60s; allow wide margin
export const DAY_MS = 24 * 3600 * 1000;
export const DAY_ACTIVE_CAP_MS = 26 * 3600 * 1000; // > 24h of active time in a day is impossible
export const SCREENSHOTS_PER_HOUR = 50;

export const utcDay = (t: number) => Math.floor(t / DAY_MS);

function timestampOk(t: number, now: number): boolean {
  return Number.isInteger(t) && t <= now + FUTURE_SLACK_MS && t >= now - MAX_AGE_MS;
}

export interface SessionIn {
  id: string;
  kind: "clock_in" | "clock_out";
  at: number;
}

export function filterSessions(events: SessionIn[], now: number): { accepted: SessionIn[]; dropped: number } {
  const accepted = events.filter((e) => timestampOk(e.at, now));
  return { accepted, dropped: events.length - accepted.length };
}

export interface SegmentIn {
  id: string;
  start: number;
  end: number;
  idle: boolean;
  app: string;
  title?: string;
}

/**
 * Validates each segment and caps non-idle (active) time per UTC day.
 * `existingActiveByDay` maps a UTC day index (floor(ms/DAY_MS)) to already-stored active ms
 * for this device, so a day's total across requests cannot exceed DAY_ACTIVE_CAP_MS.
 */
export function filterSegments(
  segments: SegmentIn[],
  now: number,
  existingActiveByDay: Map<number, number> = new Map(),
): { accepted: SegmentIn[]; dropped: number; cappedDays: number[] } {
  const accepted: SegmentIn[] = [];
  const dayActive = new Map(existingActiveByDay);
  const cappedDays = new Set<number>();
  let dropped = 0;
  // Oldest first so the earliest activity of a day wins the remaining budget.
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const dur = s.end - s.start;
    const valid =
      Number.isInteger(s.start) &&
      Number.isInteger(s.end) &&
      dur > 0 &&
      dur <= MAX_SEGMENT_MS &&
      timestampOk(s.start, now) &&
      timestampOk(s.end, now);
    if (!valid) {
      dropped++;
      continue;
    }
    if (!s.idle) {
      const day = utcDay(s.start);
      const used = dayActive.get(day) ?? 0;
      if (used + dur > DAY_ACTIVE_CAP_MS) {
        cappedDays.add(day);
        dropped++;
        continue;
      }
      dayActive.set(day, used + dur);
    }
    accepted.push(s);
  }
  return { accepted, dropped, cappedDays: [...cappedDays] };
}
