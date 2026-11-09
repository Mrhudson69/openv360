import type { FastifyInstance, FastifyReply } from "fastify";
import {
  deliver,
  isAlertType,
  isChannelKind,
  toRule,
  RULE_COLUMNS,
  type AlertRule,
} from "../alerts.js";
import { requireAdmin } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function badId(reply: FastifyReply) {
  return reply.code(404).send({ error: "not found" });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface RuleRow {
  id: string;
  type: AlertRule["type"];
  name: string;
  params: Record<string, unknown>;
  channel_kind: AlertRule["channelKind"];
  channel_target: string;
  enabled: boolean;
  created_at: number;
}

async function getRule(db: Db, id: string): Promise<AlertRule | null> {
  const { rows } = await db.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM alert_rules WHERE id = $1`, [id]);
  return rows[0] ? toRule(rows[0]) : null;
}

export async function alertsRoutes(app: FastifyInstance, { db }: { db: Db; config: Config }) {
  await app.register(async (r) => {
    r.addHook("preHandler", requireAdmin(db));

    r.get("/api/alerts/rules", async () => {
      const { rows } = await db.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM alert_rules ORDER BY created_at`);
      return { rules: rows.map(toRule) };
    });

    r.post<{
      Body: {
        type?: unknown;
        name?: unknown;
        params?: unknown;
        channelKind?: unknown;
        channelTarget?: unknown;
        enabled?: unknown;
      };
    }>("/api/alerts/rules", async (req, reply) => {
      const b = req.body ?? {};
      if (!isAlertType(b.type)) return reply.code(400).send({ error: "invalid type" });
      if (!isChannelKind(b.channelKind)) return reply.code(400).send({ error: "invalid channelKind" });
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return reply.code(400).send({ error: "name is required" });
      const channelTarget = typeof b.channelTarget === "string" ? b.channelTarget.trim() : "";
      if (!channelTarget) return reply.code(400).send({ error: "channelTarget is required" });
      if (b.params !== undefined && !isPlainObject(b.params))
        return reply.code(400).send({ error: "params must be an object" });
      const params = isPlainObject(b.params) ? b.params : {};
      const enabled = b.enabled === undefined ? true : !!b.enabled;

      const { rows } = await db.query<RuleRow>(
        `INSERT INTO alert_rules (type, name, params, channel_kind, channel_target, enabled, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${RULE_COLUMNS}`,
        [b.type, name, JSON.stringify(params), b.channelKind, channelTarget, enabled, Date.now()],
      );
      return { rule: toRule(rows[0]!) };
    });

    r.patch<{
      Params: { id: string };
      Body: {
        type?: unknown;
        name?: unknown;
        params?: unknown;
        channelKind?: unknown;
        channelTarget?: unknown;
        enabled?: unknown;
      };
    }>("/api/alerts/rules/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      if (!(await getRule(db, req.params.id))) return badId(reply);
      const b = req.body ?? {};

      const sets: string[] = [];
      const vals: unknown[] = [];
      const push = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };

      if (b.type !== undefined) {
        if (!isAlertType(b.type)) return reply.code(400).send({ error: "invalid type" });
        push("type", b.type);
      }
      if (b.name !== undefined) {
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name) return reply.code(400).send({ error: "name is required" });
        push("name", name);
      }
      if (b.channelKind !== undefined) {
        if (!isChannelKind(b.channelKind)) return reply.code(400).send({ error: "invalid channelKind" });
        push("channel_kind", b.channelKind);
      }
      if (b.channelTarget !== undefined) {
        const t = typeof b.channelTarget === "string" ? b.channelTarget.trim() : "";
        if (!t) return reply.code(400).send({ error: "channelTarget is required" });
        push("channel_target", t);
      }
      if (b.params !== undefined) {
        if (!isPlainObject(b.params)) return reply.code(400).send({ error: "params must be an object" });
        push("params", JSON.stringify(b.params));
      }
      if (b.enabled !== undefined) push("enabled", !!b.enabled);

      if (sets.length) {
        vals.push(req.params.id);
        await db.query(`UPDATE alert_rules SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      }
      return { rule: await getRule(db, req.params.id) };
    });

    r.delete<{ Params: { id: string } }>("/api/alerts/rules/:id", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const { rowCount } = await db.query("DELETE FROM alert_rules WHERE id = $1", [req.params.id]);
      if (!rowCount) return badId(reply);
      return { ok: true };
    });

    r.post<{ Params: { id: string } }>("/api/alerts/rules/:id/test", async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return badId(reply);
      const rule = await getRule(db, req.params.id);
      if (!rule) return badId(reply);
      const res = await deliver(
        rule.channelKind,
        rule.channelTarget,
        {
          type: rule.type,
          name: rule.name,
          message: `Test alert from rule "${rule.name}" (${rule.type}).`,
          employeeId: null,
          deviceId: null,
          at: Date.now(),
        },
        db,
      );
      return res.delivered ? { ok: true } : { ok: false, error: res.error };
    });

    r.get<{ Querystring: { limit?: string } }>("/api/alerts/events", async (req) => {
      let limit = Number(req.query.limit ?? 50);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      limit = Math.min(Math.trunc(limit), 500);
      const { rows } = await db.query<{
        id: string;
        rule_id: string | null;
        rule_name: string | null;
        type: string | null;
        message: string;
        employee_id: string | null;
        device_id: string | null;
        created_at: number;
        delivered: boolean;
        delivery_error: string | null;
      }>(
        `SELECT ev.id, ev.rule_id, r.name AS rule_name, r.type, ev.message,
                ev.employee_id, ev.device_id, ev.created_at, ev.delivered, ev.delivery_error
         FROM alert_events ev LEFT JOIN alert_rules r ON r.id = ev.rule_id
         ORDER BY ev.created_at DESC, ev.id
         LIMIT $1`,
        [limit],
      );
      return {
        events: rows.map((e) => ({
          id: e.id,
          ruleId: e.rule_id,
          ruleName: e.rule_name,
          type: e.type,
          message: e.message,
          employeeId: e.employee_id,
          deviceId: e.device_id,
          createdAt: e.created_at,
          delivered: e.delivered,
          deliveryError: e.delivery_error,
        })),
      };
    });
  });
}
