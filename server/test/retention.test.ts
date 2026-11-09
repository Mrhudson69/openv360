import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { migrate, type Db } from "../src/db.js"; // importing db.js also registers the INT8->number parser
import { runRetentionOnce } from "../src/retention.js";

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 86_400_000;

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!DATABASE_URL)("retention (postgres)", () => {
  let db: Db;
  let config: Config;
  let dataDir: string;
  let empId = "";
  let devId = "";

  async function mkSegment(start: number, end: number): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO segments (id, employee_id, device_id, start_at, end_at, idle, app, title) VALUES ($1,$2,$3,$4,$5,false,'app','')",
      [id, empId, devId, start, end],
    );
    return id;
  }
  async function mkSession(at: number): Promise<string> {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO sessions (id, employee_id, device_id, kind, at) VALUES ($1,$2,$3,'clock_in',$4)", [
      id, empId, devId, at,
    ]);
    return id;
  }
  // Creates a screenshot row AND its file on disk under dataDir/screenshots/<rel>.
  async function mkScreenshot(takenAt: number): Promise<{ id: string; abs: string }> {
    const id = crypto.randomUUID();
    const rel = path.join("2025", "01", `${id}.png`);
    const abs = path.join(dataDir, "screenshots", rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, PNG);
    await db.query(
      "INSERT INTO screenshots (id, employee_id, device_id, taken_at, path, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,'image/png',$6)",
      [id, empId, devId, takenAt, rel, PNG.length],
    );
    return { id, abs };
  }
  const exists = async (p: string) => fs.access(p).then(() => true, () => false);
  const countRows = async (table: string, idCol = "id", id?: string) =>
    id
      ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${idCol} = $1`, [id])).rows[0]!.n
      : (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  beforeAll(async () => {
    const SCHEMA = "retention_test";
    const boot = new pg.Pool({ connectionString: DATABASE_URL! });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await boot.end();
    db = new pg.Pool({ connectionString: DATABASE_URL!, options: `-c search_path=${SCHEMA},public` });
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-ret-"));
    config = { ...loadConfig({ DATABASE_URL, DATA_DIR: dataDir }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    empId = crypto.randomUUID();
    await db.query("INSERT INTO employees (id, name, created_at) VALUES ($1,'E',$2)", [empId, Date.now()]);
    devId = crypto.randomUUID();
    await db.query(
      "INSERT INTO devices (id, employee_id, token_hash, hostname, os, os_version, agent_version, created_at) VALUES ($1,$2,$3,'h','linux','x','0.1.0',$4)",
      [devId, empId, crypto.randomBytes(16).toString("hex"), Date.now()],
    );
  });

  afterAll(async () => {
    await db?.end();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("retention_days = 0 deletes nothing", async () => {
    const now = Date.now();
    await db.query("UPDATE settings SET retention_days = 0 WHERE id = 1");
    const seg = await mkSegment(now - 100 * DAY_MS, now - 100 * DAY_MS + 1000);
    const sess = await mkSession(now - 100 * DAY_MS);
    const shot = await mkScreenshot(now - 100 * DAY_MS);

    const r = await runRetentionOnce(db, config, now);
    expect(r).toMatchObject({ screenshots: 0, segments: 0, sessions: 0, cutoff: null });
    expect(await countRows("segments", "id", seg)).toBe(1);
    expect(await countRows("sessions", "id", sess)).toBe(1);
    expect(await countRows("screenshots", "id", shot.id)).toBe(1);
    expect(await exists(shot.abs)).toBe(true);
  });

  it("deletes only rows older than the cutoff and unlinks their files", async () => {
    const now = Date.now();
    await db.query("DELETE FROM segments; DELETE FROM sessions; DELETE FROM screenshots;");
    await db.query("UPDATE settings SET retention_days = 30 WHERE id = 1");

    // Old (older than 30d) — should be deleted.
    const oldSeg = await mkSegment(now - 40 * DAY_MS, now - 40 * DAY_MS + 1000);
    const oldSess = await mkSession(now - 40 * DAY_MS);
    const oldShot = await mkScreenshot(now - 40 * DAY_MS);
    // New (within 30d) — should be kept.
    const newSeg = await mkSegment(now - 10 * DAY_MS, now - 10 * DAY_MS + 1000);
    const newSess = await mkSession(now - 10 * DAY_MS);
    const newShot = await mkScreenshot(now - 10 * DAY_MS);

    const r = await runRetentionOnce(db, config, now);
    expect(r.cutoff).toBe(now - 30 * DAY_MS);
    expect(r).toMatchObject({ screenshots: 1, segments: 1, sessions: 1 });

    // Old gone (rows + file).
    expect(await countRows("segments", "id", oldSeg)).toBe(0);
    expect(await countRows("sessions", "id", oldSess)).toBe(0);
    expect(await countRows("screenshots", "id", oldShot.id)).toBe(0);
    expect(await exists(oldShot.abs)).toBe(false);
    // New kept (rows + file).
    expect(await countRows("segments", "id", newSeg)).toBe(1);
    expect(await countRows("sessions", "id", newSess)).toBe(1);
    expect(await countRows("screenshots", "id", newShot.id)).toBe(1);
    expect(await exists(newShot.abs)).toBe(true);
  });

  it("keeps a segment whose end_at is after the cutoff even if it started before", async () => {
    const now = Date.now();
    await db.query("DELETE FROM segments;");
    await db.query("UPDATE settings SET retention_days = 30 WHERE id = 1");
    const straddle = await mkSegment(now - 40 * DAY_MS, now - 5 * DAY_MS);
    const r = await runRetentionOnce(db, config, now);
    expect(r.segments).toBe(0);
    expect(await countRows("segments", "id", straddle)).toBe(1);
  });
});
