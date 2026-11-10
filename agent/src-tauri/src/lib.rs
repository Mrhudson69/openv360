//! openv360 desktop agent.
//!
//! Background loops:
//!   * tracker    — every 5 s samples the foreground app + idle time into segments
//!   * screenshot — captures the screen at the configured (randomised) interval
//!   * sync       — uploads the local queue and refreshes server settings
//!
//! Tracking only runs while the user is clocked in, and is always visible in the tray.

mod api;
mod uninstall;
mod capture;
mod config;
mod meeting;
mod platform;
mod store;
mod tracker;
mod update;

use config::{Config, Paths, PendingEnrollment, Settings};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{QueuedScreenshot, SessionEvent, Store, Table};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracker::{Sample, SegmentBuilder};

const SAMPLE_EVERY: Duration = Duration::from_secs(5);
const SYNC_EVERY: Duration = Duration::from_secs(60);
/// How often to check for a newer agent build, after an initial short delay.
/// Hourly so a published release rolls out across the fleet within ~1h (plus the
/// server's short release-cache TTL) instead of lingering for hours.
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(3600);
const UPDATE_FIRST_DELAY: Duration = Duration::from_secs(60);
/// If the sync loop stops heartbeating for this long it has died or wedged (not
/// merely failing — a down server still beats), so the watchdog restarts the
/// process. Queued data is on disk, so a restart loses nothing.
const WATCHDOG_STALE: Duration = Duration::from_secs(5 * 60);
const WATCHDOG_CHECK: Duration = Duration::from_secs(60);

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn local_midnight_ms() -> i64 {
    use chrono::{Local, TimeZone};
    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    Local
        .from_local_datetime(&today)
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(now_ms)
}

#[derive(Default)]
struct Status {
    last_screenshot_at: Option<i64>,
    next_screenshot_at: Option<i64>,
    last_sync_at: Option<i64>,
    last_error: Option<String>,
    diagnostics: Vec<String>,
    /// Administrator paused tracking remotely (device command = stop).
    paused_by_admin: bool,
    permissions: Vec<platform::Permission>,
    /// A newer agent version the server is offering (set by the update checker).
    update_available: Option<String>,
}

pub struct Agent {
    paths: Paths,
    config: Mutex<Config>,
    store: Mutex<Store>,
    builder: Mutex<SegmentBuilder>,
    status: Mutex<Status>,
    wake_sync: tokio::sync::Notify,
    tray_items: Mutex<Option<TrayItems>>,
    /// Lock-free heartbeat: epoch-ms stamped at the top of every sync-loop
    /// iteration. The watchdog restarts the process if this goes stale, which
    /// means the loop task died or wedged. It is an atomic (never a lock) so the
    /// watchdog keeps working even if a mutex elsewhere got poisoned by a panic.
    sync_beat_ms: std::sync::atomic::AtomicI64,
}

struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    enrolled: bool,
    server_url: Option<String>,
    employee: Option<config::Employee>,
    clocked_in: bool,
    auto_clock_in: bool,
    today_active_ms: i64,
    last_screenshot_at: Option<i64>,
    next_screenshot_at: Option<i64>,
    last_sync_at: Option<i64>,
    pending_uploads: i64,
    last_error: Option<String>,
    settings: Settings,
    diagnostics: Vec<String>,
    /// OS permissions and whether each is granted (gates first-run on macOS).
    permissions: Vec<platform::Permission>,
    /// A required permission is still missing; tracking can't start.
    needs_permissions: bool,
    /// Administrator paused tracking from the dashboard.
    paused_by_admin: bool,
    os: &'static str,
    version: &'static str,
    /// A newer version available to update to, if the checker found one.
    update_available: Option<String>,
}

