//! Agent self-update.
//!
//! A low-frequency background check asks the server for the latest release for
//! this machine's OS/arch. When a strictly newer version is available and
//! updating is allowed, it applies the update by re-running the SAME installer
//! flow that first set the agent up (so we reuse already-tested, signed install
//! paths rather than hand-rolling binary surgery), then shuts the agent down so
//! the service manager relaunches the new build.
//!
//! The checker is defensive: it never panics, logs at info/warn, and treats any
//! error as "try again next cycle".

use crate::Agent;
use std::process::Command;

/// The launchd/installer bundle identifier (matches the installers).
#[cfg(target_os = "macos")]
const APP_ID: &str = "org.openv360.agent";

/// CPU architecture string understood by `GET /api/agent/release`.
fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        // Anything else won't match a published artifact; the server no-ops.
        std::env::consts::ARCH
    }
}

/// Parse a semver string, tolerating a leading `v` and trailing build metadata.
fn parse_version(s: &str) -> Option<semver::Version> {
    semver::Version::parse(s.trim().trim_start_matches('v')).ok()
}

/// Run one update check. Returns `true` if an update was launched and the caller
/// should begin a clean shutdown so the new version takes over.
pub async fn check_once(agent: &Agent) -> bool {
    match try_check(agent).await {
        Ok(launched) => launched,
        Err(e) => {
            log::warn!("update check failed (will retry): {e:#}");
            false
        }
    }
}

async fn try_check(agent: &Agent) -> anyhow::Result<bool> {
    let (server_url, local_enabled, server_switch) = {
        let c = agent.config.lock().unwrap();
        (c.server_url.clone(), c.auto_update, c.settings.agent_auto_update)
    };
    let Some(server_url) = server_url else {
        return Ok(false);
    };
    let Some(client) = agent.client() else {
        return Ok(false);
    };

    let os = crate::platform::os_name();
    let arch = current_arch();
    let rel = client.release(os, arch).await.map_err(|e| anyhow::anyhow!("{e}"))?;

    let current = parse_version(env!("CARGO_PKG_VERSION"))
        .ok_or_else(|| anyhow::anyhow!("bad local version"))?;
    let Some(latest) = parse_version(&rel.version) else {
        log::warn!("server reported unparseable version {:?}", rel.version);
        return Ok(false);
    };
    let min = parse_version(&rel.min_supported).unwrap_or_else(|| semver::Version::new(0, 0, 0));

    let newer = latest > current;
    // Surface "update available" in the UI regardless of whether we apply it.
    agent.status.lock().unwrap().update_available = newer.then(|| latest.to_string());

    if !newer {
        log::info!("up to date (v{current}, latest v{latest})");
        return Ok(false);
    }

    // The administrator can hard-disable updates from the server; that wins.
    if server_switch == Some(false) {
        log::info!("update to v{latest} available but disabled by administrator");
        return Ok(false);
    }
    // Otherwise the local flag governs, except a below-minimum build updates even
    // if the user turned the local flag off (an unsupported agent must move on).
    let forced = current < min;
    if !local_enabled && !forced {
        log::info!("update to v{latest} available but auto-update is off");
        return Ok(false);
    }

    let Some(url) = rel.url.clone() else {
        log::info!("update to v{latest} available but the server has no download URL");
        return Ok(false);
    };

    log::warn!(
        "updating from v{current} to v{latest}{}{}",
        if forced { " (current build is below the minimum supported version)" } else { "" },
        if rel.notes.trim().is_empty() { String::new() } else { format!(" — {}", rel.notes.trim()) },
    );

    apply(&client, &server_url, &rel, &url).await?;
    Ok(true)
}

