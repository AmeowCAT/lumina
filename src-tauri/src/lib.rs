//! sdcpp-gui backend: manages sd-server lifecycle, model scanning, settings,
//! output saving, and proxies the sd-server `/sdcpp/v1` HTTP API to the frontend
//! via typed Tauri commands.

mod family;
mod png_info;
mod save;
mod scanner;
mod sdcpp;
mod server;
mod settings;

use tauri::{Manager, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub server: Mutex<server::ServerManager>,
    pub settings: Mutex<settings::Settings>,
    pub settings_warning: Mutex<Option<settings::SettingsWarning>>,
}

/// Port every HTTP call should go to: the one a running child was launched on,
/// otherwise the configured one. Without the first branch, changing the port in
/// the dashboard would immediately misdirect calls to a server that is still
/// listening on the old port.
///
/// The two locks are taken sequentially (never held together) so this can't
/// deadlock against `start_server` / `save_settings`.
async fn effective_port(state: &AppState) -> u16 {
    let active = state.server.lock().await.active_port();
    match active {
        Some(port) => port,
        None => state.settings.lock().await.sd_port,
    }
}

/// 判断 `dir` 是否等于或在 `root` 之内。第一道是词法比较（Windows 下不
/// 区分大小写，先做 `..` 组件归一化——纯前缀比较会被 `D:/out/../evil`
/// 绕过）；第二道用 canonicalize 兜底符号链接：词法前缀拦不住输出目录内
/// 预置的 `out/link -> C:\\Windows` 这类 symlink 逃逸（审查 P3）。
/// `root` 为空时恒为 false。save_output / read_file_b64 是 webview 可调用的
/// 任意读写入口，收敛到用户配置的输出目录子树（对抗性审查 C）。
fn dir_is_within(dir: &str, root: &str) -> bool {
    let norm = |s: &str| {
        // 词法归一化：折叠 "."、弹出 ".."，再统一分隔符与大小写。
        let replaced = s.replace('\\', "/");
        let mut parts: Vec<&str> = Vec::new();
        for comp in replaced.split('/') {
            match comp {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                c => parts.push(c),
            }
        }
        let joined = parts.join("/");
        // Windows 与 macOS 默认文件系统都不区分大小写，统一小写比较；
        // Linux 保持大小写敏感。
        if cfg!(windows) || cfg!(target_os = "macos") {
            joined.to_ascii_lowercase()
        } else {
            joined
        }
    };
    let root = norm(root.trim());
    if root.is_empty() {
        return false;
    }
    let dir = norm(dir.trim());
    if !(dir == root || dir.starts_with(&format!("{}/", root))) {
        return false;
    }
    // symlink 兜底：canonicalize 两侧再比一次。dir 可能尚不存在
    // （save_output 会先 create_dir_all），此时规范化最近的已存在祖先并
    // 拼回剩余组件；canonicalize 失败（权限等）宁可拒绝。
    let canon = |raw: &str| {
        let p = std::path::Path::new(raw);
        let mut cur = p;
        let mut missing: Vec<String> = Vec::new();
        while cur.canonicalize().is_err() {
            match (cur.file_name(), cur.parent()) {
                (Some(name), Some(parent)) => {
                    missing.push(name.to_string_lossy().into_owned());
                    cur = parent;
                }
                _ => return None,
            }
        }
        let mut resolved = cur.canonicalize().ok()?;
        for comp in missing.iter().rev() {
            resolved.push(comp);
        }
        Some(resolved)
    };
    match (canon(&root), canon(&dir)) {
        (Some(rc), Some(dc)) => {
            let rc_str = rc.to_string_lossy();
            dc == rc || dc.starts_with(&format!("{}{}", rc_str, std::path::MAIN_SEPARATOR))
        }
        // root 可解析而 dir 不可解析：dir 链上有坏链接，保守拒绝。
        (Some(_), None) => false,
        // root 本身不可解析（盘符/目录尚不存在）：退回到已通过的词法结果——
        // 不存在的目录只会被 create_dir_all 新建为真实目录，无 symlink 可逃逸。
        (None, _) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::dir_is_within;

    #[test]
    fn dir_is_within_rejects_escapes() {
        assert!(dir_is_within("D:/out", "D:/out"));
        assert!(dir_is_within("D:/out/sub", "D:/out"));
        assert!(dir_is_within("D:/out/sub/deep", "D:/out"));
        // 兄弟前缀目录不算在内
        assert!(!dir_is_within("D:/out2", "D:/out"));
        // `..` 逃逸被词法归一化拦下
        assert!(!dir_is_within("D:/out/../evil", "D:/out"));
        // 空 root 一律拒绝
        assert!(!dir_is_within("D:/out", ""));
        assert!(!dir_is_within("", "D:/out"));
    }

    #[test]
    fn dir_is_within_blocks_symlink_escape() {
        // 词法比较会被 out/link -> 外部目录 的 symlink 绕过，canonicalize
        // 兜底必须拦下（审查 P3）。创建 symlink 需要额外权限（Windows 开发
        // 者模式/管理员），失败时跳过本测试（环境受限，非代码失败）。
        let base = std::env::temp_dir().join(format!(
            "lumina-within-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let out = base.join("out");
        let outside = base.join("evil");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = out.join("link");
        let ok = {
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&outside, &link).is_ok()
            }
            #[cfg(not(windows))]
            {
                std::os::unix::fs::symlink(&outside, &link).is_ok()
            }
        };
        if !ok {
            let _ = std::fs::remove_dir_all(&base);
            eprintln!("skipping symlink test: creation not permitted");
            return;
        }
        let out_str = out.to_string_lossy().to_string();
        let link_str = link.to_string_lossy().to_string();
        // 词法上 out/link 在 out 之内，但真实位置在 evil——必须拒绝。
        assert!(!dir_is_within(&link_str, &out_str));
        // 正常子目录仍放行。
        let sub = out.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(dir_is_within(
            &sub.to_string_lossy().to_string(),
            &out_str
        ));
        let _ = std::fs::remove_dir_all(&base);
    }
}

// ── sd-server lifecycle ───────────────────────────────────────────────

#[tauri::command]
async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    exe_path: String,
    model_name: String,
    mode: Option<String>,
    port: Option<u16>,
    args: serde_json::Value,
) -> Result<server::StartResult, String> {
    // The dashboard debounces its settings write, so a launch fired right after
    // editing the port would otherwise still read the previous value from disk.
    let port = match port {
        Some(port) => port,
        None => state.settings.lock().await.sd_port,
    };
    let mut srv = state.server.lock().await;
    let result = srv
        .start(&app, &exe_path, &model_name, port, mode, args)
        .await
        .map_err(|e| e.to_string())?;
    drop(srv);
    // Keep the in-memory settings coherent with what is actually running, so
    // the proxy commands resolve the right port before the debounced save lands.
    state.settings.lock().await.sd_port = port;
    Ok(result)
}