impl Agent {
    fn new(paths: Paths) -> anyhow::Result<Self> {
        let config = Config::load(&paths.config_file);
        let store = Store::open(&paths.db_file)?;
        std::fs::create_dir_all(&paths.screens_dir)?;
        Ok(Self {
            paths,
            config: Mutex::new(config),
            store: Mutex::new(store),
            builder: Mutex::new(SegmentBuilder::default()),
            status: Mutex::new(Status::default()),
            wake_sync: tokio::sync::Notify::new(),
            tray_items: Mutex::new(None),
            sync_beat_ms: std::sync::atomic::AtomicI64::new(now_ms()),
        })
    }

    /// Stamp the sync-loop heartbeat (called once per loop iteration).
    fn beat(&self) {
        self.sync_beat_ms
            .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    }

    fn save_config(&self, cfg: &Config) {
        if let Err(e) = cfg.save(&self.paths.config_file) {
            log::error!("saving config: {e:#}");
        }
    }

    fn client(&self) -> Option<api::Client> {
        let c = self.config.lock().unwrap();
        Some(api::Client::new(c.server_url.as_ref()?, c.device_token.clone()))
    }

    fn set_error(&self, e: Option<String>) {
        self.status.lock().unwrap().last_error = e;
    }

    fn today_active_ms(&self) -> i64 {
        let midnight = local_midnight_ms();
        let stored = self.store.lock().unwrap().active_ms_since(midnight).unwrap_or(0);
        let live = self
            .builder
            .lock()
            .unwrap()
            .current()
            .filter(|s| !s.idle && s.end > midnight)
            .map(|s| s.end - s.start.max(midnight))
            .unwrap_or(0);
        stored + live
    }

    fn view(&self) -> StateView {
        let c = self.config.lock().unwrap().clone();
        let today_active_ms = self.today_active_ms();
        let pending_uploads = self.store.lock().unwrap().pending_count().unwrap_or(0);
        let s = self.status.lock().unwrap();
        StateView {
            enrolled: c.is_enrolled(),
            server_url: c.server_url,
            employee: c.employee,
            clocked_in: c.clocked_in,
            auto_clock_in: c.auto_clock_in,
            today_active_ms,
            last_screenshot_at: s.last_screenshot_at,
            next_screenshot_at: s.next_screenshot_at,
            last_sync_at: s.last_sync_at,
            pending_uploads,
            last_error: s.last_error.clone(),
            settings: c.settings,
            diagnostics: s.diagnostics.clone(),
            permissions: s.permissions.clone(),
            needs_permissions: s.permissions.iter().any(|p| p.required && !p.granted),
            paused_by_admin: s.paused_by_admin,
            os: platform::os_name(),
            version: env!("CARGO_PKG_VERSION"),
            update_available: s.update_available.clone(),
        }
    }

    /// Whether activity and screenshots should be recorded right now.
    fn tracking_active(&self) -> bool {
        if !self.clocked_in() {
            return false;
        }
        let s = self.status.lock().unwrap();
        !s.paused_by_admin && !s.permissions.iter().any(|p| p.required && !p.granted)
    }

    fn clocked_in(&self) -> bool {
        let c = self.config.lock().unwrap();
        c.clocked_in && c.is_enrolled()
    }

    fn set_clocked_in(&self, on: bool) {
        let mut cfg = self.config.lock().unwrap();
        if !cfg.is_enrolled() || cfg.clocked_in == on {
            return;
        }
        cfg.clocked_in = on;
        self.save_config(&cfg);
        drop(cfg);
        self.record_session(if on { "clock_in" } else { "clock_out" });
        if !on {
            self.flush_segment();
            self.status.lock().unwrap().next_screenshot_at = None;
        }
        self.wake_sync.notify_one();
    }

    fn record_session(&self, kind: &str) {
        let ev = SessionEvent {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            at: now_ms(),
        };
        if let Err(e) = self.store.lock().unwrap().insert_session(&ev) {
            log::error!("queue session: {e:#}");
        }
    }

    fn flush_segment(&self) {
        if let Some(seg) = self.builder.lock().unwrap().flush() {
            let _ = self.store.lock().unwrap().insert_segment(&seg);
        }
    }

