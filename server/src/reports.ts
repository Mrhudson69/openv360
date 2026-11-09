import { buildMailTransport } from "./alerts.js";
import { categorizer, type AppRule } from "./categorize.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { getSettings } from "./settings.js";
import { DAY_MS, localDateString } from "./time.js";

// ---- Tunables ------------------------------------------------------------

/** Scheduler cadence: check whether a report is due every 5 minutes. */
export const REPORT_CYCLE_MS = 5 * 60_000;
/** How many apps to list in the "top apps" section. */
const TOP_APPS = 10;

export type ReportPeriod = "daily" | "weekly";

// ---- Rule loading (mirrors routes/admin.ts effective-rules categorisation) ----

interface RuleRow {
  id: string;
  pattern: string;
  category: AppRule["category"];
  team_id: string | null;
}
const toRule = (r: RuleRow): AppRule => ({ id: r.id, pattern: r.pattern, category: r.category, teamId: r.team_id });

async function loadGlobalRules(db: Db): Promise<AppRule[]> {
  const { rows } = await db.query<RuleRow>(
    "SELECT id, pattern, category, team_id FROM app_rules WHERE team_id IS NULL ORDER BY seq",
  );
  return rows.map(toRule);
}

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

/** Team rules first (override), then global rules — matches admin.ts. */
const effectiveRules = (teamRules: AppRule[], globalRules: AppRule[]): AppRule[] => [...teamRules, ...globalRules];

// ---- Report data ---------------------------------------------------------

export interface ReportEmployee {
  employeeId: string;
  name: string;
  activeMs: number;
  idleMs: number;
  productiveMs: number;
  unproductiveMs: number;
}

export interface ReportData {
  orgName: string;
  period: ReportPeriod;
  from: string;
  to: string;
  employees: ReportEmployee[];
  totalActiveMs: number;
  topApps: { app: string; ms: number }[];
}

/**
 * Computes per-employee active/productive/unproductive time over [start, end),
 * categorising each (app, title, idle) bucket with that employee's effective
 * rules — the same logic as routes/admin.ts `summary`.
 */
