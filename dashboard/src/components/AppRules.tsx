import { useEffect, useState } from "react";
import { api, type AppRule, type Category } from "../api";

/**
 * App-rule editor. Scoped to a team when `teamId` is set, otherwise the
 * organisation-wide (global) rules. Used by both Settings and Teams.
 */
export function AppRules(props: { teamId?: string | null; onError: (m: string) => void }) {
  const teamId = props.teamId ?? null;
  const [rules, setRules] = useState<AppRule[] | null>(null);
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState<Category>("productive");

  useEffect(() => {
    setRules(null);
    const qs = teamId ? `?teamId=${teamId}` : "";
    api<{ rules: AppRule[] }>(`/api/app-rules${qs}`)
      .then((r) => setRules(r.rules))
      .catch((e) => props.onError((e as Error).message));
  }, [teamId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!pattern.trim()) return;
    try {
      const body: Record<string, unknown> = { pattern: pattern.trim(), category };
      if (teamId) body.teamId = teamId;
      const r = await api<{ rule: AppRule }>("/api/app-rules", { method: "POST", body });
      setRules((x) => [...(x ?? []), r.rule]);
      setPattern("");
    } catch (err) { props.onError((err as Error).message); }
  }

  async function del(id: string) {
    try { await api(`/api/app-rules/${id}`, { method: "DELETE" }); setRules((x) => (x ?? []).filter((r) => r.id !== id)); }
    catch (err) { props.onError((err as Error).message); }
  }

  return (
    <>
      <form className="row rule-form" onSubmit={add}>
        <input placeholder="e.g. code, figma, youtube" value={pattern} onChange={(e) => setPattern(e.target.value)} required />
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          <option value="productive">Productive</option>
          <option value="unproductive">Unproductive</option>
          <option value="neutral">Neutral</option>
        </select>
        <button className="btn btn-primary">Add rule</button>
      </form>
      {rules === null ? <p className="muted">Loading…</p> : rules.length === 0 ? (
        <p className="muted">{teamId ? "No team rules yet — this team uses the organisation rules." : "No rules yet."}</p>
      ) : (
        <ul className="rules">
          {rules.map((r, i) => (
            <li key={r.id}>
              <span className="muted rule-n">{i + 1}</span>
              <code className="mono">{r.pattern}</code>
              <span className={`pill cat-pill cat-${r.category}`}>{r.category}</span>
              <button className="btn btn-small btn-ghost danger" onClick={() => del(r.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
