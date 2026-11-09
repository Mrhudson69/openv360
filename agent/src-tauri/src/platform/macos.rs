use super::{ActiveWindow, Permission};
use image::RgbaImage;
use std::process::Command;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

const COMBINED_SESSION_STATE: i32 = 0;
const ANY_INPUT_EVENT: u32 = u32::MAX;

fn screen_recording_granted() -> bool {
    // SAFETY: no preconditions.
    unsafe { CGPreflightScreenCaptureAccess() }
}

fn accessibility_granted() -> bool {
    // SAFETY: no preconditions.
    unsafe { AXIsProcessTrusted() }
}

pub fn active_window() -> Option<ActiveWindow> {
    // Window titles need Screen Recording permission; without it the app name
    // is still reported but the title comes back empty.
    super::active_window_generic()
}

pub fn idle_ms() -> Option<i64> {
    // SAFETY: plain C call with constant arguments.
    let secs =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    secs.is_finite().then_some((secs * 1000.0) as i64)
}

pub async fn capture_screens() -> anyhow::Result<Vec<RgbaImage>> {
    if !screen_recording_granted() {
        anyhow::bail!(
            "Screen Recording permission not granted (System Settings → Privacy & Security → Screen Recording)"
        );
    }
    tokio::task::spawn_blocking(super::capture_with_xcap).await?
}

pub fn permissions() -> Vec<Permission> {
    vec![
        Permission {
            key: "screen-recording".into(),
            label: "Screen Recording".into(),
            required: true,
            granted: screen_recording_granted(),
            help: "Needed to take the periodic screenshots and read window titles.".into(),
        },
        Permission {
            key: "accessibility".into(),
            label: "Accessibility".into(),
            required: false,
            granted: accessibility_granted(),
            help: "Improves which-app and window-title detection. Optional.".into(),
        },
    ]
}

pub fn request_permission(key: &str) {
    match key {
        "screen-recording" => {
            // SAFETY: no preconditions. Shows the system prompt once; thereafter
            // macOS ignores it, so also open the settings pane as a fallback.
            if !unsafe { CGRequestScreenCaptureAccess() } {
                open_settings("Privacy_ScreenCapture");
            }
        }
        "accessibility" => open_settings("Privacy_Accessibility"),
        _ => {}
    }
}

fn open_settings(anchor: &str) {
    let _ = Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{anchor}"
        ))
        .spawn();
}

pub fn prepare() {
    // Deliberately does NOT prompt here. Screen Recording is requested from the
    // first-run permission screen (the "Grant" button → request_permission).
    // Prompting on every launch would re-pop the dialog each time the KeepAlive
    // login agent relaunches us — an endless loop the user can't escape.
}

pub fn diagnostics() -> Vec<String> {
    let mut out = Vec::new();
    if !screen_recording_granted() {
        out.push("Screen Recording permission is off. Enable openv360 in System Settings → Privacy & Security → Screen Recording, then reopen openv360.".into());
    }
    out
}
