import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate, type Db } from "../src/db.js"; // importing db.js also registers the INT8->number parser

const DATABASE_URL = process.env.DATABASE_URL;

// 1x1 PNG (valid magic bytes)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function multipart(file?: { name: string; data: Buffer; type: string }) {
  const boundary = "----openv360" + crypto.randomBytes(8).toString("hex");
  const parts: Buffer[] = [];
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

describe.skipIf(!DATABASE_URL)("branding (postgres)", () => {
  let db: Db;
  let app: FastifyInstance;
  let dataDir: string;
  let admin = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const SCHEMA = "branding_test";
    const boot = new pg.Pool({ connectionString: DATABASE_URL! });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await boot.end();
    db = new pg.Pool({ connectionString: DATABASE_URL!, options: `-c search_path=${SCHEMA},public` });
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-brand-"));
    const config = { ...loadConfig({ DATABASE_URL, DATA_DIR: dataDir }), dashboardDir: "/nonexistent" };
    await migrate(db, config.migrationsDir);
    app = await buildApp(db, config);
    // buildApp already registers brandingRoutes (wired in app.ts).
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { name: "Admin", email: "admin@example.com", password: "supersecret", orgName: "Acme" },
    });
    admin = setup.json().token;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("validates hex colours on the settings patch", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(admin),
      payload: { brandPrimary: "red" },
    });
    expect(bad.statusCode).toBe(400);

    const bad2 = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(admin),
      payload: { brandAccent: "#12345" }, // too short
    });
    expect(bad2.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(admin),
      payload: { brandPrimary: "#123abc", brandAccent: "#FFFFFF" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ brandPrimary: "#123abc", brandAccent: "#FFFFFF" });
  });

  it("GET /api/branding returns defaults, then reflects updates (no auth)", async () => {
    // Fresh schema default colours before the patch above would have changed them,
    // so assert current persisted values rather than the hard-coded defaults.
    const res = await app.inject({ method: "GET", url: "/api/branding" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      orgName: "Acme",
      brandPrimary: "#123abc",
      brandAccent: "#FFFFFF",
      logoUrl: null,
    });

    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin), payload: { orgName: "Globex" } });
    expect((await app.inject({ method: "GET", url: "/api/branding" })).json()).toMatchObject({ orgName: "Globex" });
  });

  it("GET /api/branding/logo is 404 when no logo is set", async () => {
    expect((await app.inject({ method: "GET", url: "/api/branding/logo" })).statusCode).toBe(404);
  });

  it("rejects a non-image upload and accepts a PNG", async () => {
    const notImg = multipart({ name: "x.png", data: Buffer.from("hello"), type: "image/png" });
    const bad = await app.inject({
      method: "POST",
      url: "/api/branding/logo",
      headers: { ...auth(admin), ...notImg.headers },
      payload: notImg.payload,
    });
    expect(bad.statusCode).toBe(415);

    const good = multipart({ name: "logo.png", data: PNG, type: "image/png" });
    const up = await app.inject({
      method: "POST",
      url: "/api/branding/logo",
      headers: { ...auth(admin), ...good.headers },
      payload: good.payload,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ logoUrl: "/api/branding/logo" });

    // The logo now streams with its content-type, and /api/branding advertises it.
    const img = await app.inject({ method: "GET", url: "/api/branding/logo" });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/branding" })).json().logoUrl).toBe("/api/branding/logo");

    // DELETE removes it.
    expect((await app.inject({ method: "DELETE", url: "/api/branding/logo", headers: auth(admin) })).json()).toEqual({
      ok: true,
    });
    expect((await app.inject({ method: "GET", url: "/api/branding/logo" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/branding" })).json().logoUrl).toBe(null);
  });

  it("requires auth to upload a logo", async () => {
    const good = multipart({ name: "logo.png", data: PNG, type: "image/png" });
    const up = await app.inject({ method: "POST", url: "/api/branding/logo", headers: good.headers, payload: good.payload });
    expect(up.statusCode).toBe(401);
  });
});
