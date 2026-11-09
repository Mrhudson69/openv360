//! Self-removal when the administrator sends the "uninstall" command.
//!
//! This runs in the user's session (no root), so it removes everything the
//! agent installed for this user: the background service / autostart entries,
//! the GNOME helper, the local queue and config, and finally the binary. A
//! root-installed guard (Linux `openv360-guard`, if present) is left for the
//! admin's `uninstall.sh --system` to remove, since the agent can't.

use std::path::Path;
use std::process::Command;

/// Best-effort removal of everything installed for the current user, then schedule
/// deletion of the binary and exit. Never panics.
pub fn self_uninstall(config_dir: &Path, data_dir: &Path) {
    log::warn!("administrator requested uninstall; removing openv360 from this machine");
    let _ = std::fs::remove_dir_all(config_dir);
    let _ = std::fs::remove_dir_all(data_dir);

    #[cfg(target_os = "linux")]
    linux(config_dir);
    #[cfg(target_os = "macos")]
    macos();
    #[cfg(windows)]
    windows();
}

#[cfg(target_os = "linux")]
fn linux(config_dir: &Path) {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    if let Some(home) = &home {
        // Background service + autostart entries.
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", "openv360-agent.service"])
            .output();
        let _ = std::fs::remove_file(home.join(".config/systemd/user/openv360-agent.service"));
        let _ = std::fs::remove_file(home.join(".config/autostart/openv360.desktop"));
        // GNOME helper.
        let _ = Command::new("gnome-extensions")
            .args(["disable", "openv360@openv360.org"])
            .output();
        let _ = std::fs::remove_dir_all(
            home.join(".local/share/gnome-shell/extensions/openv360@openv360.org"),
        );
    }
    let _ = config_dir; // already removed above
    // User-local AppImage install, if any.
    if let Some(home) = &home {
        let _ = std::fs::remove_file(home.join(".local/bin/openv360-agent.AppImage"));
        let _ = std::fs::remove_file(home.join(".local/share/applications/openv360.desktop"));
    }
    // A system .deb can only be removed by root; leave a breadcrumb for the admin.
    schedule_self_delete_and_exit();
}

#[cfg(target_os = "macos")]
fn macos() {
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
        let plist = home.join("Library/LaunchAgents/org.openv360.agent.plist");
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{}", unsafe { libc_getuid() })])
            .arg(&plist)
            .output();
        let _ = Command::new("launchctl").arg("unload").arg(&plist).output();
        let _ = std::fs::remove_file(&plist);
    }
    schedule_self_delete_and_exit();
}

#[cfg(windows)]
fn windows() {
    let _ = Command::new("schtasks")
        .args(["/Delete", "/TN", "openv360", "/F"])
        .output();
    schedule_self_delete_and_exit();
}

/// The running binary can't delete itself on Windows while in use and shouldn't
/// yank the file out from under itself on Unix either, so hand the final cleanup
/// to a short-lived detached helper, then exit.
fn schedule_self_delete_and_exit() {
    let exe = std::env::current_exe().ok();
    #[cfg(unix)]
    if let Some(exe) = exe {
        // Delete the app bundle (macOS) or the installed binary (Linux).
        #[cfg(target_os = "macos")]
        let target = macos_app_root(&exe).unwrap_or(exe);
        #[cfg(not(target_os = "macos"))]
        let target = exe;
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "sleep 2; rm -rf {} >/dev/null 2>&1",
                shell_quote(&target.to_string_lossy())
            ))
            .spawn();
    }
    #[cfg(windows)]
    if let Some(exe) = exe {
        let dir = exe.parent().map(|p| p.to_path_buf());
        if let Some(dir) = dir {
            let _ = Command::new("cmd")
                .args(["/C", "timeout /t 3 >nul & rmdir /s /q"])
                .arg(dir)
                .spawn();
        }
    }
    log::info!("uninstall complete; exiting");
    std::process::exit(0);
}

#[cfg(target_os = "macos")]
fn macos_app_root(exe: &Path) -> Option<std::path::PathBuf> {
    // .../openv360.app/Contents/MacOS/openv360-agent -> .../openv360.app
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf())
}

#[cfg(unix)]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(target_os = "macos")]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}
