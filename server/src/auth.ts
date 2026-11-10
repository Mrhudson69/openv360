import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const ENROLL_TTL_MS = 7 * 24 * 3600 * 1000;

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// No 0/O, 1/I/L to avoid misreads.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newEnrollmentCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalizeEnrollmentCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return null;
}

export type Role = "owner" | "manager";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
}

export interface DeviceAuth {
  deviceId: string;
  employeeId: string;
  employeeName: string;
  command: "none" | "stop" | "uninstall";
  updateRequested: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminUser;
    sessionTokenHash?: string;
    device?: DeviceAuth;
  }
}

export function requireAdmin(db: Db, opts: { allowQueryToken?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    let token = bearer(req);
    if (!token && opts.allowQueryToken) {
      const q = (req.query as Record<string, unknown> | undefined)?.token;
      if (typeof q === "string") token = q;
    }
    if (!token) return reply.code(401).send({ error: "authentication required" });
    const th = hashToken(token);
    const { rows } = await db.query<{ id: string; name: string; email: string; role: Role; team_id: string | null }>(
      `SELECT a.id, a.name, a.email, a.role, a.team_id FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [th, Date.now()],
    );
    if (!rows[0]) return reply.code(401).send({ error: "invalid or expired session" });
    req.admin = { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, teamId: rows[0].team_id };
    req.sessionTokenHash = th;
  };
}

/** requireAdmin, then reject non-owners (403). Use for org-wide admin actions. */
export function requireOwner(db: Db, opts: { allowQueryToken?: boolean } = {}) {
  const admin = requireAdmin(db, opts);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await admin(req, reply);
    if (reply.sent) return;
    if (req.admin!.role !== "owner") return reply.code(403).send({ error: "owners only" });
  };
}

/** Append an entry to the audit log. Never throws into the request path. */
export async function writeAudit(
  db: Db,
  actor: AdminUser | undefined,
  action: string,
  detail?: string | null,
): Promise<void> {
  try {
    await db.query(
      "INSERT INTO audit_log (admin_id, admin_name, action, detail, at) VALUES ($1,$2,$3,$4,$5)",
      [actor?.id ?? null, actor?.name ?? "", action, detail ?? null, Date.now()],
    );
  } catch {
    /* auditing must never break the action it records */
  }
}

export function requireDevice(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ error: "device token required" });
    // The agent reports its current version in the User-Agent ("openv360-agent/X")
    // on every request. Refresh agent_version from it so the dashboard reflects an
    // in-place update, not just the version recorded at enrollment. COALESCE keeps
    // the existing value when the header is missing/unparseable.
    const ua = Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"];
    const version = /openv360-agent\/(\S{1,32})/.exec(ua ?? "")?.[1] ?? null;
    const { rows } = await db.query<{ device_id: string; employee_id: string; employee_name: string; command: DeviceAuth["command"]; update_requested: boolean }>(
      `UPDATE devices d SET last_seen_at = $2,
             agent_version = COALESCE($3, d.agent_version)
       FROM employees e
       WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND e.id = d.employee_id
       RETURNING d.id AS device_id, d.employee_id, e.name AS employee_name, d.command, d.update_requested`,
      [hashToken(token), Date.now(), version],
    );
    if (!rows[0]) return reply.code(401).send({ error: "device not enrolled or revoked" });
    req.device = {
      deviceId: rows[0].device_id,
      employeeId: rows[0].employee_id,
      employeeName: rows[0].employee_name,
      command: rows[0].command,
      updateRequested: rows[0].update_requested,
    };
  };
}

export async function createSession(db: Db, adminId: string): Promise<string> {
  const token = newToken();
  const now = Date.now();
  await db.query("INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at) VALUES ($1,$2,$3,$4)", [
    hashToken(token),
    adminId,
    now,
    now + SESSION_TTL_MS,
  ]);
  await db.query("DELETE FROM admin_sessions WHERE expires_at < $1", [now]);
  return token;
}
