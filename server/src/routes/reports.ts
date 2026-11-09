import type { FastifyInstance } from "fastify";
import { requireOwner, writeAudit } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { buildAndSendReport, type ReportPeriod } from "../reports.js";

const isPeriod = (v: unknown): v is ReportPeriod => v === "daily" || v === "weekly";

export async function reportRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  await app.register(async (r) => {
    r.addHook("preHandler", requireOwner(db));

    r.post<{ Body: { period?: unknown; to?: unknown } }>("/api/reports/send-now", async (req, reply) => {
      const b = req.body ?? {};
      let period: ReportPeriod | undefined;
      if (b.period !== undefined) {
        if (!isPeriod(b.period)) return reply.code(400).send({ error: "period must be daily or weekly" });
        period = b.period;
      }
      let to: string[] | undefined;
      if (b.to !== undefined) {
        if (!Array.isArray(b.to) || b.to.some((x) => typeof x !== "string"))
          return reply.code(400).send({ error: "to must be an array of strings" });
        to = (b.to as string[]).map((s) => s.trim()).filter(Boolean);
      }
      const res = await buildAndSendReport(db, config, { period, to });
      await writeAudit(db, req.admin, "sent report now", res.sent ? `to ${res.recipients.length} recipient(s)` : res.error ?? "not sent");
      return res;
    });
  });
}
