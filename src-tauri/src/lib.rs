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

// ── sd-server lifecycle ───────────────────────────────────────────────

#[tauri::command]
async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    exe_path: String,
    model_name: String,
    mode: Option<String>,
    args: serde_json::Value,
) -> Result<server::StartResult, String> {
    let mut srv = state.server.lock().await;
    srv.start(&app, &exe_path, &model_name, mode, args)
        .await
        .map_err(|e| e.to_string())
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
    drop(srv);

    // Always ping so we can detect an externally-launched sd-server that
    // happens to listen on the same port.  `running` only reflects a child we
    // spawned ourselves.
    let reachable = sdcpp::SdClient::new(server::SD_PORT).ping().await;
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
        sd_port: server::SD_PORT,
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

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    settings: settings::Settings,
) -> Result<(), String> {
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().await = settings;
    *state.settings_warning.lock().await = None;
    Ok(())
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
    b64: String,
    ext: String,
    name: String,
    dir: String,
) -> Result<save::SaveResult, save::SaveCommandError> {
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
async fn read_file_b64(path: String) -> Result<String, String> {
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
    let mut caps = sdcpp::SdClient::new(server::SD_PORT)
        .capabilities()
        .await
        .map_err(|e| e.to_string())?;

    let model_dir = state.settings.lock().await.model_dir.clone();
    filter_caps_loras(&mut caps, &model_dir);

    Ok(caps)
}

#[tauri::command]
async fn sdcpp_submit(mode: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let (status, body) = sdcpp::SdClient::new(server::SD_PORT)
        .submit(&mode, &body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[tauri::command]
async fn sdcpp_job(id: String) -> Result<serde_json::Value, String> {
    let (status, body) = sdcpp::SdClient::new(server::SD_PORT)
        .job(&id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[tauri::command]
async fn sdcpp_cancel(id: String) -> Result<serde_json::Value, String> {
    let (status, body) = sdcpp::SdClient::new(server::SD_PORT)
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
