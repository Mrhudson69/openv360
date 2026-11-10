//! Transparent anti-tamper respawn.
//!
//! The agent launches a lightweight sibling process — the watchdog — that brings
//! the agent back within a couple of seconds if it is killed ("End task", `kill`,
//! or a hang). The agent likewise respawns the watchdog if *it* is killed. So
//! stopping the agent means killing both at once, and even then the OS service
//! manager (systemd `Restart=always` / a Scheduled Task / launchd `KeepAlive`)
//! is the boot-time and last-resort backstop.
//!
//! This is deliberately NOT stealth: the agent stays a visible, named process
//! with its tray icon, and the admin can always stop it cleanly — the dashboard
//! "Uninstall" command and the uninstaller write a stand-down marker that makes
//! the watchdog step aside instead of fighting a legitimate removal or update.
//!
//! Coordination is done through small files in the data dir (no OS-specific
//! process APIs, so it behaves the same on Windows, Linux and macOS):
//! - `agent.beat` — the agent touches it every couple of seconds.
//! - `watchdog.beat` — the watchdog touches it; its absence lets the agent tell
//!   the watchdog died.
//! - `standdown` — a recent mtime means "a controlled stop is in progress, do
//!   not respawn" (written on update + uninstall).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

/// How often the agent and watchdog refresh their heartbeats.
pub const BEAT_EVERY: Duration = Duration::from_secs(2);
/// The agent is considered dead/hung once its heartbeat is older than this.
const AGENT_STALE: Duration = Duration::from_secs(8);
/// A stand-down marker newer than this suppresses respawns (update/uninstall
/// window). After it, the watchdog resumes — so a failed update still recovers.
const STANDDOWN_TTL: Duration = Duration::from_secs(10 * 60);

fn agent_beat(data_dir: &Path) -> PathBuf {
    data_dir.join("agent.beat")
}
fn watchdog_beat(data_dir: &Path) -> PathBuf {
    data_dir.join("watchdog.beat")
}
fn standdown_file(data_dir: &Path) -> PathBuf {
    data_dir.join("standdown")
}

fn touch(p: &Path) -> std::io::Result<()> {
    std::fs::write(p, now_ms().to_string())
}

fn age(p: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(p).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn standdown_active(data_dir: &Path) -> bool {
    matches!(age(&standdown_file(data_dir)), Some(a) if a < STANDDOWN_TTL)
}

/// Mark a controlled stop (called right before an update- or uninstall-driven
/// exit) so the watchdog steps aside instead of relaunching the agent.
pub fn mark_standdown(data_dir: &Path) {
    let _ = touch(&standdown_file(data_dir));
}

/// Clear any stand-down marker. Called once at agent startup, so a normal start
/// (including the fresh build after an update) re-arms the watchdog.
pub fn clear_standdown(data_dir: &Path) {
    let _ = std::fs::remove_file(standdown_file(data_dir));
}

/// The agent's heartbeat — proves the process is alive (and not deadlocked).
pub fn beat(data_dir: &Path) {
    let _ = touch(&agent_beat(data_dir));
}

/// Relaunch the agent proper, in service mode.
fn spawn_agent() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    Command::new(exe).args(["--autostart", "--service"]).spawn().map(|_| ())
}

/// Spawn a watchdog sibling for this agent. `data_dir` is passed through so the
/// child reads the same markers without needing Tauri's path resolver.
pub fn spawn_watchdog(data_dir: &Path) -> std::io::Result<std::process::Child> {
    let exe = std::env::current_exe()?;
    Command::new(exe).arg("--watchdog").arg(data_dir).spawn()
}

/// Entry point when the binary is started with `--watchdog <data_dir>`. A plain
/// loop with no UI/Tauri — it watches the agent's heartbeat and brings it back.
pub fn run_watchdog(data_dir: PathBuf) {
    log::info!("watchdog started for {}", data_dir.display());
    loop {
        std::thread::sleep(BEAT_EVERY);
        // If we can't write into the data dir any more, the agent was
        // uninstalled (dir removed) — nothing left to guard.
        if touch(&watchdog_beat(&data_dir)).is_err() {
            log::info!("watchdog: data dir gone; exiting");
            return;
        }
        // A controlled stop (update/uninstall) is under way: stand aside. On an
        // update the installer relaunches the new build (which starts its own
        // watchdog); on an uninstall the files are being removed.
        if standdown_active(&data_dir) {
            log::info!("watchdog: stand-down marker set; exiting");
            return;
        }
        // Agent missed its heartbeat (killed or hung) -> bring it back, then exit;
        // the fresh agent starts a new watchdog.
        match age(&agent_beat(&data_dir)) {
            Some(a) if a > AGENT_STALE => {
                log::warn!("watchdog: agent heartbeat stale ({a:?}); respawning");
                if let Err(e) = spawn_agent() {
                    log::error!("watchdog: failed to respawn agent: {e}");
                    continue; // try again next tick rather than giving up
                }
                return;
            }
            _ => {}
        }
    }
}

/// Run inside the agent: keep exactly one watchdog sibling alive, respawning it
/// if it is killed. Never returns. Spawned only for real service installs.
pub fn supervise(data_dir: PathBuf) {
    // Re-arm on every (re)start, including the fresh build after an update.
    clear_standdown(&data_dir);
    let mut child = match spawn_watchdog(&data_dir) {
        Ok(c) => Some(c),
        Err(e) => {
            log::error!("could not start watchdog: {e}");
            None
        }
    };
    loop {
        std::thread::sleep(BEAT_EVERY);
        beat(&data_dir); // heartbeat for the watchdog
        // If our watchdog exited (killed, or it respawned us and stepped down),
        // start a new one — unless we're in a controlled stop.
        let gone = match child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
            None => true,
        };
        if gone && !standdown_active(&data_dir) {
            child = spawn_watchdog(&data_dir).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "ov360-wd-{}-{}-{}",
            std::process::id(),
            now_ms(),
            N.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn standdown_marker_round_trips() {
        let d = tmp();
        assert!(!standdown_active(&d));
        mark_standdown(&d);
        assert!(standdown_active(&d), "a fresh marker suppresses respawn");
        clear_standdown(&d);
        assert!(!standdown_active(&d), "cleared marker re-arms the watchdog");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn heartbeat_is_recent() {
        let d = tmp();
        assert!(age(&agent_beat(&d)).is_none(), "no beat yet");
        beat(&d);
        assert!(age(&agent_beat(&d)).unwrap() < AGENT_STALE, "a fresh beat is not stale");
        let _ = std::fs::remove_dir_all(&d);
    }
}
