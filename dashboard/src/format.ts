export function duration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export const timeOfDay = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function relative(t: number | null): string {
  if (!t) return "Never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

export function localISODate(d = new Date()): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localISODate(new Date(y!, m! - 1, d! + days));
}

export function localMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

export const osLabel = (os: string) => ({ linux: "Linux", windows: "Windows", macos: "macOS" })[os] ?? os;

export function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
