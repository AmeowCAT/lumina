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

/// 独立放大的请求超时（秒）。该接口同步执行，4x 放大到 8K 可能要跑很久，
/// 与生成任务轮询共享的 30 秒默认超时完全不同量级。
const UPSCALE_TIMEOUT_SECS: u64 = 600;

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
        anyhow::bail!("任务 ID 非法：{}。请刷新任务列表后重试。", id);
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
/// capabilities 兜底探测的负缓存（审查 10 §2.6）。
///
/// `ping()` 每 3 秒被 `server_status` 调用一次；对「/v1/models 形状不匹配」的
/// 内核（自编译/裁剪/魔改），兜底会**每次都**打 `/sdcpp/v1/capabilities`，而该
/// 端点会触发上游全量 LoRA 递归扫描——空闲时等于每 3 秒扫一遍模型目录。
/// 连续失败 3 次后降到 30 秒最多一次，成功即清零。
struct FallbackGate {
    fails: u32,
    last_at: Option<std::time::Instant>,
}

static FALLBACK_GATE: OnceLock<std::sync::Mutex<std::collections::HashMap<u16, FallbackGate>>> =
    OnceLock::new();

const FALLBACK_FAILS_BEFORE_THROTTLE: u32 = 3;
const FALLBACK_MIN_INTERVAL: Duration = Duration::from_secs(30);

/// 现在是否允许再打一次重的 capabilities 兜底。
fn fallback_allowed(port: u16) -> bool {
    let gate = FALLBACK_GATE.get_or_init(Default::default);
    let mut map = match gate.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    let entry = map.entry(port).or_insert(FallbackGate {
        fails: 0,
        last_at: None,
    });
    if entry.fails < FALLBACK_FAILS_BEFORE_THROTTLE {
        return true;
    }
    match entry.last_at {
        Some(at) => at.elapsed() >= FALLBACK_MIN_INTERVAL,
        None => true,
    }
}

/// 记录一次兜底探测的结果（成功清零，失败累计并记时间）。
fn fallback_record(port: u16, ok: bool) {
    let gate = FALLBACK_GATE.get_or_init(Default::default);
    let mut map = match gate.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    let entry = map.entry(port).or_insert(FallbackGate {
        fails: 0,
        last_at: None,
    });
    if ok {
        entry.fails = 0;
        entry.last_at = None;
    } else {
        entry.fails = entry.fails.saturating_add(1);
        entry.last_at = Some(std::time::Instant::now());
    }
}

pub struct SdClient {
    base: String,
    http: Client,
    port: u16,
}

impl SdClient {
    pub fn new(port: u16) -> Self {
        Self {
            base: format!("http://127.0.0.1:{}", port),
            http: shared_http(),
            port,
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
            fallback_record(self.port, true);
            return true;
        }
        // 轻量探测失败：先看负缓存是否允许再打一次重的兜底（审查 10 §2.6）。
        if !fallback_allowed(self.port) {
            return false;
        }
        let req = self
            .http
            .get(format!("{}/sdcpp/v1/capabilities", self.base));
        let reachable = match req.timeout(Duration::from_secs(3)).send().await {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(v) => v.get("samplers").and_then(|s| s.as_array()).is_some(),
                Err(_) => false,
            },
            _ => false,
        };
        fallback_record(self.port, reachable);
        reachable
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
            anyhow::bail!("不支持的生成模式：{}。请切换图形/视频模式后重试。", mode);
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

    /// Stand-alone ESRGAN upscale (upstream #2026). Unlike img_gen/vid_gen this
    /// endpoint is **synchronous**: it runs the upscaler inline and returns the
    /// image, so it creates no job and cannot be polled or cancelled.
    ///
    /// The shared client's 30 s timeout is far too short here — a 4x pass over
    /// an 8K image with tiling can run for minutes — so the request carries its
    /// own, much longer deadline. The server also holds the generation context
    /// lock while upscaling, so this call can additionally wait behind a running
    /// generation without sending any bytes back.
    pub async fn upscale(&self, body: &serde_json::Value) -> Result<(u16, serde_json::Value)> {
        let resp = self
            .http
            .post(format!("{}/sdcpp/v1/upscale", self.base))
            .timeout(Duration::from_secs(UPSCALE_TIMEOUT_SECS))
            .json(body)
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
    fn fallback_gate_throttles_after_repeated_failures() {
        // 用非默认端口避免与其他用例共享全局状态。
        let port = 65535;
        assert!(fallback_allowed(port), "首次探测应放行");
        for _ in 0..FALLBACK_FAILS_BEFORE_THROTTLE {
            assert!(fallback_allowed(port));
            fallback_record(port, false);
        }
        assert!(
            !fallback_allowed(port),
            "连续失败达到阈值后应被 30s 负缓存挡住"
        );
        fallback_record(port, true);
        assert!(fallback_allowed(port), "成功后应清零并立即放行");
    }

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
        assert!(error.contains("不支持的生成模式"));
    }
}
