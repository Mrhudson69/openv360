//! Linux support, with Ubuntu 24.04 / 26.04 (GNOME on Wayland) as the main target.
//!
//! Screenshots try several methods in order and remember the first one that works:
//!   1. openv360 GNOME Shell extension over D-Bus (silent, GNOME Wayland + X11)
//!   2. xdg-desktop-portal Screenshot (any Wayland desktop; may ask permission once)
//!   3. `grim` (wlroots: Sway, Hyprland), `spectacle` (KDE), `gnome-screenshot`
//!   4. Direct X11 capture of the root window
//!
//! The focused window comes from the extension on GNOME Wayland and from X11 otherwise.

use super::ActiveWindow;
use image::RgbaImage;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use zbus::blocking::Connection;

const EXT_UUID: &str = "openv360@openv360.org";
const EXT_METADATA: &str = include_str!("../../../../linux/gnome-extension/metadata.json");
const EXT_JS: &str = include_str!("../../../../linux/gnome-extension/extension.js");
const SHELL_DEST: &str = "org.gnome.Shell";
const AGENT_PATH: &str = "/org/openv360/Agent";
const AGENT_IFACE: &str = "org.openv360.Agent";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Method {
    Extension,
    Portal,
    Grim,
    Spectacle,
    GnomeScreenshot,
    X11,
}

static WORKING_METHOD: Mutex<Option<Method>> = Mutex::new(None);
static LAST_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn session_bus() -> Option<&'static Connection> {
    static BUS: OnceLock<Option<Connection>> = OnceLock::new();
    BUS.get_or_init(|| Connection::session().ok()).as_ref()
}

fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.to_ascii_lowercase().contains("gnome"))
        .unwrap_or(false)
}

fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("org.openv360.agent")
}

// ---------- GNOME extension ----------

fn extension_call<B>(method: &str, body: &B) -> zbus::Result<zbus::message::Message>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let bus = session_bus().ok_or_else(|| zbus::Error::Failure("no session bus".into()))?;
    bus.call_method(Some(SHELL_DEST), AGENT_PATH, Some(AGENT_IFACE), method, body)
}

fn extension_available() -> bool {
    extension_call("GetFocusedWindow", &()).is_ok()
}

/// Copy the bundled extension into ~/.local/share/gnome-shell/extensions and enable it.
fn install_extension() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let dir = home.join(".local/share/gnome-shell/extensions").join(EXT_UUID);
    let up_to_date = std::fs::read_to_string(dir.join("metadata.json")).ok().as_deref()
        == Some(EXT_METADATA)
        && std::fs::read_to_string(dir.join("extension.js")).ok().as_deref() == Some(EXT_JS);
    if !up_to_date {
        let res = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(dir.join("metadata.json"), EXT_METADATA))
            .and_then(|_| std::fs::write(dir.join("extension.js"), EXT_JS));
        match res {
            Ok(()) => {
                log::info!("installed GNOME extension to {}", dir.display());
            }
            Err(e) => {
                log::warn!("could not install GNOME extension: {e}");
                return;
            }
        }
    }
    // Enabling works immediately on X11; on Wayland GNOME only picks up a
    // newly installed extension after the next login.
    let _ = Command::new("gnome-extensions").args(["enable", EXT_UUID]).output();
    if !extension_available() {
        // Fallback for when gnome-extensions can't see the not-yet-loaded extension:
        // add it to the enabled list directly so it loads at next login.
        add_to_enabled_extensions();
    }
}

fn add_to_enabled_extensions() {
    let Ok(out) = Command::new("gsettings")
        .args(["get", "org.gnome.shell", "enabled-extensions"])
        .output()
    else {
        return;
    };
    let current = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if current.contains(EXT_UUID) {
        return;
    }
    let inner = current
        .trim_start_matches("@as")
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim()
        .to_string();
    let new = if inner.is_empty() {
        format!("['{EXT_UUID}']")
    } else {
        format!("[{inner}, '{EXT_UUID}']")
    };
    let _ = Command::new("gsettings")
        .args(["set", "org.gnome.shell", "enabled-extensions", &new])
        .output();
}

// ---------- public API ----------

pub fn prepare() {
    if is_gnome() {
        install_extension();
    }
}

