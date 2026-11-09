import { useState } from "react";

export function CopyField(props: { value: string; mono?: boolean; large?: boolean; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = props.value; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className={`copy-field${props.large ? " large" : ""}`}>
      <code className={props.mono === false ? "" : "mono"} aria-label={props.label}>{props.value}</code>
      <button className="btn btn-small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}
