//! Persistent agent configuration (enrollment + cached server settings).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub screenshots_enabled: bool,
    pub screenshot_interval_sec: u64,
    pub screenshot_blur: bool,
    pub idle_threshold_sec: u64,
    pub track_window_titles: bool,
    /// Optional remote kill-switch for agent self-update. When the server sends
    /// `agentAutoUpdate: false` the agent won't update even if locally enabled.
    /// Absent (the common case) means "no opinion" and the local flag decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_auto_update: Option<bool>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            screenshots_enabled: true,
            screenshot_interval_sec: 600,
            screenshot_blur: false,
            idle_threshold_sec: 300,
            track_window_titles: true,
            agent_auto_update: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Employee {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server_url: Option<String>,
    pub device_id: Option<String>,
    pub device_token: Option<String>,
    pub employee: Option<Employee>,
    #[serde(default)]
    pub settings: Settings,
    /// Whether the user was clocked in when the agent last ran.
    #[serde(default)]
    pub clocked_in: bool,
    /// Start tracking automatically when the agent starts (e.g. at login).
    #[serde(default = "default_true")]
    pub auto_clock_in: bool,
    /// Allow the agent to download and install newer versions of itself.
    #[serde(default = "default_true")]
    pub auto_update: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: None,
            device_id: None,
            device_token: None,
            employee: None,
            settings: Settings::default(),
            clocked_in: false,
            auto_clock_in: true,
            auto_update: true,
        }
    }
}

impl Config {
    pub fn is_enrolled(&self) -> bool {
        self.server_url.is_some() && self.device_token.is_some()
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        restrict_permissions(&tmp);
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Enrollment details dropped by the one-command installer
/// (`<config dir>/enroll.json`) or passed as `--server URL --code CODE`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingEnrollment {
    pub server_url: String,
    pub code: String,
}

impl PendingEnrollment {
    pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Option<Self> {
        let args: Vec<String> = args.into_iter().collect();
        let get = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };
        Some(Self {
            server_url: get("--server")?,
            code: get("--code")?,
        })
    }

    pub fn take_from_file(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        let _ = std::fs::remove_file(path);
        serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
    }
}

pub struct Paths {
    pub config_file: PathBuf,
    pub enroll_file: PathBuf,
    pub db_file: PathBuf,
    pub screens_dir: PathBuf,
}

impl Paths {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            config_file: config_dir.join("config.json"),
            enroll_file: config_dir.join("enroll.json"),
            db_file: data_dir.join("queue.sqlite3"),
            screens_dir: data_dir.join("screens"),
        }
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_enrollment_args() {
        let args = ["openv360-agent", "--server", "https://x.io", "--code", "AB12-CD34"]
            .map(String::from);
        let p = PendingEnrollment::from_args(args).unwrap();
        assert_eq!(p.server_url, "https://x.io");
        assert_eq!(p.code, "AB12-CD34");
        assert!(PendingEnrollment::from_args(["x".to_string()]).is_none());
    }

    #[test]
    fn settings_use_camel_case() {
        let s: Settings = serde_json::from_str(
            r#"{"screenshotsEnabled":false,"screenshotIntervalSec":60,"screenshotBlur":true,"idleThresholdSec":120,"trackWindowTitles":false}"#,
        )
        .unwrap();
        assert!(!s.screenshots_enabled && s.screenshot_blur);
        assert_eq!(s.screenshot_interval_sec, 60);
    }
}
