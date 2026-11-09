import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate, type Db } from "../src/db.js";
import { createFirstAdmin } from "../src/routes/admin.js";

const DATABASE_URL = process.env.DATABASE_URL;

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer; type: string }) {
  const boundary = "----openv360" + crypto.randomBytes(8).toString("hex");
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!DATABASE_URL)("integration (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let dataDir: string;
  let admin = "";
  let device = "";
  let employeeId = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    db = createPool(DATABASE_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-test-"));
    const installerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-inst-"));
    await fs.writeFile(path.join(installerDir, "install.sh"), "SERVER=__OPENV360_SERVER_URL__\nBASE=__OPENV360_RELEASE_BASE__\n");
    await fs.writeFile(path.join(installerDir, "uninstall.sh"), "UNINSTALL __OPENV360_SERVER_URL__\n");
    const config = { ...loadConfig({ DATABASE_URL, DATA_DIR: dataDir, INSTALLER_DIR: installerDir }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    expect(await migrate(db, config.migrationsDir)).toEqual([]); // idempotent
    app = await buildApp(db, config);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("runs first-time setup once", async () => {
    expect((await app.inject("/api/auth/status")).json()).toEqual({ needsSetup: true, orgName: "openv360" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { name: "Admin", email: "Admin@Example.com", password: "supersecret", orgName: "Acme" },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject("/api/auth/status")).json()).toEqual({ needsSetup: false, orgName: "Acme" });
    // Env bootstrap path must never overwrite an existing admin.
    expect(await createFirstAdmin(db, { name: "B", email: "b@example.com", password: "supersecret", orgName: "Other" })).toBeNull();
    admin = res.json().token;
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { name: "X", email: "x@example.com", password: "supersecret" },
    });
    expect(again.statusCode).toBe(409);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "supersecret" },
    });
    expect(login.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "nope" } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ url: "/api/employees" })).statusCode).toBe(401);
  });

  it("enrolls a device with a single-use code", async () => {
    const res = await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Jane Doe", team: "Eng" } });
    expect(res.statusCode).toBe(200);
    employeeId = res.json().employee.id;
    const code: string = res.json().enrollmentCode;
    const body = { code: code.toLowerCase(), device: { hostname: "lap", os: "linux", osVersion: "Ubuntu 24.04", agentVersion: "0.1.0" } };
    const enr = await app.inject({ method: "POST", url: "/api/agent/enroll", payload: body });
    expect(enr.statusCode).toBe(200);
    expect(enr.json().employee.name).toBe("Jane Doe");
    expect(enr.json().settings.screenshotIntervalSec).toBe(600);
    device = enr.json().deviceToken;
    const reuse = await app.inject({ method: "POST", url: "/api/agent/enroll", payload: body });
    expect(reuse.statusCode).toBe(400);
    expect((await app.inject({ url: "/api/agent/me", headers: auth(device) })).json().employee.id).toBe(employeeId);
  });

  it("ingests sessions, activity and screenshots idempotently", async () => {
    const MIN = 60_000;
    // Use a recent past UTC day so every timestamp is in the past but within the 30-day window,
    // regardless of the wall clock when the test runs. Segments stay under the 20-minute cap.
    const day = Math.floor((Date.now() - 2 * 24 * 3600 * 1000) / (24 * 3600 * 1000)) * 24 * 3600 * 1000;
    const date = new Date(day).toISOString().slice(0, 10);
    const nextDate = new Date(day + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const m = (n: number) => day + n * MIN;
    const s1 = crypto.randomUUID();
    const sess = { events: [{ id: s1, kind: "clock_in", at: m(540) }, { id: crypto.randomUUID(), kind: "clock_out", at: m(1020) }] };
    expect((await app.inject({ method: "POST", url: "/api/agent/sessions", headers: auth(device), payload: sess })).json()).toMatchObject({ accepted: 2 });
    await app.inject({ method: "POST", url: "/api/agent/sessions", headers: auth(device), payload: sess });

    await app.inject({ method: "POST", url: "/api/app-rules", headers: auth(admin), payload: { pattern: "code", category: "productive" } });
    await app.inject({ method: "POST", url: "/api/app-rules", headers: auth(admin), payload: { pattern: "youtube", category: "unproductive" } });

    const segs = {
      segments: [
        { id: crypto.randomUUID(), start: m(540), end: m(555), idle: false, app: "code", title: "main.rs" }, // 15m productive
        { id: crypto.randomUUID(), start: m(555), end: m(560), idle: true, app: "code", title: "" }, // 5m idle
        { id: crypto.randomUUID(), start: m(560), end: m(570), idle: false, app: "firefox", title: "Cats - YouTube" }, // 10m unproductive
        { id: crypto.randomUUID(), start: m(570), end: m(580), idle: false, app: "terminal", title: "bash" }, // 10m neutral
        { id: crypto.randomUUID(), start: m(1435), end: m(1445), idle: false, app: "code", title: "late" }, // crosses midnight: 5m on `date`
      ],
    };
    expect((await app.inject({ method: "POST", url: "/api/agent/activity", headers: auth(device), payload: segs })).json()).toMatchObject({ accepted: 5, dropped: 0 });
    await app.inject({ method: "POST", url: "/api/agent/activity", headers: auth(device), payload: segs }); // dup

    // Invalid segments are now silently dropped and flag the device, not rejected with 400.
    const badSeg = { segments: [
      { id: crypto.randomUUID(), start: m(120), end: m(60), idle: false, app: "x", title: "" }, // end < start
      { id: crypto.randomUUID(), start: m(0), end: m(40), idle: false, app: "x", title: "" }, // 40m > 20m cap
      { id: crypto.randomUUID(), start: Date.now() + 10 * MIN, end: Date.now() + 11 * MIN, idle: false, app: "x", title: "" }, // future
    ] };
    const badRes = await app.inject({ method: "POST", url: "/api/agent/activity", headers: auth(device), payload: badSeg });
    expect(badRes.statusCode).toBe(200);
    expect(badRes.json()).toEqual({ accepted: 0, dropped: 3 });

    const shotId = crypto.randomUUID();
    const mp = multipart({ id: shotId, takenAt: String(m(550)) }, { name: "s.png", data: PNG, type: "image/png" });
    const up = await app.inject({ method: "POST", url: "/api/agent/screenshots", headers: { ...auth(device), ...mp.headers }, payload: mp.payload });
    expect(up.statusCode).toBe(200);
    const up2 = await app.inject({ method: "POST", url: "/api/agent/screenshots", headers: { ...auth(device), ...mp.headers }, payload: mp.payload });
    expect(up2.json()).toEqual({ accepted: 1 });
    const notImg = multipart({ id: crypto.randomUUID(), takenAt: String(m(550)) }, { name: "x.png", data: Buffer.from("hello"), type: "image/png" });
    expect((await app.inject({ method: "POST", url: "/api/agent/screenshots", headers: { ...auth(device), ...notImg.headers }, payload: notImg.payload })).statusCode).toBe(415);
    const oldShot = multipart({ id: crypto.randomUUID(), takenAt: String(Date.now() - 40 * 24 * 3600 * 1000) }, { name: "old.png", data: PNG, type: "image/png" });
    expect((await app.inject({ method: "POST", url: "/api/agent/screenshots", headers: { ...auth(device), ...oldShot.headers }, payload: oldShot.payload })).statusCode).toBe(400);

    const dayRes = await app.inject({ url: `/api/employees/${employeeId}/day?date=${date}&tzOffsetMin=0`, headers: auth(admin) });
    expect(dayRes.statusCode).toBe(200);
    const d = dayRes.json();
    expect(d.segments).toHaveLength(5);
    expect(d.sessions).toHaveLength(2);
    expect(d.screenshots).toEqual([{ id: shotId, takenAt: m(550) }]);
    expect(d.totals.activeMs).toBe((15 + 10 + 10 + 5) * MIN);
    expect(d.totals.idleMs).toBe(5 * MIN);
    expect(d.totals.productiveMs).toBe((15 + 5) * MIN);
    expect(d.totals.unproductiveMs).toBe(10 * MIN);
    expect(d.totals.neutralMs).toBe(10 * MIN);
    expect(d.totals.firstSeen).toBe(m(540));
    expect(d.totals.lastSeen).toBe(m(1440));
    expect(d.apps[0]).toMatchObject({ app: "code", category: "productive", ms: 20 * MIN });

    // The device tripped the drop rules above, so it is now flagged.
    const flagged = (await app.inject({ url: "/api/employees", headers: auth(admin) })).json().employees.find((e: { id: string }) => e.id === employeeId);
    expect(flagged.devices[0].suspicious).toBe(true);

    const img = await app.inject({ url: `/api/screenshots/${shotId}/image?token=${admin}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(img.rawPayload, PNG)).toBe(0);

    const rep = await app.inject({ url: `/api/reports/summary?from=${date}&to=${nextDate}&tzOffsetMin=0`, headers: auth(admin) });
    expect(rep.json().rows[0]).toMatchObject({ name: "Jane Doe", activeMs: (40 + 5) * MIN, productiveMs: (20 + 5) * MIN });
    const csv = await app.inject({ url: `/api/reports/summary.csv?from=${date}&to=${date}`, headers: auth(admin) });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("Jane Doe,0.67"); // 40 active minutes = 0.67h

    expect((await app.inject({ method: "DELETE", url: `/api/screenshots/${shotId}`, headers: auth(admin) })).json()).toEqual({ ok: true });
  });

  it("drops screenshots over the hourly cap", async () => {
    // Fresh employee + device so the cap window is clean.
    const emp = (await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Cap Tester" } })).json();
    const enr = (await app.inject({ method: "POST", url: "/api/agent/enroll", payload: { code: emp.enrollmentCode, device: { hostname: "h", os: "linux", osVersion: "Ubuntu 26.04", agentVersion: "0.1.0" } } })).json();
    const dt = enr.deviceToken;
    const base = Math.floor((Date.now() - 24 * 3600 * 1000) / 3_600_000) * 3_600_000; // a past clock hour
    let lastStatus = 0;
    for (let i = 0; i <= 50; i++) {
      const mp = multipart({ id: crypto.randomUUID(), takenAt: String(base + i * 1000) }, { name: "s.png", data: PNG, type: "image/png" });
      lastStatus = (await app.inject({ method: "POST", url: "/api/agent/screenshots", headers: { ...auth(dt), ...mp.headers }, payload: mp.payload })).statusCode;
    }
    expect(lastStatus).toBe(429); // the 51st within the hour is dropped
    const day = new Date(base).toISOString().slice(0, 10);
    const d = (await app.inject({ url: `/api/employees/${emp.employee.id}/day?date=${day}&tzOffsetMin=0`, headers: auth(admin) })).json();
    expect(d.screenshots).toHaveLength(50);
    await app.inject({ method: "DELETE", url: `/api/employees/${emp.employee.id}`, headers: auth(admin) });
  });

  it("issues and clears remote device commands", async () => {
    const emp = (await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Cmd Tester" } })).json();
    const enr = (await app.inject({ method: "POST", url: "/api/agent/enroll", payload: { code: emp.enrollmentCode, device: { hostname: "h", os: "windows", osVersion: "11", agentVersion: "0.1.0" } } })).json();
    const dt = enr.deviceToken;
    expect((await app.inject({ url: "/api/agent/me", headers: auth(dt) })).json().command).toBe("none");
    const devId = (await app.inject({ url: "/api/employees", headers: auth(admin) })).json().employees.find((e: { id: string }) => e.id === emp.employee.id).devices[0].id;
    for (const [action, expected] of [["stop", "stop"], ["resume", "none"], ["uninstall", "uninstall"]] as const) {
      expect((await app.inject({ method: "POST", url: `/api/devices/${devId}/${action}`, headers: auth(admin) })).json()).toEqual({ ok: true, command: expected });
      expect((await app.inject({ url: "/api/agent/me", headers: auth(dt) })).json().command).toBe(expected);
    }
    expect((await app.inject({ method: "POST", url: `/api/devices/${crypto.randomUUID()}/stop`, headers: auth(admin) })).statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: `/api/employees/${emp.employee.id}`, headers: auth(admin) });
  });

  it("updates settings and revokes devices", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin), payload: { screenshotIntervalSec: 300, screenshotBlur: true, orgName: "  Acme Corp " } });
    expect(put.json()).toMatchObject({ orgName: "Acme Corp", screenshotIntervalSec: 300, screenshotBlur: true, screenshotsEnabled: true });
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin), payload: { orgName: "   " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin), payload: { screenshotIntervalSec: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/agent/settings", headers: auth(device) })).json().screenshotIntervalSec).toBe(300);

    const emps = (await app.inject({ url: "/api/employees", headers: auth(admin) })).json().employees;
    expect(emps[0].devices).toHaveLength(1);
    const devId = emps[0].devices[0].id;
    await app.inject({ method: "DELETE", url: `/api/devices/${devId}`, headers: auth(admin) });
    expect((await app.inject({ url: "/api/agent/me", headers: auth(device) })).statusCode).toBe(401);

    expect((await app.inject({ method: "DELETE", url: `/api/employees/${employeeId}`, headers: auth(admin) })).json()).toEqual({ ok: true });
  });

  it("serves installers and downloads", async () => {
    const sh = await app.inject({ url: "/install.sh", headers: { host: "track.example.com", "x-forwarded-proto": "https" } });
    expect(sh.statusCode).toBe(200);
    expect(sh.body).toBe("SERVER=https://track.example.com\nBASE=https://track.example.com/downloads\n");
    expect((await app.inject({ url: "/install.sh", headers: { host: "evil$(rm -rf)" } })).statusCode).toBe(400);
    expect((await app.inject("/install.ps1")).statusCode).toBe(404);
    const un = await app.inject({ url: "/uninstall.sh", headers: { host: "track.example.com", "x-forwarded-proto": "https" } });
    expect(un.statusCode).toBe(200);
    expect(un.body).toBe("UNINSTALL https://track.example.com\n");
    expect((await app.inject("/uninstall.ps1")).statusCode).toBe(404);
    expect((await app.inject("/downloads/missing.deb")).statusCode).toBe(404);
    expect((await app.inject("/downloads/..%2Fetc")).statusCode).toBe(404);
  });

  it("manages teams and scopes app rules per team", async () => {
    // --- Team CRUD ---
    const t1 = await app.inject({ method: "POST", url: "/api/teams", headers: auth(admin), payload: { name: "Engineering" } });
    expect(t1.statusCode).toBe(200);
    expect(t1.json().team).toMatchObject({ name: "Engineering", memberCount: 0, ruleCount: 0 });
    const teamId: string = t1.json().team.id;
    // Duplicate name -> 400
    expect((await app.inject({ method: "POST", url: "/api/teams", headers: auth(admin), payload: { name: "Engineering" } })).statusCode).toBe(400);
    // Whitespace-only name -> 400
    expect((await app.inject({ method: "POST", url: "/api/teams", headers: auth(admin), payload: { name: "   " } })).statusCode).toBe(400);
    // Rename
    const ren = await app.inject({ method: "PATCH", url: `/api/teams/${teamId}`, headers: auth(admin), payload: { name: "Platform" } });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().team).toMatchObject({ id: teamId, name: "Platform", memberCount: 0 });
    // Rename unknown -> 404
    expect((await app.inject({ method: "PATCH", url: `/api/teams/${crypto.randomUUID()}`, headers: auth(admin), payload: { name: "X" } })).statusCode).toBe(404);
    // Rename collision -> 400
    const t2 = (await app.inject({ method: "POST", url: "/api/teams", headers: auth(admin), payload: { name: "Sales" } })).json().team;
    expect((await app.inject({ method: "PATCH", url: `/api/teams/${t2.id}`, headers: auth(admin), payload: { name: "Platform" } })).statusCode).toBe(400);

    // --- Employee assignment ---
    const emp = (await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Team Member", teamId } })).json();
    expect(emp.employee).toMatchObject({ team: "Platform", teamId });
    const solo = (await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Solo" } })).json();
    expect(solo.employee.teamId).toBeNull();
    // Back-compat: team name string resolves-or-creates a team
    const byName = (await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "ByName", team: "Support" } })).json();
    expect(byName.employee.team).toBe("Support");
    expect(byName.employee.teamId).toBeTruthy();
    // Invalid / unknown teamId on create -> 400
    expect((await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Bad", teamId: "nope" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/employees", headers: auth(admin), payload: { name: "Bad", teamId: crypto.randomUUID() } })).statusCode).toBe(400);

    // memberCount + members list
    const teams = (await app.inject({ url: "/api/teams", headers: auth(admin) })).json().teams;
    expect(teams.find((t: any) => t.id === teamId).memberCount).toBe(1);
    expect((await app.inject({ url: `/api/teams/${teamId}/members`, headers: auth(admin) })).json().members).toEqual([
      { id: emp.employee.id, name: "Team Member", email: null },
    ]);

    // --- Rules: global slack->unproductive, team slack->productive ---
    const gRule = await app.inject({ method: "POST", url: "/api/app-rules", headers: auth(admin), payload: { pattern: "slack", category: "unproductive" } });
    expect(gRule.json().rule).toMatchObject({ pattern: "slack", category: "unproductive", teamId: null });
    const tRule = await app.inject({ method: "POST", url: "/api/app-rules", headers: auth(admin), payload: { pattern: "slack", category: "productive", teamId } });
    expect(tRule.json().rule).toMatchObject({ pattern: "slack", category: "productive", teamId });
    // GET global-only (no teamId)
    const globals = (await app.inject({ url: "/api/app-rules", headers: auth(admin) })).json().rules;
    expect(globals.every((r: any) => r.teamId === null)).toBe(true);
    expect(globals.some((r: any) => r.pattern === "slack")).toBe(true);
    // GET team-scoped
    expect((await app.inject({ url: `/api/app-rules?teamId=${teamId}`, headers: auth(admin) })).json().rules).toEqual([
      { id: tRule.json().rule.id, pattern: "slack", category: "productive", teamId },
    ]);
    // Malformed teamId -> 400; unknown team on POST -> 400
    expect((await app.inject({ url: "/api/app-rules?teamId=nope", headers: auth(admin) })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/app-rules", headers: auth(admin), payload: { pattern: "x", category: "neutral", teamId: crypto.randomUUID() } })).statusCode).toBe(400);
    // ruleCount on the team
    expect((await app.inject({ url: "/api/teams", headers: auth(admin) })).json().teams.find((t: any) => t.id === teamId).ruleCount).toBe(1);

    // --- Categorisation: team rule overrides global ---
    const MIN = 60_000;
    const day = Math.floor((Date.now() - 2 * 24 * 3600 * 1000) / (24 * 3600 * 1000)) * 24 * 3600 * 1000;
    const date = new Date(day).toISOString().slice(0, 10);
    const enroll = async (e: any) =>
      (await app.inject({ method: "POST", url: "/api/agent/enroll", payload: { code: e.enrollmentCode, device: { hostname: "h", os: "linux", osVersion: "x", agentVersion: "0.1.0" } } })).json().deviceToken;
    const dtTeam = await enroll(emp);
    const dtSolo = await enroll(solo);
    const slackSeg = { segments: [{ id: crypto.randomUUID(), start: day + 600 * MIN, end: day + 610 * MIN, idle: false, app: "slack", title: "chat" }] };
    await app.inject({ method: "POST", url: "/api/agent/activity", headers: auth(dtTeam), payload: slackSeg });
    await app.inject({ method: "POST", url: "/api/agent/activity", headers: auth(dtSolo), payload: { segments: [{ ...slackSeg.segments[0], id: crypto.randomUUID() }] } });

    const dayTeam = (await app.inject({ url: `/api/employees/${emp.employee.id}/day?date=${date}&tzOffsetMin=0`, headers: auth(admin) })).json();
    expect(dayTeam.employee).toMatchObject({ team: "Platform", teamId });
    expect(dayTeam.segments[0].category).toBe("productive");
    expect(dayTeam.totals.productiveMs).toBe(10 * MIN);
    const daySolo = (await app.inject({ url: `/api/employees/${solo.employee.id}/day?date=${date}&tzOffsetMin=0`, headers: auth(admin) })).json();
    expect(daySolo.segments[0].category).toBe("unproductive");
    expect(daySolo.totals.unproductiveMs).toBe(10 * MIN);
    // Report summary respects per-team rules too
    const rep = (await app.inject({ url: `/api/reports/summary?from=${date}&to=${date}&tzOffsetMin=0`, headers: auth(admin) })).json().rows;
    expect(rep.find((r: any) => r.employeeId === emp.employee.id).productiveMs).toBe(10 * MIN);
    expect(rep.find((r: any) => r.employeeId === solo.employee.id).unproductiveMs).toBe(10 * MIN);

    // --- PATCH employee: unassign then reassign ---
    const upd = await app.inject({ method: "PATCH", url: `/api/employees/${emp.employee.id}`, headers: auth(admin), payload: { teamId: null } });
    expect(upd.json().employee).toMatchObject({ teamId: null, team: null });
    expect((await app.inject({ url: `/api/employees/${emp.employee.id}/day?date=${date}&tzOffsetMin=0`, headers: auth(admin) })).json().segments[0].category).toBe("unproductive");
    expect((await app.inject({ method: "PATCH", url: `/api/employees/${emp.employee.id}`, headers: auth(admin), payload: { teamId: "bad" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/employees/${emp.employee.id}`, headers: auth(admin), payload: { teamId: crypto.randomUUID() } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/employees/${crypto.randomUUID()}`, headers: auth(admin), payload: { name: "Z" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/employees/${emp.employee.id}`, headers: auth(admin), payload: { teamId } })).json().employee.teamId).toBe(teamId);

    // --- DELETE team: members unassigned, rules cascade-deleted ---
    expect((await app.inject({ method: "DELETE", url: `/api/teams/${teamId}`, headers: auth(admin) })).json()).toEqual({ ok: true });
    const after = (await app.inject({ url: "/api/employees", headers: auth(admin) })).json().employees.find((e: any) => e.id === emp.employee.id);
    expect(after.teamId).toBeNull();
    expect(after.team).toBeNull();
    // Global slack rule still present; team rule gone -> slack reverts to unproductive
    expect((await app.inject({ url: "/api/app-rules", headers: auth(admin) })).json().rules.some((r: any) => r.pattern === "slack")).toBe(true);
    expect((await app.inject({ url: `/api/employees/${emp.employee.id}/day?date=${date}&tzOffsetMin=0`, headers: auth(admin) })).json().segments[0].category).toBe("unproductive");
  });
});

