import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ENROLL_TTL_MS,
  createSession,
  hashPassword,
  newEnrollmentCode,
  requireAdmin,
  verifyPassword,
  writeAudit,
} from "../auth.js";
import { assertEmployeeInScope, isOwner, ownerOnly } from "../scope.js";
import { categorizer, type AppRule } from "../categorize.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import { getSettings, settingsPatchSchema, updateSettings, type Settings } from "../settings.js";
import { DAY_MS, clippedDuration, dateRange, dayStart, localDateString, parseDate, parseTzOffset } from "../time.js";

/**
 * Creates the first admin (and optionally sets the org name) atomically.
 * Returns null if an admin already exists — never overwrites.
 */
export async function createFirstAdmin(
  db: Db,
  input: { name: string; email: string; password: string; orgName?: string },
): Promise<{ id: string; name: string; email: string } | null> {
  const id = crypto.randomUUID();
  const name = input.name.trim() || "Admin";
  const email = input.email.trim().toLowerCase();
  const hash = await hashPassword(input.password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE admins IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM admins");
    if (rows[0]!.n > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("INSERT INTO admins (id, name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)", [
      id,
      name,
      email,
      hash,
      Date.now(),
    ]);
    const org = input.orgName?.trim();
    if (org) await client.query("UPDATE settings SET org_name = $1 WHERE id = 1", [org.slice(0, 100)]);
    await client.query("COMMIT");
    return { id, name, email };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_REPORT_DAYS = 366;

interface RuleRow {
  id: string;
  pattern: string;
  category: AppRule["category"];
  team_id: string | null;
}
const toRule = (r: RuleRow): AppRule => ({ id: r.id, pattern: r.pattern, category: r.category, teamId: r.team_id });

/** Global (org-wide) rules only, in creation order. */
async function loadGlobalRules(db: Db): Promise<AppRule[]> {
  const { rows } = await db.query<RuleRow>(
    "SELECT id, pattern, category, team_id FROM app_rules WHERE team_id IS NULL ORDER BY seq",
  );
  return rows.map(toRule);
}

/** One team's rules, in creation order. */
async function loadTeamRules(db: Db, teamId: string): Promise<AppRule[]> {
  const { rows } = await db.query<RuleRow>(
    "SELECT id, pattern, category, team_id FROM app_rules WHERE team_id = $1 ORDER BY seq",
    [teamId],
  );
  return rows.map(toRule);
}

/** Map of team_id -> that team's rules (creation order), loaded in one query. */
async function loadTeamRulesMap(db: Db): Promise<Map<string, AppRule[]>> {
  const { rows } = await db.query<RuleRow>(
    "SELECT id, pattern, category, team_id FROM app_rules WHERE team_id IS NOT NULL ORDER BY seq",
  );
  const map = new Map<string, AppRule[]>();
  for (const r of rows) {
    const list = map.get(r.team_id!) ?? [];
    list.push(toRule(r));
    map.set(r.team_id!, list);
  }
  return map;
}

/**
 * An employee's effective rules: their team's rules first (creation order), then
 * global rules (creation order). Team rules therefore override global ones.
 */
const effectiveRules = (teamRules: AppRule[], globalRules: AppRule[]): AppRule[] => [...teamRules, ...globalRules];

async function teamExists(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM teams WHERE id = $1", [id]);
  return !!rowCount;
}

interface TeamShape {
  id: string;
  name: string;
  memberCount: number;
  ruleCount: number;
  createdAt: number;
}

async function teamShape(db: Db, id: string): Promise<TeamShape | null> {
  const { rows } = await db.query<{ id: string; name: string; created_at: number; member_count: number; rule_count: number }>(
    `SELECT t.id, t.name, t.created_at,
       (SELECT count(*)::int FROM employees e WHERE e.team_id = t.id) AS member_count,
       (SELECT count(*)::int FROM app_rules ar WHERE ar.team_id = t.id) AS rule_count
     FROM teams t WHERE t.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, memberCount: r.member_count, ruleCount: r.rule_count, createdAt: r.created_at } : null;
}

/** Resolves an existing team by exact name, or creates one. Returns its id and name. */
async function resolveOrCreateTeam(db: Db, name: string): Promise<{ id: string; name: string }> {
  const existing = await db.query<{ id: string; name: string }>("SELECT id, name FROM teams WHERE name = $1", [name]);
  if (existing.rows[0]) return existing.rows[0];
  const id = crypto.randomUUID();
  try {
    await db.query("INSERT INTO teams (id, name, created_at) VALUES ($1,$2,$3)", [id, name, Date.now()]);
    return { id, name };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      const again = await db.query<{ id: string; name: string }>("SELECT id, name FROM teams WHERE name = $1", [name]);
      if (again.rows[0]) return again.rows[0];
    }
    throw err;
  }
}

async function issueCode(db: Db, employeeId: string): Promise<{ enrollmentCode: string; expiresAt: number }> {
  const expiresAt = Date.now() + ENROLL_TTL_MS;
  // Only one live code per employee.
  await db.query("DELETE FROM enrollment_codes WHERE employee_id = $1 AND used_at IS NULL", [employeeId]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newEnrollmentCode();
    const res = await db.query(
      "INSERT INTO enrollment_codes (code, employee_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING",
      [code, employeeId, expiresAt],
    );
    if (res.rowCount) return { enrollmentCode: code, expiresAt };
  }
  throw new Error("could not allocate a unique enrollment code");
}

async function deleteFiles(dataDir: string, relPaths: string[]) {
  await Promise.all(relPaths.map((p) => fsp.rm(path.join(dataDir, "screenshots", p), { force: true })));
}

function badId(reply: FastifyReply) {
  return reply.code(404).send({ error: "not found" });
}

interface ReportRow {
  employeeId: string;
  name: string;
  activeMs: number;
  idleMs: number;
  productiveMs: number;
  unproductiveMs: number;
}

async function summary(db: Db, from: string, to: string, tz: number, teamId?: string | null): Promise<ReportRow[]> {
  const [start, end] = dateRange(from, to, tz);
  const globalRules = await loadGlobalRules(db);
  const teamRulesMap = await loadTeamRulesMap(db);
  const { rows: emps } = await db.query<{ id: string; name: string; team_id: string | null }>(
    teamId ? "SELECT id, name, team_id FROM employees WHERE team_id = $1 ORDER BY name" : "SELECT id, name, team_id FROM employees ORDER BY name",
    teamId ? [teamId] : [],
  );
  const empTeam = new Map(emps.map((e) => [e.id, e.team_id]));
  // One memoised categoriser per team (members of a team share their effective rules).
  const catCache = new Map<string, ReturnType<typeof categorizer>>();
  const catFor = (teamId: string | null): ReturnType<typeof categorizer> => {
    const key = teamId ?? "";
    let c = catCache.get(key);
    if (!c) {
      c = categorizer(effectiveRules(teamId ? teamRulesMap.get(teamId) ?? [] : [], globalRules));
      catCache.set(key, c);
    }
    return c;
  };
  const out = new Map<string, ReportRow>(
    emps.map((e) => [e.id, { employeeId: e.id, name: e.name, activeMs: 0, idleMs: 0, productiveMs: 0, unproductiveMs: 0 }]),
  );
  // Aggregate in SQL per (employee, app, title, idle), clipping to the range; categorise in JS.
  const { rows } = await db.query<{ employee_id: string; app: string; title: string; idle: boolean; ms: number }>(
    `SELECT employee_id, app, title, idle,
            SUM(LEAST(end_at, $2) - GREATEST(start_at, $1))::bigint AS ms
     FROM segments
     WHERE start_at < $2 AND end_at > $1
     GROUP BY employee_id, app, title, idle`,
    [start, end],
  );
  for (const r of rows) {
    const row = out.get(r.employee_id);
    if (!row) continue;
    const c = catFor(empTeam.get(r.employee_id) ?? null)(r.app, r.title, r.idle);
    if (c === "idle") row.idleMs += r.ms;
    else {
      row.activeMs += r.ms;
      if (c === "productive") row.productiveMs += r.ms;
      else if (c === "unproductive") row.unproductiveMs += r.ms;
    }
  }
  return [...out.values()];
}

function csvCell(v: string | number): string {
  const s = String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const hours = (ms: number) => (ms / 3_600_000).toFixed(2);

export async function adminRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const loginLimiter = rateLimit({ max: 10, windowMs: 60_000 });

  app.get("/api/auth/status", async () => {
    const { rows } = await db.query<{ n: number; org_name: string }>(
      "SELECT (SELECT count(*)::int FROM admins) AS n, org_name FROM settings WHERE id = 1",
    );
    return { needsSetup: rows[0]!.n === 0, orgName: rows[0]!.org_name };
  });

  const credsSchema = {
    type: "object",
    required: ["email", "password"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      email: { type: "string", minLength: 3, maxLength: 320 },
      password: { type: "string", minLength: 1, maxLength: 1024 },
    },
  } as const;

  app.post<{ Body: { name: string; email: string; password: string; orgName?: string } }>(
    "/api/auth/setup",
    {
      preHandler: loginLimiter,
      schema: {
        body: {
          ...credsSchema,
          required: ["name", "email", "password"],
          properties: { ...credsSchema.properties, orgName: { type: "string", maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const { name, email, password, orgName } = req.body;
      if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
      const user = await createFirstAdmin(db, { name, email, password, orgName });
      if (!user) return reply.code(409).send({ error: "setup already completed" });
      const token = await createSession(db, user.id);
      return { token, user };
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    { preHandler: loginLimiter, schema: { body: credsSchema } },
    async (req, reply) => {
      const { rows } = await db.query<{ id: string; name: string; email: string; password_hash: string; role: "owner" | "manager"; team_id: string | null }>(
        "SELECT id, name, email, password_hash, role, team_id FROM admins WHERE email = $1",
        [req.body.email.trim().toLowerCase()],
      );
      const a = rows[0];
      if (!a || !(await verifyPassword(req.body.password, a.password_hash)))
        return reply.code(401).send({ error: "invalid email or password" });
      const token = await createSession(db, a.id);
      await db.query("UPDATE admins SET last_login_at = $2 WHERE id = $1", [a.id, Date.now()]);
      await writeAudit(db, { id: a.id, name: a.name, email: a.email, role: a.role, teamId: a.team_id }, "signed in");
      return { token, user: { id: a.id, name: a.name, email: a.email, role: a.role, teamId: a.team_id } };
    },
  );

  // Screenshot images: allow ?token= so <img src> works.
  app.get<{ Params: { id: string } }>(
    "/api/screenshots/:id/image",
    { preHandler: requireAdmin(db, { allowQueryToken: true }) },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rows } = await db.query<{ path: string; mime: string; employee_id: string }>(
        "SELECT path, mime, employee_id FROM screenshots WHERE id = $1",
        [req.params.id],
      );
      if (!rows[0]) return badId(reply);
      if (!(await assertEmployeeInScope(db, req, reply, rows[0].employee_id))) return;
      const abs = path.join(config.dataDir, "screenshots", rows[0].path);
      try {
        await fsp.access(abs);
      } catch {
        return reply.code(404).send({ error: "screenshot file missing" });
      }
      reply.header("content-type", rows[0].mime);
      reply.header("cache-control", "private, max-age=86400");
      return reply.send(fs.createReadStream(abs));
    },
  );

  await app.register(async (r) => {
    r.addHook("preHandler", requireAdmin(db));
    // Team managers are read-only; all writes (and the admin/settings areas) are owner-only.
    r.addHook("preHandler", async (req, reply) => {
      if (req.admin!.role === "owner") return;
      const url = req.url.split("?")[0]!;
      // Writes are owner-only, except a manager's own session actions: signing
      // out and changing their own password.
      const selfAllowed = url === "/api/auth/logout" || url === "/api/auth/password";
      if (req.method !== "GET" && !selfAllowed) return reply.code(403).send({ error: "owners only" });
    });

    r.post("/api/auth/logout", async (req) => {
      await db.query("DELETE FROM admin_sessions WHERE token_hash = $1", [req.sessionTokenHash]);
      return { ok: true };
    });

    r.get("/api/auth/me", async (req) => ({ user: req.admin }));

    // Any admin changes their own password (must supply the current one).
    r.put<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/auth/password", async (req, reply) => {
      const { currentPassword = "", newPassword = "" } = req.body;
      if (newPassword.length < 8) return reply.code(400).send({ error: "new password must be at least 8 characters" });
      const { rows } = await db.query<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [req.admin!.id]);
      if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash)))
        return reply.code(401).send({ error: "current password is incorrect" });
      await db.query("UPDATE admins SET password_hash = $2 WHERE id = $1", [req.admin!.id, await hashPassword(newPassword)]);
      // Keep the current session; drop the rest.
      await db.query("DELETE FROM admin_sessions WHERE admin_id = $1 AND token_hash <> $2", [req.admin!.id, req.sessionTokenHash]);
      await writeAudit(db, req.admin, "changed own password");
      return { ok: true };
    });

    r.get<{ Querystring: { tzOffsetMin?: string } }>("/api/employees", async (req) => {
      const tz = parseTzOffset(req.query.tzOffsetMin);
      const start = dayStart(localDateString(Date.now(), tz), tz);
      const end = start + DAY_MS;
      const { rows: emps } = await db.query<{
        id: string;
        name: string;
        email: string | null;
        team: string | null;
        team_id: string | null;
        created_at: number;
        today_active_ms: number;
      }>(
        `SELECT e.id, e.name, e.email, t.name AS team, e.team_id, e.created_at,
           COALESCE((SELECT SUM(LEAST(s.end_at, $2) - GREATEST(s.start_at, $1))
                     FROM segments s WHERE s.employee_id = e.id AND NOT s.idle
                       AND s.start_at < $2 AND s.end_at > $1), 0)::bigint AS today_active_ms
         FROM employees e LEFT JOIN teams t ON t.id = e.team_id
         ${isOwner(req) ? "" : "WHERE e.team_id = $3"} ORDER BY lower(e.name)`,
        isOwner(req) ? [start, end] : [start, end, req.admin!.teamId],
      );
      const { rows: devs } = await db.query<{
        id: string;
        employee_id: string;
        hostname: string;
        os: string;
        os_version: string;
        agent_version: string;
        last_seen_at: number | null;
        command: string;
        suspicious_at: number | null;
      }>("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at");
      return {
        employees: emps.map((e) => {
          const devices = devs
            .filter((d) => d.employee_id === e.id)
            .map((d) => ({
              id: d.id,
              hostname: d.hostname,
              os: d.os,
              osVersion: d.os_version,
              agentVersion: d.agent_version,
              lastSeenAt: d.last_seen_at,
              command: d.command,
              suspicious: d.suspicious_at !== null,
            }));
          const seen = devices.map((d) => d.lastSeenAt ?? 0).filter(Boolean);
          return {
            id: e.id,
            name: e.name,
            email: e.email,
            team: e.team,
            teamId: e.team_id,
            createdAt: e.created_at,
            lastSeenAt: seen.length ? Math.max(...seen) : null,
            devices,
            todayActiveMs: e.today_active_ms,
          };
        }),
      };
    });

    r.post<{ Body: { name: string; email?: string; team?: string; teamId?: string | null } }>(
      "/api/employees",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              email: { type: "string", maxLength: 320 },
              team: { type: "string", maxLength: 200 },
              teamId: { type: ["string", "null"] },
            },
          },
        },
      },
      async (req, reply) => {
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: "name is required" });
        const email = req.body.email?.trim() || null;
        // Resolve the team: an explicit teamId wins; otherwise a `team` name string
        // resolves-or-creates a team (back-compat). team_id is the source of truth,
        // and the legacy `team` text column is kept in sync with the team name.
        let teamId: string | null = null;
        let teamName: string | null = null;
        if (req.body.teamId != null) {
          if (!UUID_RE.test(req.body.teamId)) return reply.code(400).send({ error: "invalid teamId" });
          const { rows } = await db.query<{ name: string }>("SELECT name FROM teams WHERE id = $1", [req.body.teamId]);
          if (!rows[0]) return reply.code(400).send({ error: "team not found" });
          teamId = req.body.teamId;
          teamName = rows[0].name;
        } else if (req.body.team?.trim()) {
          const team = await resolveOrCreateTeam(db, req.body.team.trim());
          teamId = team.id;
          teamName = team.name;
        }
        const id = crypto.randomUUID();
        const createdAt = Date.now();
        await db.query("INSERT INTO employees (id, name, email, team, team_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [
          id,
          name,
          email,
          teamName,
          teamId,
          createdAt,
        ]);
        const { enrollmentCode, expiresAt } = await issueCode(db, id);
        return {
          employee: { id, name, email, team: teamName, teamId, createdAt, lastSeenAt: null, devices: [], todayActiveMs: 0 },
          enrollmentCode,
          expiresAt,
        };
      },
    );

    r.patch<{ Params: { id: string }; Body: { name?: string; email?: string | null; team?: string; teamId?: string | null } }>(
      "/api/employees/:id",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              email: { type: ["string", "null"], maxLength: 320 },
              team: { type: "string", maxLength: 200 },
              teamId: { type: ["string", "null"] },
            },
          },
        },
      },
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return badId(reply);
        const { rows: cur } = await db.query<{ id: string }>("SELECT id FROM employees WHERE id = $1", [req.params.id]);
        if (!cur[0]) return badId(reply);

        const sets: string[] = [];
        const vals: unknown[] = [];
        const push = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };

        if (req.body.name !== undefined) {
          const name = req.body.name.trim();
          if (!name) return reply.code(400).send({ error: "name is required" });
          push("name", name);
        }
        if (req.body.email !== undefined) push("email", req.body.email?.trim() || null);

        // Team: explicit teamId (null to unassign) wins; else a `team` name resolves-or-creates.
        if (req.body.teamId !== undefined) {
          if (req.body.teamId === null) {
            push("team_id", null);
            push("team", null);
          } else {
            if (!UUID_RE.test(req.body.teamId)) return reply.code(400).send({ error: "invalid teamId" });
            const { rows } = await db.query<{ name: string }>("SELECT name FROM teams WHERE id = $1", [req.body.teamId]);
            if (!rows[0]) return reply.code(400).send({ error: "team not found" });
            push("team_id", req.body.teamId);
            push("team", rows[0].name);
          }
        } else if (req.body.team !== undefined) {
          if (req.body.team.trim()) {
            const team = await resolveOrCreateTeam(db, req.body.team.trim());
            push("team_id", team.id);
            push("team", team.name);
          } else {
            push("team_id", null);
            push("team", null);
          }
        }

        if (sets.length) {
          vals.push(req.params.id);
          await db.query(`UPDATE employees SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
        }
        const { rows } = await db.query<{
          id: string;
          name: string;
          email: string | null;
          team: string | null;
          team_id: string | null;
          created_at: number;
        }>(
          `SELECT e.id, e.name, e.email, t.name AS team, e.team_id, e.created_at
           FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = $1`,
          [req.params.id],
        );
        const e = rows[0]!;
        return { employee: { id: e.id, name: e.name, email: e.email, team: e.team, teamId: e.team_id, createdAt: e.created_at } };
      },
    );

    r.post<{ Params: { id: string } }>("/api/employees/:id/enrollment-code", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rowCount } = await db.query("SELECT 1 FROM employees WHERE id = $1", [req.params.id]);
      if (!rowCount) return badId(reply);
      return issueCode(db, req.params.id);
    });

    r.delete<{ Params: { id: string } }>("/api/employees/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rows: shots } = await db.query<{ path: string }>("SELECT path FROM screenshots WHERE employee_id = $1", [
        req.params.id,
      ]);
      const { rowCount } = await db.query("DELETE FROM employees WHERE id = $1", [req.params.id]);
      if (!rowCount) return badId(reply);
      await deleteFiles(config.dataDir, shots.map((s) => s.path));
      return { ok: true };
    });

    r.delete<{ Params: { id: string } }>("/api/devices/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rowCount } = await db.query(
        "UPDATE devices SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
        [req.params.id, Date.now()],
      );
      if (!rowCount) return badId(reply);
      return { ok: true };
    });

    // Remote lifecycle commands the agent reads from GET /api/agent/me.
    const setCommand = (command: "none" | "stop" | "uninstall") => async (
      req: { params: { id: string } },
      reply: FastifyReply,
    ) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rowCount } = await db.query(
        "UPDATE devices SET command = $2 WHERE id = $1 AND revoked_at IS NULL",
        [req.params.id, command],
      );
      if (!rowCount) return badId(reply);
      return { ok: true, command };
    };
    r.post<{ Params: { id: string } }>("/api/devices/:id/stop", setCommand("stop"));
    r.post<{ Params: { id: string } }>("/api/devices/:id/resume", setCommand("none"));
    r.post<{ Params: { id: string } }>("/api/devices/:id/uninstall", setCommand("uninstall"));

    r.get<{ Params: { id: string }; Querystring: { date?: string; tzOffsetMin?: string } }>(
      "/api/employees/:id/day",
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return badId(reply);
        if (!(await assertEmployeeInScope(db, req, reply, req.params.id))) return;
        const tz = parseTzOffset(req.query.tzOffsetMin);
        const date = req.query.date ?? localDateString(Date.now(), tz);
        if (!parseDate(date)) return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
        const start = dayStart(date, tz);
        const end = start + DAY_MS;
        const { rows: emp } = await db.query<{
          id: string;
          name: string;
          email: string | null;
          team: string | null;
          team_id: string | null;
          created_at: number;
        }>(
          `SELECT e.id, e.name, e.email, t.name AS team, e.team_id, e.created_at
           FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = $1`,
          [req.params.id],
        );
        if (!emp[0]) return badId(reply);

        const [segs, sess, shots, globalRules, teamRules] = await Promise.all([
          db.query<{ id: string; start_at: number; end_at: number; idle: boolean; app: string; title: string }>(
            `SELECT id, start_at, end_at, idle, app, title FROM segments
             WHERE employee_id = $1 AND start_at < $3 AND end_at > $2 ORDER BY start_at`,
            [req.params.id, start, end],
          ),
          db.query<{ id: string; kind: string; at: number }>(
            "SELECT id, kind, at FROM sessions WHERE employee_id = $1 AND at >= $2 AND at < $3 ORDER BY at",
            [req.params.id, start, end],
          ),
          db.query<{ id: string; taken_at: number }>(
            "SELECT id, taken_at FROM screenshots WHERE employee_id = $1 AND taken_at >= $2 AND taken_at < $3 ORDER BY taken_at",
            [req.params.id, start, end],
          ),
          loadGlobalRules(db),
          emp[0].team_id ? loadTeamRules(db, emp[0].team_id) : Promise.resolve([] as AppRule[]),
        ]);

        const cat = categorizer(effectiveRules(teamRules, globalRules));
        const totals = {
          activeMs: 0,
          idleMs: 0,
          productiveMs: 0,
          unproductiveMs: 0,
          neutralMs: 0,
          firstSeen: null as number | null,
          lastSeen: null as number | null,
        };
        const apps = new Map<string, { app: string; category: string; ms: number }>();
        const segments = segs.rows.map((s) => {
          const category = cat(s.app, s.title, s.idle);
          const ms = clippedDuration(s.start_at, s.end_at, start, end);
          if (category === "idle") totals.idleMs += ms;
          else {
            totals.activeMs += ms;
            totals[`${category}Ms`] += ms;
            // Top apps are keyed by app name; category reflects the app-level rule match.
            const a = apps.get(s.app) ?? { app: s.app, category: cat(s.app, ""), ms: 0 };
            a.ms += ms;
            apps.set(s.app, a);
          }
          const cs = Math.max(s.start_at, start);
          const ce = Math.min(s.end_at, end);
          totals.firstSeen = totals.firstSeen === null ? cs : Math.min(totals.firstSeen, cs);
          totals.lastSeen = totals.lastSeen === null ? ce : Math.max(totals.lastSeen, ce);
          return { id: s.id, start: s.start_at, end: s.end_at, idle: s.idle, app: s.app, title: s.title, category };
        });

        const e = emp[0];
        return {
          employee: { id: e.id, name: e.name, email: e.email, team: e.team, teamId: e.team_id, createdAt: e.created_at },
          segments,
          sessions: sess.rows,
          screenshots: shots.rows.map((s) => ({ id: s.id, takenAt: s.taken_at })),
          totals,
          apps: [...apps.values()].sort((a, b) => b.ms - a.ms),
        };
      },
    );

    r.delete<{ Params: { id: string } }>("/api/screenshots/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rows } = await db.query<{ path: string }>("DELETE FROM screenshots WHERE id = $1 RETURNING path", [
        req.params.id,
      ]);
      if (!rows[0]) return badId(reply);
      await deleteFiles(config.dataDir, [rows[0].path]);
      return { ok: true };
    });

    type RangeQuery = { Querystring: { from?: string; to?: string; tzOffsetMin?: string } };
    function parseRange(q: RangeQuery["Querystring"]): { from: string; to: string; tz: number } | string {
      const tz = parseTzOffset(q.tzOffsetMin);
      const today = localDateString(Date.now(), tz);
      const from = q.from ?? today;
      const to = q.to ?? from;
      if (!parseDate(from) || !parseDate(to)) return "from/to must be YYYY-MM-DD";
      if (from > to) return "from must not be after to";
      if ((dayStart(to, 0) - dayStart(from, 0)) / DAY_MS > MAX_REPORT_DAYS) return "range is limited to 366 days";
      return { from, to, tz };
    }

    r.get<RangeQuery>("/api/reports/summary", async (req, reply) => {
      const p = parseRange(req.query);
      if (typeof p === "string") return reply.code(400).send({ error: p });
      return { rows: await summary(db, p.from, p.to, p.tz, isOwner(req) ? null : req.admin!.teamId) };
    });

    r.get<RangeQuery>("/api/reports/summary.csv", async (req, reply) => {
      const p = parseRange(req.query);
      if (typeof p === "string") return reply.code(400).send({ error: p });
      const rows = await summary(db, p.from, p.to, p.tz, isOwner(req) ? null : req.admin!.teamId);
      const lines = [
        [
          "employee_id",
          "name",
          "active_hours",
          "idle_hours",
          "productive_hours",
          "unproductive_hours",
          "active_ms",
          "idle_ms",
          "productive_ms",
          "unproductive_ms",
        ].join(","),
        ...rows.map((r) =>
          [
            r.employeeId,
            r.name,
            hours(r.activeMs),
            hours(r.idleMs),
            hours(r.productiveMs),
            hours(r.unproductiveMs),
            r.activeMs,
            r.idleMs,
            r.productiveMs,
            r.unproductiveMs,
          ]
            .map(csvCell)
            .join(","),
        ),
      ];
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="openv360-summary-${p.from}_${p.to}.csv"`);
      return lines.join("\n") + "\n";
    });

    r.get("/api/settings", async () => getSettings(db));
    r.put<{ Body: Partial<Settings> }>("/api/settings", { schema: { body: settingsPatchSchema } }, async (req) =>
      updateSettings(db, req.body),
    );

    // ---- Teams ----
    r.get("/api/teams", async (req) => {
      const { rows: all } = await db.query<{ id: string; name: string; created_at: number; member_count: number; rule_count: number }>(
        `SELECT t.id, t.name, t.created_at,
           (SELECT count(*)::int FROM employees e WHERE e.team_id = t.id) AS member_count,
           (SELECT count(*)::int FROM app_rules ar WHERE ar.team_id = t.id) AS rule_count
         FROM teams t ORDER BY lower(t.name), t.name`,
      );
      // Managers only ever see their own team.
      const rows = isOwner(req) ? all : all.filter((t) => t.id === req.admin!.teamId);
      return {
        teams: rows.map((t) => ({
          id: t.id,
          name: t.name,
          memberCount: t.member_count,
          ruleCount: t.rule_count,
          createdAt: t.created_at,
        })),
      };
    });

    r.post<{ Body: { name: string } }>(
      "/api/teams",
      { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } } } },
      async (req, reply) => {
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: "name is required" });
        const id = crypto.randomUUID();
        const createdAt = Date.now();
        try {
          await db.query("INSERT INTO teams (id, name, created_at) VALUES ($1,$2,$3)", [id, name, createdAt]);
        } catch (err) {
          if ((err as { code?: string }).code === "23505") return reply.code(400).send({ error: "team name already exists" });
          throw err;
        }
        return { team: { id, name, memberCount: 0, ruleCount: 0, createdAt } };
      },
    );

    r.patch<{ Params: { id: string }; Body: { name: string } }>(
      "/api/teams/:id",
      { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } } } },
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return badId(reply);
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: "name is required" });
        try {
          const { rowCount } = await db.query("UPDATE teams SET name = $2 WHERE id = $1", [req.params.id, name]);
          if (!rowCount) return badId(reply);
        } catch (err) {
          if ((err as { code?: string }).code === "23505") return reply.code(400).send({ error: "team name already exists" });
          throw err;
        }
        // Keep the legacy employees.team text column in sync with the renamed team.
        await db.query("UPDATE employees SET team = $2 WHERE team_id = $1", [req.params.id, name]);
        return { team: await teamShape(db, req.params.id) };
      },
    );

    r.delete<{ Params: { id: string } }>("/api/teams/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      // Members' team_id -> null (FK ON DELETE SET NULL); also clear the legacy text column.
      // Team's rules cascade-delete (FK ON DELETE CASCADE).
      await db.query("UPDATE employees SET team = NULL WHERE team_id = $1", [req.params.id]);
      const { rowCount } = await db.query("DELETE FROM teams WHERE id = $1", [req.params.id]);
      if (!rowCount) return badId(reply);
      return { ok: true };
    });

    r.get<{ Params: { id: string } }>("/api/teams/:id/members", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      if (!isOwner(req) && req.params.id !== req.admin!.teamId) return reply.code(403).send({ error: "outside your team" });
      if (!(await teamExists(db, req.params.id))) return badId(reply);
      const { rows } = await db.query<{ id: string; name: string; email: string | null }>(
        "SELECT id, name, email FROM employees WHERE team_id = $1 ORDER BY lower(name), name",
        [req.params.id],
      );
      return { members: rows.map((m) => ({ id: m.id, name: m.name, email: m.email })) };
    });

    // ---- App rules (global or team-scoped) ----
    r.get<{ Querystring: { teamId?: string } }>("/api/app-rules", async (req, reply) => {
      const { teamId } = req.query;
      if (teamId !== undefined) {
        if (!UUID_RE.test(teamId)) return reply.code(400).send({ error: "invalid teamId" });
        if (!isOwner(req) && teamId !== req.admin!.teamId) return reply.code(403).send({ error: "outside your team" });
        return { rules: await loadTeamRules(db, teamId) };
      }
      return { rules: await loadGlobalRules(db) };
    });
    r.post<{ Body: { pattern: string; category: AppRule["category"]; teamId?: string | null } }>(
      "/api/app-rules",
      {
        schema: {
          body: {
            type: "object",
            required: ["pattern", "category"],
            properties: {
              pattern: { type: "string", minLength: 1, maxLength: 256 },
              category: { type: "string", enum: ["productive", "unproductive", "neutral"] },
              teamId: { type: ["string", "null"] },
            },
          },
        },
      },
      async (req, reply) => {
        const pattern = req.body.pattern.trim();
        if (!pattern) return reply.code(400).send({ error: "pattern is required" });
        let teamId: string | null = null;
        if (req.body.teamId != null) {
          if (!UUID_RE.test(req.body.teamId)) return reply.code(400).send({ error: "invalid teamId" });
          if (!(await teamExists(db, req.body.teamId))) return reply.code(400).send({ error: "team not found" });
          teamId = req.body.teamId;
        }
        const id = crypto.randomUUID();
        await db.query("INSERT INTO app_rules (id, pattern, category, team_id, created_at) VALUES ($1,$2,$3,$4,$5)", [
          id,
          pattern,
          req.body.category,
          teamId,
          Date.now(),
        ]);
        return { rule: { id, pattern, category: req.body.category, teamId } };
      },
    );
    r.delete<{ Params: { id: string } }>("/api/app-rules/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rowCount } = await db.query("DELETE FROM app_rules WHERE id = $1", [req.params.id]);
      if (!rowCount) return badId(reply);
      return { ok: true };
    });
  });
}