pub fn active_window() -> Option<ActiveWindow> {
    if is_gnome()
        && let Some(w) = extension_call("GetFocusedWindow", &())
            .ok()
            .and_then(|m| m.body().deserialize::<String>().ok())
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        {
            let app = w["app"].as_str().unwrap_or_default().to_string();
            let title = w["title"].as_str().unwrap_or_default().to_string();
            return Some(ActiveWindow { app, title });
        }
    if is_wayland() {
        // X11 APIs only see XWayland windows on Wayland, which would be misleading.
        return None;
    }
    super::active_window_generic()
}

pub fn idle_ms() -> Option<i64> {
    if let Some(bus) = session_bus() {
        // GNOME (Wayland and X11).
        if let Ok(m) = bus.call_method(
            Some("org.gnome.Mutter.IdleMonitor"),
            "/org/gnome/Mutter/IdleMonitor/Core",
            Some("org.gnome.Mutter.IdleMonitor"),
            "GetIdletime",
            &(),
        ) && let Ok(ms) = m.body().deserialize::<u64>()
        {
            return Some(ms as i64);
        }
        // KDE Plasma and others implementing the freedesktop screensaver API (milliseconds).
        if let Ok(m) = bus.call_method(
            Some("org.freedesktop.ScreenSaver"),
            "/org/freedesktop/ScreenSaver",
            Some("org.freedesktop.ScreenSaver"),
            "GetSessionIdleTime",
            &(),
        ) && let Ok(ms) = m.body().deserialize::<u32>()
        {
            return Some(ms as i64);
        }
    }
    // Any X11 session (Xfce, MATE, Cinnamon, i3, ...): XScreenSaver extension.
    if !is_wayland() {
        return x11_idle_ms();
    }
    None
}

fn x11_idle_ms() -> Option<i64> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::screensaver::ConnectionExt as _;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots[screen_num].root;
    let info = conn.screensaver_query_info(root).ok()?.reply().ok()?;
    Some(info.ms_since_user_input as i64)
}

/// "Ubuntu 24.04.1 LTS" from /etc/os-release, if available.
pub fn os_version() -> Option<String> {
    let raw = std::fs::read_to_string("/etc/os-release").ok()?;
    raw.lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
}

pub async fn capture_screens() -> anyhow::Result<Vec<RgbaImage>> {
    let order = method_order();
    let mut errors = Vec::new();
    for m in order {
        match capture_with(m).await {
            Ok(images) if !images.is_empty() => {
                let mut wm = WORKING_METHOD.lock().unwrap();
                if *wm != Some(m) {
                    log::info!("screenshots: using {m:?}");
                    *wm = Some(m);
                }
                LAST_ERRORS.lock().unwrap().clear();
                return Ok(images);
            }
            Ok(_) => errors.push(format!("{m:?}: empty image")),
            Err(e) => errors.push(format!("{m:?}: {e}")),
        }
    }
    *WORKING_METHOD.lock().unwrap() = None;
    *LAST_ERRORS.lock().unwrap() = errors.clone();
    anyhow::bail!("no screenshot method worked: {}", errors.join("; "))
}

fn method_order() -> Vec<Method> {
    let mut order = Vec::new();
    if let Some(m) = *WORKING_METHOD.lock().unwrap() {
        order.push(m);
    }
    let candidates: &[Method] = if is_wayland() {
        &[
            Method::Extension,
            Method::Portal,
            Method::Grim,
            Method::Spectacle,
            Method::GnomeScreenshot,
        ]
    } else {
        &[
            Method::X11,
            Method::Extension,
            Method::Portal,
            Method::Spectacle,
            Method::GnomeScreenshot,
        ]
    };
    for &m in candidates {
        if !order.contains(&m) {
            order.push(m);
        }
    }
    order
}

