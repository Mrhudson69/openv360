import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate, type Db } from "../src/db.js"; // importing db.js also registers the INT8->number parser
import { createSession } from "../src/auth.js";
import { createFirstAdmin } from "../src/routes/admin.js";
import { smtpRoutes } from "../src/routes/smtp.js";
import { buildMailTransport } from "../src/alerts.js";

const DATABASE_URL = process.env.DATABASE_URL;

// Capture every transport built and every message "sent" without touching a real SMTP server.
const { createdTransports, sentMails } = vi.hoisted(() => ({
  createdTransports: [] as Record<string, unknown>[],
  sentMails: [] as Record<string, unknown>[],
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      createdTransports.push(opts);
      return {
        sendMail: async (msg: Record<string, unknown>) => {
          sentMails.push(msg);
          return { messageId: "test" };
        },
      };
    },
  },
}));

describe.skipIf(!DATABASE_URL)("smtp (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let token = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const SCHEMA = "smtp_test";
    const boot = new pg.Pool({ connectionString: DATABASE_URL! });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await boot.end();
    db = new pg.Pool({ connectionString: DATABASE_URL!, options: `-c search_path=${SCHEMA},public` });
    const config = { ...loadConfig({ DATABASE_URL }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    const owner = await createFirstAdmin(db, { name: "Owner", email: "owner@example.com", password: "supersecret" });
    token = await createSession(db, owner!.id);
    // Register ONLY the new routes on a dedicated instance (app.ts will wire them separately).
    app = Fastify();
    await app.register(smtpRoutes, { db, config });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("requires owner auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/smtp" })).statusCode).toBe(401);
  });

  it("GET reports source=none with no config and never leaks a password", async () => {
    const res = await app.inject({ method: "GET", url: "/api/smtp", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ host: null, source: "none", hasPassword: false });
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("smtp_pass");
    expect(body).toHaveProperty("secure", "starttls");
  });

  it("PUT validates secure enum and port range", async () => {
    expect(
      (await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { secure: "ssl" } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { port: 70000 } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { port: 0 } })).statusCode,
    ).toBe(400);
  });

  it("PUT stores config; password is kept on omit, cleared on empty, never returned", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/smtp",
      headers: auth(token),
      payload: { host: "smtp.example.com", port: 587, secure: "starttls", user: "u@example.com", from: "noreply@example.com", password: "s3cret" },
    });
    expect(set.statusCode).toBe(200);
    const body = set.json();
    expect(body).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: "starttls",
      user: "u@example.com",
      from: "noreply@example.com",
      hasPassword: true,
      source: "db",
    });
    expect(body).not.toHaveProperty("password");

    // Omitting password keeps it (still hasPassword), and lets us change another field.
    const keep = await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { port: 465, secure: "tls" } });
    expect(keep.json()).toMatchObject({ port: 465, secure: "tls", hasPassword: true });

    // password:"" clears it.
    const clear = await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { password: "" } });
    expect(clear.json().hasPassword).toBe(false);

    // Empty-string clears a text field (user -> null).
    const clearUser = await app.inject({ method: "PUT", url: "/api/smtp", headers: auth(token), payload: { user: "" } });
    expect(clearUser.json().user).toBe(null);
  });

  it("buildMailTransport maps secure modes and passes rejectUnauthorized", async () => {
    await db.query(
      "UPDATE settings SET smtp_host='smtp.map.test', smtp_from='rep@map.test', smtp_user=NULL, smtp_pass=NULL, smtp_port=NULL, smtp_reject_unauthorized=false WHERE id=1",
    );

    // tls -> secure:true, no requireTLS, default port 465
    await db.query("UPDATE settings SET smtp_secure='tls' WHERE id=1");
    createdTransports.length = 0;
    let mt = await buildMailTransport(db);
    expect(mt).not.toBeNull();
    expect(createdTransports.at(-1)).toMatchObject({ host: "smtp.map.test", secure: true, port: 465, tls: { rejectUnauthorized: false } });
    expect(createdTransports.at(-1)).not.toHaveProperty("requireTLS");

    // starttls -> secure:false, requireTLS:true, default port 587
    await db.query("UPDATE settings SET smtp_secure='starttls' WHERE id=1");
    createdTransports.length = 0;
    mt = await buildMailTransport(db);
    expect(createdTransports.at(-1)).toMatchObject({ host: "smtp.map.test", secure: false, requireTLS: true, port: 587 });

    // none -> secure:false, no requireTLS, default port 25
    await db.query("UPDATE settings SET smtp_secure='none' WHERE id=1");
    createdTransports.length = 0;
    mt = await buildMailTransport(db);
    expect(createdTransports.at(-1)).toMatchObject({ host: "smtp.map.test", secure: false, port: 25 });
    expect(createdTransports.at(-1)).not.toHaveProperty("requireTLS");

    // No host -> returns null (no env fallback in test env).
    await db.query("UPDATE settings SET smtp_host=NULL WHERE id=1");
    expect(await buildMailTransport(db)).toBeNull();
  });

  it("POST /api/smtp/test sends via the effective transport, or reports not configured", async () => {
    // Not configured first.
    const none = await app.inject({ method: "POST", url: "/api/smtp/test", headers: auth(token), payload: { to: "x@y.com" } });
    expect(none.json()).toMatchObject({ ok: false });

    // Configure, then send.
    await db.query("UPDATE settings SET smtp_host='smtp.send.test', smtp_from='rep@send.test', smtp_secure='starttls' WHERE id=1");
    sentMails.length = 0;
    const ok = await app.inject({ method: "POST", url: "/api/smtp/test", headers: auth(token), payload: { to: "dest@y.com" } });
    expect(ok.json()).toEqual({ ok: true });
    expect(sentMails.at(-1)).toMatchObject({ to: "dest@y.com", from: "rep@send.test" });

    // Missing "to" -> 400.
    expect((await app.inject({ method: "POST", url: "/api/smtp/test", headers: auth(token), payload: {} })).statusCode).toBe(400);
  });
});
