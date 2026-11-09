import type { Db } from "./db.js";

export interface Settings {
  orgName: string;
  screenshotsEnabled: boolean;
  screenshotIntervalSec: number;
  screenshotBlur: boolean;
  idleThresholdSec: number;
  trackWindowTitles: boolean;
  workStartMin: number;
  workEndMin: number;
  workdays: number;
  retentionDays: number;
  brandPrimary: string;
  brandAccent: string;
  reportSchedule: "off" | "daily" | "weekly";
  reportHour: number;
  reportWeekday: number;
  reportRecipients: string;
  reportTzOffsetMin: number;
}

interface Row {
  org_name: string;
  screenshots_enabled: boolean;
  screenshot_interval_sec: number;
  screenshot_blur: boolean;
  idle_threshold_sec: number;
  track_window_titles: boolean;
  work_start_min: number;
  work_end_min: number;
  workdays: number;
  retention_days: number;
  brand_primary: string;
  brand_accent: string;
  report_schedule: "off" | "daily" | "weekly";
  report_hour: number;
  report_weekday: number;
  report_recipients: string;
  report_tz_offset_min: number;
}

const toSettings = (r: Row): Settings => ({
  orgName: r.org_name,
  screenshotsEnabled: r.screenshots_enabled,
  screenshotIntervalSec: r.screenshot_interval_sec,
  screenshotBlur: r.screenshot_blur,
  idleThresholdSec: r.idle_threshold_sec,
  trackWindowTitles: r.track_window_titles,
  workStartMin: r.work_start_min,
  workEndMin: r.work_end_min,
  workdays: r.workdays,
  retentionDays: r.retention_days,
  brandPrimary: r.brand_primary,
  brandAccent: r.brand_accent,
  reportSchedule: r.report_schedule,
  reportHour: r.report_hour,
  reportWeekday: r.report_weekday,
  reportRecipients: r.report_recipients,
  reportTzOffsetMin: r.report_tz_offset_min,
});

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<Row>("SELECT * FROM settings WHERE id = 1");
  return toSettings(rows[0]!);
}

const COLUMNS: Record<keyof Settings, keyof Row> = {
  orgName: "org_name",
  screenshotsEnabled: "screenshots_enabled",
  screenshotIntervalSec: "screenshot_interval_sec",
  screenshotBlur: "screenshot_blur",
  idleThresholdSec: "idle_threshold_sec",
  trackWindowTitles: "track_window_titles",
  workStartMin: "work_start_min",
  workEndMin: "work_end_min",
  workdays: "workdays",
  retentionDays: "retention_days",
  brandPrimary: "brand_primary",
  brandAccent: "brand_accent",
  reportSchedule: "report_schedule",
  reportHour: "report_hour",
  reportWeekday: "report_weekday",
  reportRecipients: "report_recipients",
  reportTzOffsetMin: "report_tz_offset_min",
};

export async function updateSettings(db: Db, patch: Partial<Settings>): Promise<Settings> {
  if (patch.orgName !== undefined) patch = { ...patch, orgName: patch.orgName.trim() };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(COLUMNS) as [keyof Settings, keyof Row][]) {
    if (patch[k] !== undefined) {
      vals.push(patch[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (sets.length) await db.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, vals);
  return getSettings(db);
}

export const settingsPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    orgName: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
    screenshotsEnabled: { type: "boolean" },
    screenshotIntervalSec: { type: "integer", minimum: 60, maximum: 86400 },
    screenshotBlur: { type: "boolean" },
    idleThresholdSec: { type: "integer", minimum: 30, maximum: 7200 },
    trackWindowTitles: { type: "boolean" },
    workStartMin: { type: "integer", minimum: 0, maximum: 1439 },
    workEndMin: { type: "integer", minimum: 0, maximum: 1439 },
    workdays: { type: "integer", minimum: 0, maximum: 127 },
    retentionDays: { type: "integer", minimum: 0, maximum: 3650 },
    brandPrimary: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    brandAccent: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    reportSchedule: { type: "string", enum: ["off", "daily", "weekly"] },
    reportHour: { type: "integer", minimum: 0, maximum: 23 },
    reportWeekday: { type: "integer", minimum: 0, maximum: 6 },
    // Empty, or a comma-separated list of simple addresses (optional surrounding spaces).
    reportRecipients: {
      type: "string",
      maxLength: 4000,
      pattern: "^\\s*$|^\\s*[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+\\s*(,\\s*[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+\\s*)*$",
    },
    reportTzOffsetMin: { type: "integer", minimum: -840, maximum: 840 },
  },
} as const;
