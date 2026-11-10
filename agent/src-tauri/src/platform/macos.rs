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
    // CGPreflightScreenCaptureAccess is authoritative when it returns true, but
    // it CACHES its result for the life of the process — so after the user turns
    // Screen Recording on, the running agent keeps seeing `false` until it is
    // relaunched. Fall back to a live, uncached probe so we detect the grant
    // right away (no restart needed).
    // SAFETY: no preconditions.
    if unsafe { CGPreflightScreenCaptureAccess() } {
        return true;
    }
    can_read_foreign_window_names()
}

/// Live Screen-Recording probe: with the permission granted we can read the
/// window *name* of a window owned by another process; without it, macOS strips
/// those names. Unlike the preflight call this reflects the current grant state.
fn can_read_foreign_window_names() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowOwnerPID,
    };
    use std::os::raw::c_void;

    fn num(dict: &CFDictionary, key: CFStringRef) -> Option<i64> {
        let v = dict.find(key as *const c_void)?;
        // SAFETY: value is a +0 CFNumber owned by the dict.
        unsafe { CFNumber::wrap_under_get_rule(*v as _) }.to_i64()
    }
    fn text(dict: &CFDictionary, key: CFStringRef) -> Option<String> {
        let v = dict.find(key as *const c_void)?;
        // SAFETY: value is a +0 CFString owned by the dict.
        Some(unsafe { CFString::wrap_under_get_rule(*v as _) }.to_string())
    }

    let me = std::process::id() as i64;
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let Some(windows) = copy_window_info(opts, kCGNullWindowID) else {
        return false;
    };
    for i in 0..windows.len() {
        let Some(item) = windows.get(i) else { continue };
        // SAFETY: each element is a +0 CFDictionary owned by the array.
        let dict: CFDictionary =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        // Only normal app windows (layer 0) owned by another process.
        if num(&dict, unsafe { kCGWindowLayer }) != Some(0) {
            continue;
        }
        match num(&dict, unsafe { kCGWindowOwnerPID }) {
            Some(pid) if pid != me => {}
            _ => continue,
        }
        if text(&dict, unsafe { kCGWindowName }).is_some_and(|n| !n.trim().is_empty()) {
            return true; // read another app's window title ⇒ permission is on
        }
    }
    false
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
