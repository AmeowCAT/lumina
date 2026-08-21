use anyhow::Result;
use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

/// Shared client: `SdClient::new` is called on every Tauri command (incl. the
/// 2 s job poll), and each `Client::builder()` would create a fresh connection
/// pool. `Client` is internally Arc'd, so cloning the singleton is cheap.
///
/// 重定向必须禁用：本项目只访问本机 127.0.0.1 上的 sd-server。若端口被恶意
/// 服务占用并返回重定向，reqwest 默认会跟随到任意地址，形成 SSRF/外联
/// 风险。
fn shared_http() -> Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
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
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        anyhow::bail!("invalid job id: {}", id);
    }
    Ok(())
}

/// sd-server 的 /v1/models 响应形状（routes_openai.cpp）：
/// `data[0].id == "sd-cpp-local"`。用这个轻量端点做 3s 心跳而不是
/// /sdcpp/v1/capabilities——后者每次都会触发上游 refresh_lora_cache 对
/// lora-model-dir 做递归全量扫描，大模型目录下会让心跳超过 2s 超时。
fn is_sd_server_models_shape(value: &serde_json::Value) -> bool {
    value
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|data| data.first())
        .and_then(|entry| entry.get("id"))
        .and_then(|id| id.as_str())
        == Some("sd-cpp-local")
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

    /// Quick reachability probe used by `server_status`.  Besides the
    /// status code, the body must carry sd-server's `/v1/models` shape —
    /// otherwise any HTTP service answering 200 on that path (SPA dev-server
    /// fallback, ComfyUI, reverse proxy) would be mistaken for an external
    /// sd-server and receive generation requests (adversarial review C).
    /// `/v1/models` is a static handler that does not refresh LoRA/upscaler
    /// caches, unlike `/sdcpp/v1/capabilities`.
    ///
    /// 回退:自编译/裁剪的 sd-server 可能不含 OpenAI 兼容路由(或模型 id
    /// 与 "sd-cpp-local" 不一致),轻量探测恒失败会把可用服务器误判为不可达
    /// (审查 M2)。此时退回 sd-server 专属的 /sdcpp/v1/capabilities 做结构
    /// 校验(带 samplers 数组即为本家,不会误认 ComfyUI/反向代理)。该端点
    /// 会触发 LoRA 全量扫描、较重,所以只在轻量探测失败时才调用。
    pub async fn ping(&self) -> bool {
        let req = self.http.get(format!("{}/v1/models", self.base));
        let models_ok = match req.timeout(Duration::from_secs(2)).send().await {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(value) => is_sd_server_models_shape(&value),
                Err(_) => false,
            },
            _ => false,
        };
        if models_ok {
            return true;
        }
        let req = self
            .http
            .get(format!("{}/sdcpp/v1/capabilities", self.base));
        match req.timeout(Duration::from_secs(3)).send().await {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(v) => v.get("samplers").and_then(|s| s.as_array()).is_some(),
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

    #[test]
    fn models_shape_requires_the_sd_cpp_local_id() {
        assert!(is_sd_server_models_shape(
            &serde_json::json!({"data": [{"id": "sd-cpp-local", "object": "model"}]})
        ));
        assert!(!is_sd_server_models_shape(&serde_json::json!({"data": []})));
        assert!(!is_sd_server_models_shape(
            &serde_json::json!({"data": [{"id": "comfy-model"}]})
        ));
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
