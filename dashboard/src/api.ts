export interface User { id: string; name: string; email: string }
export type DeviceCommand = "none" | "stop" | "uninstall";
export interface Device { id: string; hostname: string; os: "linux" | "windows" | "macos" | string; osVersion: string; agentVersion: string; lastSeenAt: number | null; command: DeviceCommand; suspicious: boolean }
export interface Employee { id: string; name: string; email: string | null; team: string | null; teamId: string | null; createdAt: number; lastSeenAt: number | null; devices: Device[]; todayActiveMs: number }
export type Category = "productive" | "unproductive" | "neutral";
export interface Segment { id: string; start: number; end: number; idle: boolean; app: string; title: string; category: Category | "idle" }
export interface SessionEvent { id: string; kind: "clock_in" | "clock_out"; at: number }
export interface Shot { id: string; takenAt: number }
export interface Totals { activeMs: number; idleMs: number; productiveMs: number; unproductiveMs: number; neutralMs: number; firstSeen: number | null; lastSeen: number | null }
export interface DayData { employee: Pick<Employee, "id" | "name" | "email" | "team">; segments: Segment[]; sessions: SessionEvent[]; screenshots: Shot[]; totals: Totals; apps: { app: string; category: Category; ms: number }[] }
export interface Settings { orgName: string; screenshotsEnabled: boolean; screenshotIntervalSec: number; screenshotBlur: boolean; idleThresholdSec: number; screenshotIdleStopSec: number; trackWindowTitles: boolean; workStartMin: number; workEndMin: number; workdays: number; brandPrimary: string; brandAccent: string; retentionDays: number; reportSchedule: "off" | "daily" | "weekly"; reportHour: number; reportWeekday: number; reportRecipients: string; reportTzOffsetMin: number; agentAutoUpdate?: boolean }

// Overview
export interface Overview {
  headcount: number;
  onlineNow: number;
  today: { activeMs: number; productiveMs: number; unproductiveMs: number; neutralMs: number; idleMs: number };
  productivityPct: number | null;
  trend: { date: string; activeMs: number; productiveMs: number }[];
  topApps: { app: string; category: Category; ms: number }[];
  attention: {
    suspiciousDevices: { deviceId: string; hostname: string; employeeId: string; employeeName: string }[];
    offlineAgents: { employeeId: string; name: string; lastSeenAt: number | null }[];
  };
}

// Week view
export interface WeekDay { date: string; activeMs: number; productiveMs: number; unproductiveMs: number; idleMs: number; firstSeen: number | null; lastSeen: number | null }
export interface WeekData { employee: { id: string; name: string; team: string | null; teamId: string | null }; days: WeekDay[]; totals: { activeMs: number; productiveMs: number; unproductiveMs: number; idleMs: number } }

// Attendance
export interface AttendanceDay { date: string; firstSeen: number | null; lastSeen: number | null; activeMs: number; present: boolean; late: boolean; isWorkday: boolean }
export interface Attendance { schedule: { workStartMin: number; workEndMin: number; workdays: number }; dates: string[]; rows: { employeeId: string; name: string; team: string | null; days: AttendanceDay[] }[] }

// Alerts
export type AlertType = "idle_too_long" | "app_used" | "device_offline" | "suspicious_device" | "outside_hours";
export type ChannelKind = "slack" | "webhook" | "email";
export interface AlertRule { id: string; type: AlertType; name: string; params: Record<string, unknown>; channelKind: ChannelKind; channelTarget: string; enabled: boolean; createdAt: number }
export interface AlertEvent { id: string; ruleId: string; ruleName: string; type: AlertType; message: string; employeeId: string | null; deviceId: string | null; createdAt: number; delivered: boolean; deliveryError: string | null }

// Admins / roles
export type Role = "owner" | "manager";
export interface Admin { id: string; name: string; email: string; role: Role; teamId: string | null; teamName?: string | null; createdAt: number; lastLoginAt?: number | null }
export interface AuditEntry { id: string; adminId: string | null; adminName: string | null; action: string; detail: string | null; at: number }
export interface Storage { dbBytes: number; screenshotsBytes: number; totalBytes: number; counts: { employees: number; devices: number; screenshots: number; segments: number; sessions: number } }
export interface Smtp { host: string | null; port: number | null; secure: "none" | "starttls" | "tls"; user: string | null; from: string | null; rejectUnauthorized: boolean; hasPassword: boolean; source: "db" | "env" | "none" }
export interface AppRule { id: string; pattern: string; category: Category; teamId: string | null }
export interface Team { id: string; name: string; memberCount: number; ruleCount: number; createdAt: number }
export interface ReportRow { employeeId: string; name: string; activeMs: number; idleMs: number; productiveMs: number; unproductiveMs: number }

const TOKEN_KEY = "worklens.token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const tzOffset = () => new Date().getTimezoneOffset();
export const screenshotUrl = (id: string) => `/api/screenshots/${id}/image?token=${encodeURIComponent(getToken() ?? "")}`;

/** Fetches a file with auth and triggers a browser download. */
export async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
