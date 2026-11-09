import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

/** Owners see everything; managers are scoped to their one team. */
export function isOwner(req: FastifyRequest): boolean {
  return req.admin?.role !== "manager";
}

/** Reject non-owners with 403. Returns false when it has already replied. */
export function ownerOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (isOwner(req)) return true;
  reply.code(403).send({ error: "owners only" });
  return false;
}

/**
 * Ensure the current admin may act on this employee. Owners always may; a manager
 * only within their own team. Replies 404/403 and returns false otherwise.
 */
export async function assertEmployeeInScope(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
): Promise<boolean> {
  if (isOwner(req)) return true;
  const { rows } = await db.query<{ team_id: string | null }>("SELECT team_id FROM employees WHERE id = $1", [employeeId]);
  if (!rows[0]) {
    reply.code(404).send({ error: "not found" });
    return false;
  }
  if (!req.admin!.teamId || rows[0].team_id !== req.admin!.teamId) {
    reply.code(403).send({ error: "outside your team" });
    return false;
  }
  return true;
}

/** The team a manager is limited to, or null for an owner (no restriction). */
export function scopeTeamId(req: FastifyRequest): string | null {
  return isOwner(req) ? null : (req.admin!.teamId ?? "\u0000none");
}
