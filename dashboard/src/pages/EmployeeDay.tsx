import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmDialog } from "../components/confirm";
import { api, screenshotUrl, type Category, type DayData, type Segment, type Shot } from "../api";
import { ActivityLog } from "../components/ActivityLog";
import { Donut } from "../components/Donut";
import * as Icon from "../components/Icons";
import { Lightbox } from "../components/Lightbox";
import { Timeline } from "../components/Timeline";
import { useRefreshOnFocus } from "../useRefreshOnFocus";
import { duration, localISODate, localMidnight, shiftDate, timeOfDay } from "../format";
import { Link, navigate } from "../router";

const DAY_MS = 24 * 3600 * 1000;
type DetailTab = "screenshots" | "apps" | "activity" | "clock";
type Cat = Category | "idle";
const ALL_CATS: Cat[] = ["productive", "neutral", "unproductive", "idle"];
const CAT_LABEL: Record<Cat, string> = { productive: "Productive", neutral: "Neutral", unproductive: "Unproductive", idle: "Idle" };
type Zoom = "active" | "business" | "day";
const MIN_DURATIONS: { label: string; ms: number }[] = [
  { label: "Any length", ms: 0 },
  { label: "≥ 30s", ms: 30e3 },
  { label: "≥ 1m", ms: 60e3 },
  { label: "≥ 5m", ms: 300e3 },
];

