export type Category = "productive" | "unproductive" | "neutral";
export type SegmentCategory = Category | "idle";

export interface AppRule {
  id: string;
  pattern: string;
  category: Category;
  /** null/absent = global (org-wide) rule; otherwise the owning team. */
  teamId?: string | null;
}

/**
 * Rules are ordered by creation. Each rule is first tried against the app name;
 * if no rule matches the app, the rules are tried against the window title.
 */
export function categorize(rules: readonly AppRule[], app: string, title: string, idle = false): SegmentCategory {
  if (idle) return "idle";
  const a = app.toLowerCase();
  const t = title.toLowerCase();
  for (const r of rules) {
    const p = r.pattern.trim().toLowerCase();
    if (p && a.includes(p)) return r.category;
  }
  for (const r of rules) {
    const p = r.pattern.trim().toLowerCase();
    if (p && t.includes(p)) return r.category;
  }
  return "neutral";
}

/** Returns a memoised categoriser; useful when many segments share an app/title. */
export function categorizer(rules: readonly AppRule[]) {
  const cache = new Map<string, SegmentCategory>();
  return (app: string, title: string, idle = false): SegmentCategory => {
    if (idle) return "idle";
    const key = `${app}\u0000${title}`;
    let c = cache.get(key);
    if (!c) {
      c = categorize(rules, app, title);
      cache.set(key, c);
    }
    return c;
  };
}
