import { useCallback, useEffect, useState } from "react";
import { api, tzOffset, type Employee, type Team } from "../api";
import { AppRules } from "../components/AppRules";
import { Modal } from "../components/Modal";
import { confirmDialog } from "../components/confirm";
import { Link } from "../router";

export function TeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [people, setPeople] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([
        api<{ teams: Team[] }>("/api/teams"),
        api<{ employees: Employee[] }>(`/api/employees?tzOffsetMin=${tzOffset()}`),
      ]);
      setTeams(t.teams);
      setPeople(e.employees);
      setSelected((cur) => cur ?? t.teams[0]?.id ?? null);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const r = await api<{ team: Team }>("/api/teams", { method: "POST", body: { name: newName.trim() } });
      setNewName(""); setCreating(false);
      await load();
      setSelected(r.team.id);
    } catch (err) { setError((err as Error).message); }
  }

  async function rename(t: Team) {
    const name = prompt("Rename team", t.name)?.trim();
    if (!name || name === t.name) return;
    try { await api(`/api/teams/${t.id}`, { method: "PATCH", body: { name } }); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  async function remove(t: Team) {
    if (!(await confirmDialog({ title: "Delete team", message: `Delete the team "${t.name}"? Its ${t.ruleCount} rule(s) are removed and its ${t.memberCount} member(s) become unassigned. Activity data is kept.`, danger: true, confirmLabel: "Delete team" }))) return;
    try {
      await api(`/api/teams/${t.id}`, { method: "DELETE" });
      if (selected === t.id) setSelected(null);
      await load();
    } catch (err) { setError((err as Error).message); }
  }

  async function setMember(employeeId: string, teamId: string | null) {
    try { await api(`/api/employees/${employeeId}`, { method: "PATCH", body: { teamId } }); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  const team = teams?.find((t) => t.id === selected) ?? null;
  const members = people.filter((p) => p.teamId === selected);
  const unassigned = people.filter((p) => p.teamId !== selected);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Teams</h1>
          <p className="muted">Group people, and give each team its own app rules. Team rules win over the <Link to="/settings">organization rules</Link>.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New team</button>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      {!teams ? <p className="muted pad">Loading…</p> : teams.length === 0 ? (
        <div className="card empty"><p className="muted">No teams yet. Create one to set rules for a group of people.</p></div>
      ) : (
        <div className="teams-layout">
          <aside className="team-list">
            {teams.map((t) => (
              <button key={t.id} className={`team-item${selected === t.id ? " on" : ""}`} onClick={() => setSelected(t.id)}>
                <span className="team-name">{t.name}</span>
                <span className="muted small">{t.memberCount} {t.memberCount === 1 ? "person" : "people"} · {t.ruleCount} rule{t.ruleCount === 1 ? "" : "s"}</span>
              </button>
            ))}
          </aside>

          {team && (
            <div className="team-detail">
              <section className="card">
                <div className="card-head">
                  <h2 className="card-title">{team.name}</h2>
                  <div className="row">
                    <button className="btn btn-small" onClick={() => rename(team)}>Rename</button>
                    <button className="btn btn-small btn-ghost danger" onClick={() => remove(team)}>Delete</button>
                  </div>
                </div>
                <p className="muted">App rules for this team. Matched before the organization rules, so they override them for these {team.memberCount} member(s).</p>
                <AppRules teamId={team.id} onError={setError} />
              </section>

              <section className="card">
                <h2 className="card-title">Members <span className="muted">({members.length})</span></h2>
                {members.length === 0 ? <p className="muted">No one is in this team yet.</p> : (
                  <ul className="member-list">
                    {members.map((p) => (
                      <li key={p.id}>
                        <Link to={`/employees/${p.id}`}>{p.name}</Link>
                        {p.email && <span className="muted small">{p.email}</span>}
                        <button className="btn btn-small btn-ghost" onClick={() => setMember(p.id, null)}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                <AddMember people={unassigned} onAdd={(id) => setMember(id, team.id)} />
              </section>
            </div>
          )}
        </div>
      )}

      {creating && (
        <Modal title="New team" onClose={() => setCreating(false)}>
          <form onSubmit={create} className="form">
            <label className="field"><span>Team name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus required placeholder="e.g. Engineering" /></label>
            <div className="form-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function AddMember(props: { people: Employee[]; onAdd: (id: string) => void }) {
  const [id, setId] = useState("");
  if (props.people.length === 0) return <p className="hint">Everyone is already in this team.</p>;
  return (
    <div className="add-member">
      <select value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Add a person…</option>
        {props.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.team ? ` · ${p.team}` : ""}</option>)}
      </select>
      <button className="btn" disabled={!id} onClick={() => { if (id) { props.onAdd(id); setId(""); } }}>Add to team</button>
    </div>
  );
}
