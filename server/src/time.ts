export const DAY_MS = 24 * 3600 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(date: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/**
 * Start of the viewer's local day in UTC epoch ms.
 * tzOffsetMin follows JS Date#getTimezoneOffset(): UTC minus local, in minutes
 * (e.g. India = -330, New York in winter = 300).
 */
export function dayStart(date: string, tzOffsetMin: number): number {
  const p = parseDate(date);
  if (!p) throw new Error(`invalid date: ${date}`);
  return Date.UTC(p.y, p.m - 1, p.d) + tzOffsetMin * 60_000;
}

/** [start, end) of a local date range, both ends inclusive by date. */
export function dateRange(from: string, to: string, tzOffsetMin: number): [number, number] {
  return [dayStart(from, tzOffsetMin), dayStart(to, tzOffsetMin) + DAY_MS];
}

/** Today's date (YYYY-MM-DD) in the viewer's timezone. */
export function localDateString(now: number, tzOffsetMin: number): string {
  return new Date(now - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

export function clippedDuration(start: number, end: number, rangeStart: number, rangeEnd: number): number {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
}

export function parseTzOffset(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || Math.abs(n) > 14 * 60) return 0;
  return Math.trunc(n);
}
