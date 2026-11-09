import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";

/** Recursively sum file sizes under a directory. Bounded and non-throwing. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(full);
      else if (e.isFile()) total += (await fsp.stat(full)).size;
    } catch {
      /* ignore files that vanish mid-walk */
    }
  }
  return total;
}

/** Storage usage: database size, screenshot files on disk, and row counts. Owner-only. */
export async function storageRoutes(app: FastifyInstance, opts: { db: Db; config: Config }): Promise<void> {
  const { db, config } = opts;
  app.get("/api/storage", { preHandler: requireOwner(db) }, async () => {
    const [{ rows: dbRows }, screenshotsBytes, counts] = await Promise.all([
      db.query<{ size: number }>("SELECT pg_database_size(current_database())::bigint AS size"),
      dirSize(path.join(config.dataDir, "screenshots")),
      (async () => {
        const q = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]!.n);
        const [employees, devices, screenshots, segments, sessions] = await Promise.all([
          q("SELECT count(*)::int AS n FROM employees"),
          q("SELECT count(*)::int AS n FROM devices WHERE revoked_at IS NULL"),
          q("SELECT count(*)::int AS n FROM screenshots"),
          q("SELECT count(*)::int AS n FROM segments"),
          q("SELECT count(*)::int AS n FROM sessions"),
        ]);
        return { employees, devices, screenshots, segments, sessions };
      })(),
    ]);
    const dbBytes = Number(dbRows[0]!.size);
    return { dbBytes, screenshotsBytes, totalBytes: dbBytes + screenshotsBytes, counts };
  });
}
