import { useEffect, useRef } from "react";

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${props.wide ? " modal-wide" : ""}`}
      onClose={props.onClose}
      onClick={(e) => { if (e.target === ref.current) props.onClose(); }}
    >
      <div className="modal-head">
        <h2>{props.title}</h2>
        <button className="icon-btn" aria-label="Close" onClick={props.onClose}>✕</button>
      </div>
      <div className="modal-body">{props.children}</div>
    </dialog>
  );
}
