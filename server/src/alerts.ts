import crypto from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { decryptSecret } from "./secrets.js";
import { DAY_MS } from "./time.js";

// ---- Types ---------------------------------------------------------------

export type AlertType =
  | "idle_too_long"
  | "app_used"
  | "device_offline"
  | "suspicious_device"
  | "outside_hours";

export type ChannelKind = "slack" | "webhook" | "email";

export const ALERT_TYPES: readonly AlertType[] = [
  "idle_too_long",
  "app_used",
  "device_offline",
  "suspicious_device",
  "outside_hours",
];

export const CHANNEL_KINDS: readonly ChannelKind[] = ["slack", "webhook", "email"];

export const isAlertType = (v: unknown): v is AlertType => ALERT_TYPES.includes(v as AlertType);
export const isChannelKind = (v: unknown): v is ChannelKind => CHANNEL_KINDS.includes(v as ChannelKind);

export interface AlertRule {
  id: string;
  type: AlertType;
  name: string;
  params: Record<string, unknown>;
  channelKind: ChannelKind;
  channelTarget: string;
  enabled: boolean;
  createdAt: number;
}

interface RuleRow {
  id: string;
  type: AlertType;
  name: string;
  params: Record<string, unknown>;
  channel_kind: ChannelKind;
  channel_target: string;
  enabled: boolean;
  created_at: number;
}

export const toRule = (r: RuleRow): AlertRule => ({
  id: r.id,
  type: r.type,
  name: r.name,
  params: r.params ?? {},
  channelKind: r.channel_kind,
  channelTarget: r.channel_target,
  enabled: r.enabled,
  createdAt: r.created_at,
});

export const RULE_COLUMNS =
  "id, type, name, params, channel_kind, channel_target, enabled, created_at";

// ---- Tunables ------------------------------------------------------------

/** Scheduler cadence. */
export const CYCLE_MS = 60_000;
/** De-dup window: one alert per (rule, subject) per 30-minute bucket. */
export const DEDUPE_MS = 30 * 60_000;
/** Detection horizon — never alert on data older than ~2h (avoids a first-run storm). */
export const RECENT_MS = 2 * 3_600_000;
/** How recently a suspicious flag must have been set to count as "just set". */
const SUSPICIOUS_MS = 3_600_000;
/** Tolerance for treating adjacent idle segments as one contiguous idle run. */
const IDLE_GAP_TOL_MS = 2 * 60_000;
/** Bound on rows pulled per detection query. */
const SCAN_LIMIT = 1000;

const HTTP_TIMEOUT_MS = (): number => {
  const n = Number(process.env.ALERT_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
};

const numParam = (params: Record<string, unknown>, key: string, def: number): number => {
  const n = Number(params[key]);
  return Number.isFinite(n) ? n : def;
};

// ---- Delivery ------------------------------------------------------------

export interface DeliveryPayload {
  type: AlertType;
  name: string;
  message: string;
  employeeId: string | null;
  deviceId: string | null;
  at: number;
}

export interface DeliveryResult {
  delivered: boolean;
  error: string | null;
}

export type DeliverFn = (
  channelKind: ChannelKind,
  channelTarget: string,
  payload: DeliveryPayload,
  db?: Db,
) => Promise<DeliveryResult>;

export type SmtpSecure = "none" | "starttls" | "tls";

export interface MailTransport {
  transport: nodemailer.Transporter;
  from: string;
}

interface SmtpRow {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: SmtpSecure;
  smtp_user: string | null;
  smtp_pass: string | null;
  smtp_from: string | null;
  smtp_reject_unauthorized: boolean;
}

/** Builds a transport from the SMTP_URL / SMTP_HOST env vars (the legacy path). */
function buildEnvMailTransport(): MailTransport | null {
  const { SMTP_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!from) return null;
  if (SMTP_URL) return { transport: nodemailer.createTransport(SMTP_URL), from };
  if (SMTP_HOST) {
    const port = Number(SMTP_PORT ?? 587);
    const p = Number.isFinite(port) ? port : 587;
    return {
      transport: nodemailer.createTransport({
        host: SMTP_HOST,
        port: p,
        secure: p === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS ?? "" } : undefined,
      }),
      from,
    };
  }
  return null;
}

/** Default SMTP port for a given security mode when none is configured. */
export const defaultSmtpPort = (secure: SmtpSecure): number =>
  secure === "tls" ? 465 : secure === "none" ? 25 : 587;

