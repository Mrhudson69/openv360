import { useEffect, useRef, useState } from "react";
import { api, type Device } from "../api";
import { confirmDialog } from "./confirm";
import { relative } from "../format";

const ONLINE_MS = 3 * 60 * 1000;
type Action = { label: string; run: () => Promise<unknown>; confirm?: string; danger?: boolean };

export function DeviceMenu(props: { device: Device; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { device: d } = props;
  const online = !!d.lastSeenAt && Date.now() - d.lastSeenAt < ONLINE_MS;

  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", on);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", on); document.removeEventListener("keydown", esc); };
  }, [open]);

  const post = (path: string) => () => api(path, { method: "POST" });
  const del = () => api(`/api/devices/${d.id}`, { method: "DELETE" });

  const actions: Action[] = [];
  // Pause / resume.
  if (d.command === "stop") actions.push({ label: "Resume tracking", run: post(`/api/devices/${d.id}/resume`) });
  else actions.push({ label: "Pause tracking", run: post(`/api/devices/${d.id}/stop`) });
  // Uninstall, or cancel a pending uninstall.
  if (d.command === "uninstall") {
    actions.push({ label: "Cancel pending uninstall", run: post(`/api/devices/${d.id}/resume`) });
  } else {
    actions.push({
      label: "Uninstall agent remotely",
      run: post(`/api/devices/${d.id}/uninstall`),
      confirm: online
        ? `Tell ${d.hostname} to uninstall the agent? It removes itself the next time it checks in (within a minute). Past data is kept.`
        : `${d.hostname} is offline. The uninstall is queued and only runs when the device next connects — if it never comes back online, it won't uninstall. To fully decommission an offline device, use “Remove device” instead. Past data is kept either way. Queue the uninstall anyway?`,
      danger: true,
    });
  }
  actions.push({
    label: "Remove device",
    run: del,
    confirm: `Remove ${d.hostname}? The agent is disconnected immediately and stops sending data${d.command === "uninstall" ? " (this also clears the pending uninstall)" : ""}. Past data is kept.`,
    danger: true,
  });

  async function run(a: Action) {
    setOpen(false);
    if (a.confirm && !(await confirmDialog({ title: a.label, message: a.confirm, danger: a.danger, confirmLabel: a.label }))) return;
    try { await a.run(); props.onChanged(); } catch (e) { props.onError((e as Error).message); }
  }

  return (
    <div className="device-menu" ref={ref}>
      <button className="chip-x menu-dots" aria-label={`Manage ${d.hostname}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className={`status-dot ${online ? "on" : "off"}`} />
            <div>
              <div className="menu-host">{d.hostname}</div>
              <div className="muted small">{online ? "Online now" : `Last seen ${relative(d.lastSeenAt)}`}</div>
            </div>
          </div>
          {actions.map((a) => (
            <button key={a.label} role="menuitem" className={a.danger ? "danger" : ""} onClick={() => run(a)}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
