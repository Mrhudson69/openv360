import { useState } from "react";
import { CopyField } from "./CopyField";
import { Modal } from "./Modal";

type Tab = "unix" | "windows";

export function EnrollDialog(props: { name: string; code: string; expiresAt?: number; onClose: () => void }) {
  const origin = window.location.origin;
  const [tab, setTab] = useState<Tab>(() => (navigator.userAgent.includes("Windows") ? "windows" : "unix"));
  const commands: Record<Tab, string> = {
    unix: `curl -fsSL ${origin}/install.sh | sh -s -- --code ${props.code}`,
    windows: `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Code ${props.code}`,
  };
  return (
    <Modal title={`Connect ${props.name}'s computer`} onClose={props.onClose} wide>
      <p className="muted">
        This one-time code links a computer to {props.name}.
        {props.expiresAt ? ` It expires ${new Date(props.expiresAt).toLocaleDateString()}.` : ""} The person will see the
        openv360 tray icon whenever tracking is on.
      </p>
      <CopyField value={props.code} large label="Enrollment code" />

      <h3 className="section-title">Install with one command</h3>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "unix"} className={tab === "unix" ? "active" : ""} onClick={() => setTab("unix")}>macOS / Linux</button>
        <button role="tab" aria-selected={tab === "windows"} className={tab === "windows" ? "active" : ""} onClick={() => setTab("windows")}>Windows (PowerShell)</button>
      </div>
      <CopyField value={commands[tab]} />
      <p className="hint">
        {tab === "unix" ? "Run in Terminal. Supports macOS and Ubuntu 24.04 / 26.04." : "Run in PowerShell as the employee (not as Administrator)."}
      </p>

      <h3 className="section-title">Or set it up manually</h3>
      <ol className="steps">
        <li>Download and install the openv360 agent for the employee's OS.</li>
        <li>Open it and enter the server address <code className="mono">{origin}</code>.</li>
        <li>Enter the code above and click <strong>Connect</strong>.</li>
      </ol>

      <details className="uninstall">
        <summary>Uninstall the agent</summary>
        <p className="muted">Run on the employee's computer to remove the agent completely. You can also uninstall remotely from the <strong>⋯</strong> menu next to a device.</p>
        <CopyField value={tab === "windows" ? `& ([scriptblock]::Create((irm ${origin}/uninstall.ps1)))` : `curl -fsSL ${origin}/uninstall.sh | sh`} />
      </details>
    </Modal>
  );
}
