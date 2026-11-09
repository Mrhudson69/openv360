import { useEffect, useState } from "react";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Req = ConfirmOptions & { resolve: (ok: boolean) => void };
let notify: ((r: Req | null) => void) | null = null;

/** Themed replacement for window.confirm(). Returns a promise that resolves true/false. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return new Promise((resolve) => {
    if (!notify) { resolve(window.confirm(o.message)); return; }
    notify({ ...o, resolve });
  });
}

/** Mount once near the app root. */
export function ConfirmHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { notify = setReq; return () => { notify = null; }; }, []);
  if (!req) return null;
  const done = (ok: boolean) => { req.resolve(ok); setReq(null); };
  return (
    <Modal title={req.title ?? "Please confirm"} onClose={() => done(false)}>
      <p className="confirm-msg">{req.message}</p>
      <div className="form-actions">
        <button className="btn btn-ghost" onClick={() => done(false)}>{req.cancelLabel ?? "Cancel"}</button>
        <button className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => done(true)}>{req.confirmLabel ?? "Confirm"}</button>
      </div>
    </Modal>
  );
}
