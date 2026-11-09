import { useState } from "react";
import { api } from "../api";
import { Modal } from "./Modal";

export function ChangePassword(props: { onClose: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setErr("New password must be at least 8 characters.");
    if (next !== confirm) return setErr("New passwords don't match.");
    setBusy(true); setErr(null);
    try {
      await api("/api/auth/password", { method: "PUT", body: { currentPassword: cur, newPassword: next } });
      setDone(true);
    } catch (e2) { setErr((e2 as Error).message); setBusy(false); }
  }

  return (
    <Modal title="Change your password" onClose={props.onClose}>
      {done ? (
        <><p>Your password has been changed.</p><div className="form-actions"><button className="btn btn-primary" onClick={props.onClose}>Done</button></div></>
      ) : (
        <form className="form" onSubmit={submit}>
          {err && <div className="error">{err}</div>}
          <label className="field"><span>Current password</span><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus required autoComplete="current-password" /></label>
          <label className="field"><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
          <label className="field"><span>Confirm new password</span><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
