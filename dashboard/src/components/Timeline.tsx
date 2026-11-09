import { useEffect, useRef, useState } from "react";
import type { Segment, SessionEvent } from "../api";
import { duration, timeOfDay } from "../format";

type Hover = { seg: Segment; x: number } | null;

/** Pick a readable axis tick spacing (ms) for a given visible span. */
function tickStep(spanMs: number): number {
  const steps = [
    5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3,
  ];
  const target = spanMs / 8; // aim for ~8 ticks
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}

export function Timeline(props: {
  windowStart: number;
  windowEnd: number;
  segments: Segment[];
  sessions: SessionEvent[];
  selectedId?: string | null;
  matches?: (s: Segment) => boolean;
  onSelect?: (id: string) => void;
  /** Range the user brushed on the timeline, in epoch ms, or null. */
  range?: [number, number] | null;
  /** Called when the user drags out a range (or null-ish on a plain click). */
  onRange?: (range: [number, number] | null) => void;
}) {
  const { windowStart: ws, windowEnd: we } = props;
  const span = Math.max(we - ws, 1);
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const dragged = useRef(false);

  const left = (t: number) => `${((Math.min(Math.max(t, ws), we) - ws) / span) * 100}%`;
  const width = (s: Segment) => {
    const a = Math.max(s.start, ws), b = Math.min(s.end, we);
    return Math.max(((b - a) / span) * 100, 0);
  };
  const xToTime = (x: number) => {
    const w = trackRef.current?.clientWidth ?? 1;
    return ws + (Math.min(Math.max(x, 0), w) / w) * span;
  };
  const relX = (clientX: number) => clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);

  // Finish a drag on mouse-up anywhere (so releasing outside the track still works).
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
      if (dragged.current && b - a > 4) props.onRange?.([xToTime(a), xToTime(b)]);
      setDrag(null);
    };
    const move = (e: MouseEvent) => {
      setDrag((d) => (d ? { ...d, x1: relX(e.clientX) } : d));
      if (Math.abs(relX(e.clientX) - drag.x0) > 4) dragged.current = true;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = tickStep(span);
  const firstTick = Math.ceil(ws / step) * step;
  const ticks: number[] = [];
  for (let t = firstTick; t <= we; t += step) ticks.push(t);

  const visible = props.segments.filter((s) => s.end > ws && s.start < we);
  const range = props.range;

  return (
    <div className="timeline">
      <div
        className="timeline-track is-brushable"
        ref={trackRef}
        onMouseLeave={() => setHover(null)}
        onMouseDown={(e) => { const x = relX(e.clientX); dragged.current = false; setDrag({ x0: x, x1: x }); }}
      >
        {ticks.map((t) => (
          <div key={`g${t}`} className="tl-grid" style={{ left: left(t) }} />
        ))}
        {/* Persisted brushed range (dims everything outside). */}
        {range && (
          <div className="tl-range" style={{ left: left(range[0]), width: `${((Math.min(range[1], we) - Math.max(range[0], ws)) / span) * 100}%` }} />
        )}
        {visible.map((s) => {
          const inRange = !range || (s.end > range[0] && s.start < range[1]);
          const dim = (props.matches ? !props.matches(s) : false) || !inRange;
          const sel = props.selectedId === s.id;
          return (
            <div
              key={s.id}
              className={`tl-seg cat-${s.category}${dim ? " dim" : ""}${sel ? " sel" : ""}`}
              style={{ left: left(s.start), width: `${Math.max(width(s), 0.3)}%` }}
              onMouseMove={(e) => { const r = trackRef.current?.getBoundingClientRect(); if (r) setHover({ seg: s, x: e.clientX - r.left }); }}
              onMouseEnter={(e) => { const r = trackRef.current?.getBoundingClientRect(); if (r) setHover({ seg: s, x: e.clientX - r.left }); }}
              onClick={() => { if (!dragged.current) props.onSelect?.(s.id); }}
            />
          );
        })}
        {props.sessions
          .filter((e) => e.at >= ws && e.at <= we)
          .map((e) => (
            <div
              key={e.id}
              className={`tl-marker ${e.kind}`}
              style={{ left: left(e.at) }}
              title={`${e.kind === "clock_in" ? "Clocked in" : "Clocked out"} ${timeOfDay(e.at)}`}
            />
          ))}
        {/* Live drag rectangle. */}
        {drag && (
          <div className="tl-brush" style={{ left: `${Math.min(drag.x0, drag.x1)}px`, width: `${Math.abs(drag.x1 - drag.x0)}px` }} />
        )}
        {hover && !drag && (
          <div
            className="tl-tip"
            style={{ left: `${hover.x}px` }}
            data-side={hover.x > (trackRef.current?.clientWidth ?? 0) / 2 ? "right" : "left"}
          >
            <div className="tl-tip-time">
              {timeOfDay(hover.seg.start)}–{timeOfDay(hover.seg.end)}
              <span className="muted"> · {duration(hover.seg.end - hover.seg.start)}</span>
            </div>
            <div className="tl-tip-app">
              <i className={`swatch cat-${hover.seg.category}`} />
              {hover.seg.idle ? "Idle" : hover.seg.app || "unknown"}
            </div>
            {!hover.seg.idle && hover.seg.title && <div className="tl-tip-title">{hover.seg.title}</div>}
          </div>
        )}
      </div>
      <div className="timeline-axis">
        {ticks.map((t) => (
          <span key={t} style={{ left: left(t) }}>{timeOfDay(t)}</span>
        ))}
      </div>
      <div className="legend">
        <span><i className="cat-productive" />Productive</span>
        <span><i className="cat-neutral" />Neutral</span>
        <span><i className="cat-unproductive" />Unproductive</span>
        <span><i className="cat-idle" />Idle</span>
        <span><i className="marker-key" />Clock in / out</span>
        <span className="tl-hint muted">Drag to select a time range</span>
      </div>
    </div>
  );
}
