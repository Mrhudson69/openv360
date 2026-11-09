import { useCallback, useEffect, useState } from "react";
import { api, download, tzOffset, type Attendance } from "../api";
import { useRefreshOnFocus } from "../useRefreshOnFocus";
import { duration, localISODate, shiftDate, timeOfDay } from "../format";
import { Link } from "../router";

function weekAgo() { return shiftDate(localISODate(), -6); }

export function AttendancePage() {
  const [from, setFrom] = useState(weekAgo());
  const [to, setTo] = useState(localISODate());
  const [data, setData] = useState<Attendance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Attendance>(`/api/attendance?from=${from}&to=${to}&tzOffsetMin=${tzOffset()}`));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  useRefreshOnFocus(load);

  const preset = (days: number) => { setFrom(shiftDate(localISODate(), -(days - 1))); setTo(localISODate()); };
  const dl = () => download(`/api/attendance.csv?from=${from}&to=${to}&tzOffsetMin=${tzOffset()}`, `attendance_${from}_${to}.csv`);

  const dayLabel = (d: string) => new Date(d + "T00:00").toLocaleDateString([], { weekday: "short", day: "numeric" });

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Attendance</h1><p className="muted">First-in / last-out and lateness against the work schedule. Set hours in <Link to="/settings">Settings</Link>.</p></div>
        <button className="btn" onClick={dl} disabled={!data}>Download CSV</button>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      <div className="filters range-bar">
        <label className="field"><span>From</span><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} max={localISODate()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <div className="presets">
          <button className="btn btn-ghost" onClick={() => preset(1)}>Today</button>
          <button className="btn btn-ghost" onClick={() => preset(7)}>7 days</button>
          <button className="btn btn-ghost" onClick={() => preset(30)}>30 days</button>
        </div>
        {data && (
          <div className="att-legend">
            <span><i className="att-cell present" />Present</span>
            <span><i className="att-cell late" />Late</span>
            <span><i className="att-cell absent" />Absent</span>
            <span><i className="att-cell off" />Non-workday</span>
          </div>
        )}
      </div>

      {!data ? <p className="muted pad">Loading…</p> : data.rows.length === 0 ? (
        <div className="card"><p className="muted">No people to show.</p></div>
      ) : (
        <div className="card att-card">
          <div className="log-scroll">
            <table className="log att-table">
              <thead>
                <tr>
                  <th className="sticky-col">Person</th>
                  {data.dates.map((d) => <th key={d} className="att-h">{dayLabel(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.employeeId}>
                    <td className="sticky-col"><Link to={`/employees/${r.employeeId}`}>{r.name}</Link>{r.team && <span className="muted small block">{r.team}</span>}</td>
                    {r.days.map((d) => {
                      const cls = !d.isWorkday ? "off" : !d.present ? "absent" : d.late ? "late" : "present";
                      const label = !d.present ? (d.isWorkday ? "—" : "") : timeOfDay(d.firstSeen!);
                      return (
                        <td key={d.date} className="att-td">
                          <div className={`att-cell ${cls}`} title={`${d.date}\n${d.present ? `In ${timeOfDay(d.firstSeen!)} · Out ${timeOfDay(d.lastSeen!)} · ${duration(d.activeMs)} active${d.late ? " · late" : ""}` : d.isWorkday ? "Absent" : "Non-workday"}`}>
                            {label}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
