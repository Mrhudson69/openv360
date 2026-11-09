import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate, type Db } from "../src/db.js";
import { analyticsRoutes } from "../src/routes/analytics.js";
import { DAY_MS, dayStart, localDateString } from "../src/time.js";

const DATABASE_URL = process.env.DATABASE_URL;
const MIN = 60_000;

describe.skipIf(!DATABASE_URL)("analytics (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let token = "";
  const auth = () => ({ authorization: `Bearer ${token}` });

  // IDs for seeded rows.
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const carol = crypto.randomUUID();
  const engTeam = crypto.randomUUID();
  const devA = crypto.randomUUID();
  const devB = crypto.randomUUID();
  const devC = crypto.randomUUID();

  const now = Date.now();
  const today = localDateString(now, 0);
  const todayStart = dayStart(today, 0);
  const day = (k: number) => todayStart + k * DAY_MS; // local-midnight of today+k (tz=0)

  let seq = 0;
  async function seg(empId: string, startMs: number, endMs: number, idle: boolean, appName: string, title = "") {
    await db.query(
      "INSERT INTO segments (id, employee_id, device_id, start_at, end_at, idle, app, title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [crypto.randomUUID(), empId, devA, startMs, endMs, idle, appName, title],
    );
    seq++;
  }

  beforeAll(async () => {
    db = createPool(DATABASE_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const config = loadConfig({ DATABASE_URL });
    await migrate(db, config.migrationsDir);
    expect(await migrate(db, config.migrationsDir)).toEqual([]); // idempotent

    // Admin + session so requireAdmin passes.
    const adminId = crypto.randomUUID();
    await db.query("INSERT INTO admins (id, name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)", [
      adminId,
      "Admin",
      "admin@example.com",
      "scrypt$00$00",
      now,
    ]);
    token = await createSession(db, adminId);

    app = Fastify();
    await app.register(analyticsRoutes, { db, config });
    await app.ready();

    // --- Teams & employees ---
    await db.query("INSERT INTO teams (id, name, created_at) VALUES ($1,$2,$3)", [engTeam, "Eng", now]);
    const mkEmp = (id: string, name: string, teamId: string | null, teamName: string | null) =>
      db.query("INSERT INTO employees (id, name, email, team, team_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [
        id,
        name,
        null,
        teamName,
        teamId,
        now,
      ]);
    await mkEmp(alice, "Alice", engTeam, "Eng");
    await mkEmp(bob, "Bob", null, null);
    await mkEmp(carol, "Carol", null, null);

    // --- Devices: Alice online, Bob offline+suspicious, Carol never-seen ---
    const mkDev = (id: string, empId: string, lastSeen: number | null, suspiciousAt: number | null) =>
      db.query(
        `INSERT INTO devices (id, employee_id, token_hash, hostname, os, os_version, agent_version, created_at, last_seen_at, suspicious_at)
         VALUES ($1,$2,$3,$4,'linux','x','0.1.0',$5,$6,$7)`,
        [id, empId, crypto.randomUUID(), `host-${empId.slice(0, 4)}`, now, lastSeen, suspiciousAt],
      );
    await mkDev(devA, alice, now - MIN, null); // seen 1 min ago -> online
    await mkDev(devB, bob, now - 60 * MIN, now); // seen 60 min ago -> offline, flagged
    await mkDev(devC, carol, null, null); // never seen -> offline

    // --- App rules: team Eng overrides global for "slack" ---
    const mkRule = (pattern: string, category: string, teamId: string | null) =>
      db.query("INSERT INTO app_rules (id, pattern, category, team_id, created_at) VALUES ($1,$2,$3,$4,$5)", [
        crypto.randomUUID(),
        pattern,
        category,
        teamId,
        now,
      ]);
    await mkRule("code", "productive", null);
    await mkRule("youtube", "unproductive", null);
    await mkRule("slack", "unproductive", null);
    await mkRule("slack", "productive", engTeam); // team override

    // --- Segments ---
    // Alice today: 15 code (prod), 10 youtube (unprod), 10 terminal (neutral), 5 idle, 20 slack (team->prod)
    await seg(alice, day(0) + 600 * MIN, day(0) + 615 * MIN, false, "code", "main.rs");
    await seg(alice, day(0) + 620 * MIN, day(0) + 630 * MIN, false, "youtube", "cats");
    await seg(alice, day(0) + 640 * MIN, day(0) + 650 * MIN, false, "terminal", "bash");
    await seg(alice, day(0) + 660 * MIN, day(0) + 665 * MIN, true, "code", "");
    await seg(alice, day(0) + 700 * MIN, day(0) + 720 * MIN, false, "slack", "chat");
    // Alice earlier days for trend/week
    await seg(alice, day(-3) + 600 * MIN, day(-3) + 630 * MIN, false, "code", "x"); // 30m on index 3
    await seg(alice, day(-2) + 1435 * MIN, day(-2) + 1445 * MIN, false, "code", "x"); // crosses midnight: 5m idx4 + 5m idx5
    // Bob today: 10 slack (global->unprod), 20 code (prod)
    await seg(bob, day(0) + 600 * MIN, day(0) + 610 * MIN, false, "slack", "chat");
    await seg(bob, day(0) + 800 * MIN, day(0) + 820 * MIN, false, "code", "y");

    // --- Attendance-specific segments on a fixed historical week ---
    // Far in the past so it never overlaps the relative "last 7 days" window.
    // 2025-01-06 Mon (workday), 2025-01-11 Sat / 2025-01-12 Sun (non-workdays)
    const mon = dayStart("2025-01-06", 0);
    const sun = dayStart("2025-01-12", 0);
    await seg(alice, mon + 570 * MIN, mon + 600 * MIN, false, "code", "x"); // arrives 09:30 -> late
    await seg(bob, mon + 510 * MIN, mon + 540 * MIN, false, "code", "x"); // arrives 08:30 -> on time
    await seg(alice, sun + 600 * MIN, sun + 630 * MIN, false, "code", "x"); // present on a non-workday
    // Carol: no activity on Mon -> absent
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("overview: today totals, trend bucketing, top apps, attention", async () => {
    const res = await app.inject({ url: "/api/overview?tzOffsetMin=0", headers: auth() });
    expect(res.statusCode).toBe(200);
    const o = res.json();

    expect(o.headcount).toBe(3);
    expect(o.onlineNow).toBe(1); // only Alice's device seen within 3 min

    // Today totals across everyone.
    expect(o.today).toEqual({
      activeMs: 85 * MIN, // Alice 55 + Bob 30
      productiveMs: 55 * MIN, // Alice 35 (code15 + slack20 via team rule) + Bob 20 (code)
      unproductiveMs: 20 * MIN, // Alice youtube10 + Bob slack10 (global)
      neutralMs: 10 * MIN, // Alice terminal10
      idleMs: 5 * MIN,
    });
    expect(o.productivityPct).toBe(64.7); // 55/85

    // 7-day trend, oldest first, today last.
    expect(o.trend).toHaveLength(7);
    expect(o.trend[0].date).toBe(localDateString(day(-6), 0));
    expect(o.trend[6].date).toBe(today);
    expect(o.trend[6]).toMatchObject({ activeMs: 85 * MIN, productiveMs: 55 * MIN });
    expect(o.trend[3]).toMatchObject({ activeMs: 30 * MIN, productiveMs: 30 * MIN });
    expect(o.trend[4].activeMs).toBe(5 * MIN); // midnight-crossing split
    expect(o.trend[5].activeMs).toBe(5 * MIN);

    // Top apps (active only, by app name).
    const codeApp = o.topApps.find((a: { app: string }) => a.app === "code");
    expect(codeApp).toEqual({ app: "code", category: "productive", ms: 35 * MIN }); // Alice15 + Bob20
    const slackApp = o.topApps.find((a: { app: string }) => a.app === "slack");
    // Team override wins by majority ms (Alice 20 productive vs Bob 10 unproductive).
    expect(slackApp).toEqual({ app: "slack", category: "productive", ms: 30 * MIN });
    expect(o.topApps[0].app).toBe("code"); // highest ms

    // Attention.
    expect(o.attention.suspiciousDevices).toEqual([
      { deviceId: devB, hostname: `host-${bob.slice(0, 4)}`, employeeId: bob, employeeName: "Bob" },
    ]);
    const offline = o.attention.offlineAgents;
    expect(offline.map((e: { name: string }) => e.name)).toEqual(["Bob", "Carol"]);
    expect(offline.find((e: { employeeId: string }) => e.employeeId === bob).lastSeenAt).toBe(now - 60 * MIN);
    expect(offline.find((e: { employeeId: string }) => e.employeeId === carol).lastSeenAt).toBeNull();
  });

  it("week: per-day bucketing and totals for one employee", async () => {
    const res = await app.inject({ url: `/api/employees/${alice}/week?end=${today}&tzOffsetMin=0`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const w = res.json();

    expect(w.employee).toEqual({ id: alice, name: "Alice", team: "Eng", teamId: engTeam });
    expect(w.days).toHaveLength(7);
    expect(w.days[0].date).toBe(localDateString(day(-6), 0));
    expect(w.days[6].date).toBe(today);

    // Today (index 6).
    expect(w.days[6]).toMatchObject({
      activeMs: 55 * MIN,
      productiveMs: 35 * MIN,
      unproductiveMs: 10 * MIN,
      idleMs: 5 * MIN,
      firstSeen: day(0) + 600 * MIN,
      lastSeen: day(0) + 720 * MIN,
    });
    expect(w.days[3]).toMatchObject({ activeMs: 30 * MIN, productiveMs: 30 * MIN });
    expect(w.days[4].activeMs).toBe(5 * MIN); // crossing split
    expect(w.days[5].activeMs).toBe(5 * MIN);

    expect(w.totals).toEqual({
      activeMs: (55 + 30 + 5 + 5) * MIN,
      productiveMs: (35 + 30 + 5 + 5) * MIN,
      unproductiveMs: 10 * MIN,
      idleMs: 5 * MIN,
    });

    // Unknown id -> 404.
    expect((await app.inject({ url: `/api/employees/${crypto.randomUUID()}/week`, headers: auth() })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/employees/not-a-uuid/week", headers: auth() })).statusCode).toBe(404);
  });

  it("attendance: present/late/isWorkday with a non-workday and a late arrival", async () => {
    const res = await app.inject({
      url: "/api/attendance?from=2025-01-06&to=2025-01-12&tzOffsetMin=0",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();

    expect(a.schedule).toEqual({ workStartMin: 540, workEndMin: 1080, workdays: 62 });
    expect(a.dates).toEqual([
      "2025-01-06",
      "2025-01-07",
      "2025-01-08",
      "2025-01-09",
      "2025-01-10",
      "2025-01-11",
      "2025-01-12",
    ]);

    const rowOf = (id: string) => a.rows.find((r: { employeeId: string }) => r.employeeId === id);
    const cell = (id: string, date: string) =>
      rowOf(id).days.find((d: { date: string }) => d.date === date);

    // Alice late on Mon 2025-01-06 (arrived 09:30 > 09:00 on a workday).
    expect(cell(alice, "2025-01-06")).toMatchObject({
      present: true,
      late: true,
      isWorkday: true,
      activeMs: 30 * MIN,
    });
    // Bob on time on Mon (08:30 < 09:00).
    expect(cell(bob, "2025-01-06")).toMatchObject({ present: true, late: false, isWorkday: true });
    // Carol absent on a workday.
    expect(cell(carol, "2025-01-06")).toMatchObject({ present: false, late: false, isWorkday: true });
    // Alice present on Sun 2025-01-12 (non-workday): never counts as late.
    expect(cell(alice, "2025-01-12")).toMatchObject({ present: true, late: false, isWorkday: false });
    // Sat 2025-01-11 is a non-workday with no activity.
    expect(cell(alice, "2025-01-11")).toMatchObject({ present: false, isWorkday: false });

    // Rows ordered by name.
    expect(a.rows.map((r: { name: string }) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("attendance.csv: headers, rows and content-type", async () => {
    const res = await app.inject({
      url: "/api/attendance.csv?from=2025-01-06&to=2025-01-06&tzOffsetMin=0",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("openv360-attendance-2025-01-06_2025-01-06.csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("Employee,Team,Date,First seen,Last seen,Active (min),Present,Late");
    // Alice: late Monday, 09:30-10:00, 30 active min.
    expect(lines.some((l) => l.startsWith("Alice,Eng,2025-01-06,09:30,10:00,30,yes,yes"))).toBe(true);
    // Bob: on time 08:30-09:00.
    expect(lines.some((l) => l.startsWith("Bob,,2025-01-06,08:30,09:00,30,yes,no"))).toBe(true);
    // Carol: absent.
    expect(lines.some((l) => l.startsWith("Carol,,2025-01-06,,,0,no,no"))).toBe(true);
  });

  it("requires admin auth", async () => {
    expect((await app.inject({ url: "/api/overview" })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/employees/${alice}/week` })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/attendance" })).statusCode).toBe(401);
  });

  it("attendance defaults to the last 7 days when no range is given", async () => {
    const res = await app.inject({ url: "/api/attendance?tzOffsetMin=0", headers: auth() });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.dates).toHaveLength(7);
    expect(a.dates[6]).toBe(today);
    expect(a.dates[0]).toBe(localDateString(day(-6), 0));
  });
});
