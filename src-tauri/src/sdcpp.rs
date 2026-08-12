use anyhow::Result;
use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

/// Shared client: `SdClient::new` is called on every Tauri command (incl. the
/// 2 s job poll), and each `Client::builder()` would create a fresh connection
/// pool. `Client` is internally Arc'd, so cloning the singleton is cheap.
fn shared_http() -> Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client")
    })
    .clone()
}

/// Job ids go straight into the request path. sd-server only ever mints ids
/// matching `[A-Za-z0-9_-]+` (see its route regex), so anything else is either a
/// bug or a caller trying to reach a different endpoint — reject it here rather
/// than sending a malformed URL.
fn validate_job_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        anyhow::bail!("invalid job id: {}", id);
    }
    Ok(())
}

/// sd-server 的 /sdcpp/v1/capabilities 响应必然包含 `samplers` 数组与
/// `defaults_by_mode` 对象（routes_sdcpp.cpp），两者齐备才认定是 sd-server。
fn is_capabilities_shape(value: &serde_json::Value) -> bool {
    value.get("samplers").and_then(|v| v.as_array()).is_some()
        && value
            .get("defaults_by_mode")
            .and_then(|v| v.as_object())
            .is_some()
}

/// Thin HTTP client wrapping sd-server's `/sdcpp/v1` API. Replaces the webui's
/// reverse-proxy approach: the React frontend calls Tauri commands, which use this.
pub struct SdClient {
    base: String,
    http: Client,
}

impl SdClient {
    pub fn new(port: u16) -> Self {
        Self {
            base: format!("http://127.0.0.1:{}", port),
            http: shared_http(),
        }
    }

    /// Quick (2s) reachability probe used by `server_status`.  Besides the
    /// status code, the body must carry sd-server's capabilities shape —
    /// otherwise any HTTP service answering 200 on that path (SPA dev-server
    /// fallback, ComfyUI, reverse proxy) would be mistaken for an external
    /// sd-server and receive generation requests (adversarial review C).
    pub async fn ping(&self) -> bool {
        let req = self
            .http
            .get(format!("{}/sdcpp/v1/capabilities", self.base));
        match req.timeout(Duration::from_secs(2)).send().await {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(value) => is_capabilities_shape(&value),
                Err(_) => false,
            },
            _ => false,
        }
    }

    pub async fn capabilities(&self) -> Result<serde_json::Value> {
        Ok(self
            .http
            .get(format!("{}/sdcpp/v1/capabilities", self.base))
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?)
    }

    /// Submit an img_gen / vid_gen job. Returns (HTTP status, body) so the caller
    /// can distinguish 202 (queued), 429 (queue full) and error responses.
    ///
    /// `mode` is validated against the two native endpoints rather than being
    /// interpolated as-is: it arrives from the frontend, and a stray path
    /// segment would silently POST the payload somewhere else.
    pub async fn submit(
        &self,
        mode: &str,
        body: &serde_json::Value,
    ) -> Result<(u16, serde_json::Value)> {
        if mode != "img_gen" && mode != "vid_gen" {
            anyhow::bail!("unsupported generation mode: {}", mode);
        }
        let resp = self
            .http
            .post(format!("{}/sdcpp/v1/{}", self.base, mode))
            .json(body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let value: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, value))
    }

    /// Poll a job. Returns (HTTP status, body): 404/410 mean the job is gone
    /// (server restarted or job expired) — the caller must not keep polling.
    pub async fn job(&self, id: &str) -> Result<(u16, serde_json::Value)> {
        validate_job_id(id)?;
        let resp = self
            .http
            .get(format!("{}/sdcpp/v1/jobs/{}", self.base, id))
            .send()
            .await?;
        let status = resp.status().as_u16();
        let value: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, value))
    }

    /// Cancel a job. Returns (HTTP status, body): the server answers 409 for
    /// jobs that are already generating (interruption is not supported), which
    /// the UI must surface instead of pretending the job was cancelled.
    pub async fn cancel(&self, id: &str) -> Result<(u16, serde_json::Value)> {
        validate_job_id(id)?;
        let resp = self
            .http
            .post(format!("{}/sdcpp/v1/jobs/{}/cancel", self.base, id))
            .send()
            .await?;
        let status = resp.status().as_u16();
        let value: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_job_id_accepts_server_minted_ids() {
        assert!(validate_job_id("job_01HTXYZABC").is_ok());
        assert!(validate_job_id("job-1").is_ok());
    }

    #[test]
    fn validate_job_id_rejects_path_segments() {
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("../capabilities").is_err());
        assert!(validate_job_id("a/b").is_err());
        assert!(validate_job_id("a?x=1").is_err());
    }

    #[tokio::test]
    async fn submit_rejects_an_unknown_mode() {
        let client = SdClient::new(1234);
        let error = client
            .submit("../../etc", &serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("unsupported generation mode"));
    }
}
