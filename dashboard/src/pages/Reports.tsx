import { useCallback, useEffect, useState } from "react";
import { api, download, tzOffset, type ReportRow } from "../api";
import { duration, localISODate, shiftDate } from "../format";
import { Link } from "../router";

const PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 6 },
  { label: "Last 30 days", days: 29 },
];

export function ReportsPage() {
  const today = localISODate();
  const [from, setFrom] = useState(shiftDate(today, -6));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = `from=${from}&to=${to}&tzOffsetMin=${tzOffset()}`;

  const load = useCallback(async () => {
    if (from > to) return setError("The start date must be on or before the end date.");
    try {
      setRows((await api<{ rows: ReportRow[] }>(`/api/reports/summary?${qs}`)).rows);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [qs, from, to]);

  useEffect(() => { void load(); }, [load]);

  const total = (rows ?? []).reduce(
    (a, r) => ({ activeMs: a.activeMs + r.activeMs, idleMs: a.idleMs + r.idleMs, productiveMs: a.productiveMs + r.productiveMs, unproductiveMs: a.unproductiveMs + r.unproductiveMs }),
    { activeMs: 0, idleMs: 0, productiveMs: 0, unproductiveMs: 0 },
  );
  const max = Math.max(1, ...(rows ?? []).map((r) => r.activeMs));

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Reports</h1><p className="muted">Time summary per person for a date range.</p></div>
        <button className="btn" onClick={() => download(`/api/reports/summary.csv?${qs}`, `worklens-summary-${from}_${to}.csv`).catch((e) => setError(e.message))}>Download CSV</button>
      </header>
      <div className="toolbar">
        <label>From<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <div className="row">
          {PRESETS.map((p) => (
            <button key={p.label} className="btn btn-small btn-ghost" onClick={() => { setFrom(shiftDate(today, -p.days)); setTo(today); }}>{p.label}</button>
          ))}
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="card table-card">
        <table className="table">
          <thead><tr><th>Name</th><th className="num">Active</th><th className="bar-col" /><th className="num">Productive</th><th className="num">Unproductive</th><th className="num">Idle</th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.employeeId}>
                <td><Link to={`/employees/${r.employeeId}?date=${to}`}>{r.name}</Link></td>
                <td className="num strong">{duration(r.activeMs)}</td>
                <td className="bar-col">
                  <div className="stack" style={{ width: `${(r.activeMs / max) * 100}%` }}>
                    <span className="cat-productive" style={{ flex: r.productiveMs }} />
                    <span className="cat-neutral" style={{ flex: Math.max(r.activeMs - r.productiveMs - r.unproductiveMs, 0) }} />
                    <span className="cat-unproductive" style={{ flex: r.unproductiveMs }} />
                  </div>
                </td>
                <td className="num">{duration(r.productiveMs)}</td>
                <td className="num">{duration(r.unproductiveMs)}</td>
                <td className="num muted">{duration(r.idleMs)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={6} className="muted">No employees yet.</td></tr>}
          </tbody>
          {rows && rows.length > 1 && (
            <tfoot><tr><td>Total</td><td className="num">{duration(total.activeMs)}</td><td /><td className="num">{duration(total.productiveMs)}</td><td className="num">{duration(total.unproductiveMs)}</td><td className="num">{duration(total.idleMs)}</td></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
