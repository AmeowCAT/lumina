use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

/// Historical sd-server port, kept as the fallback when nothing is configured.
pub const DEFAULT_SD_PORT: u16 = 1234;

/// Reject ports the launcher can't realistically bind to. Port 0 would make the
/// OS pick a random one (we'd never know where to proxy), and <1024 needs
/// elevation on Unix — both fail far less legibly at spawn time than here.
pub fn validate_port(port: u16) -> Result<u16> {
    if port < 1024 {
        anyhow::bail!("端口 {} 不可用，请使用 1024–65535 之间的端口", port);
    }
    Ok(port)
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub reachable: bool,
    /// true when an sd-server is responding on the configured port but wasn't
    /// started by us
    pub external: bool,
    pub pid: Option<u32>,
    pub model: String,
    pub sd_port: u16,
    /// stopped / starting / ready / external / failed
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub pid: u32,
    pub phase: String,
    pub executable: String,
    pub sd_port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    pub stopped: bool,
    pub already_stopped: bool,
    pub pid: Option<u32>,
}

pub struct ServerManager {
    child: Option<Child>,
    model: String,
    executable: String,
    /// Port the currently-running child was launched on. `None` when no child
    /// of ours is alive — callers then fall back to the configured port.
    port: Option<u16>,
    last_error: Option<String>,
    started_at: Option<u64>,
}

fn format_num(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(f) = n.as_f64() {
        if f == f.trunc() {
            return format!("{}", f as i64);
        }
        return format!("{}", f);
    }
    n.to_string()
}

