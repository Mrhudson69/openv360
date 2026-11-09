//! OS-specific integration: foreground window, idle time and screen capture.

use image::RgbaImage;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[derive(Debug, Clone, Default)]
pub struct ActiveWindow {
    pub app: String,
    pub title: String,
}

/// An OS permission the agent needs. On macOS these gate first-run; on Linux and
/// Windows the list is empty (nothing to grant up front).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    /// Stable key passed back to `request_permission`.
    pub key: String,
    pub label: String,
    /// A required permission must be granted before tracking starts.
    pub required: bool,
    pub granted: bool,
    /// One line telling the user what it's for.
    pub help: String,
}

/// Permissions the agent needs on this OS, with their current state.
pub fn permissions() -> Vec<Permission> {
    imp::permissions()
}

/// Prompt the OS for `key`, or open the relevant settings pane. Non-blocking-ish.
pub fn request_permission(key: &str) {
    imp::request_permission(key)
}


/// Foreground application and window title, if it can be determined.
/// Blocking — call from a blocking-friendly thread.
pub fn active_window() -> Option<ActiveWindow> {
    imp::active_window()
}

/// Milliseconds since the last keyboard/mouse input. Blocking.
pub fn idle_ms() -> Option<i64> {
    imp::idle_ms()
}

/// Capture every monitor. Returns one image per monitor.
pub async fn capture_screens() -> anyhow::Result<Vec<RgbaImage>> {
    imp::capture_screens().await
}

/// One-time setup at startup (e.g. installing the GNOME Shell helper).
pub fn prepare() {
    imp::prepare()
}

/// Human-readable problems the user may need to fix (shown in the agent window).
pub fn diagnostics() -> Vec<String> {
    imp::diagnostics()
}

/// Human-readable OS version for the admin's device list.
pub fn os_version() -> String {
    #[cfg(target_os = "linux")]
    if let Some(v) = linux::os_version() {
        return v;
    }
    let info = os_info::get();
    format!("{} {}", info.os_type(), info.version())
}

pub fn os_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    }
}

/// Capture via the cross-platform `xcap` crate (Windows, macOS).
#[cfg(not(target_os = "linux"))]
pub(crate) fn capture_with_xcap() -> anyhow::Result<Vec<RgbaImage>> {
    let monitors = xcap::Monitor::all()?;
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
        out.push(m.capture_image()?);
    }
    if out.is_empty() {
        anyhow::bail!("no monitors found");
    }
    Ok(out)
}

/// Foreground window via the cross-platform `active-win-pos-rs` crate.
pub(crate) fn active_window_generic() -> Option<ActiveWindow> {
    let w = active_win_pos_rs::get_active_window().ok()?;
    let app = if w.app_name.trim().is_empty() {
        std::path::Path::new(&w.process_path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        w.app_name
    };
    Some(ActiveWindow {
        app,
        title: w.title,
    })
}