/**
 * Builds the nodemailer transport from the DB `settings` row first, falling back
 * to the SMTP_* env vars when DB SMTP is not configured. Returns null when
 * neither is configured (no host, or no usable `from` address).
 *
 * smtp_secure maps to: tls -> secure:true; starttls -> secure:false, requireTLS:true;
 * none -> secure:false. tls.rejectUnauthorized follows smtp_reject_unauthorized.
 */
export async function buildMailTransport(db: Db): Promise<MailTransport | null> {
  const { rows } = await db.query<SmtpRow>(
    `SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, smtp_reject_unauthorized
     FROM settings WHERE id = 1`,
  );
  const s = rows[0];
  const host = s?.smtp_host?.trim();
  if (s && host) {
    const secureMode: SmtpSecure = s.smtp_secure ?? "starttls";
    const port = s.smtp_port ?? defaultSmtpPort(secureMode);
    const user = s.smtp_user?.trim();
    const opts: Record<string, unknown> = {
      host,
      port,
      secure: secureMode === "tls",
      tls: { rejectUnauthorized: s.smtp_reject_unauthorized },
    };
    if (secureMode === "starttls") opts.requireTLS = true;
    if (user) opts.auth = { user, pass: decryptSecret(s.smtp_pass) };
    const from = s.smtp_from?.trim() || process.env.ALERT_EMAIL_FROM || user;
    if (!from) return null;
    return { transport: nodemailer.createTransport(opts as nodemailer.TransportOptions), from };
  }
  // DB SMTP not configured -> fall back to env behaviour.
  return buildEnvMailTransport();
}

async function deliverEmail(to: string, payload: DeliveryPayload, db?: Db): Promise<DeliveryResult> {
  const mt = db ? await buildMailTransport(db) : buildEnvMailTransport();
  if (!mt) return { delivered: false, error: "email not configured" };
  try {
    await mt.transport.sendMail({
      from: mt.from,
      to,
      subject: `[Alert] ${payload.name}`,
      text: payload.message,
    });
    return { delivered: true, error: null };
  } catch (err) {
    return { delivered: false, error: (err as Error).message || "email delivery failed" };
  }
}

/**
 * Posts an alert to its channel. Slack -> `{ text }`; webhook -> structured JSON;
 * email -> SMTP (if configured). A short timeout bounds each attempt, and
 * redirects are not followed (a weak SSRF guard on this admin-configured, self-hosted box).
 */