/// Split a string into shell-like tokens supporting double-quote ("") and
/// single-quote ('') escaping.
fn split_args(input: &str) -> Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;
    for ch in input.chars() {
        match ch {
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            c if c.is_whitespace() && !in_double && !in_single => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if in_double || in_single {
        anyhow::bail!("extra_args contains an unclosed quote");
    }
    Ok(tokens)
}

fn validate_path_arg(key: &str, value: &str) -> Result<()> {
    let path = Path::new(value);
    let looks_like_path = key.ends_with("-dir")
        || key.ends_with("_dir")
        || path.is_absolute()
        || value.contains('/')
        || value.contains('\\')
        || path.extension().is_some();
    if !looks_like_path {
        return Ok(());
    }
    if !path.exists() {
        anyhow::bail!("--{} path does not exist: {}", key, value);
    }
    if (key.ends_with("-dir") || key.ends_with("_dir")) && !path.is_dir() {
        anyhow::bail!("--{} expects a directory: {}", key, value);
    }
    Ok(())
}

fn build_args(args: &serde_json::Value, port: u16) -> Result<Vec<String>> {
    let mut out = vec![
        "--listen-port".into(),
        port.to_string(),
        "--listen-ip".into(),
        "127.0.0.1".into(),
    ];
    if let Some(obj) = args.as_object() {
        for (key, val) in obj {
            if key == "extra_args" {
                if let Some(s) = val.as_str() {
                    for t in split_args(s)? {
                        // The launcher owns the listen address: it proxies every
                        // API call to `port`, so an override buried in the extra
                        // args would silently point sd-server somewhere the GUI
                        // never talks to.
                        if t == "--listen-port" || t == "--listen-ip" {
                            anyhow::bail!(
                                "附加启动参数不能包含 {}，请在控制台的“启动端口”中修改",
                                t
                            );
                        }
                        out.push(t);
                    }
                }
                continue;
            }
            match val {
                serde_json::Value::Bool(b) => {
                    if *b {
                        out.push(format!("--{}", key));
                    }
                }
                serde_json::Value::String(s) => {
                    if !s.is_empty() {
                        validate_path_arg(key, s)?;
                        out.push(format!("--{}", key));
                        out.push(s.clone());
                    }
                }
                serde_json::Value::Number(n) => {
                    out.push(format!("--{}", key));
                    out.push(format_num(n));
                }
                serde_json::Value::Array(arr) => {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            validate_path_arg(key, s)?;
                            out.push(format!("--{}", key));
                            out.push(s.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 {
        return None;
    }
    let path = env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        if cfg!(windows) && candidate.extension().is_none() {
            for extension in &extensions {
                let with_extension = dir.join(format!("{}{}", name, extension));
                if with_extension.is_file() {
                    return Some(with_extension);
                }
            }
        }
    }
    None
}

fn resolve_executable(exe_path: &str) -> Result<PathBuf> {
    let binary_name = if cfg!(windows) {
        "sd-server.exe"
    } else {
        "sd-server"
    };
    let input = exe_path.trim();
    let path = if input.is_empty() {
        find_in_path(binary_name).ok_or_else(|| anyhow!("sd-server not found in PATH"))?
    } else {
        let path = PathBuf::from(input);
        if path.is_file() {
            path
        } else if path.is_dir() {
            path.join(binary_name)
        } else if let Some(found) = find_in_path(input) {
            found
        } else {
            path
        }
    };
    let executable = path
        .canonicalize()
        .map_err(|error| anyhow!("sd-server not found: {} ({})", path.display(), error))?;
    if !executable.is_file() {
        anyhow::bail!("sd-server not found: {}", executable.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable.metadata()?.permissions().mode() & 0o111 == 0 {
            anyhow::bail!("sd-server is not executable: {}", executable.display());
        }
    }
    Ok(executable)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            child: None,
            model: String::new(),
            executable: String::new(),
            port: None,
            last_error: None,
            started_at: None,
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Port of the child we launched, if one is still tracked.
    pub fn active_port(&self) -> Option<u16> {
        self.child.as_ref().and(self.port)
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(|c| c.id())
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn started_at(&self) -> Option<u64> {
        self.started_at
    }

    /// Forget everything tied to a child process that is no longer running.
    fn clear_child_state(&mut self) {
        self.child = None;
        self.model.clear();
        self.executable.clear();
        self.port = None;
        self.started_at = None;
    }

    /// Non-blocking liveness check; reaps the child if it has exited.
    pub fn check_alive(&mut self) -> bool {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        self.last_error = Some(format!("sd-server exited with status {}", status));
                    }
                    self.clear_child_state();
                    false
                }
                Ok(None) => true,
                Err(error) => {
                    self.last_error = Some(format!("failed to query sd-server status: {}", error));
                    false
                }
            }
        } else {
            false
        }
    }

    pub async fn stop(&mut self) -> Result<StopResult> {
        let Some(child) = self.child.as_mut() else {
            self.clear_child_state();
            return Ok(StopResult {
                stopped: true,
                already_stopped: true,
                pid: None,
            });
        };
        let pid = child.id();
        if let Some(status) = child
            .try_wait()
            .context("query sd-server before stopping")?
        {
            self.clear_child_state();
            if !status.success() {
                self.last_error = Some(format!("sd-server exited with status {}", status));
            }
            return Ok(StopResult {
                stopped: true,
                already_stopped: true,
                pid,
            });
        }

        child
            .start_kill()
            .context("request sd-server termination")?;
        match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
            Ok(Ok(status)) => {
                log::info!("sd-server stopped with status {}", status);
            }
            Ok(Err(error)) => {
                self.last_error = Some(format!("failed to wait for sd-server: {}", error));
                return Err(error).context("wait for sd-server termination");
            }
            Err(_) => {
                self.last_error = Some("timed out waiting for sd-server to stop".into());
                anyhow::bail!("timed out waiting for sd-server to stop");
            }
        }
        self.clear_child_state();
        self.last_error = None;
        Ok(StopResult {
            stopped: true,
            already_stopped: false,
            pid,
        })
    }

    pub async fn start(
        &mut self,
        app: &AppHandle,
        exe_path: &str,
        model_name: &str,
        port: u16,
        _mode: Option<String>,
        args: serde_json::Value,
    ) -> Result<StartResult> {
        // Validate the new launch completely before unloading the current model.
        let port = validate_port(port)?;
        let exe = resolve_executable(exe_path)?;
        let cmd_args = build_args(&args, port)?;
        self.stop().await?;

        // A listener that is not our previous child would make the new process
        // fail immediately with a much less actionable log message.
        let port_guard = TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
            anyhow!(
                "端口 {} 已被占用，请先停止占用它的进程或改用其他端口（{}）",
                port,
                error
            )
        })?;
        drop(port_guard);

        log::info!(
            "Starting sd-server: {} {}",
            exe.display(),
            cmd_args.join(" ")
        );

        let mut command = Command::new(&exe);
        command.current_dir(exe.parent().unwrap_or(Path::new(".")));
        command.args(&cmd_args);
        command.stdin(Stdio::null());
        // Pipe instead of inherit: inheriting pops a cmd console window on
        // Windows. We stream the lines to the frontend `server-log` event so
        // they render in the in-app log panel, not an external console.
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        // Windows: sd-server 是控制台程序，即便 stdout/stderr 已 pipe，系统仍会
        // 为它创建一个控制台窗口（弹出的黑框）。CREATE_NO_WINDOW 抑制该窗口，
        // 日志已通过上面的 pipe 接管到 GUI 内的日志面板。
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| anyhow!("failed to start {}: {}", exe.display(), e))?;
        let pid = child.id().ok_or_else(|| anyhow!("no pid"))?;

        // Start log readers BEFORE storing the child — this minimises the window
        // where the process could exit and close pipes before readers attach.
        spawn_log_reader(app.clone(), child.stdout.take());
        spawn_log_reader(app.clone(), child.stderr.take());

        self.child = Some(child);
        self.model = model_name.to_string();
        self.executable = exe.to_string_lossy().to_string();
        self.port = Some(port);
        self.started_at = Some(now_epoch_seconds());
        self.last_error = None;

        // Post-spawn health check: wait a short grace period then verify the
        // process hasn't already exited.  Catches immediate crashes (bad model
        // path, missing DLL, port conflict, …) and surfaces them to the user as
        // an error instead of silently falling back to the next 3 s poll.
        tokio::time::sleep(Duration::from_millis(400)).await;
        if !self.check_alive() {
            return Err(anyhow!(
                "sd-server 启动后立即退出，请查看日志面板中的错误信息"
            ));
        }

        Ok(StartResult {
            pid,
            phase: "starting".into(),
            executable: self.executable.clone(),
            sd_port: port,
        })
    }

    /// Synchronous forced kill — used on app exit where we can't `.await`.
    /// Terminating the sd-server process is what actually releases its GPU
    /// VRAM, so this is the "unload model" step before the GUI shuts down.
    pub fn kill(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
        self.clear_child_state();
        log::info!("sd-server killed");
    }
}

