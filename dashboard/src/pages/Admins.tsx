import { useCallback, useEffect, useState } from "react";
import { api, type Admin, type AuditEntry, type Role, type Team } from "../api";
import { Modal } from "../components/Modal";
import { confirmDialog } from "../components/confirm";
import { relative } from "../format";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", manager: "Team manager" };

export function AdminsPage() {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState<Admin | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, t, au] = await Promise.all([
        api<{ admins: Admin[] }>("/api/admins"),
        api<{ teams: Team[] }>("/api/teams"),
        api<{ entries: AuditEntry[] }>("/api/audit?limit=40"),
      ]);
      setAdmins(a.admins); setTeams(t.teams); setAudit(au.entries); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "—";

  async function setRole(a: Admin, role: Role, teamId: string | null) {
    try { await api(`/api/admins/${a.id}`, { method: "PATCH", body: { role, teamId: role === "manager" ? teamId : null } }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function remove(a: Admin) {
    if (!(await confirmDialog({ title: "Remove admin", message: `Remove admin ${a.name}? They lose access immediately.`, danger: true, confirmLabel: "Remove" }))) return;
    try { await api(`/api/admins/${a.id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Admins</h1><p className="muted">Who can sign in to this dashboard. Owners see everything; team managers see only their team.</p></div>
        <button className="btn btn-primary" onClick={() => setInviting(true)}>+ Add admin</button>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <h2 className="card-title">People with access</h2>
        {!admins ? <p className="muted">Loading…</p> : (
          <div className="log-scroll">
            <table className="log">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Last sign-in</th><th></th></tr></thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.id}>
                    <td className="app">{a.name}</td>
                    <td className="mono small">{a.email}</td>
                    <td>
                      <select value={a.role} onChange={(e) => setRole(a, e.target.value as Role, a.teamId)}>
                        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
                    <td>
                      {a.role === "manager" ? (
                        <select value={a.teamId ?? ""} onChange={(e) => setRole(a, "manager", e.target.value || null)}>
                          <option value="">Pick a team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      ) : <span className="muted">All teams</span>}
                    </td>
                    <td className="small muted">{a.lastLoginAt ? relative(a.lastLoginAt) : "never"}</td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => setResetting(a)}>Reset password</button>
                      <button className="btn btn-small btn-ghost danger" onClick={() => remove(a)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Activity log</h2>
        {audit.length === 0 ? <p className="muted">No admin activity recorded yet.</p> : (
          <ul className="audit">
            {audit.map((e) => (
              <li key={e.id}>
                <span className="muted small audit-time">{relative(e.at)}</span>
                <span><strong>{e.adminName ?? "system"}</strong> {e.action}{e.detail ? <span className="muted"> · {e.detail}</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {inviting && <InviteModal teams={teams} teamName={teamName} onClose={() => setInviting(false)} onSaved={() => { setInviting(false); void load(); }} onError={setError} />}
      {resetting && <ResetPasswordModal admin={resetting} onClose={() => setResetting(null)} onDone={() => { setResetting(null); void load(); }} onError={setError} />}
    </div>
  );
}

function InviteModal(props: { teams: Team[]; teamName: (id: string | null) => string; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 8) { props.onError("Name, email, and a password of at least 8 characters are required."); return; }
    if (role === "manager" && !teamId) { props.onError("Pick a team for a team manager."); return; }
    setBusy(true);
    try {
      await api("/api/admins", { method: "POST", body: { name: name.trim(), email: email.trim(), password, role, teamId: role === "manager" ? teamId : null } });
      props.onSaved();
    } catch (err) { props.onError((err as Error).message); setBusy(false); }
  }

  return (
    <Modal title="Add admin" onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field"><span>Full name</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></label>
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Temporary password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>
        <label className="field"><span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="manager">Team manager (one team)</option>
            <option value="owner">Owner (full access)</option>
          </select>
        </label>
        {role === "manager" && (
          <label className="field"><span>Team</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Pick a team…</option>
              {props.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add admin"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal(props: { admin: Admin; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) { props.onError("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      await api(`/api/admins/${props.admin.id}/password`, { method: "PUT", body: { password: pw } });
      props.onDone();
    } catch (err) { props.onError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`Reset password · ${props.admin.name}`} onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">Set a new password for {props.admin.name}. They'll be signed out everywhere and must use the new password next time.</p>
        <label className="field"><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} autoFocus required autoComplete="new-password" /></label>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
        </div>
      </form>
    </Modal>
  );
}
