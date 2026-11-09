import { useCallback, useEffect, useState } from "react";
import { api, type AlertEvent, type AlertRule, type AlertType, type ChannelKind } from "../api";
import { useRefreshOnFocus } from "../useRefreshOnFocus";
import { Modal } from "../components/Modal";
import { confirmDialog } from "../components/confirm";
import { relative } from "../format";

const TYPE_LABEL: Record<AlertType, string> = {
  idle_too_long: "Idle too long",
  app_used: "Specific app used",
  device_offline: "Device went offline",
  suspicious_device: "Suspicious / tampered data",
  outside_hours: "Activity outside work hours",
};
const TYPE_HINT: Record<AlertType, string> = {
  idle_too_long: "Fires when someone is idle longer than the limit while clocked in.",
  app_used: "Fires when an app or window title matching the text is used.",
  device_offline: "Fires when a device stops checking in for longer than the limit.",
  suspicious_device: "Fires when a device sends data that fails the server's sanity checks.",
  outside_hours: "Fires when activity is recorded outside the given hours.",
};
const CHANNEL_LABEL: Record<ChannelKind, string> = { slack: "Slack webhook", webhook: "Webhook (JSON)", email: "Email" };

export function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<AlertRule | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([
        api<{ rules: AlertRule[] }>("/api/alerts/rules"),
        api<{ events: AlertEvent[] }>("/api/alerts/events?limit=40"),
      ]);
      setRules(r.rules); setEvents(e.events); setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useRefreshOnFocus(load);

  async function toggle(r: AlertRule) {
    try { await api(`/api/alerts/rules/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function del(r: AlertRule) {
    if (!(await confirmDialog({ title: "Delete alert", message: `Delete the alert "${r.name}"?`, danger: true, confirmLabel: "Delete" }))) return;
    try { await api(`/api/alerts/rules/${r.id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function test(r: AlertRule) {
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; error?: string }>(`/api/alerts/rules/${r.id}/test`, { method: "POST" });
      if (res.ok) { setNotice(`Test message sent to ${r.channelTarget}.`); setTimeout(() => setNotice(null), 4000); }
      else setError(`Test failed: ${res.error ?? "unknown error"}`);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Alerts</h1><p className="muted">Get notified in Slack, a webhook, or by email when something needs attention.</p></div>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>+ New alert</button>
      </header>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      <section className="card">
        <h2 className="card-title">Rules</h2>
        {!rules ? <p className="muted">Loading…</p> : rules.length === 0 ? (
          <p className="muted">No alerts yet. Create one to start getting notified.</p>
        ) : (
          <ul className="alert-rules">
            {rules.map((r) => (
              <li key={r.id} className={r.enabled ? "" : "off"}>
                <div className="ar-main">
                  <div className="ar-title">{r.name} <span className="tag plain">{TYPE_LABEL[r.type]}</span></div>
                  <div className="muted small">→ {CHANNEL_LABEL[r.channelKind]}: {r.channelTarget}</div>
                </div>
                <div className="ar-actions">
                  <label className="switch-sm" title={r.enabled ? "Enabled" : "Disabled"}>
                    <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} /><span />
                  </label>
                  <button className="btn btn-small" onClick={() => test(r)}>Test</button>
                  <button className="btn btn-small" onClick={() => setEditing(r)}>Edit</button>
                  <button className="btn btn-small btn-ghost danger" onClick={() => del(r)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Recent alerts <span className="muted">({events.length})</span></h2>
        {events.length === 0 ? <p className="muted">No alerts have fired yet.</p> : (
          <ul className="alert-events">
            {events.map((e) => (
              <li key={e.id}>
                <span className={`dot ${e.delivered ? "dot-ok" : "dot-warn"}`} title={e.delivered ? "Delivered" : `Not delivered${e.deliveryError ? `: ${e.deliveryError}` : ""}`} />
                <span className="ae-msg">{e.message}</span>
                <span className="muted small ae-time">{relative(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && <RuleModal rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} onError={setError} />}
    </div>
  );
}

function RuleModal(props: { rule: AlertRule | null; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const r = props.rule;
  const [name, setName] = useState(r?.name ?? "");
  const [type, setType] = useState<AlertType>(r?.type ?? "idle_too_long");
  const [channelKind, setChannelKind] = useState<ChannelKind>(r?.channelKind ?? "slack");
  const [channelTarget, setChannelTarget] = useState(r?.channelTarget ?? "");
  const [params, setParams] = useState<Record<string, unknown>>(r?.params ?? {});
  const [busy, setBusy] = useState(false);

  const p = (k: string, def: unknown = "") => params[k] ?? def;
  const setP = (k: string, v: unknown) => setParams((x) => ({ ...x, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !channelTarget.trim()) return;
    setBusy(true);
    const body = { name: name.trim(), type, channelKind, channelTarget: channelTarget.trim(), params, enabled: r?.enabled ?? true };
    try {
      if (r) await api(`/api/alerts/rules/${r.id}`, { method: "PATCH", body });
      else await api("/api/alerts/rules", { method: "POST", body });
      props.onSaved();
    } catch (err) { props.onError((err as Error).message); setBusy(false); }
  }

  const num = (k: string, label: string, def: number) => (
    <label className="field"><span>{label}</span>
      <input type="number" min={1} value={Number(p(k, def))} onChange={(e) => setP(k, Number(e.target.value))} />
    </label>
  );

  return (
    <Modal title={r ? "Edit alert" : "New alert"} onClose={props.onClose} wide>
      <form className="form" onSubmit={submit}>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus required placeholder="e.g. Long idle in Support" /></label>
        <label className="field"><span>When</span>
          <select value={type} onChange={(e) => setType(e.target.value as AlertType)}>
            {(Object.keys(TYPE_LABEL) as AlertType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <p className="hint">{TYPE_HINT[type]}</p>

        {type === "idle_too_long" && num("minutes", "Idle minutes", 15)}
        {type === "device_offline" && num("minutes", "Offline minutes", 30)}
        {type === "app_used" && (
          <label className="field"><span>App or title contains</span><input value={String(p("pattern"))} onChange={(e) => setP("pattern", e.target.value)} placeholder="e.g. youtube" required /></label>
        )}
        {type === "outside_hours" && (
          <div className="row">
            {num("startMin", "Work start (min from midnight)", 540)}
            {num("endMin", "Work end (min from midnight)", 1080)}
          </div>
        )}

        <label className="field"><span>Notify via</span>
          <select value={channelKind} onChange={(e) => setChannelKind(e.target.value as ChannelKind)}>
            {(Object.keys(CHANNEL_LABEL) as ChannelKind[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{channelKind === "email" ? "Email address" : channelKind === "slack" ? "Slack incoming-webhook URL" : "Webhook URL"}</span>
          <input value={channelTarget} onChange={(e) => setChannelTarget(e.target.value)} required
            placeholder={channelKind === "email" ? "alerts@company.com" : "https://hooks.slack.com/services/…"} />
        </label>
        {channelKind === "email" && <p className="hint">Email needs SMTP configured on the server (SMTP_URL / SMTP_HOST). Otherwise use Slack or a webhook.</p>}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : r ? "Save" : "Create alert"}</button>
        </div>
      </form>
    </Modal>
  );
}