// ── ANSI escape sequence stripping ─────────────────────────────────────

/// Strips ANSI CSI (Control Sequence Introducer) escape sequences from a string.
/// Handles sequences like `\x1b[K`, `\x1b[31m`, `\x1b[0;1;34m`, etc.
///
/// Iterates by `char` (not by byte): a byte-wise `as char` reinterprets every
/// multibyte UTF-8 sequence as Latin-1, turning Chinese/non-ASCII log text
/// (model names, prompts, paths) into mojibake.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
                          // Consume parameter bytes (digits, semicolons)
            while let Some(&p) = chars.peek() {
                if p.is_ascii_digit() || p == ';' {
                    chars.next();
                } else {
                    break;
                }
            }
            // Consume final byte (letter)
            chars.next();
        } else {
            result.push(c);
        }
    }
    result
}

// ── Log pipeline ───────────────────────────────────────────────────────

/// Process a single line (terminated by `\n`, or the final flush at EOF) and
/// emit `server-log` events.  A line may contain `\r`-separated segments: all
/// but the last are `progress` (the UI replaces the previous line in place),
/// the final segment is `line` (the UI appends it).  ANSI escapes are stripped
/// from every segment before emission.
fn emit_line(app: &AppHandle, line: &str) {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return;
    }
    let parts: Vec<&str> = trimmed.split('\r').collect();
    let last = parts.len().saturating_sub(1);
    for (i, part) in parts.iter().enumerate() {
        let t = part.trim();
        if t.is_empty() {
            continue;
        }
        let clean = strip_ansi(t);
        if clean.is_empty() {
            continue;
        }
        let kind = if i == last { "line" } else { "progress" };
        let _ = app.emit(
            "server-log",
            serde_json::json!({ "type": kind, "text": clean }),
        );
    }
}

