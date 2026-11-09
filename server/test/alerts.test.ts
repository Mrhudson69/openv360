import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate, type Db } from "../src/db.js"; // importing db.js also registers the INT8->number parser
import { deliver, evaluateOnce, type DeliverFn } from "../src/alerts.js";

const DATABASE_URL = process.env.DATABASE_URL;
const MIN = 60_000;

// A deterministic delivery stub so detection tests never touch the network.
const okDeliver: DeliverFn = async () => ({ delivered: true, error: null });

describe.skipIf(!DATABASE_URL)("alerts (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let admin = "";
  // Local capture server stands in for a real Slack/webhook endpoint.
  let capture: http.Server;
  let captureUrl = "";
  let lastBody: unknown = null;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function mkEmployee(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO employees (id, name, email, team, created_at) VALUES ($1,$2,$3,$4,$5)", [
      id, name, null, null, Date.now(),
    ]);
    return id;
  }
  async function mkDevice(empId: string, hostname: string, lastSeenAt: number | null, suspiciousAt: number | null = null): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO devices (id, employee_id, token_hash, hostname, os, os_version, agent_version, created_at, last_seen_at, suspicious_at)
       VALUES ($1,$2,$3,$4,'linux','x','0.1.0',$5,$6,$7)`,
      [id, empId, crypto.randomBytes(16).toString("hex"), hostname, Date.now(), lastSeenAt, suspiciousAt],
    );
    return id;
  }
  async function mkSegment(empId: string, devId: string, start: number, end: number, idle: boolean, appName: string, title = ""): Promise<void> {
    await db.query(
      "INSERT INTO segments (id, employee_id, device_id, start_at, end_at, idle, app, title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [crypto.randomUUID(), empId, devId, start, end, idle, appName, title],
    );
  }
  async function mkSession(empId: string, devId: string, kind: "clock_in" | "clock_out", at: number): Promise<void> {
    await db.query("INSERT INTO sessions (id, employee_id, device_id, kind, at) VALUES ($1,$2,$3,$4,$5)", [
      crypto.randomUUID(), empId, devId, kind, at,
    ]);
  }
  async function eventsForRule(ruleId: string) {
    const { rows } = await db.query<{ message: string; delivered: boolean; delivery_error: string | null; employee_id: string | null; device_id: string | null }>(
      "SELECT message, delivered, delivery_error, employee_id, device_id FROM alert_events WHERE rule_id = $1 ORDER BY created_at",
      [ruleId],
    );
    return rows;
  }
  async function createRule(body: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/alerts/rules", headers: auth(admin), payload: body });
  }

  beforeAll(async () => {
    // Run in a dedicated schema so this file is isolated from integration.test.ts,
    // which resets `public` — vitest runs test files in parallel.
    const SCHEMA = "alerts_test";
    const boot = new pg.Pool({ connectionString: DATABASE_URL! });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await boot.end();
    db = new pg.Pool({ connectionString: DATABASE_URL!, options: `-c search_path=${SCHEMA},public` });
    const config = { ...loadConfig({ DATABASE_URL }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    app = await buildApp(db, config);
    // buildApp already registers alertsRoutes (wired in app.ts).
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { name: "Admin", email: "admin@example.com", password: "supersecret" },
    });
    admin = setup.json().token;

    capture = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { lastBody = JSON.parse(Buffer.concat(chunks).toString()); } catch { lastBody = null; }
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
    const addr = capture.address();
    if (addr && typeof addr === "object") captureUrl = `http://127.0.0.1:${addr.port}/hook`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await new Promise<void>((resolve) => capture?.close(() => resolve()));
  });

  it("validates and CRUDs alert rules", async () => {
    const ok = await createRule({ type: "idle_too_long", name: "Idle 15m", params: { minutes: 15 }, channelKind: "slack", channelTarget: captureUrl });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rule).toMatchObject({ type: "idle_too_long", name: "Idle 15m", channelKind: "slack", channelTarget: captureUrl, enabled: true });
    expect(ok.json().rule.params).toEqual({ minutes: 15 });
    const id: string = ok.json().rule.id;

    // Validation: bad enums / empty strings / non-object params -> 400.
    expect((await createRule({ type: "nope", name: "x", channelKind: "slack", channelTarget: "u" })).statusCode).toBe(400);
    expect((await createRule({ type: "app_used", name: "x", channelKind: "pigeon", channelTarget: "u" })).statusCode).toBe(400);
    expect((await createRule({ type: "app_used", name: "  ", channelKind: "slack", channelTarget: "u" })).statusCode).toBe(400);
    expect((await createRule({ type: "app_used", name: "x", channelKind: "slack", channelTarget: " " })).statusCode).toBe(400);
    expect((await createRule({ type: "app_used", name: "x", channelKind: "slack", channelTarget: "u", params: [1, 2] })).statusCode).toBe(400);

    // List includes it.
    const list = await app.inject({ url: "/api/alerts/rules", headers: auth(admin) });
    expect(list.json().rules.some((r: { id: string }) => r.id === id)).toBe(true);

    // Unauthorized.
    expect((await app.inject({ url: "/api/alerts/rules" })).statusCode).toBe(401);

    // PATCH partial.
    const patched = await app.inject({ method: "PATCH", url: `/api/alerts/rules/${id}`, headers: auth(admin), payload: { enabled: false, name: "Idle renamed" } });
    expect(patched.json().rule).toMatchObject({ enabled: false, name: "Idle renamed", type: "idle_too_long" });
    expect((await app.inject({ method: "PATCH", url: `/api/alerts/rules/${id}`, headers: auth(admin), payload: { type: "bogus" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/alerts/rules/${crypto.randomUUID()}`, headers: auth(admin), payload: { name: "z" } })).statusCode).toBe(404);

    // DELETE.
    expect((await app.inject({ method: "DELETE", url: `/api/alerts/rules/${id}`, headers: auth(admin) })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "DELETE", url: `/api/alerts/rules/${id}`, headers: auth(admin) })).statusCode).toBe(404);
  });

  it("fires device_offline and idle_too_long, and dedupes within the window", async () => {
    const now = Date.now();

    // idle_too_long: clocked-in employee whose latest segment is a 19-minute idle run.
    const e1 = await mkEmployee("Idle Ida");
    const d1 = await mkDevice(e1, "ida-lap", now - 2 * MIN);
    await mkSession(e1, d1, "clock_in", now - 60 * MIN);
    await mkSegment(e1, d1, now - 40 * MIN, now - 20 * MIN, false, "code", "work");
    await mkSegment(e1, d1, now - 20 * MIN, now - 1 * MIN, true, "code", "");

    // device_offline: a device last seen 45m ago (>= 30m), plus one seen recently (must NOT fire).
    const e2 = await mkEmployee("Offline Otto");
    const dOff = await mkDevice(e2, "otto-desk", now - 45 * MIN);
    await mkDevice(e2, "otto-online", now - 3 * MIN);

    const idleRule = (await createRule({ type: "idle_too_long", name: "Idle", params: { minutes: 15 }, channelKind: "webhook", channelTarget: captureUrl })).json().rule;
    const offRule = (await createRule({ type: "device_offline", name: "Offline", params: { minutes: 30 }, channelKind: "webhook", channelTarget: captureUrl })).json().rule;

    const first = await evaluateOnce(db, now, okDeliver);
    expect(first.fired).toBeGreaterThanOrEqual(2);

    const idleEv = await eventsForRule(idleRule.id);
    expect(idleEv).toHaveLength(1);
    expect(idleEv[0]!.employee_id).toBe(e1);
    expect(idleEv[0]!.message).toContain("idle for 19 min");

    const offEv = await eventsForRule(offRule.id);
    expect(offEv).toHaveLength(1);
    expect(offEv[0]!.device_id).toBe(dOff);
    expect(offEv[0]!.message).toContain("offline");

    // Dedupe: a second evaluation in the same 30-min bucket adds nothing.
    const second = await evaluateOnce(db, now, okDeliver);
    expect((await eventsForRule(idleRule.id))).toHaveLength(1);
    expect((await eventsForRule(offRule.id))).toHaveLength(1);
    expect(second.fired).toBe(0);
  });

  it("matches app_used by case-insensitive substring on app or title", async () => {
    const now = Date.now();
    const e = await mkEmployee("Tube Tom");
    const dv = await mkDevice(e, "tom-lap", now - 2 * MIN);
    await mkSegment(e, dv, now - 10 * MIN, now - 5 * MIN, false, "firefox", "Funny Cats - YouTube");
    // A non-matching employee that must not fire for this rule.
    const e3 = await mkEmployee("Clean Cleo");
    const d3 = await mkDevice(e3, "cleo-lap", now - 2 * MIN);
    await mkSegment(e3, d3, now - 10 * MIN, now - 5 * MIN, false, "code", "main.rs");

    const rule = (await createRule({ type: "app_used", name: "No YT", params: { pattern: "youtube" }, channelKind: "webhook", channelTarget: captureUrl })).json().rule;
    await evaluateOnce(db, now, okDeliver);
    const ev = await eventsForRule(rule.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.employee_id).toBe(e);
    expect(ev[0]!.message.toLowerCase()).toContain("youtube");
  });

  it("records delivered=false with an error when the webhook is unreachable", async () => {
    const prev = process.env.ALERT_HTTP_TIMEOUT_MS;
    process.env.ALERT_HTTP_TIMEOUT_MS = "200"; // keep the test fast
    try {
      const now = Date.now();
      const e = await mkEmployee("Dead Drop");
      await mkDevice(e, "dd-online", now - 3 * MIN);
      const dOffline = await mkDevice(e, "dd-offline", now - 50 * MIN);
      // Port 1 refuses connections immediately.
      const rule = (await createRule({ type: "device_offline", name: "Unreachable", params: { minutes: 30 }, channelKind: "webhook", channelTarget: "http://127.0.0.1:1/hook" })).json().rule;

      // Use the REAL deliver() so the failed POST is recorded.
      await evaluateOnce(db, now, deliver);
      const ev = await eventsForRule(rule.id);
      // The rule scans all offline devices in the shared DB; every delivery must fail.
      expect(ev.length).toBeGreaterThanOrEqual(1);
      expect(ev.every((e) => e.delivered === false && !!e.delivery_error)).toBe(true);
      expect(ev.some((e) => e.device_id === dOffline)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ALERT_HTTP_TIMEOUT_MS;
      else process.env.ALERT_HTTP_TIMEOUT_MS = prev;
    }
  });

  it("delivers slack payloads and powers the /test endpoint", async () => {
    lastBody = null;
    const rule = (await createRule({ type: "suspicious_device", name: "Slack test", channelKind: "slack", channelTarget: captureUrl })).json().rule;
    const res = await app.inject({ method: "POST", url: `/api/alerts/rules/${rule.id}/test`, headers: auth(admin) });
    expect(res.json()).toEqual({ ok: true });
    expect(lastBody).toMatchObject({ text: expect.stringContaining("Test alert") });

    // Test endpoint reports failure for an unreachable target.
    const bad = (await createRule({ type: "suspicious_device", name: "Bad", channelKind: "webhook", channelTarget: "http://127.0.0.1:1/x" })).json().rule;
    const prev = process.env.ALERT_HTTP_TIMEOUT_MS;
    process.env.ALERT_HTTP_TIMEOUT_MS = "200";
    try {
      const r = await app.inject({ method: "POST", url: `/api/alerts/rules/${bad.id}/test`, headers: auth(admin) });
      expect(r.json().ok).toBe(false);
      expect(r.json().error).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.ALERT_HTTP_TIMEOUT_MS;
      else process.env.ALERT_HTTP_TIMEOUT_MS = prev;
    }
  });

  it("lists events newest-first with rule metadata", async () => {
    const res = await app.inject({ url: "/api/alerts/events?limit=50", headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const events = res.json().events;
    expect(events.length).toBeGreaterThan(0);
    // Newest-first.
    for (let i = 1; i < events.length; i++) expect(events[i - 1].createdAt).toBeGreaterThanOrEqual(events[i].createdAt);
    const sample = events[0];
    expect(sample).toHaveProperty("ruleId");
    expect(sample).toHaveProperty("ruleName");
    expect(sample).toHaveProperty("type");
    expect(sample).toHaveProperty("delivered");
    expect(sample).toHaveProperty("deliveryError");
  });
});