describe.skipIf(!DATABASE_URL)("teams migration backfill (postgres)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createPool(DATABASE_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });
  afterAll(async () => {
    await db?.end();
  });

  it("creates teams from distinct employees.team strings and links members", async () => {
    const migrationsDir = loadConfig({ DATABASE_URL }).migrationsDir;
    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const backfill = files.find((f) => f.startsWith("004_"))!; // 004_teams.sql (robust to later migrations)
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-mig-"));
    // Migrate everything BEFORE the backfill, seed pre-migration data, then apply it.
    for (const f of files.filter((x) => x < backfill)) await fs.copyFile(path.join(migrationsDir, f), path.join(tmp, f));
    await migrate(db, tmp);

    const mkEmp = async (name: string, team: string | null) =>
      (await db.query<{ id: string }>("INSERT INTO employees (id, name, email, team, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
        crypto.randomUUID(), name, null, team, Date.now(),
      ])).rows[0]!.id;
    const a = await mkEmp("A", "Eng");
    const b = await mkEmp("B", "Eng "); // trims to the same team
    const c = await mkEmp("C", "Sales");
    const d = await mkEmp("D", null);
    const e = await mkEmp("E", "   "); // whitespace only -> no team
    await db.query("INSERT INTO app_rules (id, pattern, category, created_at) VALUES ($1,'code','productive',$2)", [crypto.randomUUID(), Date.now()]);

    await fs.copyFile(path.join(migrationsDir, backfill), path.join(tmp, backfill));
    expect(await migrate(db, tmp)).toEqual([backfill]);

    expect((await db.query<{ name: string }>("SELECT name FROM teams ORDER BY name")).rows.map((r) => r.name)).toEqual(["Eng", "Sales"]);
    const teamOf = async (id: string) =>
      (await db.query<{ name: string | null }>("SELECT t.name FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = $1", [id])).rows[0]!.name;
    expect(await teamOf(a)).toBe("Eng");
    expect(await teamOf(b)).toBe("Eng");
    expect(await teamOf(c)).toBe("Sales");
    expect(await teamOf(d)).toBeNull();
    expect(await teamOf(e)).toBeNull();
    // Pre-existing rules become global (team_id NULL).
    expect((await db.query<{ team_id: string | null }>("SELECT team_id FROM app_rules WHERE pattern = 'code'")).rows[0]!.team_id).toBeNull();

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