export async function computeReport(
  db: Db,
  start: number,
  end: number,
  period: ReportPeriod,
  from: string,
  to: string,
): Promise<ReportData> {
  const { orgName } = await getSettings(db);
  const globalRules = await loadGlobalRules(db);
  const teamRulesMap = await loadTeamRulesMap(db);
  const { rows: emps } = await db.query<{ id: string; name: string; team_id: string | null }>(
    "SELECT id, name, team_id FROM employees ORDER BY name",
  );
  const empTeam = new Map(emps.map((e) => [e.id, e.team_id]));
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

  const out = new Map<string, ReportEmployee>(
    emps.map((e) => [e.id, { employeeId: e.id, name: e.name, activeMs: 0, idleMs: 0, productiveMs: 0, unproductiveMs: 0 }]),
  );
  const appMs = new Map<string, number>();

  const { rows } = await db.query<{ employee_id: string; app: string; title: string; idle: boolean; ms: number }>(
    `SELECT employee_id, app, title, idle,
            SUM(LEAST(end_at, $2) - GREATEST(start_at, $1))::bigint AS ms
     FROM segments
     WHERE start_at < $2 AND end_at > $1
     GROUP BY employee_id, app, title, idle`,
    [start, end],
  );

  let totalActiveMs = 0;
  for (const r of rows) {
    const row = out.get(r.employee_id);
    if (!row) continue;
    const c = catFor(empTeam.get(r.employee_id) ?? null)(r.app, r.title, r.idle);
    if (c === "idle") {
      row.idleMs += r.ms;
    } else {
      row.activeMs += r.ms;
      totalActiveMs += r.ms;
      if (c === "productive") row.productiveMs += r.ms;
      else if (c === "unproductive") row.unproductiveMs += r.ms;
      // Top apps are keyed by app name, active time only.
      appMs.set(r.app, (appMs.get(r.app) ?? 0) + r.ms);
    }
  }

  const topApps = [...appMs.entries()]
    .map(([app, ms]) => ({ app: app || "(unknown)", ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, TOP_APPS);

  return {
    orgName,
    period,
    from,
    to,
    employees: [...out.values()].sort((a, b) => b.activeMs - a.activeMs),
    totalActiveMs,
    topApps,
  };
}

// ---- Rendering -----------------------------------------------------------

const hrs = (ms: number): string => (ms / 3_600_000).toFixed(2);
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function reportSubject(d: ReportData): string {
  const range = d.period === "daily" ? d.from : `${d.from} – ${d.to}`;
  return `[${d.orgName}] ${d.period === "daily" ? "Daily" : "Weekly"} activity report (${range})`;
}

export function renderReportText(d: ReportData): string {
  const range = d.period === "daily" ? d.from : `${d.from} to ${d.to}`;
  const lines: string[] = [];
  lines.push(`${d.orgName} — ${d.period === "daily" ? "Daily" : "Weekly"} activity report`);
  lines.push(`Period: ${range}`);
  lines.push(`Team active total: ${hrs(d.totalActiveMs)} h`);
  lines.push("");
  lines.push("Per employee (active / productive / unproductive hours):");
  if (d.employees.length === 0) lines.push("  (no employees)");
  for (const e of d.employees) {
    lines.push(`  ${e.name}: ${hrs(e.activeMs)} / ${hrs(e.productiveMs)} / ${hrs(e.unproductiveMs)}`);
  }
  lines.push("");
  lines.push("Top apps (active hours):");
  if (d.topApps.length === 0) lines.push("  (none)");
  for (const a of d.topApps) lines.push(`  ${a.app}: ${hrs(a.ms)}`);
  lines.push("");
  return lines.join("\n");
}

export function renderReportHtml(d: ReportData): string {
  const range = d.period === "daily" ? esc(d.from) : `${esc(d.from)} – ${esc(d.to)}`;
  const empRows = d.employees.length
    ? d.employees
        .map(
          (e) =>
            `<tr><td>${esc(e.name)}</td><td align="right">${hrs(e.activeMs)}</td><td align="right">${hrs(
              e.productiveMs,
            )}</td><td align="right">${hrs(e.unproductiveMs)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4">(no employees)</td></tr>`;
  const appRows = d.topApps.length
    ? d.topApps.map((a) => `<tr><td>${esc(a.app)}</td><td align="right">${hrs(a.ms)}</td></tr>`).join("")
    : `<tr><td colspan="2">(none)</td></tr>`;
  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;color:#222">
  <h2>${esc(d.orgName)} — ${d.period === "daily" ? "Daily" : "Weekly"} activity report</h2>
  <p><strong>Period:</strong> ${range}<br><strong>Team active total:</strong> ${hrs(d.totalActiveMs)} h</p>
  <h3>Per employee</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <thead><tr><th align="left">Employee</th><th>Active (h)</th><th>Productive (h)</th><th>Unproductive (h)</th></tr></thead>
    <tbody>${empRows}</tbody>
  </table>
  <h3>Top apps</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <thead><tr><th align="left">App</th><th>Active (h)</th></tr></thead>
    <tbody>${appRows}</tbody>
  </table>
  </body></html>`;
}

// ---- Period maths --------------------------------------------------------

/** Parse "a@b.com, c@d.com" -> ["a@b.com","c@d.com"], trimmed and de-blanked. */
export function parseRecipients(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Start of the viewer's local day in UTC epoch ms for the instant `at`. */
function localDayStart(at: number, tz: number): number {
  const shifted = at - tz * 60_000;
  const midnightUtc = Math.floor(shifted / DAY_MS) * DAY_MS;
  return midnightUtc + tz * 60_000;
}

/** The [start, end) range for a period ending at the start of today (local). */
export function periodRange(now: number, tz: number, period: ReportPeriod): { start: number; end: number; from: string; to: string } {
  const end = localDayStart(now, tz); // start of today -> covers only complete days
  const span = period === "weekly" ? 7 * DAY_MS : DAY_MS;
  const start = end - span;
  const from = localDateString(start, tz);
  const to = localDateString(end - 1, tz); // last complete day covered
  return { start, end, from, to };
}

/** ISO week key, e.g. "2026-W45", for the local wall-clock day of `now`. */
export function isoWeekKey(now: number, tz: number): string {
  const d = new Date(now - tz * 60_000);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The report_runs dedupe key for a period at `now`. */
export function periodKey(now: number, tz: number, period: ReportPeriod): string {
  return period === "weekly" ? isoWeekKey(now, tz) : localDateString(now, tz);
}

// ---- Compose & send ------------------------------------------------------

export interface SendResult {
  sent: boolean;
  recipients: string[];
  error?: string;
}

/**
 * Composes the report for the given period and sends it via the effective mail
 * transport (DB SMTP, falling back to env). Recipients come from `opts.to` or
 * the configured report_recipients. Used by the scheduler and the manual
 * "send now" endpoint. Never sends when there are no recipients or no transport.
 */
export async function buildAndSendReport(
  db: Db,
  _config: Config,
  opts: { to?: string[]; period?: ReportPeriod; now?: number } = {},
): Promise<SendResult> {
  const now = opts.now ?? Date.now();
  const settings = await getSettings(db);
  const tz = settings.reportTzOffsetMin;
  const period: ReportPeriod =
    opts.period ?? (settings.reportSchedule === "weekly" ? "weekly" : "daily");

  const recipients = (opts.to ?? parseRecipients(settings.reportRecipients)).map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: false, recipients: [], error: "no recipients" };

  const mt = await buildMailTransport(db);
  if (!mt) return { sent: false, recipients, error: "email not configured" };

  const { start, end, from, to } = periodRange(now, tz, period);
  const data = await computeReport(db, start, end, period, from, to);

  try {
    await mt.transport.sendMail({
      from: mt.from,
      to: recipients.join(", "),
      subject: reportSubject(data),
      text: renderReportText(data),
      html: renderReportHtml(data),
    });
    return { sent: true, recipients };
  } catch (e) {
    return { sent: false, recipients, error: (e as Error).message || "send failed" };
  }
}

// ---- Scheduler -----------------------------------------------------------

/**
 * Decides whether a scheduled report is due at `now` given the settings, and if
 * so claims the period in report_runs (so it is sent at most once per period and
 * survives restarts) and sends it. Returns what it did; never throws.
 */
export async function runReportTick(db: Db, config: Config, now: number = Date.now()): Promise<{ sent: boolean; skipped: string }> {
  try {
    const s = await getSettings(db);
    if (s.reportSchedule === "off") return { sent: false, skipped: "off" };
    const tz = s.reportTzOffsetMin;
    const local = new Date(now - tz * 60_000);
    const hour = local.getUTCHours();
    const weekday = local.getUTCDay();

    if (hour < s.reportHour) return { sent: false, skipped: "before hour" };
    if (s.reportSchedule === "weekly" && weekday !== s.reportWeekday)
      return { sent: false, skipped: "wrong weekday" };

    const period: ReportPeriod = s.reportSchedule === "weekly" ? "weekly" : "daily";
    const key = periodKey(now, tz, period);

    // Claim the period first: at most one send per period, even across restarts.
    const claim = await db.query(
      "INSERT INTO report_runs (period_key, sent_at) VALUES ($1, $2) ON CONFLICT (period_key) DO NOTHING",
      [key, now],
    );
    if (!claim.rowCount) return { sent: false, skipped: "already sent" };

    const res = await buildAndSendReport(db, config, { period, now });
    if (!res.sent) {
      // Record the failure reason; the period stays claimed (at-most-once).
      await db.query("UPDATE report_runs SET sent_at = $2 WHERE period_key = $1", [key, now]).catch(() => {});
      console.error(`scheduled report ${key} not sent: ${res.error ?? "unknown"}`);
      return { sent: false, skipped: res.error ?? "send failed" };
    }
    return { sent: true, skipped: "" };
  } catch (err) {
    console.error("report tick failed:", (err as Error).message);
    return { sent: false, skipped: "error" };
  }
}

/**
 * Starts the 5-minute report scheduler. Returns a stop function. The timer is
 * unref'd so it never keeps the process alive on its own, and the loop never
 * throws.
 */
export function startReportScheduler(db: Db, config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReportTick(db, config, Date.now());
    } catch (err) {
      console.error("report scheduler failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), REPORT_CYCLE_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