    async fn enroll(&self, server_url: &str, code: &str) -> anyhow::Result<()> {
        let server_url = api::normalize_server_url(server_url);
        let client = api::Client::new(&server_url, None);
        let device = api::DeviceInfo {
            hostname: gethostname::gethostname().to_string_lossy().into_owned(),
            os: platform::os_name().into(),
            os_version: platform::os_version(),
            agent_version: env!("CARGO_PKG_VERSION").into(),
        };
        let resp = client.enroll(code, device).await?;
        let mut cfg = self.config.lock().unwrap();
        let auto = cfg.auto_clock_in;
        let auto_update = cfg.auto_update;
        *cfg = Config {
            server_url: Some(server_url),
            device_id: Some(resp.device_id),
            device_token: Some(resp.device_token),
            employee: Some(resp.employee),
            settings: resp.settings,
            clocked_in: false,
            auto_clock_in: auto,
            auto_update,
        };
        self.save_config(&cfg);
        drop(cfg);
        self.set_error(None);
        log::info!("enrolled with server");
        Ok(())
    }

    /// Forget the server credentials and local queue (used on sign-out and on 401).
    fn unenroll(&self) {
        self.set_clocked_in(false);
        let mut cfg = self.config.lock().unwrap();
        let auto = cfg.auto_clock_in;
        let auto_update = cfg.auto_update;
        *cfg = Config {
            auto_clock_in: auto,
            auto_update,
            ..Config::default()
        };
        self.save_config(&cfg);
        drop(cfg);
        let _ = self.store.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.paths.screens_dir);
        let _ = std::fs::create_dir_all(&self.paths.screens_dir);
        *self.status.lock().unwrap() = Status::default();
    }

    /// Upload everything queued. Returns Err(Unauthorized) if the device was revoked.
    async fn sync(&self) -> api::ApiResult<()> {
        let Some(client) = self.client() else {
            return Ok(());
        };

        let sessions = self.store.lock().unwrap().pending_sessions()?;
        if !sessions.is_empty() {
            client.post_sessions(&sessions).await?;
            let ids: Vec<String> = sessions.into_iter().map(|s| s.id).collect();
            self.store.lock().unwrap().mark_uploaded(Table::Sessions, &ids)?;
            self.beat(); // flushing a large backlog is progress, not a stall
        }

        loop {
            let segs = self.store.lock().unwrap().pending_segments(500)?;
            if segs.is_empty() {
                break;
            }
            client.post_activity(&segs).await?;
            let ids: Vec<String> = segs.into_iter().map(|s| s.id).collect();
            self.store.lock().unwrap().mark_uploaded(Table::Segments, &ids)?;
            self.beat();
        }

        loop {
            let shots = self.store.lock().unwrap().pending_screenshots(10)?;
            if shots.is_empty() {
                break;
            }
            for shot in shots {
                match std::fs::read(&shot.path) {
                    Ok(bytes) => client.post_screenshot(&shot.id, shot.taken_at, bytes).await?,
                    Err(e) => log::warn!("screenshot file missing, dropping: {e}"),
                }
                let _ = std::fs::remove_file(&shot.path);
                self.store
                    .lock()
                    .unwrap()
                    .mark_uploaded(Table::Screenshots, &[shot.id])?;
                self.beat(); // each uploaded screenshot is progress
            }
        }

        let week_ago = now_ms() - 7 * 24 * 3600 * 1000;
        let _ = self.store.lock().unwrap().prune(week_ago.min(local_midnight_ms()));
        self.status.lock().unwrap().last_sync_at = Some(now_ms());
        Ok(())
    }

    async fn refresh_settings(&self) -> api::ApiResult<()> {
        let Some(client) = self.client() else {
            return Ok(());
        };
        let me = client.me().await?;
        self.apply_command(me.command);
        let mut cfg = self.config.lock().unwrap();
        if cfg.settings != me.settings || cfg.employee.as_ref().map(|e| &e.name) != Some(&me.employee.name) {
            cfg.settings = me.settings;
            cfg.employee = Some(me.employee);
            self.save_config(&cfg);
        }
        Ok(())
    }

    /// Act on the administrator's remote command. Returns true if the agent is
    /// shutting down (uninstall), so callers can stop their loops.
    fn apply_command(&self, cmd: api::DeviceCommand) -> bool {
        use api::DeviceCommand::*;
        match cmd {
            None => {
                let was = std::mem::replace(&mut self.status.lock().unwrap().paused_by_admin, false);
                if was {
                    log::info!("administrator resumed tracking");
                }
                false
            }
            Stop => {
                let mut s = self.status.lock().unwrap();
                if !s.paused_by_admin {
                    s.paused_by_admin = true;
                    drop(s);
                    log::info!("administrator paused tracking");
                    self.flush_segment();
                }
                false
            }
            Uninstall => {
                // Clock out cleanly and push a final sync best-effort before removing ourselves.
                self.set_clocked_in(false);
                uninstall::self_uninstall(
                    self.paths.config_file.parent().unwrap_or(&self.paths.config_file),
                    self.paths.screens_dir.parent().unwrap_or(&self.paths.screens_dir),
                );
                true
            }
        }
    }

    fn refresh_permissions(&self) {
        let perms = platform::permissions();
        self.status.lock().unwrap().permissions = perms;
    }

    async fn take_screenshot(&self) -> anyhow::Result<()> {
        let blur = self.config.lock().unwrap().settings.screenshot_blur;
        let taken_at = now_ms();
        let images = platform::capture_screens().await?;
        let jpeg = tauri::async_runtime::spawn_blocking(move || capture::process(&images, blur)).await??;
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.paths.screens_dir.join(format!("{id}.jpg"));
        std::fs::write(&path, jpeg)?;
        self.store.lock().unwrap().insert_screenshot(&QueuedScreenshot {
            id,
            taken_at,
            path: path.to_string_lossy().into_owned(),
        })?;
        self.status.lock().unwrap().last_screenshot_at = Some(taken_at);
        Ok(())
    }
}