#[tauri::command]
async fn stop_server(state: State<'_, AppState>) -> Result<server::StopResult, String> {
    state
        .server
        .lock()
        .await
        .stop()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_status(state: State<'_, AppState>) -> Result<server::ServerStatus, String> {
    let mut srv = state.server.lock().await;
    let running = srv.check_alive();
    let pid = srv.pid();
    let model = srv.model().to_string();
    let last_error = srv.last_error().map(str::to_string);
    let started_at = srv.started_at();
    let active_port = srv.active_port();
    drop(srv);

    let sd_port = match active_port {
        Some(port) => port,
        None => state.settings.lock().await.sd_port,
    };

    // Always ping so we can detect an externally-launched sd-server that
    // happens to listen on the same port.  `running` only reflects a child we
    // spawned ourselves.
    let reachable = sdcpp::SdClient::new(sd_port).ping().await;
    let external = reachable && !running;
    let phase = if external {
        "external"
    } else if running && reachable {
        "ready"
    } else if running {
        "starting"
    } else if last_error.is_some() {
        "failed"
    } else {
        "stopped"
    };

    Ok(server::ServerStatus {
        running,
        reachable,
        external,
        pid,
        model,
        sd_port,
        phase: phase.into(),
        last_error,
        started_at,
    })
}

// ── model scanning ────────────────────────────────────────────────────

#[tauri::command]
async fn scan_models(dir: String) -> Result<scanner::ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scanner::scan_models(&dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Single source of truth for family detection (family.rs). The frontend used
/// to keep a parallel regex port that kept drifting from the Rust logic — it
/// now calls this instead.
#[tauri::command]
fn detect_family(path: String) -> String {
    family::detect_family(&path).to_string()
}

// ── settings ──────────────────────────────────────────────────────────

#[tauri::command]
async fn load_settings(
    state: State<'_, AppState>,
) -> Result<settings::SettingsLoadResponse, String> {
    let settings = state.settings.lock().await.clone();
    let load_warning = state.settings_warning.lock().await.clone();
    Ok(settings::SettingsLoadResponse {
        settings,
        load_warning,
    })
}

/// save_settings 的返回：运行中的子进程端口以内存为准、前端快照被覆盖时，
/// 把被保持的端口回传给前端（portKept），让控制台提示"端口修改在运行期
/// 不生效"而不是静默丢失（审查 P4b）。未发生覆盖时为 null。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsResponse {
    port_kept: Option<u16>,
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    mut settings: settings::Settings,
) -> Result<SaveSettingsResponse, String> {
    // 运行中的子进程端口以内存为准：前端携带的 Settings 快照可能还是旧端口
    // （保存防抖），直接落盘会覆盖刚更新的值，stop 后代理会连错端口。
    let active = state.server.lock().await.active_port();
    let overridden = active.filter(|port| *port != settings.sd_port);
    if let Some(port) = active {
        settings.sd_port = port;
    }
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().await = settings;
    *state.settings_warning.lock().await = None;
    Ok(SaveSettingsResponse { port_kept: overridden })
}

// ── native dialogs ────────────────────────────────────────────────────

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().replace('\\', "/")))
}