export const deliver: DeliverFn = async (channelKind, channelTarget, payload, db) => {
  if (channelKind === "email") return deliverEmail(channelTarget, payload, db);

  const body =
    channelKind === "slack"
      ? JSON.stringify({ text: payload.message })
      : JSON.stringify({
          type: payload.type,
          name: payload.name,
          message: payload.message,
          employeeId: payload.employeeId,
          deviceId: payload.deviceId,
          at: payload.at,
        });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS());
  try {
    const res = await fetch(channelTarget, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    if (!res.ok && res.type !== "opaqueredirect")
      return { delivered: false, error: `HTTP ${res.status}` };
    return { delivered: true, error: null };
  } catch (err) {
    const e = err as Error;
    const msg = e.name === "AbortError" ? "delivery timed out" : e.message || "delivery failed";
    return { delivered: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
};

// ---- Detection -----------------------------------------------------------

interface Candidate {
  /** Stable id for the alert's subject, used in the de-dup key. */
  subjectId: string;
  employeeId: string | null;
  deviceId: string | null;
  message: string;
}

interface SegRow {
  employee_id: string;
  device_id: string;
  start_at: number;
  end_at: number;
  idle: boolean;
  app: string;
  title: string;
  name: string;
}

const RECENT_SEG_SQL = `
  SELECT s.employee_id, s.device_id, s.start_at, s.end_at, s.idle, s.app, s.title, e.name
  FROM segments s JOIN employees e ON e.id = s.employee_id
  WHERE s.end_at >= $1 AND s.end_at <= $2
  ORDER BY s.employee_id, s.start_at`;

async function detectIdleTooLong(db: Db, params: Record<string, unknown>, now: number): Promise<Candidate[]> {
  const minutes = numParam(params, "minutes", 15);
  const minMs = minutes * 60_000;
  const { rows } = await db.query<SegRow>(RECENT_SEG_SQL, [now - RECENT_MS, now]);

  // Only alert while the employee is on the clock (latest session is a clock-in).
  const { rows: sess } = await db.query<{ employee_id: string; kind: string }>(
    "SELECT DISTINCT ON (employee_id) employee_id, kind FROM sessions ORDER BY employee_id, at DESC",
  );
  const clockedIn = new Set(sess.filter((s) => s.kind === "clock_in").map((s) => s.employee_id));

  const byEmp = new Map<string, SegRow[]>();
  for (const r of rows) {
    const list = byEmp.get(r.employee_id) ?? [];
    list.push(r);
    byEmp.set(r.employee_id, list);
  }

  const out: Candidate[] = [];
  for (const [empId, segs] of byEmp) {
    if (!clockedIn.has(empId)) continue;
    // segs are start-ordered; the latest segment is the one with the greatest end_at.
    let latest = segs[0]!;
    for (const s of segs) if (s.end_at > latest.end_at) latest = s;
    if (!latest.idle) continue;
    // Walk backward over contiguous idle segments to measure the idle run.
    let idleStart = latest.start_at;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!;
      if (s.start_at >= latest.start_at) continue;
      if (!s.idle) break;
      if (s.end_at < idleStart - IDLE_GAP_TOL_MS) break;
      idleStart = Math.min(idleStart, s.start_at);
    }
    const runMs = latest.end_at - idleStart;
    if (runMs < minMs) continue;
    out.push({
      subjectId: empId,
      employeeId: empId,
      deviceId: latest.device_id,
      message: `${latest.name} has been idle for ${Math.floor(runMs / 60_000)} min`,
    });
  }
  return out;
}

async function detectAppUsed(db: Db, params: Record<string, unknown>, now: number): Promise<Candidate[]> {
  const pattern = String(params.pattern ?? "").trim();
  if (!pattern) return [];
  const like = `%${pattern.toLowerCase()}%`;
  const { rows } = await db.query<SegRow>(
    `SELECT DISTINCT ON (s.employee_id)
       s.employee_id, s.device_id, s.start_at, s.end_at, s.idle, s.app, s.title, e.name
     FROM segments s JOIN employees e ON e.id = s.employee_id
     WHERE s.end_at >= $1 AND s.end_at <= $2
       AND (lower(s.app) LIKE $3 OR lower(s.title) LIKE $3)
     ORDER BY s.employee_id, s.end_at DESC
     LIMIT $4`,
    [now - RECENT_MS, now, like, SCAN_LIMIT],
  );
  return rows.map((r) => ({
    subjectId: r.employee_id,
    employeeId: r.employee_id,
    deviceId: r.device_id,
    message: `${r.name} used "${r.app || r.title}" (matches "${pattern}")`,
  }));
}

async function detectDeviceOffline(db: Db, params: Record<string, unknown>, now: number): Promise<Candidate[]> {
  const minutes = numParam(params, "minutes", 30);
  const threshold = now - minutes * 60_000;
  const { rows } = await db.query<{
    id: string;
    employee_id: string;
    hostname: string;
    last_seen_at: number;
    name: string;
  }>(
    `SELECT d.id, d.employee_id, d.hostname, d.last_seen_at, e.name
     FROM devices d JOIN employees e ON e.id = d.employee_id
     WHERE d.revoked_at IS NULL AND d.last_seen_at IS NOT NULL
       AND d.last_seen_at <= $1 AND d.last_seen_at >= $2
     ORDER BY d.last_seen_at DESC
     LIMIT $3`,
    [threshold, threshold - RECENT_MS, SCAN_LIMIT],
  );
  return rows.map((r) => ({
    subjectId: r.id,
    employeeId: r.employee_id,
    deviceId: r.id,
    message: `Device ${r.hostname} (${r.name}) has been offline for ${Math.floor(
      (now - r.last_seen_at) / 60_000,
    )} min`,
  }));
}

async function detectSuspiciousDevice(db: Db, _params: Record<string, unknown>, now: number): Promise<Candidate[]> {
  const { rows } = await db.query<{
    id: string;
    employee_id: string;
    hostname: string;
    name: string;
  }>(
    `SELECT d.id, d.employee_id, d.hostname, e.name
     FROM devices d JOIN employees e ON e.id = d.employee_id
     WHERE d.revoked_at IS NULL AND d.suspicious_at IS NOT NULL AND d.suspicious_at >= $1
     ORDER BY d.suspicious_at DESC
     LIMIT $2`,
    [now - SUSPICIOUS_MS, SCAN_LIMIT],
  );
  return rows.map((r) => ({
    subjectId: r.id,
    employeeId: r.employee_id,
    deviceId: r.id,
    message: `Device ${r.hostname} (${r.name}) was flagged as suspicious`,
  }));
}

/** Minutes past local midnight for an epoch-ms instant, given a getTimezoneOffset-style offset. */
const localMinuteOfDay = (at: number, tzOffsetMin: number): number =>
  Math.floor((((at - tzOffsetMin * 60_000) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);

const hhmm = (minuteOfDay: number): string =>
  `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

async function detectOutsideHours(db: Db, params: Record<string, unknown>, now: number): Promise<Candidate[]> {
  const startMin = numParam(params, "startMin", 0);
  const endMin = numParam(params, "endMin", DAY_MS / 60_000);
  const tz = numParam(params, "tzOffsetMin", 0);
  const { rows } = await db.query<SegRow>(
    `SELECT s.employee_id, s.device_id, s.start_at, s.end_at, s.idle, s.app, s.title, e.name
     FROM segments s JOIN employees e ON e.id = s.employee_id
     WHERE s.end_at >= $1 AND s.end_at <= $2 AND NOT s.idle
     ORDER BY s.employee_id, s.start_at DESC
     LIMIT $3`,
    [now - RECENT_MS, now, SCAN_LIMIT],
  );
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (seen.has(r.employee_id)) continue; // one alert per employee per cycle
    const mod = localMinuteOfDay(r.start_at, tz);
    if (mod >= startMin && mod < endMin) continue;
    seen.add(r.employee_id);
    out.push({
      subjectId: r.employee_id,
      employeeId: r.employee_id,
      deviceId: r.device_id,
      message: `${r.name} was active at ${hhmm(mod)} local, outside allowed hours`,
    });
  }
  return out;
}

async function detect(db: Db, rule: AlertRule, now: number): Promise<Candidate[]> {
  switch (rule.type) {
    case "idle_too_long":
      return detectIdleTooLong(db, rule.params, now);
    case "app_used":
      return detectAppUsed(db, rule.params, now);
    case "device_offline":
      return detectDeviceOffline(db, rule.params, now);
    case "suspicious_device":
      return detectSuspiciousDevice(db, rule.params, now);
    case "outside_hours":
      return detectOutsideHours(db, rule.params, now);
    default:
      return [];
  }
}

// ---- Evaluation ----------------------------------------------------------

/**
 * Evaluates every enabled rule against recent data once. For each matching
 * (rule, subject) not already alerted within the current de-dup bucket, inserts
 * an alert_events row and attempts delivery. Deterministic given `now`, which is
 * why tests drive it directly. `deliverFn` is injectable for deterministic tests.
 */
export async function evaluateOnce(
  db: Db,
  now: number = Date.now(),
  deliverFn: DeliverFn = deliver,
): Promise<{ fired: number }> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM alert_rules WHERE enabled ORDER BY created_at`,
  );
  const rules = rows.map(toRule);
  const bucket = Math.floor(now / DEDUPE_MS);
  let fired = 0;

  for (const rule of rules) {
    let candidates: Candidate[];
    try {
      candidates = await detect(db, rule, now);
    } catch (err) {
      console.error(`alert rule ${rule.id} detection failed:`, (err as Error).message);
      continue;
    }
    for (const c of candidates) {
      const dedupeKey = `${rule.type}:${c.subjectId}:${bucket}`;
      const dup = await db.query(
        "SELECT 1 FROM alert_events WHERE rule_id = $1 AND dedupe_key = $2 LIMIT 1",
        [rule.id, dedupeKey],
      );
      if (dup.rowCount) continue;

      let result: DeliveryResult;
      try {
        result = await deliverFn(
          rule.channelKind,
          rule.channelTarget,
          {
            type: rule.type,
            name: rule.name,
            message: c.message,
            employeeId: c.employeeId,
            deviceId: c.deviceId,
            at: now,
          },
          db,
        );
      } catch (err) {
        result = { delivered: false, error: (err as Error).message || "delivery failed" };
      }

      await db.query(
        `INSERT INTO alert_events
           (id, rule_id, employee_id, device_id, message, created_at, delivered, delivery_error, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          crypto.randomUUID(),
          rule.id,
          c.employeeId,
          c.deviceId,
          c.message,
          now,
          result.delivered,
          result.error,
          dedupeKey,
        ],
      );
      fired++;
    }
  }
  return { fired };
}

/**
 * Starts the 60s evaluation loop. Returns a stop function. The timer is unref'd
 * so it never keeps the process alive on its own.
 */
export function startAlertScheduler(db: Db, _config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap evaluations
    running = true;
    try {
      await evaluateOnce(db, Date.now());
    } catch (err) {
      console.error("alert evaluation failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CYCLE_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
