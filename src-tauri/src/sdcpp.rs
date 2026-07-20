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

    /// Quick (2s) reachability probe used by `server_status`.
    pub async fn ping(&self) -> bool {
        let req = self
            .http
            .get(format!("{}/sdcpp/v1/capabilities", self.base));
        match req.timeout(Duration::from_secs(2)).send().await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
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
    pub async fn submit(
        &self,
        mode: &str,
        body: &serde_json::Value,
    ) -> Result<(u16, serde_json::Value)> {
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
