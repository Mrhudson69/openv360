import { useEffect, useState } from "react";
import { api, type Smtp } from "../api";

const SECURE_LABEL: Record<Smtp["secure"], string> = {
  none: "None (plain, usually port 25)",
  starttls: "STARTTLS (usually port 587)",
  tls: "SSL/TLS (usually port 465)",
};

/** SMTP configuration for alert + report emails. Owner-only on the server. */
export function EmailSettings(props: { onError: (m: string) => void }) {
  const [s, setS] = useState<Smtp | null>(null);
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { api<Smtp>("/api/smtp").then(setS).catch((e) => props.onError((e as Error).message)); }, []);
  if (!s) return <section className="card"><h2 className="card-title">Email (SMTP)</h2><p className="muted">Loading…</p></section>;
  const set = <K extends keyof Smtp>(k: K, v: Smtp[K]) => setS({ ...s, [k]: v });

  async function save() {
    setBusy(true); setNotice(null);
    try {
      const body: Record<string, unknown> = { host: s!.host ?? "", port: s!.port, secure: s!.secure, user: s!.user ?? "", from: s!.from ?? "", rejectUnauthorized: s!.rejectUnauthorized };
      if (password) body.password = password;
      const r = await api<Smtp>("/api/smtp", { method: "PUT", body });
      setS(r); setPassword(""); setNotice("Saved.");
      setTimeout(() => setNotice(null), 3000);
    } catch (e) { props.onError((e as Error).message); } finally { setBusy(false); }
  }

  async function sendTest() {
    if (!testTo.trim()) return;
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ ok: boolean; error?: string }>("/api/smtp/test", { method: "POST", body: { to: testTo.trim() } });
      if (r.ok) { setNotice(`Test email sent to ${testTo}.`); setTimeout(() => setNotice(null), 4000); }
      else props.onError(`Test failed: ${r.error ?? "unknown error"}`);
    } catch (e) { props.onError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2 className="card-title">Email (SMTP)</h2>
      <p className="muted">Used for alert notifications and scheduled reports. {s.source === "env" && <span>Currently configured from environment variables — saving here overrides them.</span>}</p>
      {notice && <div className="notice" role="status">{notice}</div>}
      <div className="smtp-grid">
        <label className="field"><span>SMTP host</span><input value={s.host ?? ""} onChange={(e) => set("host", e.target.value || null)} placeholder="smtp.example.com" /></label>
        <label className="field"><span>Port</span><input type="number" min={1} max={65535} value={s.port ?? ""} onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)} placeholder="587" /></label>
        <label className="field"><span>Encryption</span>
          <select value={s.secure} onChange={(e) => set("secure", e.target.value as Smtp["secure"])}>
            {(Object.keys(SECURE_LABEL) as Smtp["secure"][]).map((k) => <option key={k} value={k}>{SECURE_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field"><span>Username</span><input value={s.user ?? ""} onChange={(e) => set("user", e.target.value || null)} autoComplete="off" /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={s.hasPassword ? "•••••••• (unchanged)" : ""} autoComplete="new-password" /></label>
        <label className="field"><span>From address</span><input value={s.from ?? ""} onChange={(e) => set("from", e.target.value || null)} placeholder="openv360 <alerts@example.com>" /></label>
      </div>
      <label className="toggle">
        <input type="checkbox" role="switch" checked={s.rejectUnauthorized} onChange={(e) => set("rejectUnauthorized", e.target.checked)} />
        <span className="switch" aria-hidden />
        <span><span className="toggle-label">Verify TLS certificate</span><small className="muted block">Off allows self-signed certificates (less secure — only for trusted internal relays).</small></span>
      </label>
      <div className="row end"><button className="btn btn-primary" onClick={save} disabled={busy}>Save SMTP settings</button></div>

      <h3 className="section-title">Send a test email</h3>
      <div className="row">
        <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
        <button className="btn" onClick={sendTest} disabled={busy || !testTo.trim()}>Send test</button>
      </div>
    </section>
  );
}
