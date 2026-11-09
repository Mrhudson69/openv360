// Small SVG donut for the day's time breakdown. Accessible: each slice has a
// <title>, and the legend conveys the same data as text (not color alone).
import { duration } from "../format";

type Slice = { label: string; ms: number; cls: string };

export function Donut(props: { slices: Slice[]; centerLabel: string; centerSub: string; size?: number }) {
  const size = props.size ?? 132;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = props.slices.reduce((a, s) => a + s.ms, 0) || 1;
  let offset = 0;

  return (
    <div className="donut" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${props.centerLabel} ${props.centerSub}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
          {props.slices.filter((s) => s.ms > 0).map((s) => {
            const len = (s.ms / total) * c;
            const el = (
              <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
                className={`donut-slice ${s.cls}`} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} strokeLinecap="butt">
                <title>{s.label}: {duration(s.ms)}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </g>
        <text x="50%" y="46%" textAnchor="middle" className="donut-center">{props.centerLabel}</text>
        <text x="50%" y="62%" textAnchor="middle" className="donut-sub">{props.centerSub}</text>
      </svg>
    </div>
  );
}