async fn capture_with(m: Method) -> anyhow::Result<Vec<RgbaImage>> {
    match m {
        Method::X11 => tokio::task::spawn_blocking(capture_x11).await?,
        Method::Extension => {
            let path = temp_png()?;
            let p = path.clone();
            let ok = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
                let msg = extension_call("Screenshot", &(p.to_string_lossy().as_ref(),))?;
                Ok(msg.body().deserialize::<bool>()?)
            })
            .await??;
            if !ok {
                anyhow::bail!("extension reported failure");
            }
            read_and_remove(&path)
        }
        Method::Portal => {
            use ashpd::desktop::screenshot::Screenshot;
            let resp = Screenshot::request()
                .interactive(false)
                .modal(false)
                .send()
                .await?
                .response()?;
            let path = url::Url::parse(resp.uri().as_str())?
                .to_file_path()
                .map_err(|_| anyhow::anyhow!("portal returned a non-file URI"))?;
            read_and_remove(&path)
        }
        Method::Grim => run_tool("grim", |p| vec![p.to_string()]).await,
        Method::Spectacle => {
            run_tool("spectacle", |p| {
                ["-b", "-n", "-f", "-o", p].map(String::from).to_vec()
            })
            .await
        }
        Method::GnomeScreenshot => run_tool("gnome-screenshot", |p| vec!["-f".into(), p.into()]).await,
    }
}

async fn run_tool(bin: &str, args: impl Fn(&str) -> Vec<String>) -> anyhow::Result<Vec<RgbaImage>> {
    let path = temp_png()?;
    let a = args(&path.to_string_lossy());
    let bin = bin.to_string();
    let status = tokio::task::spawn_blocking(move || {
        Command::new(&bin)
            .args(&a)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    })
    .await??;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        anyhow::bail!("exited with {status}");
    }
    read_and_remove(&path)
}

fn temp_png() -> anyhow::Result<PathBuf> {
    let dir = data_dir().join("capture");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.png", uuid::Uuid::new_v4())))
}

fn read_and_remove(path: &Path) -> anyhow::Result<Vec<RgbaImage>> {
    let img = image::open(path);
    let _ = std::fs::remove_file(path);
    Ok(vec![img?.to_rgba8()])
}

pub fn permissions() -> Vec<super::Permission> {
    Vec::new()
}

pub fn request_permission(_key: &str) {}

pub fn diagnostics() -> Vec<String> {
    let mut out = Vec::new();
    let wayland = is_wayland();
    if is_gnome() && !extension_available() {
        if wayland {
            out.push(
                "Log out and back in once to finish setup. Until then, screenshots use the system screenshot portal (it may ask for permission) and app names are not recorded."
                    .into(),
            );
        } else {
            out.push("openv360 GNOME helper is not active yet; restart GNOME Shell or log out and back in.".into());
        }
    } else if wayland && !is_gnome() {
        out.push("On Wayland desktops other than GNOME, the focused app can't be detected; time and screenshots are still recorded.".into());
    }
    if idle_ms().is_none() {
        out.push("Idle time can't be read on this desktop; all clocked-in time counts as active.".into());
    }
    let errs = LAST_ERRORS.lock().unwrap();
    if !errs.is_empty() {
        out.push(format!(
            "Screenshots are failing ({}). Install `gnome-screenshot` or `grim` as a fallback.",
            errs.join("; ")
        ));
    }
    out
}

/// Grab the whole X11 root window (all monitors) in one request.
fn capture_x11() -> anyhow::Result<Vec<RgbaImage>> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat};

    let (conn, screen_num) = x11rb::connect(None)?;
    let setup = conn.setup();
    let screen = &setup.roots[screen_num];
    let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, screen.root, 0, 0, w, h, u32::MAX)?
        .reply()?;
    let bpp = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == reply.depth)
        .map(|f| f.bits_per_pixel)
        .unwrap_or(32);
    anyhow::ensure!(
        bpp == 32 && matches!(reply.depth, 24 | 32),
        "unsupported X11 pixel format (depth {}, {} bpp)",
        reply.depth,
        bpp
    );
    anyhow::ensure!(
        setup.image_byte_order == x11rb::protocol::xproto::ImageOrder::LSB_FIRST,
        "unsupported X11 byte order"
    );
    // Little-endian 32 bpp ZPixmap is B, G, R, X per pixel.
    let mut rgba = reply.data;
    for px in rgba.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    let img = RgbaImage::from_raw(w as u32, h as u32, rgba)
        .ok_or_else(|| anyhow::anyhow!("X11 image size mismatch"))?;
    Ok(vec![img])
}
