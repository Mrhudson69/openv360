import { useEffect } from "react";
import { screenshotUrl, type Shot } from "../api";

export function Lightbox(props: { shots: Shot[]; index: number; onIndex: (i: number) => void; onClose: () => void; onDelete: (s: Shot) => void }) {
  const shot = props.shots[props.index];
  const { index, onIndex, onClose, shots } = props;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < shots.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [index, onIndex, onClose, shots.length]);
  if (!shot) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-bar">
          <span>{new Date(shot.takenAt).toLocaleString()} · {index + 1} of {shots.length}</span>
          <div className="row">
            <button className="btn btn-small btn-danger" onClick={() => props.onDelete(shot)}>Delete</button>
            <button className="btn btn-small" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="lightbox-stage">
          <button className="lb-nav" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous">‹</button>
          <img src={screenshotUrl(shot.id)} alt={`Screenshot at ${new Date(shot.takenAt).toLocaleTimeString()}`} />
          <button className="lb-nav" disabled={index === shots.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next">›</button>
        </div>
      </div>
    </div>
  );
}