#[tauri::command]
async fn pick_file() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().replace('\\', "/")))
}

// ── output saving ─────────────────────────────────────────────────────

#[tauri::command]
async fn save_output(
    state: State<'_, AppState>,
    b64: String,
    ext: String,
    name: String,
    dir: String,
) -> Result<save::SaveResult, save::SaveCommandError> {
    // 该命令是 webview 可调用的任意写入口：目录必须位于配置的输出目录内，
    // 防止被注入脚本写到任意位置（对抗性审查 C）。
    let output_dir = state.settings.lock().await.output_dir.clone();
    if !dir_is_within(&dir, &output_dir) {
        return Err(save::SaveCommandError {
            code: "save_dir_not_allowed",
            message: "输出目录必须位于已配置的输出目录内".into(),
        });
    }
    let inner =
        tauri::async_runtime::spawn_blocking(move || save::save_output(&b64, &ext, &name, &dir))
            .await
            .map_err(|error| save::SaveCommandError {
                code: "save_worker_failed",
                message: error.to_string(),
            })?;
    inner
        .map(save::SaveResult::saved)
        .map_err(save::SaveCommandError::output)
}

#[tauri::command]
async fn save_as(
    b64: String,
    ext: String,
    name: String,
) -> Result<save::SaveResult, save::SaveCommandError> {
    match save::save_as(&b64, &ext, &name).await {
        Ok(Some(path)) => Ok(save::SaveResult::saved(path)),
        Ok(None) => Ok(save::SaveResult::cancelled()),
        Err(e) => Err(save::SaveCommandError::save_as(e)),
    }
}

