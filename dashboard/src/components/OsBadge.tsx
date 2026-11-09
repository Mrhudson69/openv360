import type { Device } from "../api";
import { osLabel, relative } from "../format";

const ONLINE_MS = 3 * 60 * 1000;

export function OsBadge({ d }: { d: Device }) {
  const online = !!d.lastSeenAt && Date.now() - d.lastSeenAt < ONLINE_MS;
  const state =
    d.command === "uninstall" ? " · uninstalling" : d.command === "stop" ? " · paused" : "";
  return (
    <span
      className={`os-badge os-${d.os}${d.command !== "none" ? " dimmed" : ""}${online ? " is-online" : ""}`}
      title={`${d.hostname} · ${d.osVersion} · agent ${d.agentVersion} · ${online ? "online now" : `seen ${relative(d.lastSeenAt)}`}${state}`}
    >
      <span className={`status-dot ${online ? "on" : "off"}`} aria-label={online ? "online" : "offline"} />
      <i aria-hidden /> {osLabel(d.os)}
      {d.command === "stop" && <span className="cmd-tag">paused</span>}
      {d.command === "uninstall" && <span className="cmd-tag warn">uninstalling</span>}
      {d.suspicious && (
        <span className="warn-badge" title="Unusual data: this device sent values that failed sanity checks (impossible times, or more activity than a day can hold). The data was limited. A user with admin rights on their own computer can still forge plausible data.">⚠</span>
      )}
    </span>
  );
}
