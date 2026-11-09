use super::ActiveWindow;
use image::RgbaImage;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

pub fn active_window() -> Option<ActiveWindow> {
    super::active_window_generic()
}

pub fn idle_ms() -> Option<i64> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a properly initialised LASTINPUTINFO with cbSize set.
    let ok = unsafe { GetLastInputInfo(&mut info) }.as_bool();
    if !ok {
        return None;
    }
    // SAFETY: no preconditions.
    let now = unsafe { GetTickCount() };
    // Both are 32-bit tick counts that wrap every ~49 days; wrapping_sub handles it.
    Some(now.wrapping_sub(info.dwTime) as i64)
}

pub async fn capture_screens() -> anyhow::Result<Vec<RgbaImage>> {
    tokio::task::spawn_blocking(super::capture_with_xcap).await?
}

pub fn prepare() {}

pub fn permissions() -> Vec<super::Permission> {
    Vec::new()
}

pub fn request_permission(_key: &str) {}

pub fn diagnostics() -> Vec<String> {
    Vec::new()
}
