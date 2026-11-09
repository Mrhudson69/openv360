import { useEffect, useRef } from "react";

/**
 * Re-runs `load` when the tab becomes visible again or the window regains focus,
 * so switching back to a tab always shows the latest data. Debounced so a quick
 * focus/visibility double-fire only reloads once, and skipped if the last refresh
 * was under `minIntervalMs` ago.
 */
export function useRefreshOnFocus(load: () => void, minIntervalMs = 5000) {
  const last = useRef(0);
  const fn = useRef(load);
  fn.current = load;
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last.current < minIntervalMs) return;
      last.current = now;
      fn.current();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [minIntervalMs]);
}
