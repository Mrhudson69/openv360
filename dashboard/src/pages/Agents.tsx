import { useCallback, useEffect, useMemo, useState } from "react";
import { api, tzOffset, type Device, type Employee } from "../api";
import { CopyField } from "../components/CopyField";
import { DeviceMenu } from "../components/DeviceMenu";
import { Modal } from "../components/Modal";
import { OsBadge } from "../components/OsBadge";
import { relative } from "../format";
import { Link } from "../router";

type Os = "linux" | "macos" | "windows";
const OS_TABS: { key: Os; label: string }[] = [
  { key: "linux", label: "Linux" },
  { key: "macos", label: "macOS" },
  { key: "windows", label: "Windows" },
];
const ONLINE_MS = 3 * 60 * 1000;

function installCommand(os: Os, origin: string, code: string): string {
  return os === "windows"
    ? `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Code ${code}`
    : `curl -fsSL ${origin}/install.sh | sh -s -- --code ${code}`;
}
function uninstallCommand(os: Os, origin: string): string {
  return os === "windows"
    ? `& ([scriptblock]::Create((irm ${origin}/uninstall.ps1)))`
    : `curl -fsSL ${origin}/uninstall.sh | sh`;
}
const OS_NOTE: Record<Os, string> = {
  linux: "Runs on Ubuntu 24.04 / 26.04 and most desktops. Installs a background service that starts on boot and restarts if stopped. On GNOME/Wayland the employee logs out and back in once to finish setup.",
  macos: "On first launch the app asks for Screen Recording permission, then runs in the menu bar. Installs as a login agent that restarts if quit.",
  windows: "Run in PowerShell as the employee (not as Administrator). Registers a logon task that restarts the agent if it is closed.",
};

