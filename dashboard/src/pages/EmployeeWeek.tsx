import { useCallback, useEffect, useRef, useState } from "react";
import { api, tzOffset, type WeekData } from "../api";
import { duration, localISODate, shiftDate } from "../format";
import { Link, navigate } from "../router";

const fmt = (d: string) => new Date(d + "T00:00").toLocaleDateString([], { month: "short", day: "numeric" });

/** Per-person week view: 7 days ending `end`, with per-day active/productive bars. */
export function EmployeeWeekPage(props: { id: string; end: string | null }) {
  const end = props.end ?? localISODate();
  const [data, setData] = useState<WeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = localISODate();

  const reqSeq = useRef(0); // ignore out-of-order responses (instance reused when `end` changes)
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const d = await api<WeekData>(`/api/employees/${props.id}/week?end=${end}&tzOffsetMin=${tzOffset()}`);
      if (seq !== reqSeq.current) return;
      setData(d);
      setError(null);
    } catch (e) { if (seq === reqSeq.current) setError((e as Error).message); }
  }, [props.id, end]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const setEnd = (d: string) => navigate(`/employees/${props.id}?view=week&end=${d}`);
  const openDay = (d: string) => navigate(`/employees/${props.id}?date=${d}`);

  const max = Math.max(...(data?.days ?? []).map((d) => d.activeMs), 1);
  const weekStart = data?.days[0]?.date ?? end;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Link to="/team" className="back">← Members</Link>
          <h1>{data?.employee.name ?? "…"}</h1>
          {data?.employee.team && <p className="muted">{data.employee.team}</p>}
        </div>
        <div className="date-nav">
          <div className="seg-control">
            <button onClick={() => navigate(`/employees/${props.id}?date=${end}`)}>Day</button>
            <button className="on">Week</button>
          </div>
          <button className="btn" onClick={() => setEnd(shiftDate(end, -7))} aria-label="Previous week">‹</button>
          <span className="muted week-range">{fmt(weekStart)} – {fmt(end)}</span>
          <button className="btn" onClick={() => setEnd(shiftDate(end, 7))} disabled={end >= today} aria-label="Next week">›</button>
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      {!data ? <p className="muted pad">Loading…</p> : (
        <>
          <section className="stats">
            <Stat label="Active this week" value={duration(data.totals.activeMs)} accent />
            <Stat label="Productive" value={duration(data.totals.productiveMs)} tone="productive" />
            <Stat label="Unproductive" value={duration(data.totals.unproductiveMs)} tone="unproductive" />
            <Stat label="Idle" value={duration(data.totals.idleMs)} tone="idle" />
          </section>

          <section className="card">
            <h2 className="card-title">Daily activity</h2>
            <div className="week-chart">
              {data.days.map((d) => {
                const prod = d.activeMs ? (d.productiveMs / d.activeMs) * 100 : 0;
                return (
                  <button key={d.date} className={`week-col${d.date === today ? " today" : ""}`} onClick={() => openDay(d.date)}
                    title={`${d.date}\n${duration(d.activeMs)} active · ${duration(d.productiveMs)} productive\nClick to open the day`}>
                    <div className="week-bar-wrap">
                      <div className="week-bar" style={{ height: `${(d.activeMs / max) * 100}%` }}>
                        <div className="trend-prod" style={{ height: `${prod}%` }} />
                      </div>
                    </div>
                    <span className="week-val">{d.activeMs ? duration(d.activeMs) : "—"}</span>
                    <span className="week-x">{new Date(d.date + "T00:00").toLocaleDateString([], { weekday: "short" })}</span>
                    <span className="week-date muted">{new Date(d.date + "T00:00").getDate()}</span>
                  </button>
                );
              })}
            </div>
            <p className="hint"><i className="swatch cat-productive" /> productive share · click a day for the full breakdown.</p>
          </section>
        </>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: string; tone?: string; accent?: boolean }) {
  return (
    <div className={`stat${props.accent ? " stat-accent" : ""}`}>
      <div className="stat-label">{props.tone && <i className={`swatch cat-${props.tone}`} />}{props.label}</div>
      <div className="stat-value">{props.value}</div>
    </div>
  );
}
