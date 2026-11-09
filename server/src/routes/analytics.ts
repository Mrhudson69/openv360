import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin } from "../auth.js";
import { assertEmployeeInScope, ownerOnly } from "../scope.js";
import { categorizer, type AppRule } from "../categorize.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY_MS, dayStart, localDateString, parseDate, parseTzOffset } from "../time.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_REPORT_DAYS = 366;
const ONLINE_MS = 3 * 60_000; // a device seen this recently is "online now"
const OFFLINE_MS = 30 * 60_000; // an enrolled agent quiet longer than this is "offline"

// ---- Per-employee effective-rules categorisation (team rules then global) ----
// These mirror the helpers in routes/admin.ts (which are not exported).

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

type Categoriser = ReturnType<typeof categorizer>;

/**
 * Builds a `teamId -> categoriser` resolver. Loads global rules and the team
 * rules map once; each employee is categorised with their team's rules first
 * (so team rules override) then the global rules, memoised per team.
 */
async function buildCatFor(db: Db): Promise<(teamId: string | null) => Categoriser> {
  const globalRules = await loadGlobalRules(db);
  const teamRulesMap = await loadTeamRulesMap(db);
  const cache = new Map<string, Categoriser>();
  return (teamId: string | null): Categoriser => {
    const key = teamId ?? "";
    let c = cache.get(key);
    if (!c) {
      const teamRules = teamId ? teamRulesMap.get(teamId) ?? [] : [];
      c = categorizer([...teamRules, ...globalRules]);
      cache.set(key, c);
    }
    return c;
  };
}

interface SegRow {
  employee_id: string;
  start_at: number;
  end_at: number;
  idle: boolean;
  app: string;
  title: string;
}

/**
 * Splits a segment across the fixed-width local-day buckets of a window and
 * invokes `fn` once per day it touches. Day boundaries are `windowStart +
 * i*DAY_MS` (the tz offset is constant, so days are exactly DAY_MS apart).
 * Segments are capped at 20 minutes, so this is O(1) per segment in practice.
 */
function eachDayBucket(
  start: number,
  end: number,
  windowStart: number,
  nDays: number,
  fn: (dayIndex: number, ms: number, clipStart: number, clipEnd: number) => void,
): void {
  const windowEnd = windowStart + nDays * DAY_MS;
  const s = Math.max(start, windowStart);
  const e = Math.min(end, windowEnd);
  if (e <= s) return;
  const first = Math.floor((s - windowStart) / DAY_MS);
  const last = Math.floor((e - 1 - windowStart) / DAY_MS);
  for (let i = first; i <= last; i++) {
    const ds = windowStart + i * DAY_MS;
    const cs = Math.max(s, ds);
    const ce = Math.min(e, ds + DAY_MS);
    if (ce > cs) fn(i, ce - cs, cs, ce);
  }
}

function badId(reply: FastifyReply) {
  return reply.code(404).send({ error: "not found" });
}