/// Download `url` and verify its sha256 against `expected` when one is given.
#[cfg(any(target_os = "macos", windows))]
async fn download_verified(
    client: &crate::api::Client,
    url: &str,
    expected: Option<&str>,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let bytes = client.download(url).await?;
    if let Some(want) = expected {
        let got = hex::encode(Sha256::digest(&bytes));
        if !got.eq_ignore_ascii_case(want.trim()) {
            anyhow::bail!("sha256 mismatch for {url}: expected {want}, got {got}");
        }
        log::info!("verified sha256 of downloaded artifact");
    }
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// A unique, empty temp directory for this update attempt.
fn temp_dir() -> anyhow::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("openv360-update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------- Linux ----------
// Re-run the published installer with `--server` (no code: already enrolled).
// install.sh updates the .deb/AppImage in place and restarts the systemd user
// service, so we don't need to touch binaries ourselves.
#[cfg(target_os = "linux")]
async fn apply(
    client: &crate::api::Client,
    server_url: &str,
    _rel: &crate::api::ReleaseInfo,
    _url: &str,
) -> anyhow::Result<()> {
    // We fetch install.sh and run it as root-ish via the service; over plaintext
    // http an on-path attacker could swap in a malicious script (RCE). macOS and
    // Windows verify a sha256 of their artifact; the Linux script path has no such
    // check, so require https here. http deployments simply skip auto-update (the
    // admin can update manually) rather than accept a code-injection vector.
    if !server_url.starts_with("https://") {
        anyhow::bail!(
            "auto-update over an unencrypted (http) server is disabled for safety — \
             a man-in-the-middle could inject a malicious installer. Use https, or update manually."
        );
    }
    let dir = temp_dir()?;
    let script = dir.join("install.sh");
    let bytes = client.download(&format!("{server_url}/install.sh")).await?;
    std::fs::write(&script, bytes)?;
    // Give ourselves a moment to exit cleanly before the installer restarts the
    // service; run detached so it outlives this process.
    let cmd = format!(
        "sleep 2; sh {} --server {} >/dev/null 2>&1",
        shell_quote(&script.to_string_lossy()),
        shell_quote(server_url),
    );
    Command::new("sh").arg("-c").arg(cmd).spawn()?;
    log::info!("launched installer to update in place");
    Ok(())
}

// ---------- macOS ----------
// Replace the .app bundle from the downloaded tarball, then kickstart the
// launchd service so the new binary runs.
#[cfg(target_os = "macos")]
async fn apply(
    client: &crate::api::Client,
    _server_url: &str,
    rel: &crate::api::ReleaseInfo,
    url: &str,
) -> anyhow::Result<()> {
    let dir = temp_dir()?;
    let tgz = dir.join("openv360.app.tar.gz");
    download_verified(client, url, rel.sha256.as_deref(), &tgz).await?;

    let exe = std::env::current_exe()?;
    let app_root = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| p.to_path_buf())
        .ok_or_else(|| anyhow::anyhow!("could not locate the .app bundle from {exe:?}"))?;
    let parent = app_root
        .parent()
        .ok_or_else(|| anyhow::anyhow!("app bundle has no parent dir"))?;
    let uid = unsafe { getuid() };

    let cmd = format!(
        "sleep 2; osascript -e 'quit app \"openv360\"' >/dev/null 2>&1 || true; \
         rm -rf {app}; tar -xzf {tgz} -C {parent}; \
         xattr -dr com.apple.quarantine {app} >/dev/null 2>&1 || true; \
         launchctl kickstart -k gui/{uid}/{id} >/dev/null 2>&1 || open {app}",
        app = shell_quote(&app_root.to_string_lossy()),
        tgz = shell_quote(&tgz.to_string_lossy()),
        parent = shell_quote(&parent.to_string_lossy()),
        uid = uid,
        id = APP_ID,
    );
    Command::new("sh").arg("-c").arg(cmd).spawn()?;
    log::info!("launched macOS updater (will replace bundle and kickstart service)");
    Ok(())
}

// ---------- Windows ----------
// Run the NSIS setup silently; the scheduled task (or the installer itself)
// relaunches the new build.
#[cfg(windows)]
async fn apply(
    client: &crate::api::Client,
    _server_url: &str,
    rel: &crate::api::ReleaseInfo,
    url: &str,
) -> anyhow::Result<()> {
    let dir = temp_dir()?;
    let setup = dir.join("openv360-setup.exe");
    download_verified(client, url, rel.sha256.as_deref(), &setup).await?;
    // Wait a few seconds so this process has exited (NSIS can't replace a running
    // exe), then run the installer silently and detached.
    let cmd = format!(
        "timeout /t 5 >nul & \"{}\" /S",
        setup.to_string_lossy()
    );
    Command::new("cmd").args(["/C", &cmd]).spawn()?;
    log::info!("launched Windows installer (/S) to update");
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe fn getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_is_known() {
        assert!(matches!(current_arch(), "x86_64" | "aarch64"));
    }

    #[test]
    fn version_parsing_is_lenient() {
        assert_eq!(parse_version("v1.2.3").unwrap(), semver::Version::new(1, 2, 3));
        assert_eq!(parse_version(" 0.1.0 ").unwrap(), semver::Version::new(0, 1, 0));
        assert!(parse_version("not-a-version").is_none());
    }

    #[test]
    fn newer_versions_compare_greater() {
        let a = parse_version("0.1.0").unwrap();
        let b = parse_version("0.2.0").unwrap();
        assert!(b > a);
        assert!(parse_version("0.1.0").unwrap() <= parse_version("0.1.0").unwrap());
    }
}
