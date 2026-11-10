import type { FastifyInstance } from "fastify";
import { buildMailTransport, type SmtpSecure } from "../alerts.js";
import { requireOwner, writeAudit } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { encryptSecret } from "../secrets.js";

const SECURE_VALUES: readonly SmtpSecure[] = ["none", "starttls", "tls"];
const isSecure = (v: unknown): v is SmtpSecure => SECURE_VALUES.includes(v as SmtpSecure);

interface SmtpRow {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: SmtpSecure;
  smtp_user: string | null;
  smtp_pass: string | null;
  smtp_from: string | null;
  smtp_reject_unauthorized: boolean;
}

const SELECT =
  "SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, smtp_reject_unauthorized FROM settings WHERE id = 1";

export interface SmtpView {
  host: string | null;
  port: number | null;
  secure: SmtpSecure;
  user: string | null;
  from: string | null;
  rejectUnauthorized: boolean;
  hasPassword: boolean;
  source: "db" | "env" | "none";
}

/** True when the SMTP_* env vars describe a usable transport. */
function envConfigured(): boolean {
  return !!(process.env.SMTP_URL || process.env.SMTP_HOST);
}

function envHasPassword(): boolean {
  // An SMTP_URL may embed credentials; otherwise an explicit SMTP_PASS counts.
  return !!(process.env.SMTP_PASS || (process.env.SMTP_URL && process.env.SMTP_URL.includes("@")));
}

/**
 * The current effective SMTP config, never including the password itself.
 * `source` is "db" when a host is stored in settings, else "env" when the
 * SMTP_* env vars are set, else "none".
 */
async function smtpView(db: Db): Promise<SmtpView> {
  const { rows } = await db.query<SmtpRow>(SELECT);
  const s = rows[0];
  const dbHost = s?.smtp_host?.trim() || null;
  const dbHasPass = !!(s?.smtp_pass && s.smtp_pass.length > 0);
  const hasPassword = dbHasPass || envHasPassword();

  if (dbHost && s) {
    return {
      host: dbHost,
      port: s.smtp_port,
      secure: s.smtp_secure ?? "starttls",
      user: s.smtp_user?.trim() || null,
      from: s.smtp_from?.trim() || null,
      rejectUnauthorized: s.smtp_reject_unauthorized,
      hasPassword,
      source: "db",
    };
  }
  if (envConfigured()) {
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
    const p = port !== null && Number.isFinite(port) ? port : null;
    return {
      host: process.env.SMTP_HOST?.trim() || null,
      port: p,
      secure: p === 465 ? "tls" : "starttls",
      user: process.env.SMTP_USER?.trim() || null,
      from: process.env.ALERT_EMAIL_FROM?.trim() || null,
      rejectUnauthorized: true,
      hasPassword,
      source: "env",
    };
  }
  return {
    host: null,
    port: null,
    secure: "starttls",
    user: null,
    from: null,
    rejectUnauthorized: false,
    hasPassword,
    source: "none",
  };
}

type PutBody = {
  host?: unknown;
  port?: unknown;
  secure?: unknown;
  user?: unknown;
  from?: unknown;
  rejectUnauthorized?: unknown;
  password?: unknown;
};

export async function smtpRoutes(app: FastifyInstance, { db }: { db: Db; config: Config }) {
  await app.register(async (r) => {
    r.addHook("preHandler", requireOwner(db));

    r.get("/api/smtp", async () => smtpView(db));

    r.put<{ Body: PutBody }>("/api/smtp", async (req, reply) => {
      const b = req.body ?? {};
      const sets: string[] = [];
      const vals: unknown[] = [];
      const push = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      // A text field: omit = keep; "" (or null) = clear to NULL; else trimmed value.
      const textField = (key: keyof PutBody, col: string): string | undefined => {
        if (b[key] === undefined) return;
        if (b[key] === null || b[key] === "") {
          push(col, null);
          return;
        }
        if (typeof b[key] !== "string") return "must be a string";
        push(col, (b[key] as string).trim());
      };

      let err = textField("host", "smtp_host");
      if (err) return reply.code(400).send({ error: `host ${err}` });
      err = textField("user", "smtp_user");
      if (err) return reply.code(400).send({ error: `user ${err}` });
      err = textField("from", "smtp_from");
      if (err) return reply.code(400).send({ error: `from ${err}` });

      if (b.port !== undefined) {
        if (b.port === null || b.port === "") {
          push("smtp_port", null);
        } else {
          const n = Number(b.port);
          if (!Number.isInteger(n) || n < 1 || n > 65535)
            return reply.code(400).send({ error: "port must be an integer 1..65535" });
          push("smtp_port", n);
        }
      }

      if (b.secure !== undefined) {
        if (!isSecure(b.secure))
          return reply.code(400).send({ error: "secure must be one of none|starttls|tls" });
        push("smtp_secure", b.secure);
      }

      if (b.rejectUnauthorized !== undefined) {
        if (typeof b.rejectUnauthorized !== "boolean")
          return reply.code(400).send({ error: "rejectUnauthorized must be a boolean" });
        push("smtp_reject_unauthorized", b.rejectUnauthorized);
      }

      // password: omit = keep; "" = clear; string = set.
      if (b.password !== undefined) {
        if (b.password === "" || b.password === null) push("smtp_pass", null);
        else if (typeof b.password === "string") push("smtp_pass", encryptSecret(b.password));
        else return reply.code(400).send({ error: "password must be a string" });
      }

      if (sets.length) {
        await db.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, vals);
        await writeAudit(db, req.admin, "updated SMTP settings");
      }
      return smtpView(db);
    });

    r.post<{ Body: { to?: unknown } }>("/api/smtp/test", async (req, reply) => {
      const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
      if (!to) return reply.code(400).send({ error: "to is required" });
      try {
        const mt = await buildMailTransport(db);
        if (!mt) return { ok: false, error: "email not configured" };
        await mt.transport.sendMail({
          from: mt.from,
          to,
          subject: "openv360 SMTP test",
          text: "This is a test message confirming your openv360 SMTP configuration works.",
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message || "send failed" };
      }
    });
  });
}
