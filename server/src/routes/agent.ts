import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { hashToken, newToken, normalizeEnrollmentCode, requireDevice } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { detectImage } from "../images.js";
import {
  DAY_MS,
  FUTURE_SLACK_MS,
  MAX_AGE_MS,
  SCREENSHOTS_PER_HOUR,
  filterSegments,
  filterSessions,
  utcDay,
} from "../ingest.js";
import { rateLimit } from "../ratelimit.js";
import { getSettings } from "../settings.js";

export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UUID_RE = new RegExp(UUID);
const HOUR_MS = 3600 * 1000;

/** Marks a device as having sent questionable data; shown as a warning in the dashboard. */
async function flagDevice(db: Db, deviceId: string, hits: number): Promise<void> {
  if (hits <= 0) return;
  await db.query("UPDATE devices SET flag_count = flag_count + $2, suspicious_at = $3 WHERE id = $1", [
    deviceId,
    hits,
    Date.now(),
  ]);
}

export async function agentRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.post<{
    Body: { code: string; device: { hostname: string; os: string; osVersion: string; agentVersion: string } };
  }>(
    "/api/agent/enroll",
    {
      preHandler: rateLimit({ max: 20, windowMs: 60_000 }),
      schema: {
        body: {
          type: "object",
          required: ["code", "device"],
          properties: {
            code: { type: "string", maxLength: 32 },
            device: {
              type: "object",
              required: ["hostname", "os", "osVersion", "agentVersion"],
              properties: {
                hostname: { type: "string", maxLength: 255 },
                os: { type: "string", enum: ["linux", "windows", "macos"] },
                osVersion: { type: "string", maxLength: 255 },
                agentVersion: { type: "string", maxLength: 64 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const code = normalizeEnrollmentCode(req.body.code);
      const now = Date.now();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ employee_id: string; name: string }>(
          `UPDATE enrollment_codes c SET used_at = $2 FROM employees e
           WHERE c.code = $1 AND c.used_at IS NULL AND c.expires_at > $2 AND e.id = c.employee_id
           RETURNING c.employee_id, e.name`,
          [code, now],
        );
        const emp = rows[0];
        if (!emp) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid, used or expired enrollment code" });
        }
        const deviceId = crypto.randomUUID();
        const token = newToken();
        const d = req.body.device;
        await client.query(
          `INSERT INTO devices (id, employee_id, token_hash, hostname, os, os_version, agent_version, created_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [deviceId, emp.employee_id, hashToken(token), d.hostname, d.os, d.osVersion, d.agentVersion, now],
        );
        await client.query("COMMIT");
        return {
          deviceId,
          deviceToken: token,
          employee: { id: emp.employee_id, name: emp.name },
          settings: await getSettings(db),
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // Everything below requires a device token.
  await app.register(async (r) => {
    r.addHook("preHandler", requireDevice(db));

    r.get("/api/agent/settings", async () => getSettings(db));

    r.get("/api/agent/me", async (req) => ({
      employee: { id: req.device!.employeeId, name: req.device!.employeeName },
      settings: await getSettings(db),
      command: req.device!.command,
    }));

    r.post<{ Body: { events: { id: string; kind: string; at: number }[] } }>(
      "/api/agent/sessions",
      {
        schema: {
          body: {
            type: "object",
            required: ["events"],
            properties: {
              events: {
                type: "array",
                maxItems: 1000,
                items: {
                  type: "object",
                  required: ["id", "kind", "at"],
                  properties: {
                    id: { type: "string", pattern: UUID },
                    kind: { type: "string", enum: ["clock_in", "clock_out"] },
                    at: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => {
        // Invalid timestamps are dropped (not 400) so a single bad event cannot discard a good batch.
        const { accepted, dropped } = filterSessions(
          req.body.events as { id: string; kind: "clock_in" | "clock_out"; at: number }[],
          Date.now(),
        );
        if (accepted.length) {
          await db.query(
            `INSERT INTO sessions (id, employee_id, device_id, kind, at)
             SELECT u.id, $1, $2, u.kind, u.at FROM unnest($3::uuid[], $4::text[], $5::bigint[]) AS u(id, kind, at)
             ON CONFLICT (id) DO NOTHING`,
            [req.device!.employeeId, req.device!.deviceId, accepted.map((e) => e.id), accepted.map((e) => e.kind), accepted.map((e) => e.at)],
          );
        }
        await flagDevice(db, req.device!.deviceId, dropped);
        return { accepted: accepted.length, dropped };
      },
    );

    r.post<{ Body: { segments: { id: string; start: number; end: number; idle: boolean; app: string; title: string }[] } }>(
      "/api/agent/activity",
      {
        bodyLimit: 4 * 1024 * 1024,
        schema: {
          body: {
            type: "object",
            required: ["segments"],
            properties: {
              segments: {
                type: "array",
                maxItems: 1000,
                items: {
                  type: "object",
                  required: ["id", "start", "end", "idle", "app"],
                  properties: {
                    id: { type: "string", pattern: UUID },
                    start: { type: "integer", minimum: 0 },
                    end: { type: "integer", minimum: 0 },
                    idle: { type: "boolean" },
                    // Idle segments legitimately carry an empty app, so allow "".
                    // (Active segments always arrive non-empty from the agent.)
                    // minLength:1 here rejected the whole batch on the first idle
                    // segment, jamming the queue forever and taking the device
                    // permanently offline.
                    app: { type: "string", minLength: 0, maxLength: 256 },
                    title: { type: "string", maxLength: 1024 },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => {
        const now = Date.now();
        const incoming = req.body.segments;
        // Pull this device's already-stored active time for the UTC days this batch touches,
        // so the per-day active cap holds across requests.
        const days = [...new Set(incoming.filter((s) => !s.idle).map((s) => utcDay(s.start)))];
        const existingActiveByDay = new Map<number, number>();
        if (days.length) {
          const lo = Math.min(...days) * DAY_MS;
          const hi = (Math.max(...days) + 1) * DAY_MS;
          const { rows } = await db.query<{ day: number; ms: number }>(
            `SELECT floor(start_at / $4::float8)::bigint AS day, COALESCE(SUM(end_at - start_at), 0)::bigint AS ms
             FROM segments WHERE device_id = $1 AND idle = false AND start_at >= $2 AND start_at < $3
             GROUP BY day`,
            [req.device!.deviceId, lo, hi, DAY_MS],
          );
          for (const row of rows) existingActiveByDay.set(Number(row.day), row.ms);
        }

        const { accepted, dropped } = filterSegments(incoming, now, existingActiveByDay);
        if (accepted.length) {
          await db.query(
            `INSERT INTO segments (id, employee_id, device_id, start_at, end_at, idle, app, title)
             SELECT u.id, $1, $2, u.s, u.e, u.idle, u.app, u.title
             FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $6::boolean[], $7::text[], $8::text[])
               AS u(id, s, e, idle, app, title)
             ON CONFLICT (id) DO NOTHING`,
            [
              req.device!.employeeId,
              req.device!.deviceId,
              accepted.map((s) => s.id),
              accepted.map((s) => s.start),
              accepted.map((s) => s.end),
              accepted.map((s) => s.idle),
              accepted.map((s) => s.app),
              accepted.map((s) => s.title ?? ""),
            ],
          );
        }
        await flagDevice(db, req.device!.deviceId, dropped);
        return { accepted: accepted.length, dropped };
      },
    );

    r.post("/api/agent/screenshots", async (req, reply) => {
      let id: string | undefined;
      let takenAt: number | undefined;
      let file: Buffer | undefined;
      try {
        for await (const part of req.parts({ limits: { fileSize: MAX_SCREENSHOT_BYTES, files: 1, fields: 10 } })) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              part.file.resume();
              continue;
            }
            file = await part.toBuffer();
          } else if (part.fieldname === "id") {
            id = String(part.value);
          } else if (part.fieldname === "takenAt") {
            takenAt = Number(part.value);
          }
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "screenshot exceeds 10 MB" });
        throw err;
      }
      const now = Date.now();
      if (!id || !UUID_RE.test(id)) return reply.code(400).send({ error: "missing or invalid id" });
      if (!takenAt || !Number.isInteger(takenAt) || takenAt > now + FUTURE_SLACK_MS || takenAt < now - MAX_AGE_MS)
        return reply.code(400).send({ error: "missing or invalid takenAt" });
      if (!file || file.length === 0) return reply.code(400).send({ error: "missing file" });
      const kind = detectImage(file);
      if (!kind) return reply.code(415).send({ error: "file must be a JPEG or PNG image" });

      const existing = await db.query("SELECT 1 FROM screenshots WHERE id = $1", [id]);
      if (existing.rowCount) return { accepted: 1 };

      // Rate cap: at most SCREENSHOTS_PER_HOUR per device within the clock hour of takenAt.
      const hourStart = Math.floor(takenAt / HOUR_MS) * HOUR_MS;
      const { rows: cnt } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM screenshots WHERE device_id = $1 AND taken_at >= $2 AND taken_at < $3",
        [req.device!.deviceId, hourStart, hourStart + HOUR_MS],
      );
      if ((cnt[0]?.n ?? 0) >= SCREENSHOTS_PER_HOUR) {
        await flagDevice(db, req.device!.deviceId, 1);
        return reply.code(429).send({ error: "screenshot rate limit for this hour reached", accepted: 0, dropped: 1 });
      }

      const d = new Date(takenAt);
      const rel = path.join(
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        `${id.toLowerCase()}.${kind.ext}`,
      );
      const abs = path.join(config.dataDir, "screenshots", rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file);
      await db.query(
        `INSERT INTO screenshots (id, employee_id, device_id, taken_at, path, mime, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [id, req.device!.employeeId, req.device!.deviceId, takenAt, rel, kind.mime, file.length],
      );
      return { accepted: 1 };
    });
  });
}
