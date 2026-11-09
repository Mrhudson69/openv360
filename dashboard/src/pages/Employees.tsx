import { useCallback, useEffect, useState } from "react";
import { api, tzOffset, type Employee } from "../api";
import { useRefreshOnFocus } from "../useRefreshOnFocus";
import { DeviceMenu } from "../components/DeviceMenu";
import { EnrollDialog } from "../components/EnrollDialog";
import { Modal } from "../components/Modal";
import { confirmDialog } from "../components/confirm";
import { OsBadge } from "../components/OsBadge";
import { duration, relative } from "../format";
import { Link } from "../router";

const ONLINE_MS = 3 * 60 * 1000;

export function EmployeesPage() {
  const [list, setList] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [enroll, setEnroll] = useState<{ name: string; code: string; expiresAt?: number } | null>(null);
  const [filter, setFilter] = useState("");

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
  useRefreshOnFocus(load);

  async function regenerate(e: Employee) {
    try {
      const r = await api<{ enrollmentCode: string; expiresAt: number }>(`/api/employees/${e.id}/enrollment-code`, { method: "POST" });
      setEnroll({ name: e.name, code: r.enrollmentCode, expiresAt: r.expiresAt });
    } catch (err) { setError((err as Error).message); }
  }

  async function remove(e: Employee) {
    if (!(await confirmDialog({ title: "Remove employee", message: `Remove ${e.name}? This deletes all of their activity data and screenshots and disconnects their devices.`, danger: true, confirmLabel: "Remove" }))) return;
    try { await api(`/api/employees/${e.id}`, { method: "DELETE" }); await load(); } catch (err) { setError((err as Error).message); }
  }

  const q = filter.trim().toLowerCase();
  const shown = (list ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || (e.team ?? "").toLowerCase().includes(q) || (e.email ?? "").toLowerCase().includes(q));
  const online = (list ?? []).filter((e) => e.lastSeenAt && Date.now() - e.lastSeenAt < ONLINE_MS).length;
  const teamTotal = (list ?? []).reduce((a, e) => a + e.todayActiveMs, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">{list ? `${list.length} people · ${online} online now · ${duration(teamTotal)} active today` : "Loading…"}</p>
        </div>
        <div className="row">
          <input className="search" placeholder="Search people or teams" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn btn-primary" onClick={() => setAdding(true)}>Add employee</button>
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      {!list ? <p className="muted pad">Loading…</p> : (
        <div className="card">
          <div className="log-scroll">
            <table className="log emp-table">
              <thead>
                <tr><th>Name</th><th>Team</th><th>Devices</th><th>Last seen</th><th className="num">Active today</th><th aria-label="Actions"></th></tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const isOnline = e.lastSeenAt && Date.now() - e.lastSeenAt < ONLINE_MS;
                  return (
                    <tr key={e.id}>
                      <td>
                        <div className="person">
                          <span className="avatar" aria-hidden>{e.name.slice(0, 1).toUpperCase()}</span>
                          <div className="person-name">
                            <Link to={`/employees/${e.id}`}>{e.name}</Link>
                            {e.email && <span className="muted small block">{e.email}</span>}
                          </div>
                        </div>
                      </td>
                      <td>{e.team ?? <span className="muted">—</span>}</td>
                      <td>
                        {e.devices.length === 0 ? <span className="muted small">No devices</span> : (
                          <div className="dev-list">
                            {e.devices.map((d) => (
                              <span key={d.id} className="dev-item"><OsBadge d={d} /><DeviceMenu device={d} onChanged={load} onError={setError} /></span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="small muted">{isOnline ? <span className="online-tag">online</span> : relative(e.lastSeenAt)}</td>
                      <td className="num tnum">{duration(e.todayActiveMs)}</td>
                      <td className="row-actions">
                        <button className="btn btn-small" onClick={() => regenerate(e)}>Add device</button>
                        <button className="btn btn-small btn-ghost danger" onClick={() => remove(e)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={6} className="muted pad">No people match “{filter}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && <AddEmployee onClose={() => setAdding(false)} onAdded={(r) => { setAdding(false); void load(); setEnroll({ name: r.employee.name, code: r.enrollmentCode, expiresAt: r.expiresAt }); }} onError={setError} />}
      {enroll && <EnrollDialog name={enroll.name} code={enroll.code} expiresAt={enroll.expiresAt} onClose={() => setEnroll(null)} />}
    </div>
  );
}

type AddResult = { employee: Employee; enrollmentCode: string; expiresAt: number };

function AddEmployee(props: { onClose: () => void; onAdded: (r: AddResult) => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const body: Record<string, string> = { name: name.trim() };
    if (email.trim()) body.email = email.trim();
    if (team.trim()) body.team = team.trim();
    try {
      const r = await api<AddResult>("/api/employees", { method: "POST", body });
      props.onAdded(r);
    } catch (err) { props.onError((err as Error).message); setBusy(false); }
  }

  return (
    <Modal title="Add employee" onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
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