/// Next screenshot time: the configured interval ±30 %, so captures aren't predictable.
fn next_screenshot_delay_ms(interval_sec: u64) -> i64 {
    let base = (interval_sec.max(30) * 1000) as i64;
    let jitter = (uuid::Uuid::new_v4().as_u128() % 600) as i64 - 300; // -300..299 per mille
    base + base * jitter / 1000
}

fn notify_ui(app: &AppHandle) {
    let agent = app.state::<Arc<Agent>>();
    let view = agent.view();
    if let Some(items) = agent.tray_items.lock().unwrap().as_ref() {
        let mins = view.today_active_ms / 60_000;
        let status = if !view.enrolled {
            "Not set up".to_string()
        } else if view.clocked_in {
            format!("Tracking · {}h {:02}m today", mins / 60, mins % 60)
        } else {
            format!("Paused · {}h {:02}m today", mins / 60, mins % 60)
        };
        let _ = items.status.set_text(status);
        let _ = items
            .toggle
            .set_text(if view.clocked_in { "Clock out" } else { "Clock in" });
        let _ = items.toggle.set_enabled(view.enrolled);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let mut tip = if view.clocked_in { "openv360 — tracking".to_string() } else { "openv360 — not tracking".to_string() };
        if let Some(v) = &view.update_available {
            tip.push_str(&format!(" · updating to v{v}"));
        }
        let _ = tray.set_tooltip(Some(tip));
    }
    let _ = app.emit("state", view);
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn spawn_loops(app: AppHandle) {
    // Tracker.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        let mut tick = tokio::time::interval(SAMPLE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            n += 1;
            if !agent.tracking_active() {
                continue;
            }
            let (titles, idle_threshold_ms) = {
                let c = agent.config.lock().unwrap();
                (c.settings.track_window_titles, c.settings.idle_threshold_sec as i64 * 1000)
            };
            let sampled = tauri::async_runtime::spawn_blocking(|| {
                (platform::active_window(), platform::idle_ms())
            })
            .await;
            let Ok((win, idle)) = sampled else { continue };
            let win = win.unwrap_or_default();
            // A live call (Zoom/Meet/Teams/etc.) counts as working even when the
            // user is only listening and generating no keyboard/mouse input.
            let meeting = meeting::is_meeting(&win.app, &win.title);
            let sample = Sample {
                at: now_ms(),
                idle_ms: idle.unwrap_or(0),
                app: win.app,
                title: if titles { win.title } else { String::new() },
                meeting,
            };
            let done = agent.builder.lock().unwrap().push(&sample, idle_threshold_ms);
            for seg in done {
                if let Err(e) = agent.store.lock().unwrap().insert_segment(&seg) {
                    log::error!("queue segment: {e:#}");
                }
            }
            if n.is_multiple_of(6) {
                notify_ui(&a); // refresh the "today" counter every 30 s
            }
        }
    });

    // Screenshots.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let (enabled, interval) = {
                let c = agent.config.lock().unwrap();
                (c.settings.screenshots_enabled, c.settings.screenshot_interval_sec)
            };
            if !agent.tracking_active() || !enabled {
                agent.status.lock().unwrap().next_screenshot_at = None;
                continue;
            }
            let now = now_ms();
            let next = {
                let mut s = agent.status.lock().unwrap();
                *s.next_screenshot_at
                    .get_or_insert_with(|| now + next_screenshot_delay_ms(interval))
            };
            if now < next {
                continue;
            }
            match agent.take_screenshot().await {
                Ok(()) => log::info!("screenshot captured"),
                Err(e) => {
                    log::warn!("screenshot failed: {e:#}");
                    agent.set_error(Some(format!("Screenshot failed: {e}")));
                }
            }
            agent.status.lock().unwrap().next_screenshot_at =
                Some(now_ms() + next_screenshot_delay_ms(interval));
            notify_ui(&a);
        }
    });

    // Sync.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        loop {
            agent.beat(); // heartbeat for the watchdog — proves this loop is alive
            if agent.config.lock().unwrap().is_enrolled() {
                let mut result = agent.sync().await;
                if result.is_ok() {
                    // Poll settings + remote commands every cycle so a dashboard
                    // pause/uninstall takes effect within about a minute.
                    result = agent.refresh_settings().await;
                }
                match result {
                    Ok(()) => {
                        let mut s = agent.status.lock().unwrap();
                        if s.last_error.as_deref().is_some_and(|e| e.starts_with("Sync") || e.starts_with("Reconnecting")) {
                            s.last_error = None;
                        }
                    }
                    Err(api::ApiError::Unauthorized) => {
                        // NEVER auto-unenroll on a 401. A server restart, redeploy,
                        // reverse-proxy, or a multi-day outage can all return 401,
                        // and none of them mean the device was removed. We keep the
                        // enrollment and all queued data, and keep retrying forever;
                        // when the server returns, the backlog flushes. A device is
                        // only ever removed by the explicit "Uninstall agent"
                        // command or a local sign-out — never on its own.
                        log::warn!("server returned 401; keeping enrollment and retrying");
                        agent.set_error(Some("Reconnecting to the server…".into()));
                    }
                    Err(e) => {
                        log::warn!("sync failed: {e}");
                        agent.set_error(Some(format!("Sync failed (will retry): {e}")));
                    }
                }
                notify_ui(&a);
            }
            let _ = tokio::time::timeout(SYNC_EVERY, agent.wake_sync.notified()).await;
        }
    });

    // Auto-update: a low-frequency check that reuses the installer flow. The
    // first check runs about a minute after start, then every few hours. When an
    // update is launched we shut down cleanly so the service manager starts the
    // new binary.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        tokio::time::sleep(UPDATE_FIRST_DELAY).await;
        loop {
            if agent.config.lock().unwrap().is_enrolled() && update::check_once(&agent).await {
                log::info!("update staged; shutting down for the new version to take over");
                shutdown(&a).await;
                return;
            }
            notify_ui(&a);
            tokio::time::sleep(UPDATE_CHECK_EVERY).await;
        }
    });

    // Watchdog: an enrolled agent that stops making sync progress for too long
    // (a panicked task, a wedged connection, any unknown stuck state) is forced
    // to restart via the service manager, so it can never remain silently offline.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        loop {
            tokio::time::sleep(WATCHDOG_CHECK).await;
            // Only an atomic read — no mutex — so the watchdog survives even a
            // poisoned lock. If the sync loop stopped heartbeating, it died or
            // wedged; exit so the service manager relaunches a healthy process.
            // (A server that is merely down keeps the loop beating, so this does
            // NOT fire during outages — the loop just keeps retrying.)
            let beat = agent.sync_beat_ms.load(std::sync::atomic::Ordering::Relaxed);
            let stale_ms = (now_ms() - beat).max(0) as u64;
            if stale_ms >= WATCHDOG_STALE.as_secs() * 1000 {
                log::error!("watchdog: sync loop silent for {stale_ms}ms; restarting process");
                std::process::exit(1);
            }
        }
    });

    // Platform diagnostics (permissions, missing helpers).
    let a = app;
    tauri::async_runtime::spawn(async move {
        let agent = a.state::<Arc<Agent>>().inner().clone();
        loop {
            let probe = tauri::async_runtime::spawn_blocking(|| {
                (platform::diagnostics(), platform::permissions())
            })
            .await;
            if let Ok((d, perms)) = probe {
                let mut s = agent.status.lock().unwrap();
                s.diagnostics = d;
                s.permissions = perms;
                drop(s);
                notify_ui(&a);
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

async fn enroll_and_start(app: &AppHandle, p: PendingEnrollment) -> Result<(), String> {
    let agent = app.state::<Arc<Agent>>().inner().clone();
    agent.enroll(&p.server_url, &p.code).await.map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        if let Err(e) = app.autolaunch().enable() {
            log::warn!("could not enable start at login: {e}");
        }
    }
    if agent.config.lock().unwrap().auto_clock_in {
        agent.set_clocked_in(true);
    }
    notify_ui(app);
    Ok(())
}

// ---------- commands for the UI ----------

#[tauri::command]
fn get_state(agent: tauri::State<'_, Arc<Agent>>) -> StateView {
    agent.view()
}

#[tauri::command]
fn request_permission(app: AppHandle, key: String) -> StateView {
    platform::request_permission(&key);
    let agent = app.state::<Arc<Agent>>();
    agent.refresh_permissions();
    agent.view()
}

/// Relaunch the agent. macOS caches the Screen Recording check per process, so a
/// newly-granted permission is only seen after a restart; the KeepAlive login
/// agent (macOS/Windows) or the systemd service (Linux) brings it back up.
#[tauri::command]
fn restart_agent(app: AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { shutdown(&app).await });
}

#[tauri::command]
async fn enroll(app: AppHandle, server_url: String, code: String) -> Result<StateView, String> {
    enroll_and_start(&app, PendingEnrollment { server_url, code }).await?;
    Ok(app.state::<Arc<Agent>>().view())
}

#[tauri::command]
fn set_clocked_in(app: AppHandle, on: bool) -> StateView {
    let agent = app.state::<Arc<Agent>>();
    agent.set_clocked_in(on);
    notify_ui(&app);
    agent.view()
}

#[tauri::command]
fn set_auto_clock_in(app: AppHandle, on: bool) -> StateView {
    let agent = app.state::<Arc<Agent>>();
    {
        let mut c = agent.config.lock().unwrap();
        c.auto_clock_in = on;
        agent.save_config(&c);
    }
    agent.view()
}

#[tauri::command]
fn sync_now(agent: tauri::State<'_, Arc<Agent>>) {
    agent.wake_sync.notify_one();
}

#[tauri::command]
fn sign_out(app: AppHandle) -> StateView {
    let agent = app.state::<Arc<Agent>>();
    agent.unenroll();
    notify_ui(&app);
    agent.view()
}

/// Close the open session, save the in-progress segment, try a final upload, exit.
/// The "was tracking" flag is kept so tracking resumes on next start.
async fn shutdown(app: &AppHandle) {
    let agent = app.state::<Arc<Agent>>().inner().clone();
    if agent.clocked_in() {
        agent.record_session("clock_out");
        agent.flush_segment();
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), agent.sync()).await;
    app.exit(0);
}

/// Logout / shutdown / `kill` send SIGTERM: shut down cleanly instead of losing data.
#[cfg(unix)]
fn handle_termination(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
        else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        log::info!("termination signal received; shutting down");
        shutdown(&app).await;
    });
}

