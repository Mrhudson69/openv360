import { useEffect, useRef, useState } from "react";
import type { Segment } from "../api";
import { duration, timeOfDay } from "../format";

type SortKey = "start" | "duration" | "app";

/** Detailed, sortable list of activity segments. Rows link back to the timeline. */
export function ActivityLog(props: {
  segments: Segment[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [sort, setSort] = useState<SortKey>("start");
  const [asc, setAsc] = useState(true);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  // Scroll the selected row into view when it's chosen on the timeline.
  useEffect(() => {
    if (props.selectedId) rowRefs.current[props.selectedId]?.scrollIntoView({ block: "nearest" });
  }, [props.selectedId]);

  const sorted = [...props.segments].sort((a, b) => {
    const dir = asc ? 1 : -1;
    if (sort === "duration") return dir * (a.end - a.start - (b.end - b.start));
    if (sort === "app") return dir * (a.app || "").localeCompare(b.app || "");
    return dir * (a.start - b.start);
  });

  const head = (key: SortKey, label: string, extra = "") => (
    <th
      className={`sortable ${extra}`}
      aria-sort={sort === key ? (asc ? "ascending" : "descending") : "none"}
      onClick={() => {
        if (sort === key) setAsc(!asc);
        else { setSort(key); setAsc(key === "app"); }
      }}
    >
      {label}
      <span className="sort-caret">{sort === key ? (asc ? "▲" : "▼") : ""}</span>
    </th>
  );

  if (props.segments.length === 0) return <p className="muted">No activity matches these filters.</p>;

  return (
    <div className="log-scroll">
      <table className="log">
        <thead>
          <tr>
            {head("start", "Time")}
            {head("duration", "Length", "num")}
            {head("app", "App")}
            <th>Window title</th>
            <th>Category</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr
              key={s.id}
              ref={(el) => { rowRefs.current[s.id] = el; }}
              className={props.selectedId === s.id ? "sel" : ""}
              onClick={() => props.onSelect(props.selectedId === s.id ? null : s.id)}
            >
              <td className="mono">{timeOfDay(s.start)}<span className="muted">–{timeOfDay(s.end)}</span></td>
              <td className="num mono">{duration(s.end - s.start)}</td>
              <td className="app">{s.idle ? <span className="muted">—</span> : (s.app || "unknown")}</td>
              <td className="title" title={s.title}>{s.idle ? <span className="muted">Idle</span> : (s.title || <span className="muted">—</span>)}</td>
              <td><span className={`tag cat-${s.category}`}>{s.category}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