// ── PNG metadata ───────────────────────────────────────────────────────

#[tauri::command]
async fn parse_png_metadata(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || match png_info::parse_png_metadata(&path) {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Ok(serde_json::Value::Null),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_output_files(dir: String) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || png_info::list_output_files(&dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_b64(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    // 与 save_output 对等：任意路径读取同样收敛到输出目录内（对抗性审查 C）。
    // 历史画廊/恢复参数只用输出目录下的文件。
    let output_dir = state.settings.lock().await.output_dir.clone();
    if !dir_is_within(&path, &output_dir) {
        return Err("文件必须位于已配置的输出目录内".into());
    }
    use base64::Engine;
    use std::fs;
    tauri::async_runtime::spawn_blocking(move || {
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&data))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── sd-server API passthrough ─────────────────────────────────────────

/// Filter the `loras` list in the capabilities JSON so that when a
/// structured layout (`loras/` or `lora/` under the model directory)
/// exists, only LoRA files inside that directory are shown.  Otherwise
/// the list passes through unchanged (the server's default behaviour).
///
/// NOTE: the server returns *relative* paths (e.g. `loras/foo.sft`) in the
/// `path` field, so we match against the directory name + `/` prefix.
fn filter_caps_loras(caps: &mut serde_json::Value, model_dir: &str) {
    use std::path::PathBuf;

    let base = PathBuf::from(model_dir);
    if !base.is_dir() {
        return;
    }
    // Pick the first existing dedicated LoRA directory and extract its name.
    let lora_dir = scanner::find_dir(&base, &["loras", "lora"]);
    let dir_name = match lora_dir.as_ref().and_then(|d| d.file_name()) {
        Some(n) => n.to_string_lossy().to_string(),
        None => return,
    };
    let prefix = format!("{}/", dir_name); // e.g. "loras/"

    if let Some(arr) = caps.get_mut("loras").and_then(|v| v.as_array_mut()) {
        arr.retain(|entry| {
            entry
                .get("path")
                .and_then(|p| p.as_str())
                .map(|p| p.replace('\\', "/").starts_with(&prefix))
                .unwrap_or(true)
        });
    }
}

#[tauri::command]
async fn sdcpp_capabilities(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = effective_port(&state).await;
    let mut caps = sdcpp::SdClient::new(port)
        .capabilities()
        .await
        .map_err(|e| e.to_string())?;

    let model_dir = state.settings.lock().await.model_dir.clone();
    filter_caps_loras(&mut caps, &model_dir);

    Ok(caps)
}

#[tauri::command]
async fn sdcpp_submit(
    state: State<'_, AppState>,
    mode: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = effective_port(&state).await;
    let (status, body) = sdcpp::SdClient::new(port)
        .submit(&mode, &body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[tauri::command]
async fn sdcpp_job(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let port = effective_port(&state).await;
    let (status, body) = sdcpp::SdClient::new(port)
        .job(&id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[tauri::command]
async fn sdcpp_cancel(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let port = effective_port(&state).await;
    let (status, body) = sdcpp::SdClient::new(port)
        .cancel(&id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

// ── entry ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();
    let loaded_settings = settings::Settings::load();
    tauri::Builder::default()
        .manage(AppState {
            server: Mutex::new(server::ServerManager::new()),
            settings: Mutex::new(loaded_settings.settings),
            settings_warning: Mutex::new(loaded_settings.warning),
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            server_status,
            scan_models,
            detect_family,
            load_settings,
            save_settings,
            pick_folder,
            pick_file,
            save_output,
            save_as,
            parse_png_metadata,
            list_output_files,
            read_file_b64,
            sdcpp_capabilities,
            sdcpp_submit,
            sdcpp_job,
            sdcpp_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出前强制停止 sd-server：释放显存，避免后台残留进程。
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut server = state.server.blocking_lock();
                    server.kill();
                }
            }
        });
}