export function AgentsPage() {
  const [list, setList] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [os, setOs] = useState<Os>(() =>
    navigator.userAgent.includes("Windows") ? "windows" : navigator.userAgent.includes("Mac") ? "macos" : "linux",
  );
  const [selected, setSelected] = useState<string>("");
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const origin = window.location.origin;

  const load = useCallback(async () => {
    try {
      const r = await api<{ employees: Employee[] }>(`/api/employees?tzOffsetMin=${tzOffset()}`);
      setList(r.employees);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function generate(id: string) {
    setSelected(id);
    setCode(null);
    if (!id) return;
    setBusy(true);
    try {
      const r = await api<{ enrollmentCode: string; expiresAt: number }>(`/api/employees/${id}/enrollment-code`, { method: "POST" });
      setCode(r.enrollmentCode);
      setExpiresAt(r.expiresAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addPerson(name: string, email: string, team: string) {
    const body: Record<string, string> = { name };
    if (email) body.email = email;
    if (team) body.team = team;
    const r = await api<{ employee: Employee; enrollmentCode: string; expiresAt: number }>("/api/employees", { method: "POST", body });
    setAdding(false);
    await load();
    setSelected(r.employee.id);
    setCode(r.enrollmentCode);
    setExpiresAt(r.expiresAt);
  }

  const shownCode = code ?? "YOUR-CODE";
  const devices = useMemo(() => {
    const rows: { device: Device; person: Employee }[] = [];
    for (const e of list ?? []) for (const d of e.devices) rows.push({ device: d, person: e });
    return rows.sort((a, b) => (b.device.lastSeenAt ?? 0) - (a.device.lastSeenAt ?? 0));
  }, [list]);
  const onlineCount = devices.filter((r) => r.device.lastSeenAt && Date.now() - r.device.lastSeenAt < ONLINE_MS).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">Install the openv360 agent on a computer, and manage the ones already connected.</p>
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <h2 className="card-title">Add an agent</h2>
        <p className="muted">Pick who this computer belongs to, choose the operating system, and run the one-line command on that computer.</p>

        <div className="agent-who">
          <label className="field">
            <span>Employee</span>
            <select value={selected} onChange={(e) => generate(e.target.value)}>
              <option value="">Select a person…</option>
              {(list ?? []).map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.team ? ` · ${e.team}` : ""}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={() => setAdding(true)}>+ New employee</button>
          {busy && <span className="muted small">Generating code…</span>}
        </div>

        {code && (
          <div className="code-callout">
            <CopyField value={code} large label="Enrollment code" />
            <span className="muted small">
              One-time code for {(list ?? []).find((e) => e.id === selected)?.name ?? "this person"}
              {expiresAt ? ` · expires ${new Date(expiresAt).toLocaleDateString()}` : ""}
            </span>
          </div>
        )}

        <div className="tabs" role="tablist">
          {OS_TABS.map((o) => (
            <button key={o.key} role="tab" aria-selected={os === o.key} className={os === o.key ? "active" : ""} onClick={() => setOs(o.key)}>{o.label}</button>
          ))}
        </div>

        <h3 className="section-title">Install command</h3>
        <CopyField value={installCommand(os, origin, shownCode)} />
        {!code && <p className="hint">Select an employee above to fill in their code automatically.</p>}
        <p className="hint">{OS_NOTE[os]}</p>

        <details className="uninstall">
          <summary>Uninstall command</summary>
          <p className="muted">Run on the computer to remove the agent and its data. You can also uninstall remotely from the device list below.</p>
          <CopyField value={uninstallCommand(os, origin)} />
          {os === "linux" && <p className="hint">Add <code className="mono">| sudo sh -s -- --system</code> to also remove the managed-device guard.</p>}
        </details>

        <h3 className="section-title">Or install manually</h3>
        <ol className="steps">
          <li>Download the openv360 agent for the operating system and install it.</li>
          <li>Open it and enter the server address <code className="mono">{origin}</code>.</li>
          <li>Enter the enrollment code and click <strong>Connect</strong>.</li>
        </ol>

        <details className="uninstall">
          <summary>Updating agents</summary>
          <p className="muted">Agents <strong>update themselves</strong>: each one checks this server for a newer build shortly after start and every 6 hours, then downloads it, verifies its checksum, and re-runs the installer in place — no action from the employee. To publish a release, drop the new build and a <code className="mono">releases.json</code> into the server's <code className="mono">downloads</code> folder (or point <code className="mono">GITHUB_RELEASES_URL</code> at a GitHub release).</p>
          <p className="hint">To force an immediate update on one machine, re-run the install one-liner (no code needed — it keeps the existing enrollment):</p>
          <CopyField value={os === "windows" ? `& ([scriptblock]::Create((irm ${origin}/install.ps1)))` : `curl -fsSL ${origin}/install.sh | sh`} />
        </details>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Connected devices</h2>
          <span className="muted small">{devices.length} device{devices.length === 1 ? "" : "s"} · {onlineCount} online now</span>
        </div>
        {!list ? <p className="muted">Loading…</p> : devices.length === 0 ? (
          <p className="muted">No devices yet. Add an agent above to connect the first one.</p>
        ) : (
          <div className="log-scroll">
            <table className="log">
              <thead>
                <tr><th>Device</th><th>Person</th><th>OS / version</th><th>Agent</th><th>Last seen</th><th aria-label="Actions"></th></tr>
              </thead>
              <tbody>
                {devices.map(({ device: d, person }) => {
                  const online = d.lastSeenAt && Date.now() - d.lastSeenAt < ONLINE_MS;
                  return (
                    <tr key={d.id}>
                      <td className="app">{d.hostname || "unknown"}{online && <span className="dot-online" title="Online now" />}</td>
                      <td><Link to={`/employees/${person.id}`}>{person.name}</Link></td>
                      <td><OsBadge d={d} /> <span className="muted small">{d.osVersion}</span></td>
                      <td className="mono small muted">{d.agentVersion}</td>
                      <td className="small muted">{relative(d.lastSeenAt)}</td>
                      <td className="row-actions"><DeviceMenu device={d} onChanged={load} onError={setError} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && <AddPersonModal onAdd={addPerson} onClose={() => setAdding(false)} onError={setError} />}
    </div>
  );
}

function AddPersonModal(props: { onAdd: (n: string, e: string, t: string) => Promise<void>; onClose: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { await props.onAdd(name.trim(), email.trim(), team.trim()); }
    catch (err) { props.onError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title="New employee" onClose={props.onClose}>
      <form onSubmit={submit} className="form">
        <label className="field"><span>Full name</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></label>
        <label className="field"><span>Email <span className="muted">(optional)</span></span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Team <span className="muted">(optional)</span></span><input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Engineering" /></label>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add & get code"}</button>
        </div>
      </form>
    </Modal>
  );
}