function csvCell(v: string | number): string {
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Local time-of-day of an epoch-ms instant, as minutes past that day's local midnight. */
const minutesOfDay = (at: number, dayStartMs: number) => Math.floor((at - dayStartMs) / 60_000);

/** Local time-of-day as HH:MM (empty string for null). */
function hhmm(at: number | null, dayStartMs: number): string {
  if (at === null) return "";
  const m = minutesOfDay(at, dayStartMs);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 0=Sunday..6=Saturday for a YYYY-MM-DD local date. */
function weekday(date: string): number {
  const p = parseDate(date);
  if (!p) throw new Error(`invalid date: ${date}`);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export async function analyticsRoutes(app: FastifyInstance, { db }: { db: Db; config: Config }) {
  await app.register(async (r) => {
    r.addHook("preHandler", requireAdmin(db));

    // ---- 1. Overview ----
    r.get<{ Querystring: { tzOffsetMin?: string } }>("/api/overview", async (req, reply) => {
      if (!ownerOnly(req, reply)) return;
      const tz = parseTzOffset(req.query.tzOffsetMin);
      const now = Date.now();
      const today = localDateString(now, tz);
      const todayStart = dayStart(today, tz);
      const windowStart = todayStart - 6 * DAY_MS; // 7 local days incl. today
      const windowEnd = todayStart + DAY_MS;

      const [{ rows: hc }, { rows: on }, { rows: emps }, segsRes, catFor] = await Promise.all([
        db.query<{ n: number }>("SELECT count(*)::int AS n FROM employees"),
        db.query<{ n: number }>(
          "SELECT count(DISTINCT employee_id)::int AS n FROM devices WHERE revoked_at IS NULL AND last_seen_at > $1",
          [now - ONLINE_MS],
        ),
        db.query<{ id: string; team_id: string | null }>("SELECT id, team_id FROM employees"),
        db.query<SegRow>(
          `SELECT employee_id, start_at, end_at, idle, app, title FROM segments
           WHERE start_at < $2 AND end_at > $1`,
          [windowStart, windowEnd],
        ),
        buildCatFor(db),
      ]);
      const empTeam = new Map(emps.map((e) => [e.id, e.team_id]));

      const trend = Array.from({ length: 7 }, (_, i) => ({
        date: localDateString(windowStart + i * DAY_MS, tz),
        activeMs: 0,
        productiveMs: 0,
      }));
      const todayTotals = { activeMs: 0, productiveMs: 0, unproductiveMs: 0, neutralMs: 0, idleMs: 0 };
      const appAgg = new Map<string, { app: string; ms: number; catMs: Record<string, number> }>();

      for (const s of segsRes.rows) {
        const cat = catFor(empTeam.get(s.employee_id) ?? null);
        const c = cat(s.app, s.title, s.idle);
        eachDayBucket(s.start_at, s.end_at, windowStart, 7, (i, ms) => {
          if (c !== "idle") {
            trend[i]!.activeMs += ms;
            if (c === "productive") trend[i]!.productiveMs += ms;
          }
          if (i === 6) {
            // today
            if (c === "idle") todayTotals.idleMs += ms;
            else {
              todayTotals.activeMs += ms;
              if (c === "productive") todayTotals.productiveMs += ms;
              else if (c === "unproductive") todayTotals.unproductiveMs += ms;
              else todayTotals.neutralMs += ms;
              const appCat = cat(s.app, "");
              const a = appAgg.get(s.app) ?? { app: s.app, ms: 0, catMs: {} };
              a.ms += ms;
              a.catMs[appCat] = (a.catMs[appCat] ?? 0) + ms;
              appAgg.set(s.app, a);
            }
          }
        });
      }

      const topApps = [...appAgg.values()]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10)
        .map((a) => ({
          app: a.app,
          category: Object.entries(a.catMs).sort((x, y) => y[1] - x[1])[0]![0],
          ms: a.ms,
        }));

      const productivityPct = todayTotals.activeMs
        ? Math.round((todayTotals.productiveMs / todayTotals.activeMs) * 1000) / 10
        : null;

      const [{ rows: susp }, { rows: offline }] = await Promise.all([
        db.query<{ id: string; hostname: string; employee_id: string; employee_name: string }>(
          `SELECT d.id, d.hostname, d.employee_id, e.name AS employee_name
           FROM devices d JOIN employees e ON e.id = d.employee_id
           WHERE d.revoked_at IS NULL AND d.suspicious_at IS NOT NULL
           ORDER BY d.suspicious_at DESC`,
        ),
        db.query<{ id: string; name: string; last_seen: number | null }>(
          `SELECT e.id, e.name, MAX(d.last_seen_at) AS last_seen
           FROM employees e JOIN devices d ON d.employee_id = e.id AND d.revoked_at IS NULL
           GROUP BY e.id, e.name
           HAVING MAX(d.last_seen_at) IS NULL OR MAX(d.last_seen_at) <= $1
           ORDER BY lower(e.name), e.name`,
          [now - OFFLINE_MS],
        ),
      ]);

      return {
        headcount: hc[0]!.n,
        onlineNow: on[0]!.n,
        today: todayTotals,
        productivityPct,
        trend,
        topApps,
        attention: {
          suspiciousDevices: susp.map((d) => ({
            deviceId: d.id,
            hostname: d.hostname,
            employeeId: d.employee_id,
            employeeName: d.employee_name,
          })),
          offlineAgents: offline.map((e) => ({ employeeId: e.id, name: e.name, lastSeenAt: e.last_seen })),
        },
      };
    });

    // ---- 2. Per-person week ----
    r.get<{ Params: { id: string }; Querystring: { end?: string; tzOffsetMin?: string } }>(
      "/api/employees/:id/week",
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return badId(reply);
        if (!(await assertEmployeeInScope(db, req, reply, req.params.id))) return;
        const tz = parseTzOffset(req.query.tzOffsetMin);
        const end = req.query.end ?? localDateString(Date.now(), tz);
        if (!parseDate(end)) return reply.code(400).send({ error: "end must be YYYY-MM-DD" });

        const { rows: emp } = await db.query<{ id: string; name: string; team: string | null; team_id: string | null }>(
          `SELECT e.id, e.name, t.name AS team, e.team_id
           FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = $1`,
          [req.params.id],
        );
        if (!emp[0]) return badId(reply);

        const endStart = dayStart(end, tz);
        const windowStart = endStart - 6 * DAY_MS;
        const windowEnd = endStart + DAY_MS;

        const [{ rows: segs }, catFor] = await Promise.all([
          db.query<SegRow>(
            `SELECT employee_id, start_at, end_at, idle, app, title FROM segments
             WHERE employee_id = $1 AND start_at < $3 AND end_at > $2 ORDER BY start_at`,
            [req.params.id, windowStart, windowEnd],
          ),
          buildCatFor(db),
        ]);
        const cat = catFor(emp[0].team_id);

        const days = Array.from({ length: 7 }, (_, i) => ({
          date: localDateString(windowStart + i * DAY_MS, tz),
          activeMs: 0,
          productiveMs: 0,
          unproductiveMs: 0,
          idleMs: 0,
          firstSeen: null as number | null,
          lastSeen: null as number | null,
        }));

        for (const s of segs) {
          const c = cat(s.app, s.title, s.idle);
          eachDayBucket(s.start_at, s.end_at, windowStart, 7, (i, ms, cs, ce) => {
            const d = days[i]!;
            if (c === "idle") d.idleMs += ms;
            else {
              d.activeMs += ms;
              if (c === "productive") d.productiveMs += ms;
              else if (c === "unproductive") d.unproductiveMs += ms;
            }
            d.firstSeen = d.firstSeen === null ? cs : Math.min(d.firstSeen, cs);
            d.lastSeen = d.lastSeen === null ? ce : Math.max(d.lastSeen, ce);
          });
        }

        const totals = { activeMs: 0, productiveMs: 0, unproductiveMs: 0, idleMs: 0 };
        for (const d of days) {
          totals.activeMs += d.activeMs;
          totals.productiveMs += d.productiveMs;
          totals.unproductiveMs += d.unproductiveMs;
          totals.idleMs += d.idleMs;
        }

        const e = emp[0];
        return { employee: { id: e.id, name: e.name, team: e.team, teamId: e.team_id }, days, totals };
      },
    );

    // ---- 3 & 4. Attendance ----
    type AttQuery = { Querystring: { from?: string; to?: string; tzOffsetMin?: string } };

    /** Validates the range, defaulting to the last 7 local days ending today. */
    function parseAttRange(q: AttQuery["Querystring"]): { from: string; to: string; tz: number } | string {
      const tz = parseTzOffset(q.tzOffsetMin);
      const today = localDateString(Date.now(), tz);
      const to = q.to ?? today;
      const from = q.from ?? localDateString(dayStart(today, tz) - 6 * DAY_MS, tz);
      if (!parseDate(from) || !parseDate(to)) return "from/to must be YYYY-MM-DD";
      if (from > to) return "from must not be after to";
      if ((dayStart(to, 0) - dayStart(from, 0)) / DAY_MS > MAX_REPORT_DAYS) return "range is limited to 366 days";
      return { from, to, tz };
    }

    interface AttCell {
      date: string;
      firstSeen: number | null;
      lastSeen: number | null;
      activeMs: number;
      present: boolean;
      late: boolean;
      isWorkday: boolean;
    }
    interface AttRow {
      employeeId: string;
      name: string;
      team: string | null;
      days: AttCell[];
    }

    async function attendance(from: string, to: string, tz: number) {
      const settings = await getSettings(db);
      const windowStart = dayStart(from, tz);
      const nDays = (dayStart(to, tz) - windowStart) / DAY_MS + 1;
      const windowEnd = windowStart + nDays * DAY_MS;

      const dayMeta = Array.from({ length: nDays }, (_, i) => {
        const date = localDateString(windowStart + i * DAY_MS, tz);
        return { date, start: windowStart + i * DAY_MS, isWorkday: ((settings.workdays >> weekday(date)) & 1) === 1 };
      });

      const [{ rows: emps }, { rows: segs }, catFor] = await Promise.all([
        db.query<{ id: string; name: string; team: string | null; team_id: string | null }>(
          `SELECT e.id, e.name, t.name AS team, e.team_id FROM employees e LEFT JOIN teams t ON t.id = e.team_id
           ORDER BY lower(e.name), e.name`,
        ),
        db.query<SegRow>(
          `SELECT employee_id, start_at, end_at, idle, app, title FROM segments
           WHERE start_at < $2 AND end_at > $1`,
          [windowStart, windowEnd],
        ),
        buildCatFor(db),
      ]);
      const empTeam = new Map(emps.map((e) => [e.id, e.team_id]));

      const rows = new Map<string, AttRow>(
        emps.map((e) => [
          e.id,
          {
            employeeId: e.id,
            name: e.name,
            team: e.team,
            days: dayMeta.map((d) => ({
              date: d.date,
              firstSeen: null,
              lastSeen: null,
              activeMs: 0,
              present: false,
              late: false,
              isWorkday: d.isWorkday,
            })),
          },
        ]),
      );

      for (const s of segs) {
        const row = rows.get(s.employee_id);
        if (!row) continue;
        const cat = catFor(empTeam.get(s.employee_id) ?? null);
        const c = cat(s.app, s.title, s.idle);
        eachDayBucket(s.start_at, s.end_at, windowStart, nDays, (i, ms, cs, ce) => {
          const cell = row.days[i]!;
          if (c !== "idle") cell.activeMs += ms;
          cell.firstSeen = cell.firstSeen === null ? cs : Math.min(cell.firstSeen, cs);
          cell.lastSeen = cell.lastSeen === null ? ce : Math.max(cell.lastSeen, ce);
        });
      }

      for (const row of rows.values()) {
        for (let i = 0; i < row.days.length; i++) {
          const cell = row.days[i]!;
          cell.present = cell.firstSeen !== null;
          cell.late =
            cell.isWorkday && cell.present && minutesOfDay(cell.firstSeen!, dayMeta[i]!.start) > settings.workStartMin;
        }
      }

      return {
        schedule: { workStartMin: settings.workStartMin, workEndMin: settings.workEndMin, workdays: settings.workdays },
        dates: dayMeta.map((d) => d.date),
        rows: [...rows.values()],
        dayMeta,
      };
    }

    r.get<AttQuery>("/api/attendance", async (req, reply) => {
      if (!ownerOnly(req, reply)) return;
      const p = parseAttRange(req.query);
      if (typeof p === "string") return reply.code(400).send({ error: p });
      const { schedule, dates, rows } = await attendance(p.from, p.to, p.tz);
      return { schedule, dates, rows };
    });

    r.get<AttQuery>("/api/attendance.csv", async (req, reply) => {
      if (!ownerOnly(req, reply)) return;
      const p = parseAttRange(req.query);
      if (typeof p === "string") return reply.code(400).send({ error: p });
      const { rows, dayMeta } = await attendance(p.from, p.to, p.tz);
      const startOf = new Map(dayMeta.map((d) => [d.date, d.start]));
      const lines = [["Employee", "Team", "Date", "First seen", "Last seen", "Active (min)", "Present", "Late"].join(",")];
      for (const row of rows) {
        for (const cell of row.days) {
          const ds = startOf.get(cell.date)!;
          lines.push(
            [
              row.name,
              row.team ?? "",
              cell.date,
              hhmm(cell.firstSeen, ds),
              hhmm(cell.lastSeen, ds),
              Math.round(cell.activeMs / 60_000),
              cell.present ? "yes" : "no",
              cell.late ? "yes" : "no",
            ]
              .map(csvCell)
              .join(","),
          );
        }
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="openv360-attendance-${p.from}_${p.to}.csv"`);
      return lines.join("\n") + "\n";
    });
  });
}
