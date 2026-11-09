import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

/** Rows deleted per statement, to keep locks short. */
const BATCH = 1000;
const DAY_MS = 86_400_000;
/** First run shortly after boot, then every 6 hours. */
const FIRST_DELAY_MS = 30_000;
const CYCLE_MS = 6 * 3_600_000;

/** Deletes a screenshot file by its dataDir-relative `path` column value. Mirrors admin.ts's deleteFiles. */
async function deleteScreenshotFiles(dataDir: string, relPaths: string[]): Promise<void> {
  await Promise.all(relPaths.map((p) => fsp.rm(path.join(dataDir, "screenshots", p), { force: true })));
}

export interface RetentionResult {
  screenshots: number;
  segments: number;
  sessions: number;
  cutoff: number | null;
}

/**
 * Deletes screenshots, segments, and sessions older than the configured retention
 * window, plus the screenshot files on disk. retention_days = 0 means keep forever
 * (a no-op). Deletes in batches of BATCH rows to avoid long-held locks. Safe to call
 * directly from tests via its optional `now`.
 */
export async function runRetentionOnce(db: Db, config: Config, now: number = Date.now()): Promise<RetentionResult> {
  const { rows } = await db.query<{ retention_days: number }>("SELECT retention_days FROM settings WHERE id = 1");
  const retentionDays = rows[0]?.retention_days ?? 0;
  if (retentionDays <= 0) return { screenshots: 0, segments: 0, sessions: 0, cutoff: null };

  const cutoff = now - retentionDays * DAY_MS;
  const result: RetentionResult = { screenshots: 0, segments: 0, sessions: 0, cutoff };

  // Screenshots: delete files first (by batch of ids), then the rows.
  for (;;) {
    const { rows: batch } = await db.query<{ id: string; path: string }>(
      "SELECT id, path FROM screenshots WHERE taken_at < $1 ORDER BY taken_at LIMIT $2",
      [cutoff, BATCH],
    );
    if (batch.length === 0) break;
    await deleteScreenshotFiles(config.dataDir, batch.map((r) => r.path));
    const { rowCount } = await db.query("DELETE FROM screenshots WHERE id = ANY($1::uuid[])", [batch.map((r) => r.id)]);
    result.screenshots += rowCount ?? 0;
    if (batch.length < BATCH) break;
  }

  // Segments: a segment is expired once it ended before the cutoff.
  for (;;) {
    const { rowCount } = await db.query(
      "DELETE FROM segments WHERE id IN (SELECT id FROM segments WHERE end_at < $1 ORDER BY end_at LIMIT $2)",
      [cutoff, BATCH],
    );
    const n = rowCount ?? 0;
    result.segments += n;
    if (n < BATCH) break;
  }

  // Sessions: clock events older than the cutoff.
  for (;;) {
    const { rowCount } = await db.query(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE at < $1 ORDER BY at LIMIT $2)",
      [cutoff, BATCH],
    );
    const n = rowCount ?? 0;
    result.sessions += n;
    if (n < BATCH) break;
  }

  return result;
}

/**
 * Starts the retention loop: once ~30s after start, then every 6h. Returns a stop
 * function. Never throws into the scheduler; timers are unref'd so they don't keep
 * the process alive on their own.
 */
export function startRetentionScheduler(db: Db, config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runRetentionOnce(db, config, Date.now());
      if (r.cutoff !== null && (r.screenshots || r.segments || r.sessions)) {
        console.log(
          `retention: deleted ${r.screenshots} screenshots, ${r.segments} segments, ${r.sessions} sessions older than ${new Date(r.cutoff).toISOString()}`,
        );
      }
    } catch (err) {
      console.error("retention sweep failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
  const timer = setInterval(() => void tick(), CYCLE_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
