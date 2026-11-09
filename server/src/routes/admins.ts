import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword, requireOwner, writeAudit, type Role } from "../auth.js";
import type { Db } from "../db.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface AdminRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  team_id: string | null;
  team_name: string | null;
  created_at: number;
  last_login_at: number | null;
}

const toAdmin = (r: AdminRow) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  teamId: r.team_id,
  teamName: r.team_name,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

const SELECT =
  `SELECT a.id, a.name, a.email, a.role, a.team_id, t.name AS team_name, a.created_at, a.last_login_at
   FROM admins a LEFT JOIN teams t ON t.id = a.team_id`;

async function ownerCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admins WHERE role = 'owner'");
  return rows[0]!.n;
}

async function teamExists(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM teams WHERE id = $1", [id]);
  return !!rowCount;
}

/** Owner-only administration: manage admin accounts and read the audit log. */
export async function adminsRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  await app.register(async (r) => {
    r.addHook("preHandler", requireOwner(db));

    r.get("/api/admins", async () => {
      const { rows } = await db.query<AdminRow>(`${SELECT} ORDER BY lower(a.name)`);
      return { admins: rows.map(toAdmin) };
    });

    r.post<{ Body: { name?: string; email?: string; password?: string; role?: Role; teamId?: string | null } }>(
      "/api/admins",
      async (req, reply) => {
        const name = (req.body.name ?? "").trim();
        const email = (req.body.email ?? "").trim().toLowerCase();
        const password = req.body.password ?? "";
        const role: Role = req.body.role === "manager" ? "manager" : "owner";
        const teamId = req.body.teamId ?? null;
        if (!name) return reply.code(400).send({ error: "name is required" });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "a valid email is required" });
        if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
        if (role === "manager") {
          if (!teamId || !UUID_RE.test(teamId)) return reply.code(400).send({ error: "a team is required for a manager" });
          if (!(await teamExists(db, teamId))) return reply.code(400).send({ error: "unknown team" });
        }
        const id = crypto.randomUUID();
        const hash = await hashPassword(password);
        try {
          await db.query(
            "INSERT INTO admins (id, name, email, password_hash, role, team_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [id, name, email, hash, role, role === "manager" ? teamId : null, Date.now()],
          );
        } catch (e) {
          if (String((e as { code?: string }).code) === "23505") return reply.code(400).send({ error: "an admin with that email already exists" });
          throw e;
        }
        await writeAudit(db, req.admin, "added admin", `${name} <${email}> as ${role}`);
        const { rows } = await db.query<AdminRow>(`${SELECT} WHERE a.id = $1`, [id]);
        return { admin: toAdmin(rows[0]!) };
      },
    );

    r.patch<{ Params: { id: string }; Body: { name?: string; role?: Role; teamId?: string | null } }>(
      "/api/admins/:id",
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not found" });
        const { rows: cur } = await db.query<{ role: Role }>("SELECT role FROM admins WHERE id = $1", [req.params.id]);
        if (!cur[0]) return reply.code(404).send({ error: "not found" });

        const sets: string[] = [];
        const vals: unknown[] = [];
        const push = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

        if (req.body.name !== undefined) {
          const name = req.body.name.trim();
          if (!name) return reply.code(400).send({ error: "name cannot be empty" });
          push("name", name);
        }
        if (req.body.role !== undefined) {
          const role: Role = req.body.role === "manager" ? "manager" : "owner";
          // Never allow removing the last owner.
          if (cur[0].role === "owner" && role === "manager" && (await ownerCount(db)) <= 1)
            return reply.code(400).send({ error: "there must be at least one owner" });
          push("role", role);
          if (role === "manager") {
            const teamId = req.body.teamId ?? null;
            if (!teamId || !UUID_RE.test(teamId) || !(await teamExists(db, teamId)))
              return reply.code(400).send({ error: "a valid team is required for a manager" });
            push("team_id", teamId);
          } else {
            push("team_id", null);
          }
        } else if (req.body.teamId !== undefined) {
          const teamId = req.body.teamId;
          if (teamId !== null && (!UUID_RE.test(teamId) || !(await teamExists(db, teamId))))
            return reply.code(400).send({ error: "unknown team" });
          push("team_id", teamId);
        }
        if (sets.length) await db.query(`UPDATE admins SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, req.params.id]);
        await writeAudit(db, req.admin, "updated admin", req.params.id);
        const { rows } = await db.query<AdminRow>(`${SELECT} WHERE a.id = $1`, [req.params.id]);
        return { admin: toAdmin(rows[0]!) };
      },
    );

    r.delete<{ Params: { id: string } }>("/api/admins/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not found" });
      const { rows } = await db.query<{ role: Role; name: string }>("SELECT role, name FROM admins WHERE id = $1", [req.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: "not found" });
      if (rows[0].role === "owner" && (await ownerCount(db)) <= 1)
        return reply.code(400).send({ error: "there must be at least one owner" });
      await db.query("DELETE FROM admins WHERE id = $1", [req.params.id]);
      await writeAudit(db, req.admin, "removed admin", rows[0].name);
      return { ok: true };
    });

    // Owner resets another admin's password (no current password needed).
    r.put<{ Params: { id: string }; Body: { password?: string } }>("/api/admins/:id/password", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not found" });
      const password = req.body.password ?? "";
      if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
      const { rows } = await db.query<{ name: string }>("SELECT name FROM admins WHERE id = $1", [req.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: "not found" });
      await db.query("UPDATE admins SET password_hash = $2 WHERE id = $1", [req.params.id, await hashPassword(password)]);
      // Sign the affected admin out of all sessions so the old password can't be reused.
      await db.query("DELETE FROM admin_sessions WHERE admin_id = $1", [req.params.id]);
      await writeAudit(db, req.admin, "reset password", rows[0].name);
      return { ok: true };
    });

    r.get<{ Querystring: { limit?: string } }>("/api/audit", async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const { rows } = await db.query<{ id: string; admin_id: string | null; admin_name: string; action: string; detail: string | null; at: number }>(
        "SELECT id, admin_id, admin_name, action, detail, at FROM audit_log ORDER BY at DESC LIMIT $1",
        [limit],
      );
      return { entries: rows.map((e) => ({ id: e.id, adminId: e.admin_id, adminName: e.admin_name || null, action: e.action, detail: e.detail, at: e.at })) };
    });
  });
}
