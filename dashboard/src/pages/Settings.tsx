import { useEffect, useRef, useState } from "react";
import { api, getToken, type Settings, type Storage } from "../api";
import { applyBrand, getBrand, loadBrand } from "../brand";
import { AppRules } from "../components/AppRules";
import { EmailSettings } from "../components/EmailSettings";
import { fmtBytes } from "../format";
import { Link } from "../router";

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(getBrand().logoUrl);
  const [logoV, setLogoV] = useState(0);
  const [storage, setStorage] = useState<Storage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Settings>("/api/settings")
      .then((st) => { setS(st); setSaved(st); })
      .catch((e) => setError(e.message));
    api<Storage>("/api/storage").then(setStorage).catch(() => {});
  }, []);

  const dirty = s && saved && JSON.stringify(s) !== JSON.stringify(saved);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    try {
      const r = await api<Settings>("/api/settings", { method: "PUT", body: s });
      setS(r); setSaved(r); setError(null);
      applyBrand({ ...getBrand(), orgName: r.orgName, brandPrimary: r.brandPrimary, brandAccent: r.brandAccent });
      setNotice("Saved. Agents pick up changes within a few minutes.");
      setTimeout(() => setNotice(null), 4000);
    } catch (err) { setError((err as Error).message); }
  }

  async function sendReportNow() {
    if (!s) return;
    try {
      const r = await api<{ sent: boolean; recipients: string[]; error?: string }>("/api/reports/send-now", { method: "POST", body: { period: s.reportSchedule === "weekly" ? "weekly" : "daily" } });
      if (r.sent) { setNotice(`Report sent to ${r.recipients.join(", ")}.`); setTimeout(() => setNotice(null), 4000); }
      else setError(`Report not sent: ${r.error ?? "no recipients or SMTP not configured"}`);
    } catch (err) { setError((err as Error).message); }
  }

  async function uploadLogo(file: File) {
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/branding/logo", { method: "POST", headers: { authorization: `Bearer ${getToken() ?? ""}` }, body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `upload failed (${res.status})`);
      const b = await loadBrand();
      setLogoUrl(b.logoUrl); setLogoV((v) => v + 1);
      setNotice("Logo updated."); setTimeout(() => setNotice(null), 3000);
    } catch (err) { setError((err as Error).message); }
  }

  async function removeLogo() {
    try {
      await api("/api/branding/logo", { method: "DELETE" });
      const b = await loadBrand();
      setLogoUrl(b.logoUrl); setLogoV((v) => v + 1);
    } catch (err) { setError((err as Error).message); }
  }

  if (!s) return <div className="page"><h1>Settings</h1>{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const setColor = (k: "brandPrimary" | "brandAccent", v: string) => {
    setS({ ...s, [k]: v });
    if (/^#[0-9a-fA-F]{6}$/.test(v)) applyBrand({ ...getBrand(), [k]: v });
  };
  const minutes = Math.round(s.screenshotIntervalSec / 60);

  return (
    <div className="page">
      <header className="page-head"><div><h1>Settings</h1><p className="muted">Applies to every connected agent.</p></div></header>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      <form className="card form" onSubmit={save}>
        <h2 className="card-title">Branding</h2>
        <p className="muted">Rebrand the whole dashboard — name, colors, and logo. Changes apply instantly across the site.</p>
        <label>Organization name<input value={s.orgName} maxLength={100} required onChange={(e) => set("orgName", e.target.value)} /></label>
        <div className="brand-grid">
          <label>Primary color
            <div className="color-field">
              <input type="color" value={s.brandPrimary} onChange={(e) => setColor("brandPrimary", e.target.value)} />
              <input className="hex" value={s.brandPrimary} onChange={(e) => setColor("brandPrimary", e.target.value)} pattern="#[0-9a-fA-F]{6}" />
            </div>
          </label>
          <label>Accent color
            <div className="color-field">
              <input type="color" value={s.brandAccent} onChange={(e) => setColor("brandAccent", e.target.value)} />
              <input className="hex" value={s.brandAccent} onChange={(e) => setColor("brandAccent", e.target.value)} pattern="#[0-9a-fA-F]{6}" />
            </div>
          </label>
        </div>
        <div className="logo-row">
          <div className="logo-preview">{logoUrl ? <img src={`${logoUrl}?v=${logoV}`} alt="Current logo" /> : <span className="brand-mark" />}</div>
          <div>
            <div className="logo-actions">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = ""; }} />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Upload logo</button>
              {logoUrl && <button type="button" className="btn btn-ghost danger" onClick={removeLogo}>Remove</button>}
            </div>
            <p className="hint">PNG, JPG, WebP or SVG, up to 2 MB. Shown in the sidebar and on the sign-in screen.</p>
          </div>
        </div>
        <p className="hint">Color and logo changes save when you click Save; the preview updates immediately.</p>

        <h2 className="card-title">Screenshots</h2>
        <Toggle label="Capture screenshots" hint="Employees see a notice in the agent whenever screenshots are on." checked={s.screenshotsEnabled} onChange={(v) => set("screenshotsEnabled", v)} />
        <label className={s.screenshotsEnabled ? "" : "disabled"}>
          Interval
          <div className="row">
            <input type="number" min={1} max={1440} value={minutes} disabled={!s.screenshotsEnabled}
              onChange={(e) => set("screenshotIntervalSec", Math.max(1, Number(e.target.value) || 1) * 60)} />
            <span className="muted">minutes between screenshots</span>
          </div>
        </label>
        <Toggle label="Blur screenshots" hint="Blur on the device before upload, so text is unreadable." checked={s.screenshotBlur} disabled={!s.screenshotsEnabled} onChange={(v) => set("screenshotBlur", v)} />
        <label className={s.screenshotsEnabled ? "" : "disabled"}>
          Pause when idle for
          <div className="row">
            <input type="number" min={0} max={1440} value={Math.round(s.screenshotIdleStopSec / 60)} disabled={!s.screenshotsEnabled}
              onChange={(e) => set("screenshotIdleStopSec", Math.min(1440, Math.max(0, Number(e.target.value) || 0)) * 60)} />
            <span className="muted">minutes — screenshots keep going while working or briefly idle, and pause after this much continuous idle (resuming when active). 0 = never pause.</span>
          </div>
        </label>

        <h2 className="card-title">Activity</h2>
        <label>
          Idle after
          <div className="row">
            <input type="number" min={1} max={120} value={Math.round(s.idleThresholdSec / 60)}
              onChange={(e) => set("idleThresholdSec", Math.min(120, Math.max(1, Number(e.target.value) || 1)) * 60)} />
            <span className="muted">minutes without keyboard or mouse input</span>
          </div>
        </label>
        <Toggle label="Record window titles" hint="Titles show document and page names. Turn off to record app names only." checked={s.trackWindowTitles} onChange={(v) => set("trackWindowTitles", v)} />

        <h2 className="card-title">Work schedule</h2>
        <p className="muted">Used by the Attendance report to flag late arrivals and non-workdays.</p>
        <div className="row schedule-row">
          <label>Start<input type="time" value={minToTime(s.workStartMin ?? 540)} onChange={(e) => set("workStartMin", timeToMin(e.target.value))} /></label>
          <label>End<input type="time" value={minToTime(s.workEndMin ?? 1080)} onChange={(e) => set("workEndMin", timeToMin(e.target.value))} /></label>
        </div>
        <div className="weekday-row">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
            const on = ((s.workdays ?? 62) & (1 << i)) !== 0;
            return (
              <button type="button" key={d} className={`weekday${on ? " on" : ""}`} aria-pressed={on}
                onClick={() => set("workdays", (s.workdays ?? 62) ^ (1 << i))}>{d}</button>
            );
          })}
        </div>

        <h2 className="card-title">Data retention</h2>
        <label>
          Keep data for
          <div className="row">
            <input type="number" min={0} max={3650} value={s.retentionDays}
              onChange={(e) => set("retentionDays", Math.min(3650, Math.max(0, Number(e.target.value) || 0)))} />
            <span className="muted">days — screenshots, activity and sessions older than this are deleted automatically. <strong>0 = keep forever.</strong></span>
          </div>
        </label>

        <h2 className="card-title">Scheduled email reports</h2>
        <p className="muted">Email a team summary automatically. Configure SMTP below first.</p>
        <label>Frequency
          <select value={s.reportSchedule} onChange={(e) => {
            const v = e.target.value as Settings["reportSchedule"];
            setS({ ...s, reportSchedule: v, reportTzOffsetMin: v === "off" ? s.reportTzOffsetMin : new Date().getTimezoneOffset() });
          }}>
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        {s.reportSchedule !== "off" && (
          <>
            <div className="row">
              <label className="inline-field">Send at
                <select value={s.reportHour} onChange={(e) => set("reportHour", Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </select>
              </label>
              {s.reportSchedule === "weekly" && (
                <label className="inline-field">on
                  <select value={s.reportWeekday} onChange={(e) => set("reportWeekday", Number(e.target.value))}>
                    {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </label>
              )}
              <span className="muted small">in your timezone</span>
            </div>
            <label>Recipients<input value={s.reportRecipients} onChange={(e) => set("reportRecipients", e.target.value)} placeholder="manager@company.com, lead@company.com" /></label>
            <div className="row"><button type="button" className="btn" onClick={sendReportNow} disabled={!s.reportRecipients.trim()}>Send a report now</button></div>
          </>
        )}

        <div className="row end"><button className="btn btn-primary" disabled={!dirty}>Save changes</button></div>
      </form>

      <EmailSettings onError={setError} />

      <section className="card">
        <h2 className="card-title">Storage used</h2>
        {!storage ? <p className="muted">Calculating…</p> : (
          <>
            <div className="storage-total">{fmtBytes(storage.totalBytes)}<span className="muted small"> total</span></div>
            <div className="storage-bar">
              <div className="storage-seg cat-productive" style={{ width: `${pct(storage.screenshotsBytes, storage.totalBytes)}%` }} title={`Screenshots ${fmtBytes(storage.screenshotsBytes)}`} />
              <div className="storage-seg cat-neutral" style={{ width: `${pct(storage.dbBytes, storage.totalBytes)}%` }} title={`Database ${fmtBytes(storage.dbBytes)}`} />
            </div>
            <div className="storage-legend">
              <span><i className="swatch cat-productive" />Screenshots {fmtBytes(storage.screenshotsBytes)}</span>
              <span><i className="swatch cat-neutral" />Database {fmtBytes(storage.dbBytes)}</span>
            </div>
            <div className="storage-counts">
              {([["employees","People"],["devices","Devices"],["screenshots","Screenshots"],["segments","Activity segments"],["sessions","Clock events"]] as const).map(([k, label]) => (
                <div key={k}><strong className="tnum">{storage.counts[k].toLocaleString()}</strong><span className="muted small">{label}</span></div>
              ))}
            </div>
            <p className="hint">Set a retention period above to keep this from growing without bound.</p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Organization app rules</h2>
        <p className="muted">Classify apps and websites for everyone. Each rule is matched as text against the app name first, then the window title. The first matching rule wins; anything unmatched is neutral. Give a specific team its own rules under <Link to="/teams">Teams</Link> — team rules win over these.</p>
        <AppRules onError={setError} />
      </section>
    </div>
  );
}

const minToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function Toggle(props: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`toggle${props.disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span><span className="toggle-label">{props.label}</span>{props.hint && <small className="muted block">{props.hint}</small>}</span>
    </label>
  );
}