/// Streams a piped child output to the frontend `server-log` event.
///
/// Uses raw `read` (not `read_line`) so that `\r`-only progress updates from
/// sd-server's `print_progress_line` are pushed to the UI immediately instead
/// of being stuck in BufReader's internal buffer waiting for the next `\n`.
///
/// Algorithm:
/// 1. Read chunks into a pending buffer.
/// 2. Drain every `\n`-terminated *complete line* through `emit_line`.
/// 3. If the remaining partial data contains `\r`, emit the text after the
///    *last* `\r` as a progress update — this is the current in-place state.
/// 4. On EOF, flush whatever is left as a final line.
fn spawn_log_reader<R>(app: AppHandle, out: Option<R>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let Some(mut out) = out else { return };
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 4096];
        // Raw bytes not yet decoded: a multibyte UTF-8 char may straddle two
        // reads, so the trailing incomplete bytes are held here until completed.
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut pending = String::new();
        loop {
            match out.read(&mut buf).await {
                Ok(0) => {
                    // EOF — decode whatever bytes remain (lossily) and flush.
                    if !byte_buf.is_empty() {
                        pending.push_str(&String::from_utf8_lossy(&byte_buf));
                        byte_buf.clear();
                    }
                    if !pending.is_empty() {
                        emit_line(&app, &pending);
                    }
                    break;
                }
                Ok(n) => {
                    byte_buf.extend_from_slice(&buf[..n]);
                    // Decode the longest valid UTF-8 prefix; keep any trailing
                    // incomplete char for the next read so it isn't corrupted
                    // into a U+FFFD replacement at the chunk boundary.
                    let consumed = match std::str::from_utf8(&byte_buf) {
                        Ok(s) => {
                            pending.push_str(s);
                            byte_buf.len()
                        }
                        Err(e) => {
                            let valid = e.valid_up_to();
                            if valid > 0 {
                                pending.push_str(
                                    std::str::from_utf8(&byte_buf[..valid]).unwrap_or(""),
                                );
                            }
                            match e.error_len() {
                                // Genuinely invalid sequence: emit U+FFFD, skip it.
                                Some(bad) => {
                                    pending.push('\u{FFFD}');
                                    valid + bad
                                }
                                // Incomplete trailing char: wait for more bytes.
                                None => valid,
                            }
                        }
                    };
                    byte_buf.drain(..consumed);

                    // Drain complete lines (delimited by \n)
                    while let Some(pos) = pending.find('\n') {
                        let line: String = pending.drain(..=pos).collect();
                        emit_line(&app, &line);
                    }

                    // Partial progress: content after the last \r is the
                    // current in-place state.  Emit it as a progress update so
                    // the UI shows real-time feedback even when no \n has
                    // arrived yet.
                    if !pending.is_empty() {
                        if let Some(pos) = pending.rfind('\r') {
                            let after_cr = pending[pos..].trim_start_matches('\r');
                            if !after_cr.is_empty() {
                                let clean = strip_ansi(after_cr);
                                if !clean.is_empty() {
                                    let _ = app.emit(
                                        "server-log",
                                        serde_json::json!({ "type": "progress", "text": clean }),
                                    );
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_args_rejects_unclosed_quotes() {
        assert!(split_args("--foo \"unterminated").is_err());
        assert_eq!(
            split_args("--foo \"two words\" --bar 'three words'").unwrap(),
            vec!["--foo", "two words", "--bar", "three words"]
        );
    }

    #[test]
    fn build_args_rejects_missing_path_before_start() {
        let missing = std::env::temp_dir().join(format!(
            "lumina-missing-model-{}-{}.gguf",
            std::process::id(),
            now_epoch_seconds()
        ));
        let args = serde_json::json!({ "model": missing.to_string_lossy() });
        let error = build_args(&args, DEFAULT_SD_PORT).unwrap_err().to_string();
        assert!(error.contains("path does not exist"));
    }

    #[test]
    fn build_args_keeps_compatible_cli_shape() {
        let args = serde_json::json!({
            "backend": "cuda",
            "offload-to-cpu": true,
            "disabled": false,
            "extra_args": "--verbose --threads 4"
        });
        assert_eq!(
            build_args(&args, DEFAULT_SD_PORT).unwrap(),
            vec![
                "--listen-port",
                "1234",
                "--listen-ip",
                "127.0.0.1",
                "--backend",
                "cuda",
                "--verbose",
                "--threads",
                "4",
                "--offload-to-cpu",
            ]
        );
    }

    #[test]
    fn build_args_uses_the_configured_port() {
        let args = serde_json::json!({});
        assert_eq!(
            build_args(&args, 8188).unwrap(),
            vec!["--listen-port", "8188", "--listen-ip", "127.0.0.1"]
        );
    }

    #[test]
    fn build_args_rejects_a_listen_override_in_extra_args() {
        let args = serde_json::json!({ "extra_args": "--listen-port 9000" });
        let error = build_args(&args, 1234).unwrap_err().to_string();
        assert!(error.contains("--listen-port"));

        let args = serde_json::json!({ "extra_args": "--listen-ip 0.0.0.0" });
        assert!(build_args(&args, 1234).is_err());
    }

    #[test]
    fn validate_port_rejects_privileged_and_zero_ports() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(80).is_err());
        assert!(validate_port(1023).is_err());
        assert_eq!(validate_port(1024).unwrap(), 1024);
        assert_eq!(validate_port(DEFAULT_SD_PORT).unwrap(), 1234);
        assert_eq!(validate_port(65535).unwrap(), 65535);
    }
}
