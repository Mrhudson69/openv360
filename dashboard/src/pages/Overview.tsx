import { useEffect, useState } from "react";
import { api, tzOffset, type Overview } from "../api";
import { duration, relative } from "../format";
import { Link } from "../router";

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<Overview>(`/api/overview?tzOffsetMin=${tzOffset()}`).then(setData).catch((e) => setError((e as Error).message));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="page"><h1>Overview</h1><div className="error">{error}</div></div>;
  if (!data) return <div className="page"><h1>Overview</h1><p className="muted pad">Loading…</p></div>;

  const t = data.today;
  const maxTrend = Math.max(...data.trend.map((d) => d.activeMs), 1);
  const maxApp = data.topApps[0]?.ms ?? 1;
  const attention = data.attention.suspiciousDevices.length + data.attention.offlineAgents.length;

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Overview</h1><p className="muted">Everyone, today. Updates every minute.</p></div>
      </header>

      <section className="stats">
        <Stat label="Active today" value={duration(t.activeMs)} accent />
        <Stat label="Productivity" value={data.productivityPct === null ? "—" : `${data.productivityPct}%`} sub="of active time" tone="productive" />
        <Stat label="Online now" value={String(data.onlineNow)} sub={`of ${data.headcount}`} />
        <Stat label="Productive" value={duration(t.productiveMs)} tone="productive" />
        <Stat label="Unproductive" value={duration(t.unproductiveMs)} tone="unproductive" />
        <Stat label="Idle" value={duration(t.idleMs)} tone="idle" />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">Active hours · last 7 days</h2>
          <div className="trend">
            {data.trend.map((d) => {
              const prod = d.activeMs ? (d.productiveMs / d.activeMs) * 100 : 0;
              return (
                <div key={d.date} className="trend-col" title={`${d.date}\n${duration(d.activeMs)} active · ${duration(d.productiveMs)} productive`}>
                  <div className="trend-bar" style={{ height: `${(d.activeMs / maxTrend) * 100}%` }}>
                    <div className="trend-prod" style={{ height: `${prod}%` }} />
                  </div>
                  <span className="trend-x">{new Date(d.date + "T00:00").toLocaleDateString([], { weekday: "short" })}</span>
                </div>
              );
            })}
          </div>
          <p className="hint"><i className="swatch cat-productive" /> productive share of each day's active time.</p>
        </section>

        <section className="card">
          <h2 className="card-title">Needs attention {attention > 0 && <span className="count-badge">{attention}</span>}</h2>
          {attention === 0 ? <p className="muted">All clear — every agent is reporting normally.</p> : (
            <ul className="attention">
              {data.attention.offlineAgents.map((a) => (
                <li key={`off-${a.employeeId}`}>
                  <span className="dot dot-offline" />
                  <Link to={`/employees/${a.employeeId}`}>{a.name}</Link>
                  <span className="muted small">offline · last seen {relative(a.lastSeenAt)}</span>
                </li>
              ))}
              {data.attention.suspiciousDevices.map((d) => (
                <li key={`sus-${d.deviceId}`}>
                  <span className="dot dot-warn" />
                  <Link to={`/employees/${d.employeeId}`}>{d.employeeName}</Link>
                  <span className="muted small">unusual data from {d.hostname}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Top apps today</h2>
        {data.topApps.length === 0 ? <p className="muted">No activity yet today.</p> : (
          <ul className="bars">
            {data.topApps.map((a) => (
              <li key={a.app}>
                <div className="bar-label"><span>{a.app}</span><span className="muted">{duration(a.ms)}</span></div>
                <div className="bar"><div className={`bar-fill cat-${a.category}`} style={{ width: `${Math.max((a.ms / maxApp) * 100, 1)}%` }} /></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat(props: { label: string; value: string; sub?: string; tone?: string; accent?: boolean }) {
  return (
    <div className={`stat${props.accent ? " stat-accent" : ""}`}>
      <div className="stat-label">{props.tone && <i className={`swatch cat-${props.tone}`} />}{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.sub && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}