export function EmployeeDayPage(props: { id: string; date: string | null; isOwner?: boolean }) {
  const date = props.date ?? localISODate();
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // Apps the user just classified as productive org-wide, for inline feedback.
  const [addedApps, setAddedApps] = useState<Record<string, "saving" | "done">>({});

  // Filters.
  const [cats, setCats] = useState<Set<Cat>>(new Set(ALL_CATS));
  const [appFilter, setAppFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [minMs, setMinMs] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [shotsInRangeOnly, setShotsInRangeOnly] = useState(false);
  const [tab, setTab] = useState<DetailTab>("screenshots");
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);

  // Guard against out-of-order responses: this component instance is reused when
  // only `date` changes, so a slow fetch for one date could otherwise overwrite
  // a newer one. Only the latest request is allowed to set state.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const tz = new Date(localMidnight(date)).getTimezoneOffset();
      const d = await api<DayData>(`/api/employees/${props.id}/day?date=${date}&tzOffsetMin=${tz}`);
      if (seq !== reqSeq.current) return; // a newer load superseded this one
      setData(d);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError((e as Error).message);
    }
  }, [props.id, date]);

  useEffect(() => { setData(null); setSelected(null); setTimeRange(null); void load(); }, [load]);
  useEffect(() => {
    if (date !== localISODate()) return;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [date, load]);
  // Re-fetch when the tab regains focus so you always see the latest data.
  useRefreshOnFocus(load);

  const setDate = (d: string) => navigate(`/employees/${props.id}?date=${d}`);
  const today = localISODate();
  const dayStart = localMidnight(date);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (s: Segment) =>
      cats.has(s.category) &&
      (!appFilter || s.app === appFilter) &&
      s.end - s.start >= minMs &&
      (!timeRange || (s.end > timeRange[0] && s.start < timeRange[1])) &&
      (!q || s.app.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)),
    [cats, appFilter, minMs, q, timeRange],
  );

  const segments = data?.segments ?? [];
  const filtered = useMemo(() => segments.filter(matches), [segments, matches]);

  const fTotals = useMemo(() => {
    const t = { active: 0, idle: 0, productive: 0, unproductive: 0, neutral: 0 };
    for (const s of filtered) {
      const ms = s.end - s.start;
      if (s.category === "idle") t.idle += ms;
      else { t.active += ms; t[s.category] += ms; }
    }
    return t;
  }, [filtered]);

  const [winStart, winEnd] = useMemo(() => {
    if (zoom === "day") return [dayStart, dayStart + DAY_MS];
    if (zoom === "business") return [dayStart + 7 * 3600e3, dayStart + 19 * 3600e3];
    const fs = data?.totals.firstSeen, ls = data?.totals.lastSeen;
    if (!fs || !ls || ls <= fs) return [dayStart, dayStart + DAY_MS];
    const pad = Math.max((ls - fs) * 0.08, 5 * 60e3);
    return [Math.max(fs - pad, dayStart), Math.min(ls + pad, dayStart + DAY_MS)];
  }, [zoom, dayStart, data]);

  const apps = data?.apps ?? [];
  const toggleCat = (c: Cat) => setCats((prev) => {
    const n = new Set(prev);
    n.has(c) ? n.delete(c) : n.add(c);
    return n.size ? n : new Set(ALL_CATS);
  });
  const filtersActive = cats.size !== ALL_CATS.length || appFilter || q || minMs > 0;
  const resetFilters = () => { setCats(new Set(ALL_CATS)); setAppFilter(""); setQuery(""); setMinMs(0); };

  const shotApp = useCallback(
    (shot: Shot) => segments.find((s) => !s.idle && shot.takenAt >= s.start && shot.takenAt <= s.end)?.app ?? null,
    [segments],
  );
  const inShotFilters = useCallback(
    (at: number) =>
      (!shotsInRangeOnly || (at >= winStart && at <= winEnd)) &&
      (!timeRange || (at >= timeRange[0] && at <= timeRange[1])),
    [shotsInRangeOnly, winStart, winEnd, timeRange],
  );
  const shownShots = useMemo(() => (data?.screenshots ?? []).filter((s) => inShotFilters(s.takenAt)), [data, inShotFilters]);

  const byHour = useMemo(() => {
    const groups = new Map<number, { shot: Shot; index: number }[]>();
    (data?.screenshots ?? []).forEach((shot, index) => {
      if (!inShotFilters(shot.takenAt)) return;
      const h = new Date(shot.takenAt).getHours();
      groups.set(h, [...(groups.get(h) ?? []), { shot, index }]);
    });
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [data, inShotFilters]);

  async function deleteShot(s: Shot) {
    if (!(await confirmDialog({ title: "Delete screenshot", message: "Delete this screenshot permanently? This can't be undone.", danger: true, confirmLabel: "Delete" }))) return;
    try {
      await api(`/api/screenshots/${s.id}`, { method: "DELETE" });
      setData((d) => {
        if (!d) return d;
        const screenshots = d.screenshots.filter((x) => x.id !== s.id);
        if (open !== null) setOpen(screenshots.length ? Math.min(open, screenshots.length - 1) : null);
        return { ...d, screenshots };
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function markProductive(app: string) {
    setAddedApps((m) => ({ ...m, [app]: "saving" }));
    try {
      await api("/api/app-rules", { method: "POST", body: { pattern: app, category: "productive", teamId: null } });
      setAddedApps((m) => ({ ...m, [app]: "done" }));
      await load(); // recolour the bars with the new rule
    } catch (e) {
      setAddedApps((m) => { const n = { ...m }; delete n[app]; return n; });
      setError((e as Error).message);
    }
  }

  const t = data?.totals;
  const maxApp = apps[0]?.ms ?? 1;
  const productivity = fTotals.active ? Math.round((fTotals.productive / fTotals.active) * 100) : null;

  return (
    <div className="page emp-page">
      <header className="page-head sticky-head">
        <div>
          <Link to="/team" className="back"><Icon.ArrowLeft size={15} /> Members</Link>
          <h1>{data?.employee.name ?? <span className="sk sk-title" />}</h1>
          {data?.employee.team && <p className="muted">{data.employee.team}</p>}
        </div>
        <div className="date-nav">
          <div className="seg-control" role="group" aria-label="View">
            <button className="on">Day</button>
            <button onClick={() => navigate(`/employees/${props.id}?view=week&end=${date}`)}>Week</button>
          </div>
          <button className="btn icon-btn" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><Icon.ChevronLeft /></button>
          <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn icon-btn" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today} aria-label="Next day"><Icon.ChevronRight /></button>
          {date !== today && <button className="btn btn-ghost" onClick={() => setDate(today)}>Today</button>}
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      {!data ? <LoadingSkeleton /> : (
        <>
          <section className="hero-card">
            <div className="hero-donut">
              <Donut
                centerLabel={duration(fTotals.active)}
                centerSub="active"
                slices={[
                  { label: "Productive", ms: fTotals.productive, cls: "cat-productive" },
                  { label: "Neutral", ms: fTotals.neutral, cls: "cat-neutral" },
                  { label: "Unproductive", ms: fTotals.unproductive, cls: "cat-unproductive" },
                  { label: "Idle", ms: fTotals.idle, cls: "cat-idle" },
                ]}
              />
            </div>
            <div className="hero-kpis">
              <KPI icon={<Icon.Gauge />} label="Productivity" value={productivity === null ? "—" : `${productivity}%`} sub="of active time" tone="productive" />
              <KPI icon={<Icon.Activity />} label="Productive" value={duration(fTotals.productive)} tone="productive" />
              <KPI icon={<Icon.Activity />} label="Unproductive" value={duration(fTotals.unproductive)} tone="unproductive" />
              <KPI icon={<Icon.Clock />} label="Idle" value={duration(fTotals.idle)} tone="idle" />
              <KPI icon={<Icon.LogIn />} label="First seen" value={t!.firstSeen ? timeOfDay(t!.firstSeen) : "—"} />
              <KPI icon={<Icon.LogOut />} label="Last seen" value={t!.lastSeen ? timeOfDay(t!.lastSeen) : "—"} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title"><Icon.Activity size={17} /> Day timeline</h2>
              <div className="seg-control" role="group" aria-label="Timeline zoom">
                {(["active", "business", "day"] as Zoom[]).map((z) => (
                  <button key={z} className={zoom === z ? "on" : ""} onClick={() => setZoom(z)}>
                    {z === "active" ? "Active hours" : z === "business" ? "7–19" : "Full day"}
                  </button>
                ))}
              </div>
            </div>
            {segments.length === 0 && data.sessions.length === 0
              ? <EmptyState icon={<Icon.Activity size={22} />} text="No activity recorded on this day." />
              : <Timeline windowStart={winStart} windowEnd={winEnd} segments={segments} sessions={data.sessions} selectedId={selected} matches={matches} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))} range={timeRange} onRange={setTimeRange} />}
            {timeRange && (
              <div className="range-filter">
                <span>Filtered to <strong className="tnum">{timeOfDay(timeRange[0])}–{timeOfDay(timeRange[1])}</strong> · {duration(timeRange[1] - timeRange[0])}</span>
                <button className="btn btn-small btn-ghost" onClick={() => setTimeRange(null)}>Clear</button>
              </div>
            )}
          </section>

          <section className="card tabs-card">
            <div className="tab-bar" role="tablist" aria-label="Employee details">
              {([
                { key: "screenshots", label: "Screenshots", icon: <Icon.Camera size={16} />, count: shownShots.length },
                { key: "apps", label: "Top apps", icon: <Icon.BarChart size={16} />, count: apps.length },
                { key: "activity", label: "Activity log", icon: <Icon.AppWindow size={16} />, count: segments.length },
                { key: "clock", label: "Clock in / out", icon: <Icon.Clock size={16} />, count: data.sessions.length },
              ] as { key: DetailTab; label: string; icon: React.ReactNode; count: number }[]).map((tb) => (
                <button key={tb.key} role="tab" aria-selected={tab === tb.key} className={`tab ${tab === tb.key ? "active" : ""}`} onClick={() => setTab(tb.key)}>
                  {tb.icon}{tb.label}<span className="tab-count">{tb.count}</span>
                </button>
              ))}
            </div>

            <div className="tab-panel" role="tabpanel">
              {tab === "screenshots" && (
                <>
                  <div className="panel-head">
                    <span className="muted small">{shownShots.length} screenshot{shownShots.length === 1 ? "" : "s"}</span>
                    <label className="check small"><input type="checkbox" checked={shotsInRangeOnly} onChange={(e) => setShotsInRangeOnly(e.target.checked)} />Only in timeline range</label>
                  </div>
                  {byHour.length === 0 ? <EmptyState icon={<Icon.Camera size={22} />} text="No screenshots in this range." /> : byHour.map(([hour, items]) => (
                    <div key={hour} className="hour-group">
                      <div className="hour-label">{String(hour).padStart(2, "0")}:00</div>
                      <div className="shots">
                        {items.map(({ shot, index }) => (
                          <button key={shot.id} className="shot" onClick={() => setOpen(index)} aria-label={`Screenshot at ${timeOfDay(shot.takenAt)}`}>
                            <span className="shot-img"><img src={screenshotUrl(shot.id)} alt="" loading="lazy" /><span className="shot-zoom"><Icon.Search size={18} /></span></span>
                            <span className="shot-meta"><span className="shot-time tnum">{timeOfDay(shot.takenAt)}</span>{shotApp(shot) && <span className="shot-app-label" title={shotApp(shot)!}>{shotApp(shot)}</span>}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {tab === "apps" && (
                apps.length === 0 ? <EmptyState icon={<Icon.AppWindow size={22} />} text="No app usage yet." /> : (
                  <>
                    <ul className="bars">
                      {apps.slice(0, 15).map((a) => {
                        const added = addedApps[a.app];
                        const isProductive = a.category === "productive" || added === "done";
                        return (
                        <li key={a.app}>
                          <button className={`bar-label bar-link${appFilter === a.app ? " on" : ""}`} onClick={() => { setAppFilter(appFilter === a.app ? "" : a.app); setTab("activity"); }} title={`Filter the activity log by ${a.app}`} aria-pressed={appFilter === a.app}>
                            <span>{a.app}</span><span className="muted tnum">{duration(a.ms)}</span>
                          </button>
                          <div className="bar-row">
                            <div className="bar"><div className={`bar-fill cat-${a.category}`} style={{ width: `${Math.max((a.ms / maxApp) * 100, 1)}%` }} /></div>
                            {props.isOwner && (
                              isProductive ? (
                                <span className="app-add is-done" title="Marked productive org-wide"><Icon.Check size={14} /></span>
                              ) : (
                                <button className="app-add" disabled={added === "saving"} title={`Mark “${a.app}” as productive for the whole organization`} aria-label={`Mark ${a.app} as productive org-wide`} onClick={() => markProductive(a.app)}>
                                  <Icon.Plus size={14} />
                                </button>
                              )
                            )}
                          </div>
                        </li>
                        );
                      })}
                    </ul>
                    <p className="hint">Click an app to filter the activity log.{props.isOwner && <> Use <strong>+</strong> to mark an app as productive for the whole organization.</>} Colors come from <Link to="/settings">Settings</Link>.</p>
                  </>
                )
              )}

              {tab === "activity" && (
                <>
                  <div className="panel-head">
                    <span className="muted small tnum">{filtered.length} of {segments.length} segments · {duration(fTotals.active + fTotals.idle)}</span>
                  </div>
                  <div className="filters">
                    <div className="chips">
                      {ALL_CATS.map((c) => (
                        <button key={c} className={`chip cat-chip cat-${c} ${cats.has(c) ? "on" : ""}`} onClick={() => toggleCat(c)} aria-pressed={cats.has(c)}>
                          <i className={`swatch cat-${c}`} />{CAT_LABEL[c]}
                        </button>
                      ))}
                    </div>
                    <div className="search-wrap">
                      <Icon.Search size={15} className="search-icon" />
                      <input className="filter-search" type="search" placeholder="Search app or window title…" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <select className="filter-select" value={appFilter} onChange={(e) => setAppFilter(e.target.value)} aria-label="Filter by app">
                      <option value="">All apps</option>
                      {apps.map((a) => <option key={a.app} value={a.app}>{a.app}</option>)}
                    </select>
                    <select className="filter-select" value={minMs} onChange={(e) => setMinMs(Number(e.target.value))} aria-label="Minimum length">
                      {MIN_DURATIONS.map((d) => <option key={d.ms} value={d.ms}>{d.label}</option>)}
                    </select>
                    {filtersActive && <button className="btn btn-ghost" onClick={resetFilters}>Clear</button>}
                  </div>
                  <ActivityLog segments={filtered} selectedId={selected} onSelect={setSelected} />
                </>
              )}

              {tab === "clock" && (
                data.sessions.length === 0 ? <EmptyState icon={<Icon.Clock size={22} />} text="No clock events." /> : (
                  <ul className="events timeline-events">
                    {data.sessions.map((s) => (
                      <li key={s.id} className={s.kind}>
                        <span className="ev-dot">{s.kind === "clock_in" ? <Icon.LogIn size={14} /> : <Icon.LogOut size={14} />}</span>
                        <span className="ev-label">{s.kind === "clock_in" ? "Clocked in" : "Clocked out"}</span>
                        <span className="ev-time tnum">{timeOfDay(s.at)}</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          </section>
        </>
      )}

      {open !== null && data && (
        <Lightbox shots={data.screenshots} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onDelete={deleteShot} />
      )}
    </div>
  );
}

function KPI(props: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="kpi">
      <div className={`kpi-icon${props.tone ? ` tone-${props.tone}` : ""}`}>{props.icon}</div>
      <div className="kpi-body">
        <div className="kpi-label">{props.label}</div>
        <div className="kpi-value tnum">{props.value}</div>
        {props.sub && <div className="kpi-sub">{props.sub}</div>}
      </div>
    </div>
  );
}

function EmptyState(props: { icon: React.ReactNode; text: string }) {
  return <div className="empty-state"><span className="empty-icon">{props.icon}</span><p className="muted">{props.text}</p></div>;
}

function LoadingSkeleton() {
  return (
    <div className="skel-wrap" aria-hidden>
      <div className="hero-card"><div className="sk sk-donut" /><div className="hero-kpis">{Array.from({ length: 6 }, (_, i) => <div key={i} className="sk sk-kpi" />)}</div></div>
      <div className="card"><div className="sk sk-line" /><div className="sk sk-timeline" /></div>
      <div className="card"><div className="sk sk-line" /><div className="sk sk-rows" /></div>
    </div>
  );
}
