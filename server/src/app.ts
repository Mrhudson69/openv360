import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { VERSION, type Config } from "./config.js";
import type { Db } from "./db.js";
import { adminRoutes } from "./routes/admin.js";
import { adminsRoutes } from "./routes/admins.js";
import { agentRoutes, MAX_SCREENSHOT_BYTES } from "./routes/agent.js";
import { alertsRoutes } from "./routes/alerts.js";
import { brandingRoutes } from "./routes/branding.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { publicRoutes } from "./routes/public.js";
import { releasesRoutes } from "./routes/releases.js";
import { storageRoutes } from "./routes/storage.js";
import { smtpRoutes } from "./routes/smtp.js";
import { reportRoutes } from "./routes/reports.js";

export async function buildApp(db: Db, config: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    // Deployed behind a reverse proxy (Caddy); req.ip/protocol come from X-Forwarded-*.
    trustProxy: true,
  });

  if (config.corsOrigin) await app.register(cors, { origin: config.corsOrigin.split(",").map((s) => s.trim()) });
  await app.register(multipart, { limits: { fileSize: MAX_SCREENSHOT_BYTES } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "internal server error" : err.message });
  });

  app.get("/api/health", async () => ({ ok: true, version: VERSION }));

  await app.register(agentRoutes, { db, config });
  await app.register(adminRoutes, { db, config });
  await app.register(adminsRoutes, { db });
  await app.register(analyticsRoutes, { db, config });
  await app.register(alertsRoutes, { db, config });
  await app.register(brandingRoutes, { db, config });
  await app.register(releasesRoutes, { config });
  await app.register(storageRoutes, { db, config });
  await app.register(smtpRoutes, { db, config });
  await app.register(reportRoutes, { db, config });
  await app.register(publicRoutes, { config });

  const hasDashboard = fs.existsSync(path.join(config.dashboardDir, "index.html"));
  if (hasDashboard) {
    await app.register(fastifyStatic, { root: config.dashboardDir, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0]!;
    if (hasDashboard && req.method === "GET" && !url.startsWith("/api/") && !url.startsWith("/downloads/"))
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}
