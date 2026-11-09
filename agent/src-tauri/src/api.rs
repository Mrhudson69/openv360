//! HTTP client for the openv360 server (see docs/API.md).

use crate::config::{Employee, Settings};
use crate::store::{Segment, SessionEvent};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug)]
pub enum ApiError {
    /// Device token rejected — the device was revoked or the employee removed.
    Unauthorized,
    Other(anyhow::Error),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized => write!(f, "this device is no longer authorised"),
            ApiError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError::Other(e.into())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub hostname: String,
    pub os: String,
    pub os_version: String,
    pub agent_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub device_id: String,
    pub device_token: String,
    pub employee: Employee,
    pub settings: Settings,
}

#[derive(Deserialize)]
pub struct MeResponse {
    pub employee: Employee,
    pub settings: Settings,
    /// Remote command set by the administrator.
    #[serde(default)]
    pub command: DeviceCommand,
}

/// The latest published agent release for this device's os/arch, as reported by
/// `GET /api/agent/release`. A `url` of `None` means the server has nothing to
/// offer and the agent should no-op.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub url: Option<String>,
    // Only consumed by the macOS/Windows updaters; Linux re-runs install.sh,
    // which verifies the download itself.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default = "zero_version")]
    pub min_supported: String,
}

fn zero_version() -> String {
    "0.0.0".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DeviceCommand {
    #[default]
    None,
    /// Pause tracking but stay installed and enrolled.
    Stop,
    /// Clock out, then remove the agent and its data from this machine.
    Uninstall,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Normalise what a user typed ("acme.com/", "http://10.0.0.5:8080") into a base URL.
pub fn normalize_server_url(input: &str) -> String {
    let s = input.trim().trim_end_matches('/');
    let s = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    s.trim_end_matches("/api").to_string()
}

impl Client {
    pub fn new(base: &str, token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("openv360-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            http,
            base: normalize_server_url(base),
            token,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }

    async fn check(resp: reqwest::Response) -> ApiResult<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthorized);
        }
        let msg = resp
            .json::<ErrorBody>()
            .await
            .map(|b| b.error)
            .unwrap_or_else(|_| status.to_string());
        Err(ApiError::Other(anyhow::anyhow!(msg)))
    }

    pub async fn enroll(&self, code: &str, device: DeviceInfo) -> anyhow::Result<EnrollResponse> {
        let body = serde_json::json!({ "code": code.trim().to_uppercase(), "device": device });
        let resp = self
            .http
            .post(self.url("/api/agent/enroll"))
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("could not reach server at {}: {e}", self.base))?;
        match Self::check(resp).await {
            Ok(r) => Ok(r.json().await?),
            Err(ApiError::Unauthorized) => anyhow::bail!("invalid or expired enrollment code"),
            Err(ApiError::Other(e)) => Err(e),
        }
    }

    pub async fn me(&self) -> ApiResult<MeResponse> {
        let r = self.auth(self.http.get(self.url("/api/agent/me"))).send().await?;
        Ok(Self::check(r).await?.json().await?)
    }

    /// The latest published release for this `os`/`arch`. Unauthenticated endpoint.
    pub async fn release(&self, os: &str, arch: &str) -> ApiResult<ReleaseInfo> {
        let path = format!("/api/agent/release?os={os}&arch={arch}");
        let r = self.http.get(self.url(&path)).send().await?;
        Ok(Self::check(r).await?.json().await?)
    }

    /// Download an arbitrary absolute URL (a release artifact or the installer
    /// script). Returns the raw bytes.
    pub async fn download(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        let resp = self.http.get(url).send().await?.error_for_status()?;
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn post_sessions(&self, events: &[SessionEvent]) -> ApiResult<()> {
        let r = self
            .auth(self.http.post(self.url("/api/agent/sessions")))
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await?;
        Self::check(r).await?;
        Ok(())
    }

    pub async fn post_activity(&self, segments: &[Segment]) -> ApiResult<()> {
        let r = self
            .auth(self.http.post(self.url("/api/agent/activity")))
            .json(&serde_json::json!({ "segments": segments }))
            .send()
            .await?;
        Self::check(r).await?;
        Ok(())
    }

    pub async fn post_screenshot(&self, id: &str, taken_at: i64, jpeg: Vec<u8>) -> ApiResult<()> {
        let part = reqwest::multipart::Part::bytes(jpeg)
            .file_name(format!("{id}.jpg"))
            .mime_str("image/jpeg")?;
        let form = reqwest::multipart::Form::new()
            .text("id", id.to_string())
            .text("takenAt", taken_at.to_string())
            .part("file", part);
        let r = self
            .auth(self.http.post(self.url("/api/agent/screenshots")))
            .multipart(form)
            .send()
            .await?;
        Self::check(r).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_server_url as n;

    #[test]
    fn normalizes_urls() {
        assert_eq!(n("acme.com/"), "https://acme.com");
        assert_eq!(n(" http://10.0.0.5:8080 "), "http://10.0.0.5:8080");
        assert_eq!(n("https://t.acme.com/api/"), "https://t.acme.com");
    }
}
