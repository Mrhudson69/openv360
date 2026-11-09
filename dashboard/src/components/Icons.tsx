// Inline, stroke-based SVG icons (Lucide-style, 1.75 stroke). No emoji, themeable
// via currentColor, crisp at any size. Keep one visual language across the app.
type P = { size?: number; className?: string };
const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round",
  "aria-hidden": true, focusable: false,
});

export const ArrowLeft = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
);
export const ChevronLeft = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}><path d="m15 18-6-6 6-6" /></svg>
);
export const ChevronRight = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}><path d="m9 18 6-6-6-6" /></svg>
);
export const Clock = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const LogIn = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /></svg>
);
export const LogOut = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
);
export const AppWindow = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><rect width="18" height="15" x="3" y="5" rx="2" /><path d="M3 9h18" /><path d="M7 7h.01" /></svg>
);
export const Camera = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
export const Activity = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
);
export const Gauge = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>
);
export const AlertTriangle = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
);
export const Search = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
export const Calendar = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></svg>
);
export const BarChart = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" rx="1" /><rect x="12" y="6" width="3" height="12" rx="1" /><rect x="17" y="13" width="3" height="5" rx="1" /></svg>
);
