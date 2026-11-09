import { useEffect, useState } from "react";
import { api, getToken, setToken, setUnauthorizedHandler, type Role, type User } from "./api";
import { getBrand, loadBrand, onBrand, type Brand } from "./brand";
import { ChangePassword } from "./components/ChangePassword";
import { ConfirmHost } from "./components/confirm";
import { AdminsPage } from "./pages/Admins";
import { AgentsPage } from "./pages/Agents";
import { AlertsPage } from "./pages/Alerts";
import { AttendancePage } from "./pages/Attendance";
import { AuthPage } from "./pages/Auth";
import { EmployeeDayPage } from "./pages/EmployeeDay";
import { EmployeeWeekPage } from "./pages/EmployeeWeek";
import { EmployeesPage } from "./pages/Employees";
import { OverviewPage } from "./pages/Overview";
import { ReportsPage } from "./pages/Reports";
import { TeamsPage } from "./pages/Teams";
import { SettingsPage } from "./pages/Settings";
import { Link, navigate, useLocation } from "./router";

type SessionUser = User & { role?: Role };
type State = { kind: "loading" } | { kind: "auth"; needsSetup: boolean; orgName: string } | { kind: "ready"; user: SessionUser } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [brand, setBrand] = useState<Brand>(getBrand());
  const [version, setVersion] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const loc = useLocation();
  const orgName = brand.orgName;

  async function boot() {
    try {
      const b = await loadBrand();
      setBrand(b);
      api<{ version: string }>("/api/health").then((h) => setVersion(h.version)).catch(() => {});
      const status = await api<{ needsSetup: boolean }>("/api/auth/status");
      if (!status.needsSetup && getToken()) {
        try {
          const me = await api<{ user: User }>("/api/auth/me");
          return setState({ kind: "ready", user: me.user });
        } catch { setToken(null); }
      }
      setState({ kind: "auth", needsSetup: status.needsSetup, orgName: b.orgName });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => { setToken(null); void boot(); });
    void boot();
    return onBrand(setBrand);
  }, []);

  if (state.kind === "loading") return <div className="center muted">Loading…</div>;
  if (state.kind === "error") return (
    <div className="center"><div className="error">Can't reach the server: {state.message}</div><button className="btn" onClick={boot}>Retry</button></div>
  );
  if (state.kind === "auth") return <AuthPage needsSetup={state.needsSetup} orgName={state.orgName} onAuthed={(user) => setState({ kind: "ready", user })} />;

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setToken(null);
    navigate("/");
    void boot();
  }

  const dayMatch = /^\/employees\/([0-9a-f-]{36})$/i.exec(loc.path);
  const params = new URLSearchParams(loc.search);
  const isOwner = state.user.role !== "manager";
  let page: React.ReactNode;
  if (dayMatch) page = params.get("view") === "week"
    ? <EmployeeWeekPage key={`w-${dayMatch[1]}`} id={dayMatch[1]!} end={params.get("end")} />
    : <EmployeeDayPage key={dayMatch[1]} id={dayMatch[1]!} date={params.get("date")} />;
  else if (loc.path === "/team") page = <EmployeesPage />;
  else if (loc.path === "/agents") page = <AgentsPage />;
  else if (loc.path === "/teams") page = <TeamsPage />;
  else if (loc.path === "/attendance") page = <AttendancePage />;
  else if (loc.path === "/alerts") page = <AlertsPage />;
  else if (loc.path === "/reports") page = <ReportsPage />;
  else if (loc.path === "/admins") page = <AdminsPage />;
  else if (loc.path === "/settings") page = <SettingsPage />;
  else page = <OverviewPage />;

  // Managers see only their team's people and reports; they land on Team, not Overview.
  if (!isOwner && (loc.path === "/" || ["/agents", "/teams", "/attendance", "/alerts", "/admins", "/settings"].includes(loc.path)))
    page = <EmployeesPage />;

  const section = dayMatch ? "team" : loc.path === "/" ? (isOwner ? "overview" : "team") : loc.path.slice(1);
  const link = (to: string, key: string, label: string) => (
    <Link to={to} className={section === key ? "active" : ""}>{label}</Link>
  );

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          {brand.logoUrl ? <img className="brand-logo" src={brand.logoUrl} alt="" /> : <img className="brand-logo" src="/logo.svg" alt="" />}
          <span className="brand-text"><strong>{orgName}</strong>{orgName !== "openv360" && <small>openv360</small>}</span>
        </div>
        <div className="nav-links">
          {isOwner && link("/", "overview", "Overview")}
          {link(isOwner ? "/team" : "/", "team", "Team")}
          {isOwner && link("/agents", "agents", "Agents")}
          {isOwner && link("/teams", "teams", "Teams")}
          {isOwner && link("/attendance", "attendance", "Attendance")}
          {isOwner && link("/alerts", "alerts", "Alerts")}
          {link("/reports", "reports", "Reports")}
          {isOwner && link("/admins", "admins", "Admins")}
          {isOwner && link("/settings", "settings", "Settings")}
        </div>
        <div className="sidebar-foot">
          <div className="user"><strong>{state.user.name}</strong><small className="muted">{state.user.email}</small></div>
          <div className="foot-actions"><button className="btn btn-small btn-ghost" onClick={() => setPwOpen(true)}>Change password</button><button className="btn btn-small btn-ghost" onClick={logout}>Sign out</button></div>
          {version && <div className="app-version muted">openv360 v{version}</div>}
        </div>
      </nav>
      <main className="main">{page}</main>
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
      <ConfirmHost />
    </div>
  );
}
