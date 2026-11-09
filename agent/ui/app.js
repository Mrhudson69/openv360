const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let state = null;

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}
function fmtUntil(ms) {
  if (!ms) return "—";
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return mins < 1 ? "any moment" : `in about ${mins} min`;
}
function show(el, text) {
  el.hidden = !text;
  el.textContent = text || "";
}

let prevNeedsPerms = null;

function renderPermissions(s) {
  const list = $("perm-list");
  list.replaceChildren(
    ...s.permissions.map((p) => {
      const li = document.createElement("li");
      li.className = p.granted ? "granted" : "";
      const main = document.createElement("div");
      main.innerHTML = `<strong>${p.label}</strong>${p.required ? "" : " <span class='muted small'>(optional)</span>"}<div class="muted small">${p.help}</div>`;
      const right = document.createElement("div");
      if (p.granted) {
        right.className = "ok";
        right.textContent = "✓ Granted";
      } else {
        const b = document.createElement("button");
        b.className = "primary";
        b.textContent = "Grant";
        b.onclick = async () => { render(await invoke("request_permission", { key: p.key })); };
        right.appendChild(b);
      }
      li.append(main, right);
      return li;
    }),
  );
  $("perm-done").disabled = s.needsPermissions;
}

function render(s) {
  state = s;
  const showPerms = s.enrolled && s.needsPermissions;
  $("setup").hidden = s.enrolled;
  $("permissions").hidden = !showPerms;
  $("home").hidden = !s.enrolled || showPerms;
  if (!s.enrolled) {
    show($("setup-error"), s.lastError);
    return;
  }
  if (showPerms) {
    prevNeedsPerms = true;
    renderPermissions(s);
    return;
  }
  // Just finished the permission flow: drop to the background (menu bar).
  if (prevNeedsPerms === true && window.__TAURI__.window) {
    window.__TAURI__.window.getCurrentWindow().hide().catch(() => {});
  }
  prevNeedsPerms = false;
  $("who").textContent = s.employee ? s.employee.name : "";
  $("today").textContent = fmtDuration(s.todayActiveMs);
  const tracking = s.clockedIn && !s.pausedByAdmin;
  $("pill").textContent = s.pausedByAdmin ? "Paused by admin" : s.clockedIn ? "Tracking" : "Paused";
  $("pill").classList.toggle("on", tracking);
  $("toggle").disabled = s.pausedByAdmin;
  $("toggle").textContent = s.clockedIn ? "Clock out" : "Clock in";
  $("auto").checked = s.autoClockIn;
  $("server-label").textContent = (s.serverUrl || "").replace(/^https?:\/\//, "") + ` · v${s.version}`;

  const st = s.settings;
  const items = [
    ["Active and idle time", true],
    ["Which app is in use", true],
    ["Window titles", st.trackWindowTitles],
    [`Screenshots about every ${Math.round(st.screenshotIntervalSec / 60)} min${st.screenshotBlur ? " (blurred)" : ""}`, st.screenshotsEnabled],
  ];
  $("recorded").replaceChildren(
    ...items.map(([text, on]) => {
      const li = document.createElement("li");
      li.textContent = on ? text : `${text} — off`;
      if (!on) li.className = "off";
      return li;
    }),
  );

  $("next-shot").textContent = s.clockedIn && st.screenshotsEnabled ? fmtUntil(s.nextScreenshotAt) : "—";
  $("last-shot").textContent = fmtTime(s.lastScreenshotAt);
  $("last-sync").textContent = fmtTime(s.lastSyncAt);
  $("pending").textContent = String(s.pendingUploads);
  const notes = [...(s.diagnostics || [])];
  if (s.pausedByAdmin) notes.unshift("Your administrator has paused tracking for this device.");
  show($("diagnostics"), notes.join("\n\n"));
  show($("home-error"), s.lastError);
}

async function refresh() {
  render(await invoke("get_state"));
}

$("enroll-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("enroll-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  show($("setup-error"), "");
  try {
    render(await invoke("enroll", { serverUrl: $("server").value, code: $("code").value }));
  } catch (err) {
    show($("setup-error"), String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
});

$("toggle").addEventListener("click", async () => {
  render(await invoke("set_clocked_in", { on: !state.clockedIn }));
});
$("auto").addEventListener("change", async (e) => {
  render(await invoke("set_auto_clock_in", { on: e.target.checked }));
});
$("sync").addEventListener("click", () => invoke("sync_now"));
$("perm-done").addEventListener("click", () => {
  if (window.__TAURI__.window) window.__TAURI__.window.getCurrentWindow().hide().catch(() => {});
});
$("signout").addEventListener("click", async () => {
  const btn = $("signout");
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Click again to disconnect";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "Disconnect"; }, 4000);
    return;
  }
  render(await invoke("sign_out"));
});

listen("state", (e) => render(e.payload));
refresh();
setInterval(refresh, 30000);
