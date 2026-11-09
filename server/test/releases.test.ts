import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { releasesRoutes } from "../src/routes/releases.js";

// OPENV360_LATEST_VERSION is read from process.env at request time (that is how a
// deployment sets it), so apply it there and record it for cleanup.
const PROCESS_ENV_KEYS = ["OPENV360_LATEST_VERSION"] as const;

async function build(env: Record<string, string>): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openv360-rel-"));
  for (const k of PROCESS_ENV_KEYS) {
    if (k in env) process.env[k] = env[k];
  }
  const config = loadConfig({ ...process.env, DOWNLOADS_DIR: dir, ...env });
  const app = Fastify({ trustProxy: true });
  await app.register(releasesRoutes, { config });
  await app.ready();
  return { app, dir };
}

describe("GET /api/agent/release", () => {
  let app: FastifyInstance;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    for (const k of PROCESS_ENV_KEYS) delete process.env[k];
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { "x-forwarded-proto": "https", "x-forwarded-host": "acme.test" } });

  it("validates os and arch", async () => {
    ({ app, dir } = await build({}));
    expect((await get("/api/agent/release?os=solaris&arch=x86_64")).statusCode).toBe(400);
    expect((await get("/api/agent/release?os=linux&arch=mips")).statusCode).toBe(400);
  });

  it("no-ops with the server version when nothing is configured", async () => {
    ({ app, dir } = await build({ OPENV360_LATEST_VERSION: "" }));
    const res = await get("/api/agent/release?os=linux&arch=x86_64");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: null, sha256: null, minSupported: "0.0.0" });
  });

  it("serves a manifest from releases.json with an absolute url", async () => {
    ({ app, dir } = await build({}));
    await fs.writeFile(
      path.join(dir, "releases.json"),
      JSON.stringify({
        version: "0.2.0",
        notes: "bugfixes",
        minSupported: "0.1.0",
        artifacts: {
          "linux-x86_64": { file: "openv360-agent_amd64.deb", sha256: "abc123" },
          "macos-universal": { file: "openv360-agent_macos-universal.app.tar.gz", sha256: null },
        },
      }),
    );
    const linux = (await get("/api/agent/release?os=linux&arch=x86_64")).json();
    expect(linux).toEqual({
      version: "0.2.0",
      notes: "bugfixes",
      url: "https://acme.test/downloads/openv360-agent_amd64.deb",
      sha256: "abc123",
      minSupported: "0.1.0",
    });
    const mac = (await get("/api/agent/release?os=macos&arch=aarch64")).json();
    expect(mac.url).toBe("https://acme.test/downloads/openv360-agent_macos-universal.app.tar.gz");
    expect(mac.sha256).toBeNull();
  });

  it("synthesizes a release from OPENV360_LATEST_VERSION with default filenames", async () => {
    ({ app, dir } = await build({ OPENV360_LATEST_VERSION: "9.9.9" }));
    const win = (await get("/api/agent/release?os=windows&arch=x86_64")).json();
    expect(win.version).toBe("9.9.9");
    expect(win.url).toBe("https://acme.test/downloads/openv360-agent_x64-setup.exe");
  });

  it("honours RELEASE_BASE over the request host", async () => {
    ({ app, dir } = await build({ OPENV360_LATEST_VERSION: "1.2.3", RELEASE_BASE: "https://cdn.example.com/rel" }));
    const res = (await get("/api/agent/release?os=linux&arch=aarch64")).json();
    expect(res.url).toBe("https://cdn.example.com/rel/openv360-agent_arm64.deb");
  });
});
