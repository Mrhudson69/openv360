import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

const SAFE_FILE = /^[A-Za-z0-9._-]+$/;
const SAFE_HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(",")[0]?.trim() || undefined;
}

/**
 * The URL agents should use to reach this server. PUBLIC_URL wins; otherwise it is
 * derived from the request, honouring X-Forwarded-Proto/Host from a reverse proxy.
 * Values are validated because they are interpolated into shell/PowerShell scripts.
 */
export function serverUrl(config: Config, req: FastifyRequest): string | null {
  if (config.publicUrl) return config.publicUrl;
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? req.protocol;
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? req.headers.host;
  if ((proto !== "http" && proto !== "https") || !host || !SAFE_HOST.test(host)) return null;
  return `${proto}://${host}`;
}

export function renderInstaller(template: string, serverUrl: string, releaseBase: string): string {
  return template.replaceAll("__OPENV360_SERVER_URL__", serverUrl).replaceAll("__OPENV360_RELEASE_BASE__", releaseBase);
}

export async function publicRoutes(app: FastifyInstance, { config }: { config: Config }) {
  for (const name of ["install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1"]) {
    app.get(`/${name}`, async (req, reply) => {
      let template: string;
      try {
        template = await fsp.readFile(path.join(config.installerDir, name), "utf8");
      } catch {
        return reply
          .code(404)
          .type("text/plain; charset=utf-8")
          .send(`${name} is not available on this server (installer template not found in ${config.installerDir}).\n`);
      }
      const url = serverUrl(config, req);
      if (!url) return reply.code(400).type("text/plain; charset=utf-8").send("Cannot determine server URL; set PUBLIC_URL.\n");
      const releaseBase = config.releaseBase ?? `${url}/downloads`;
      reply.header("cache-control", "no-store");
      return reply.type("text/plain; charset=utf-8").send(renderInstaller(template, url, releaseBase));
    });
  }

  app.get<{ Params: { file: string } }>("/downloads/:file", async (req, reply) => {
    const file = req.params.file;
    if (!SAFE_FILE.test(file) || file.startsWith(".")) return reply.code(404).send({ error: "not found" });
    const abs = path.join(config.downloadsDir, file);
    try {
      const st = await fsp.stat(abs);
      if (st.isFile()) {
        reply.header("content-type", "application/octet-stream");
        reply.header("content-length", st.size);
        reply.header("content-disposition", `attachment; filename="${file}"`);
        return reply.send(fs.createReadStream(abs));
      }
    } catch {
      // fall through to redirect / 404
    }
    if (config.githubReleasesUrl) return reply.redirect(`${config.githubReleasesUrl}/${encodeURIComponent(file)}`, 302);
    return reply.code(404).send({ error: `download ${file} not found` });
  });
}
