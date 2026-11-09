import crypto from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate, type Db } from "../src/db.js"; // importing db.js also registers the INT8->number parser
import { createSession } from "../src/auth.js";
import { createFirstAdmin } from "../src/routes/admin.js";
import { reportRoutes } from "../src/routes/reports.js";
import { buildAndSendReport, periodRange, periodKey, runReportTick, startReportScheduler } from "../src/reports.js";

const DATABASE_URL = process.env.DATABASE_URL;
const HOUR = 3_600_000;

const { sentMails } = vi.hoisted(() => ({ sentMails: [] as Record<string, unknown>[] }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (msg: Record<string, unknown>) => {
        sentMails.push(msg);
        return { messageId: "test" };
      },
    }),
  },
}));

describe.skipIf(!DATABASE_URL)("reports (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let config: ReturnType<typeof loadConfig>;
  let token = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  // 2026-11-09 10:00 UTC. With tz=0, "today" starts at 2026-11-09 00:00 UTC,
  // so the daily report covers all of 2026-11-08.
  const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
  const Y_START = Date.UTC(2026, 10, 8); // yesterday 00:00

  async function mkEmployee(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO employees (id, name, email, team, created_at) VALUES ($1,$2,$3,$4,$5)", [id, name, null, null, Date.now()]);
    return id;
  }
  async function mkDevice(empId: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO devices (id, employee_id, token_hash, hostname, os, os_version, agent_version, created_at)
       VALUES ($1,$2,$3,'host','linux','x','0.1.0',$4)`,
      [id, empId, crypto.randomBytes(16).toString("hex"), Date.now()],
    );
    return id;
  }
  async function mkSegment(empId: string, devId: string, start: number, end: number, idle: boolean, appName: string, title = ""): Promise<void> {
    await db.query("INSERT INTO segments (id, employee_id, device_id, start_at, end_at, idle, app, title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      crypto.randomUUID(), empId, devId, start, end, idle, appName, title,
    ]);
  }

  beforeAll(async () => {
    const SCHEMA = "reports_test";
    const boot = new pg.Pool({ connectionString: DATABASE_URL! });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await boot.end();
    db = new pg.Pool({ connectionString: DATABASE_URL!, options: `-c search_path=${SCHEMA},public` });
    config = { ...loadConfig({ DATABASE_URL }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    const owner = await createFirstAdmin(db, { name: "Owner", email: "owner@example.com", password: "supersecret", orgName: "Acme" });
    token = await createSession(db, owner!.id);
    app = Fastify();
    await app.register(reportRoutes, { db, config });

    // One employee with 4h of "code" (productive) and 1h idle, all on 2026-11-08.
    const e = await mkEmployee("Alice Active");
    const d = await mkDevice(e);
    await mkSegment(e, d, Y_START + 9 * HOUR, Y_START + 13 * HOUR, false, "code", "main.rs");
    await mkSegment(e, d, Y_START + 13 * HOUR, Y_START + 14 * HOUR, true, "code", "");
    await db.query("INSERT INTO app_rules (id, pattern, category, team_id, created_at) VALUES ($1,'code','productive',NULL,$2)", [
      crypto.randomUUID(), Date.now(),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("buckets daily and weekly periods and keys", () => {
    const daily = periodRange(NOW, 0, "daily");
    expect(daily.from).toBe("2026-11-08");
    expect(daily.to).toBe("2026-11-08");
    expect(daily.start).toBe(Y_START);
    expect(daily.end).toBe(Date.UTC(2026, 10, 9));

    const weekly = periodRange(NOW, 0, "weekly");
    expect(weekly.from).toBe("2026-11-02");
    expect(weekly.to).toBe("2026-11-08");
    expect(weekly.end - weekly.start).toBe(7 * 24 * HOUR);

    expect(periodKey(NOW, 0, "daily")).toBe("2026-11-09");
    expect(periodKey(NOW, 0, "weekly")).toMatch(/^2026-W\d{2}$/);
  });

  it("composes report content with names, totals, and top apps, then sends", async () => {
    sentMails.length = 0;
    await db.query("UPDATE settings SET smtp_host='smtp.test', smtp_from='rep@test', smtp_secure='starttls', report_tz_offset_min=0 WHERE id=1");
    const res = await buildAndSendReport(db, config, { period: "daily", now: NOW, to: ["boss@example.com"] });
    expect(res).toEqual({ sent: true, recipients: ["boss@example.com"] });

    const mail = sentMails.at(-1)!;
    expect(mail.to).toBe("boss@example.com");
    const text = String(mail.text);
    expect(text).toContain("Acme");
    expect(text).toContain("Alice Active");
    expect(text).toContain("4.00"); // 4h active/productive
    expect(text).toContain("code"); // top app
    expect(String(mail.subject)).toContain("Daily");
    expect(String(mail.html)).toContain("Alice Active");
  });

  it("returns an error when there are no recipients", async () => {
    const res = await buildAndSendReport(db, config, { period: "daily", now: NOW, to: [] });
    expect(res).toMatchObject({ sent: false, error: "no recipients" });
  });

  it("scheduler sends at most once per period (report_runs dedupe)", async () => {
    sentMails.length = 0;
    await db.query(
      "UPDATE settings SET report_schedule='daily', report_hour=0, report_recipients='boss@example.com', report_tz_offset_min=0, smtp_host='smtp.test', smtp_from='rep@test' WHERE id=1",
    );

    const first = await runReportTick(db, config, NOW);
    expect(first.sent).toBe(true);
    expect(sentMails.length).toBe(1);

    // Same period again -> claimed already, nothing sent.
    const second = await runReportTick(db, config, NOW + 5 * 60_000);
    expect(second.sent).toBe(false);
    expect(sentMails.length).toBe(1);

    const { rows } = await db.query<{ period_key: string }>("SELECT period_key FROM report_runs");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.period_key).toBe("2026-11-09");
  });

  it("does nothing when schedule is off or before the hour", async () => {
    await db.query("UPDATE settings SET report_schedule='off' WHERE id=1");
    expect((await runReportTick(db, config, NOW)).skipped).toBe("off");

    await db.query("UPDATE settings SET report_schedule='daily', report_hour=23 WHERE id=1");
    // NOW is 10:00 local (tz=0) which is before hour 23.
    expect((await runReportTick(db, config, NOW)).skipped).toBe("before hour");
  });

  it("send-now endpoint triggers a report (owner-only)", async () => {
    expect((await app.inject({ method: "POST", url: "/api/reports/send-now", payload: {} })).statusCode).toBe(401);

    sentMails.length = 0;
    await db.query("UPDATE settings SET smtp_host='smtp.test', smtp_from='rep@test' WHERE id=1");
    const res = await app.inject({
      method: "POST",
      url: "/api/reports/send-now",
      headers: auth(token),
      payload: { period: "daily", to: ["ceo@example.com"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, recipients: ["ceo@example.com"] });
    expect(sentMails.length).toBe(1);

    // Bad period -> 400.
    expect(
      (await app.inject({ method: "POST", url: "/api/reports/send-now", headers: auth(token), payload: { period: "yearly" } })).statusCode,
    ).toBe(400);
  });

  it("startReportScheduler returns a stop function", () => {
    const stop = startReportScheduler(db, config);
    expect(typeof stop).toBe("function");
    stop();
  });
});