#[cfg(not(unix))]
fn handle_termination(_app: AppHandle) {}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "openv360", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Clock in", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open openv360", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &toggle, &open, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("openv360")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let agent = app.state::<Arc<Agent>>();
                let on = !agent.config.lock().unwrap().clocked_in;
                agent.set_clocked_in(on);
                notify_ui(app);
            }
            "open" => show_window(app),
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { shutdown(&app).await });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    let agent = app.state::<Arc<Agent>>();
    *agent.tray_items.lock().unwrap() = Some(TrayItems { status, toggle });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launched_by_autostart = std::env::args().any(|a| a == "--autostart");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(p) = PendingEnrollment::from_args(argv) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = enroll_and_start(&app, p).await {
                        app.state::<Arc<Agent>>().set_error(Some(e));
                        notify_ui(&app);
                    }
                });
            }
            show_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let paths = Paths::new(app.path().app_config_dir()?, app.path().app_data_dir()?);
            let pending = PendingEnrollment::from_args(std::env::args())
                .or_else(|| PendingEnrollment::take_from_file(&paths.enroll_file));
            let agent = Arc::new(Agent::new(paths)?);
            app.manage(agent.clone());
            build_tray(app.handle())?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(platform::prepare);

            let enrolled = agent.config.lock().unwrap().is_enrolled();
            if enrolled {
                let c = agent.config.lock().unwrap().clone();
                if c.clocked_in {
                    // Resume a session interrupted by quit/reboot.
                    agent.record_session("clock_in");
                } else if c.auto_clock_in {
                    agent.set_clocked_in(true);
                }
            }
            if let Some(p) = pending {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = enroll_and_start(&h, p).await {
                        h.state::<Arc<Agent>>().set_error(Some(format!("Enrollment failed: {e}")));
                        notify_ui(&h);
                    }
                });
                show_window(&handle);
            } else if !enrolled || !launched_by_autostart
                || platform::permissions().iter().any(|p| p.required && !p.granted)
            {
                // Also surface the window when a required OS permission (macOS
                // Screen Recording) is still missing, so the user can grant it —
                // otherwise an autostarted, enrolled agent would stay hidden with
                // no way to complete setup.
                show_window(&handle);
            }
            spawn_loops(handle.clone());
            handle_termination(handle.clone());
            notify_ui(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the agent running in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            request_permission,
            restart_agent,
            enroll,
            set_clocked_in,
            set_auto_clock_in,
            sync_now,
            sign_out
        ])
        .run(tauri::generate_context!())
        .expect("error while running openv360");
}

#[cfg(test)]
mod tests {
    #[test]
    fn screenshot_jitter_stays_in_range() {
        for _ in 0..1000 {
            let d = super::next_screenshot_delay_ms(600);
            assert!((420_000..780_000).contains(&d), "{d}");
        }
        // Very small intervals are clamped to 30 s.
        assert!(super::next_screenshot_delay_ms(1) >= 21_000);
    }
}
