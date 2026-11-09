import { useState } from "react";
import { api, setToken, type User } from "../api";

export function AuthPage(props: { needsSetup: boolean; orgName: string; onAuthed: (u: User) => void }) {
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = props.needsSetup;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && password.length < 8) return setError("Use at least 8 characters for the password.");
    setBusy(true);
    try {
      const res = await api<{ token: string; user: User }>(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        body: setup ? { name, email, password, ...(orgName.trim() ? { orgName: orgName.trim() } : {}) } : { email, password },
      });
      setToken(res.token);
      if (setup && orgName.trim()) window.dispatchEvent(new CustomEvent("worklens:org", { detail: orgName.trim() }));
      props.onAuthed(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand brand-lg"><img className="brand-logo" src="/logo.svg" alt="" />{props.orgName}</div>
        <h1>{setup ? "Set up your workspace" : "Sign in"}</h1>
        <p className="muted">{setup ? "Create the administrator account for this server." : "Sign in to view your team's activity."}</p>
        {setup && (
          <>
            <label>Organization name<input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Inc." autoFocus /></label>
            <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          </>
        )}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!setup} autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={setup ? "new-password" : "current-password"} /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Please wait…" : setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>
  );
}
