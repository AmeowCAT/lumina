use crate::args::*;
use crate::log_pipe::{emit_line, spawn_log_reader};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
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
    /// Windows: KILL_ON_JOB_CLOSE 作业对象，随 child 一起创建/清理。
    #[cfg(windows)]
    job: Option<JobGuard>,
    /// Unix: 非 Linux 平台的“父死看门狗”（sh 进程，见 spawn_unix_watchdog），
    /// 随 child 一起创建/清理。
    #[cfg(unix)]
    watchdog: Option<std::process::Child>,
}

/// Inspect without loading a model or stopping the running server.
pub async fn inspect_cli(exe_path: &str) -> Result<crate::cli::CliCapabilities> {
    let exe = resolve_executable(exe_path)?;
    Ok(crate::cli::probe(&exe).await)
}

/// Used before the frontend unloads a model during a switch. The authoritative
/// validation is repeated by start(), using the same short-lived probe cache.
pub async fn preflight_cli(
    exe_path: &str,
    args: &serde_json::Value,
    port: u16,
) -> Result<crate::cli::CliCapabilities> {
    let mut args = args.clone();
    let mut capabilities = inspect_cli(exe_path).await?;
    let flash_attn_warning = adapt_flash_attn_for_kernel(&mut args, &capabilities);
    let cmd_args = build_args(&args, validate_port(port)?)?;
    capabilities.warnings.extend(flash_attn_warning);
    capabilities
        .warnings
        .extend(crate::cli::validate_args(&cmd_args, &capabilities)?);
    Ok(capabilities)
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
        find_in_path(binary_name).ok_or_else(|| {
            anyhow!("找不到 sd-server：PATH 里没有该可执行文件。请在控制台指定内核路径")
        })?
    } else {
        let path = PathBuf::from(input);
        if path.is_file() {
            // 文件名身份校验上移到 start()：先按名快速放行，名字不符再回退
            // --list-devices 探测验证（防止把任意可执行文件当 sd-server
            // 启动，同时不破坏"重命名二进制"的老配置——审查 P4a）。
            path
        } else if path.is_dir() {
            path.join(binary_name)
        } else if let Some(found) = find_in_path(input) {
            found
        } else {
            path
        }
    };
    let executable = path.canonicalize().map_err(|error| {
        anyhow!(
            "找不到 sd-server：{}（{}）。请检查路径是否正确。",
            path.display(),
            error
        )
    })?;
    if !executable.is_file() {
        anyhow::bail!(
            "找不到 sd-server 可执行文件：{}。请在控制台重新选择内核路径。",
            executable.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable.metadata()?.permissions().mode() & 0o111 == 0 {
            anyhow::bail!("sd-server 没有执行权限：{}。请检查文件权限（Linux/macOS 可用 chmod +x）或重新解压。", executable.display());
        }
    }
    Ok(executable)
}

/// 显式路径的快速身份校验：文件名以 sd-server 开头（Windows 不区分大小
/// 写）。不匹配时由 start() 里的 `--list-devices` 探测兜底验证（审查 P4a）。
fn exe_name_looks_like_sd_server(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if cfg!(windows) {
        name.to_ascii_lowercase().starts_with("sd-server")
    } else {
        name.starts_with("sd-server")
    }
}

/// 能否跳过 `--list-devices` 身份探测（start() 的快速通道）。
///
/// 只看文件名会留下「任意写 → 任意执行」链：`save_settings` 能把白名单根
/// `output_dir` 指向启动项，`save_output` 再往那里落一个 `sd-server.exe`，
/// 随后 `start_server` 按文件名放行（审查 S-2）。因此配置了内核目录
/// （`settings.exe_dir`）时，还要求二进制位于该目录子树内；`exe_dir` 为空
/// （老配置 / PATH 查找）时保留仅按文件名放行的历史行为。
///
/// 两侧都规范化后再比：配置里存的是 `D:/sd-cpp`（正斜杠），而这里拿到的是
/// `resolve_executable` canonicalize 过的 verbatim 路径，直接比较恒为 false。
fn exe_trusted_without_probe(exe: &Path, exe_dir: &str) -> bool {
    if !exe_name_looks_like_sd_server(exe) {
        return false;
    }
    let dir = exe_dir.trim();
    if dir.is_empty() {
        return true;
    }
    match std::fs::canonicalize(dir) {
        // `starts_with` 按路径分量比较：`D:/sd-cpp2` 不会匹配 `D:/sd-cpp`。
        Ok(root) => exe.starts_with(&root),
        // 配置的目录已不存在（换盘/被删）：不按名字放行，回退到探测。
        Err(_) => false,
    }
}

/// `--list-devices` 输出形状判定：至少一行 `name<TAB>description` 且 name
/// 非空。只有 sd-server 系二进制支持该参数并打印该格式，任意可执行文件
/// 被误当 sd-server 启动的概率可忽略（审查 P4a）。
fn device_list_looks_plausible(output: &str) -> bool {
    output.lines().any(|line| {
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("").trim();
        !name.is_empty() && parts.next().is_some()
    })
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 探测 sd-server 编译进了哪些 ggml 后端（`--list-devices` 打印
/// "name<TAB>description" 后退出 0）。返回 None 表示二进制不支持该参数
/// （旧版本）或探测失败——此时跳过校验，维持旧行为。
fn probe_backend_devices(exe: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--list-devices");
    cmd.current_dir(exe.parent().unwrap_or_else(|| Path::new(".")));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Windows Job Object：把 sd-server 挂进带 KILL_ON_JOB_CLOSE 的作业对象。
/// GUI 正常退出前会主动 kill；若 GUI 崩溃/被任务管理器强杀/断电，作业句柄
/// 随进程关闭，OS 兜底终止 sd-server——否则孤儿进程会长期占用显存
/// （对抗性审查 C）。挂接失败（如父进程已在受限作业中）时静默降级。
#[cfg(windows)]
struct JobGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl JobGuard {
    /// 用 pid 经 OpenProcess 取进程句柄（tokio Child 不暴露 as_raw_handle，
    /// 而 AssignProcessToJobObject 需要真实句柄）。挂接失败静默降级。
    fn attach(pid: u32) -> Option<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        unsafe {
            let name: Vec<u16> = format!("lumina-sd-server-{}", pid)
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let job = CreateJobObjectW(std::ptr::null(), name.as_ptr());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Self { handle: job })
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

// HANDLE 是裸指针（*mut c_void），不自动实现 Send/Sync。JobGuard 只经
// ServerManager 的 tokio Mutex 访问、Drop 只执行一次 CloseHandle，
// 跨线程移动/共享是安全的。
#[cfg(windows)]
unsafe impl Send for JobGuard {}
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

// ── Unix: 孤儿进程防护 ──────────────────────────────────────────────
// Windows 已由 JobObject KILL_ON_JOB_CLOSE 兜底；macOS/Linux 没有等价机制，
// GUI 崩溃/被强杀时 sd-server 可能成为孤儿进程继续占用显存。
// - Linux：pre_exec 设置 PR_SET_PDEATHSIG(SIGKILL)——父进程（GUI）退出时
//   内核直接向 sd-server 发 SIGKILL，不留窗口。
// - 其他 Unix：内核无等价机制，额外起一个极小的 sh 看门狗进程定期探测
//   父进程是否存活，父进程没了就终止 sd-server。
// - 所有 Unix：sd-server 放进独立进程组，正常退出时按组 SIGKILL 连带清理
//   后代；同时隔离终端 Ctrl+C 对 sd-server 的误杀。

/// 在 spawn 前配置 Unix 子进程：独立进程组 +（Linux）父死信号。
#[cfg(unix)]
fn prepare_unix_child_command(cmd: &mut Command, parent_pid: u32) {
    // process_group(0)：子进程 pgid 取自身 pid（tokio/std 语义），独立成组。
    cmd.process_group(0);
    unsafe {
        cmd.pre_exec(move || {
            #[cfg(target_os = "linux")]
            {
                // 标准模式：设置父死信号后再校验一次 ppid，处理“设置完成前
                // 父进程已死”的竞态；已孤儿则自杀。
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent_pid as libc::pid_t {
                    std::process::exit(1);
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = parent_pid;
            }
            Ok(())
        });
    }
}

/// 按进程组 SIGKILL（组 id 即子进程 pid，process_group(0) 时成立）。
/// 进程组已不存在时 ESRCH，忽略即可。
#[cfg(unix)]
fn kill_unix_process_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

/// 非 Linux Unix 的父死看门狗：`sh -c` 每 2s 探测父进程存活，父死则
/// SIGKILL sd-server。macOS/BSD 均自带 POSIX sh；spawn 失败（极简环境）
/// 时静默降级，不影响启动本身。Linux 走内核 PDEATHSIG，不重复。
#[cfg(unix)]
fn spawn_unix_watchdog(parent_pid: u32, child_pid: u32) -> Option<std::process::Child> {
    #[cfg(not(target_os = "linux"))]
    {
        let script = "p=$1; c=$2; while kill -0 \"$p\" 2>/dev/null; do sleep 2; done; kill -9 \"$c\" 2>/dev/null";
        return std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .arg("lumina-pdeath")
            .arg(parent_pid.to_string())
            .arg(child_pid.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (parent_pid, child_pid);
        None
    }
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
            #[cfg(windows)]
            job: None,
            #[cfg(unix)]
            watchdog: None,
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
    /// On Windows the Job handle is dropped here — if the child is somehow
    /// still alive (kill issued but not yet reaped), KILL_ON_JOB_CLOSE makes
    /// the OS finish the job as the handle closes.
    fn clear_child_state(&mut self) {
        self.child = None;
        self.model.clear();
        self.executable.clear();
        self.port = None;
        self.started_at = None;
        #[cfg(windows)]
        {
            self.job = None;
        }
        #[cfg(unix)]
        {
            // 看门狗随子进程状态一起清：父进程仍在时它不能后台空转；
            // 更重要的是父进程退出后不能再让它去 kill 已被复用的旧 pid。
            if let Some(mut watchdog) = self.watchdog.take() {
                let _ = watchdog.kill();
                let _ = watchdog.wait();
            }
        }
    }

    /// Non-blocking liveness check; reaps the child if it has exited.
    pub fn check_alive(&mut self) -> bool {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        self.last_error = Some(format!("sd-server 已退出，状态 {}", status));
                    }
                    self.clear_child_state();
                    false
                }
                Ok(None) => true,
                Err(error) => {
                    self.last_error = Some(format!("查询 sd-server 状态失败：{}", error));
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
        if let Some(status) = child.try_wait().context("停止前查询 sd-server 状态失败")? {
            self.clear_child_state();
            if !status.success() {
                self.last_error = Some(format!("sd-server 已退出，状态 {}", status));
            }
            return Ok(StopResult {
                stopped: true,
                already_stopped: true,
                pid,
            });
        }

        child.start_kill().context("请求 sd-server 退出失败")?;
        #[cfg(unix)]
        if let Some(pid) = pid {
            kill_unix_process_group(pid);
        }
        match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
            Ok(Ok(status)) => {
                log::info!("sd-server stopped with status {}", status);
                crate::logging::info("app", &format!("sd-server 已退出，状态 {}", status));
            }
            Ok(Err(error)) => {
                self.last_error = Some(format!("failed to wait for sd-server: {}", error));
                return Err(error).context("等待 sd-server 退出失败");
            }
            Err(_) => {
                // start_kill 是 TerminateProcess/SIGKILL，进程不可抗拒；超时
                // 说明它陷在不可中断的内核态。释放跟踪状态让下次 start 的
                // 端口检查给出真实原因（"端口被占用"），而不是永远卡在
                // "停止不下来"（对抗性审查 C）。
                self.last_error =
                    Some("timed out waiting for sd-server to stop; termination was forced".into());
                self.clear_child_state();
                anyhow::bail!("sd-server 未在 10 秒内退出，已强制终止；如端口仍被占用请稍后重试");
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

    // 8 个参数是启动面本身（app/可执行/内核目录/模型/端口/模式/参数），
    // 收成结构体只会把同一组字段搬一次家；身份校验需要的 `exe_dir` 必须
    // 和 `exe_path` 一起传进来（审查 S-2），因此这里放行 lint。
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &mut self,
        app: &AppHandle,
        exe_path: &str,
        exe_dir: &str,
        model_name: &str,
        port: u16,
        _mode: Option<String>,
        args: serde_json::Value,
    ) -> Result<StartResult> {
        // Validate the new launch completely before unloading the current model.
        let port = validate_port(port)?;
        let exe = resolve_executable(exe_path)?;
        let mut args_json = args;
        refine_component_dirs(&mut args_json);
        let backend_spec = args_json
            .get("backend")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        // 结构化参数与附加启动参数（extra_args）统一预检：`--backend cuda999`
        // 或 `--max-vram not-a-number` 写在自由文本里同样会原样传给
        // sd-server 并让启动即退，必须在 GUI 侧拦下。
        let extra_tokens = args_json
            .get("extra_args")
            .and_then(|v| v.as_str())
            .map(split_args)
            .transpose()?
            .unwrap_or_default();
        let extra_backend_specs = extra_arg_values(&extra_tokens, &["backend", "b"]);
        if let Some(max_vram) = args_json.get("max-vram").and_then(|v| v.as_str()) {
            validate_max_vram_spec(max_vram)
                .map_err(|e| anyhow!("显存预算（--max-vram）格式无效：{}", e))?;
        }
        // 结构化 --params-backend / --rpc-servers 与附加启动参数同口径预检：
        // 前者形状错误会让内核启动即退，后者写错的端口不报错、只是加不上设备
        // （上游 add_rpc_devices 只打日志），GUI 侧提前给出可读错误。
        if let Some(spec) = args_json.get("params-backend").and_then(|v| v.as_str()) {
            if let Some(error) = params_backend_spec_error(spec) {
                anyhow::bail!(error);
            }
        }
        if let Some(spec) = args_json.get("rpc-servers").and_then(|v| v.as_str()) {
            if let Some(error) = rpc_servers_spec_error(spec) {
                anyhow::bail!(error);
            }
        }
        for spec in extra_arg_values(&extra_tokens, &["params-backend"]) {
            if let Some(error) = params_backend_spec_error(&spec) {
                anyhow::bail!("附加启动参数中的 {}", error);
            }
        }
        for spec in extra_arg_values(&extra_tokens, &["rpc-servers"]) {
            if let Some(error) = rpc_servers_spec_error(&spec) {
                anyhow::bail!("附加启动参数中的 {}", error);
            }
        }
        for spec in &extra_backend_specs {
            if let Some(error) = backend_spec_static_error(spec) {
                anyhow::bail!("附加启动参数中的 --backend 无效：{}", error);
            }
        }
        for spec in extra_arg_values(&extra_tokens, &["max-vram"]) {
            validate_max_vram_spec(&spec)
                .map_err(|e| anyhow!("附加启动参数中的 --max-vram 格式无效：{}", e))?;
        }
        // Validate against this executable before unloading the current model.
        // Unknown help is a warning, not proof that an old executable lacks a flag.
        // The probe has to run before build_args: the structured --flash-attn
        // argument falls back to --fa / --diffusion-fa on kernels predating
        // upstream #2132 (the flag itself does not exist there).
        let cli = crate::cli::probe(&exe).await;
        let flash_attn_warning = adapt_flash_attn_for_kernel(&mut args_json, &cli);
        let cmd_args = build_args(&args_json, port)?;
        let compatibility_warnings = crate::cli::validate_args(&cmd_args, &cli)?;
        for warning in cli
            .warnings
            .iter()
            .chain(flash_attn_warning.iter())
            .chain(compatibility_warnings.iter())
        {
            emit_line(app, &format!("[WARN] {}", warning));
        }
        // 结构性 backend 错误（disk / 列表内 default）不需要探测即可拦截。
        if let Some(error) = backend_spec_static_error(&backend_spec) {
            anyhow::bail!(error);
        }

        // 二进制身份与 backend 预探测共用一次 `--list-devices` 调用：
        // - 文件名不是 sd-server 前缀（或不在配置的内核目录内）时，探测输出
        //   形状（name<TAB>description）作为身份兜底——防止把任意可执行文件
        //   当 sd-server 启动，同时允许重命名二进制的旧配置继续工作（对抗性
        //   审查 C / 审查 P4a / 审查 S-2：只按文件名放行可被 `save_output`
        //   写入的 `sd-server.exe` 利用）。
        // - 设备型 backend token（cuda0/rocm/...）在二进制未编译对应后端时
        //   会让 sd-server 启动即退，先探测给出可读错误（对抗性审查 A3）。
        // 旧版二进制不支持该参数时（探测返回 None）跳过校验、维持旧行为。
        let name_ok = exe_trusted_without_probe(&exe, exe_dir);
        let need_probe = !name_ok
            || backend_spec_needs_probe(&backend_spec)
            || extra_backend_specs
                .iter()
                .any(|s| backend_spec_needs_probe(s));
        let probe_output = if need_probe {
            let exe_for_probe = exe.clone();
            tokio::time::timeout(
                Duration::from_secs(20),
                tokio::task::spawn_blocking(move || probe_backend_devices(&exe_for_probe)),
            )
            .await
            .ok()
            .and_then(|join| join.unwrap_or(None))
        } else {
            None
        };
        if !name_ok {
            let plausible = probe_output
                .as_deref()
                .map(device_list_looks_plausible)
                .unwrap_or(false);
            if !plausible {
                anyhow::bail!(
                    "{} 未通过 sd-server 身份校验（文件名不以 sd-server 开头或不在配置的内核目录内，且 --list-devices 探测未返回设备列表）",
                    exe.display()
                );
            }
        }
        if let Some(output) = &probe_output {
            if let Some(error) = find_backend_error(&backend_spec, output) {
                anyhow::bail!(error);
            }
            for spec in &extra_backend_specs {
                if let Some(error) = find_backend_error(spec, output) {
                    anyhow::bail!("附加启动参数中的 --backend 无效：{}", error);
                }
            }
        }

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
        // 启动命令行是排障第一现场（组件路径、显存预算、后端都在这条里）。
        crate::logging::info(
            "app",
            &format!("启动 sd-server: {} {}", exe.display(), cmd_args.join(" ")),
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
        // Unix: 独立进程组 +（Linux）PR_SET_PDEATHSIG，防 GUI 崩溃后孤儿
        // sd-server。必须在 spawn 之前配置。
        #[cfg(unix)]
        prepare_unix_child_command(&mut command, std::process::id());
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

        #[cfg(windows)]
        let job = JobGuard::attach(pid);
        #[cfg(unix)]
        let watchdog = spawn_unix_watchdog(std::process::id(), pid);

        self.child = Some(child);
        self.model = model_name.to_string();
        self.executable = exe.to_string_lossy().to_string();
        self.port = Some(port);
        self.started_at = Some(now_epoch_seconds());
        self.last_error = None;
        #[cfg(windows)]
        {
            self.job = job;
        }
        #[cfg(unix)]
        {
            self.watchdog = watchdog;
        }

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
        #[cfg(unix)]
        if let Some(pid) = self.child.as_ref().and_then(|c| c.id()) {
            kill_unix_process_group(pid);
        }
        self.clear_child_state();
        log::info!("sd-server killed");
        crate::logging::info("app", "sd-server 已被强制终止");
    }
}

// ── ANSI escape sequence stripping ─────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        assert!(error.contains("路径不存在"));
    }

    #[test]
    fn build_args_validates_upstream_path_aliases_too() {
        for key in ["tae", "qwen2vl", "qwen2vl_vision", "upscale-model"] {
            let missing = std::env::temp_dir().join(format!(
                "lumina-missing-alias-{}-{}.bin",
                key,
                now_epoch_seconds()
            ));
            let mut map = serde_json::Map::new();
            map.insert(
                key.to_string(),
                serde_json::Value::String(missing.to_string_lossy().into_owned()),
            );
            let args = serde_json::Value::Object(map);
            let error = build_args(&args, DEFAULT_SD_PORT).unwrap_err().to_string();
            assert!(error.contains("路径不存在"), "key {}: {}", key, error);
        }
    }

    /// 上游 #2132：--flash-attn 取代旧的裸开关。结构化参数在新旧内核之间自动
    /// 选择写法；用户写进 extra_args 的同名参数不在这里改写。
    #[test]
    fn adapts_flash_attention_argument_to_kernel_age() {
        let modern = crate::cli::CliCapabilities::for_test(&["--flash-attn"]);
        let legacy = crate::cli::CliCapabilities::for_test(&["--fa", "--diffusion-fa"]);

        let mut args = serde_json::json!({ "flash-attn": "off,diffusion=on" });
        assert!(adapt_flash_attn_for_kernel(&mut args, &modern).is_none());
        assert_eq!(args["flash-attn"], "off,diffusion=on");
        assert!(args.get("diffusion-fa").is_none());

        let mut args = serde_json::json!({ "flash-attn": "off,diffusion=on" });
        let warning = adapt_flash_attn_for_kernel(&mut args, &legacy).unwrap();
        assert!(warning.contains("--diffusion-fa"), "{warning}");
        assert_eq!(args["diffusion-fa"], true);
        assert!(args.get("flash-attn").is_none());

        let mut args = serde_json::json!({ "flash-attn": "on" });
        assert!(adapt_flash_attn_for_kernel(&mut args, &legacy).is_some());
        assert_eq!(args["fa"], true);
        assert!(args.get("flash-attn").is_none());

        // 没有旧等价写法的模式串：丢掉该参数，不让老内核因未知参数启动即退。
        let mut args = serde_json::json!({ "flash-attn": "auto,te=off" });
        let warning = adapt_flash_attn_for_kernel(&mut args, &legacy).unwrap();
        assert!(warning.contains("已忽略"), "{warning}");
        assert!(args.get("flash-attn").is_none());

        // extra_args 里手写的 --flash-attn 保持原样（由 validate_args 报错）。
        let mut args = serde_json::json!({ "extra_args": "--flash-attn on" });
        assert!(adapt_flash_attn_for_kernel(&mut args, &legacy).is_none());
        assert_eq!(args["extra_args"], "--flash-attn on");

        // 能力未知时不改写，交给 sd-server 最终校验。
        let unknown = crate::cli::CliCapabilities::unknown_for_test();
        let mut args = serde_json::json!({ "flash-attn": "on" });
        assert!(adapt_flash_attn_for_kernel(&mut args, &unknown).is_none());
        assert_eq!(args["flash-attn"], "on");
    }

    #[test]
    fn build_args_splits_inline_extra_arg_form() {
        // 上游 parse_options 不支持 `--key=value`，透传会 unknown argument
        // 启动即退——必须拆成两个 token。
        let args = serde_json::json!({ "extra_args": "--threads=4" });
        let out = build_args(&args, DEFAULT_SD_PORT).unwrap();
        assert!(out.windows(2).any(|w| w[0] == "--threads" && w[1] == "4"));
        assert!(!out.iter().any(|t| t == "--threads=4"));
    }

    #[test]
    fn build_args_splits_short_model_inline_form() {
        // `-m=model.gguf` 与 `--key=value` 同理：上游精确匹配不接受等值
        // 形式（审查 L2）。相对路径不做存在性校验，可直接构造。
        let args = serde_json::json!({ "extra_args": "-m=model.gguf" });
        let out = build_args(&args, DEFAULT_SD_PORT).unwrap();
        assert!(out.windows(2).any(|w| w[0] == "-m" && w[1] == "model.gguf"));
        assert!(!out.iter().any(|t| t == "-m=model.gguf"));
    }

    #[test]
    fn extra_arg_values_extracts_value_flags_only() {
        let tokens =
            split_args("--backend cuda0 --max-vram 6 --verbose --threads=4 -b cpu -b=rocm0")
                .unwrap();
        assert_eq!(
            extra_arg_values(&tokens, &["backend", "b"]),
            vec!["cuda0", "cpu", "rocm0"]
        );
        assert_eq!(extra_arg_values(&tokens, &["max-vram"]), vec!["6"]);
        // `--key=value` 与空格形式等价（build_args 会把它拆成两个 token）。
        let tokens2 = split_args("--backend=cuda9 --max-vram=not-a-number").unwrap();
        assert_eq!(extra_arg_values(&tokens2, &["backend", "b"]), vec!["cuda9"]);
        assert_eq!(
            extra_arg_values(&tokens2, &["max-vram"]),
            vec!["not-a-number"]
        );
        // 布尔 flag 不被当成值；缺值（下一 token 是 flag）不凭空造值。
        let tokens3 = split_args("--backend --verbose").unwrap();
        assert!(extra_arg_values(&tokens3, &["backend", "b"]).is_empty());
        // `-backend` 不是 `-b` 别名。
        let tokens4 = split_args("-backend cpu").unwrap();
        assert!(extra_arg_values(&tokens4, &["backend", "b"]).is_empty());
    }

    #[test]
    fn max_vram_spec_validation_mirrors_frontend() {
        assert!(validate_max_vram_spec("6").is_ok());
        assert!(validate_max_vram_spec("-2").is_ok());
        assert!(validate_max_vram_spec("6,cuda0=4,vulkan0=4").is_ok());
        assert!(validate_max_vram_spec("1e3").is_ok());
        assert!(validate_max_vram_spec("0x10").is_ok());
        assert!(validate_max_vram_spec("0x.8p1").is_ok());
        assert!(validate_max_vram_spec("  ").is_ok());
        assert!(validate_max_vram_spec("cuda0 = 6").is_ok());
        // 非法/溢出值必须拦下。
        assert!(validate_max_vram_spec("not-a-number").is_err());
        assert!(validate_max_vram_spec("1e999").is_err());
        assert!(validate_max_vram_spec("0x1p9999").is_err());
        assert!(validate_max_vram_spec("cuda0=inf").is_err());
        assert!(validate_max_vram_spec("cuda0=").is_err());
        assert!(validate_max_vram_spec("=6").is_err());
        // 设备名只做字符白名单（与前端一致），具体设备名由上游解析。
        assert!(validate_max_vram_spec("eq=6").is_ok());
        // 前端等价断言（utils.test.ts）：形状与有限性分开校验。
        assert!(parse_strict_vram_number("1e999").is_none());
        // 十六进制溢出解析为 inf（与前端手算 2^exp 溢出为 Infinity 相同），
        // 由 validate_max_vram_spec 的 is_finite 拦截。
        assert!(!parse_strict_vram_number("0x1p9999").unwrap().is_finite());
        assert!(parse_strict_vram_number("not-a-number").is_none());
        assert_eq!(parse_strict_vram_number("0x.8p1"), Some(1.0));
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
                "--offload-to-cpu",
                "--verbose",
                "--threads",
                "4",
            ]
        );
    }

    #[test]
    fn extra_args_override_diagnostic_controls_consistently() {
        let args = serde_json::json!({
            "log-level": "info", "linear-scale": "1", "attn-scale": "1",
            "extra_args": "--log-level=debug --linear-scale=0.5 --attn-scale=0.25"
        });
        let out = build_args(&args, DEFAULT_SD_PORT).unwrap();
        let tail: Vec<String> = [
            "--log-level",
            "debug",
            "--linear-scale",
            "0.5",
            "--attn-scale",
            "0.25",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(out.ends_with(&tail));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_preflight_probes_caches_and_rechecks_replaced_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "lumina-cli-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("sd-server");
        let model = dir.join("model.gguf");
        fs::write(&model, b"fixture").unwrap();
        let write_executable = |options: &str| {
            let help = format!("  -m, --model <string>     model\n  --listen-port <int>      port\n  -p, --prompt <string>    prompt\n{}", options);
            let script = format!("#!/bin/sh\nprintf x >> \"$0.calls\"\ncase \"$1\" in\n--help) printf '%s\\n' '{}'; exit 1;;\n--version) printf '%s\\n' 'fixture-version';;\n*) touch \"$0.generation\"; exit 2;;\nesac\n", help);
            fs::write(&exe, script).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
        };
        write_executable("  --auto-fit       on|off (default: on)\n  --disable-segmented-compute  force monolithic\n  --linear-scale    scale\n  --log-level       level\n");
        let args = serde_json::json!({"model": model.to_str().unwrap(), "extra_args": "--auto-fit on --linear-scale=0.125 --log-level debug --prompt \"--stream-layers\""});
        let caps = preflight_cli(exe.to_str().unwrap(), &args, 1234)
            .await
            .unwrap();
        assert!(caps.verified);
        assert_eq!(caps.auto_fit, crate::cli::AutoFitSyntax::OnOff);
        assert_eq!(caps.version.as_deref(), Some("fixture-version"));
        let bad = serde_json::json!({"extra_args": "--stream-layers"});
        assert!(preflight_cli(exe.to_str().unwrap(), &bad, 1234)
            .await
            .unwrap_err()
            .to_string()
            .contains("删除"));
        assert_eq!(
            fs::read(exe.with_extension("calls")).unwrap().len(),
            2,
            "second preflight should use cached help"
        );
        write_executable(
            "  --auto-fit       pick placements\n  --stream-layers   stream weights\n",
        );
        let legacy = serde_json::json!({"extra_args": "--stream-layers --auto-fit"});
        let caps = preflight_cli(exe.to_str().unwrap(), &legacy, 1234)
            .await
            .unwrap();
        assert_eq!(caps.auto_fit, crate::cli::AutoFitSyntax::Flag);
        assert_eq!(fs::read(exe.with_extension("calls")).unwrap().len(), 4);
        assert!(
            !exe.with_extension("generation").exists(),
            "preflight must never load a model"
        );
        fs::remove_dir_all(dir).unwrap();
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

        // `--flag=value` 等价形式同样必须被拦截，不能被字面量比较绕过。
        let args = serde_json::json!({ "extra_args": "--listen-port=9000" });
        assert!(build_args(&args, 1234).is_err());
        let args = serde_json::json!({ "extra_args": "--listen-ip=0.0.0.0" });
        assert!(build_args(&args, 1234).is_err());
    }

    /// 上游 `runtime.cpp:193` 给 `--listen-ip` 定了短别名 `-l`（`{"-l",
    /// "--listen-ip", ...}`），只拦长名时 `-l 0.0.0.0` 会透传并覆盖监听
    /// 地址——HTTP 面无鉴权，同局域网可直接提交任务（审查 S-1）。
    #[test]
    fn build_args_rejects_the_listen_short_alias() {
        for extra in [
            "-l 0.0.0.0",
            "-l=0.0.0.0",
            "--threads 4 -l 0.0.0.0",
            // 长名（保留旧结论的回归保护）。
            "--listen-ip 0.0.0.0",
            "--listen-port=9000",
        ] {
            let args = serde_json::json!({ "extra_args": extra });
            let error = build_args(&args, 1234).unwrap_err().to_string();
            assert!(
                error.contains("附加启动参数不能包含"),
                "{}: {}",
                extra,
                error
            );
        }
        // 短别名判定必须精确：命中集合只包含上游真实名字。
        for token in ["-l", "-l=0.0.0.0", "--listen-ip", "--listen-ip=x"] {
            assert!(is_listen_override(token), "{} should be rejected", token);
        }
        // `-l` 开头的其它 token 不得被误伤；上游 short_name 是区分大小写的
        // 精确匹配，`-L` 不是别名。
        for token in ["-log-level", "--listen-portx", "-latency", "--listen", "-L"] {
            assert!(
                !is_listen_override(token),
                "{} must not be treated as a listen override",
                token
            );
        }
    }

    /// 审查 S-2：`start_server` 的「文件名以 sd-server 开头即跳过身份探测」
    /// 快速通道必须同时要求二进制位于配置的内核目录内，否则
    /// `save_settings` → `save_output` → `start_server` 就能执行任意文件。
    #[test]
    fn exe_fast_path_requires_the_configured_kernel_directory() {
        let base = std::env::temp_dir().join(format!(
            "lumina-exe-trust-{}-{}",
            std::process::id(),
            now_epoch_seconds()
        ));
        let kernel = base.join("sd-cpp");
        let sibling = base.join("sd-cpp-2");
        let outputs = base.join("outputs");
        for dir in [&kernel, &sibling, &outputs] {
            fs::create_dir_all(dir).unwrap();
        }
        let write = |dir: &Path, name: &str| {
            let path = dir.join(name);
            fs::write(&path, b"fixture").unwrap();
            path.canonicalize().unwrap()
        };
        let kernel_exe = write(&kernel, "sd-server.exe");
        let sibling_exe = write(&sibling, "sd-server.exe");
        let planted_exe = write(&outputs, "sd-server.exe");
        let renamed_exe = write(&kernel, "renamed.exe");
        let kernel_dir = kernel.to_string_lossy().to_string();

        // 内核目录内的 sd-server：跳过探测（正常启动路径）。
        assert!(exe_trusted_without_probe(&kernel_exe, &kernel_dir));
        // exe_dir 为空（老配置 / PATH 查找）：保留仅按文件名放行的历史行为。
        assert!(exe_trusted_without_probe(&kernel_exe, ""));
        // 链条断点：输出目录里伪造的同名二进制不再享受快速通道。
        assert!(!exe_trusted_without_probe(&planted_exe, &kernel_dir));
        // 前缀相同的兄弟目录不算子树（按路径分量比较）。
        assert!(!exe_trusted_without_probe(&sibling_exe, &kernel_dir));
        // 文件名不匹配时依旧必须走探测。
        assert!(!exe_trusted_without_probe(&renamed_exe, &kernel_dir));
        // 配置的目录不存在：不按名字放行，回退到探测。
        assert!(!exe_trusted_without_probe(
            &kernel_exe,
            &base.join("gone").to_string_lossy()
        ));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn build_args_does_not_treat_numeric_values_as_paths() {
        // 旧启发式会把 1.5 之类带点数值误判为路径并要求其存在。
        let args = serde_json::json!({ "cfg-scale": 1.5, "eta": 0.5 });
        let out = build_args(&args, DEFAULT_SD_PORT).unwrap();
        assert_eq!(
            out,
            vec![
                "--listen-port",
                "1234",
                "--listen-ip",
                "127.0.0.1",
                "--cfg-scale",
                "1.5",
                "--eta",
                "0.5",
            ]
        );
    }

    #[test]
    fn backend_spec_validation_splits_key_value_assignments() {
        let devices = "CUDA0\tNVIDIA GeForce RTX\nCUDA1\tNVIDIA GeForce RTX\nCPU\tGeneric CPU\n";
        // 复合 spec：只校验 value 侧（cuda0），cpu 是通用 token 跳过。
        assert!(find_backend_error("all=cuda0,te=cpu", devices).is_none());
        // value 侧设备不存在时报错，且错误信息包含该 token。
        let err = find_backend_error("all=cuda9,te=cpu", devices).unwrap();
        assert!(err.contains("cuda9"));
        // 裸 token 前缀匹配（rocm → ROCM0）。
        assert!(find_backend_error("rocm", "ROCM0\tAMD\nCPU\tx\n").is_none());
        // 多段 spec 中任一 value 未命中即报错。
        assert!(find_backend_error("cuda0,te=vulkan0", devices).is_some());
        // 上游合法的 & 多设备列表（--backend "diffusion=cuda0&cuda1"）逐项校验。
        assert!(find_backend_error("diffusion=cuda0&cuda1", devices).is_none());
        assert!(find_backend_error("diffusion=cuda0&cuda9", devices).is_some());
        assert!(backend_spec_needs_probe("diffusion=cuda0&cuda1"));
        // 结构性错误：disk 与列表内 default token（上游 validate 启动即退）。
        assert!(backend_spec_static_error("disk").is_some());
        assert!(backend_spec_static_error("te=disk").is_some());
        assert!(backend_spec_static_error("diffusion=cuda0&default").is_some());
        assert!(backend_spec_static_error("diffusion=cuda0&cuda1").is_none());
        assert!(backend_spec_static_error("all=default,te=cpu").is_none());
        // 通用/不可探测 token 不拦截。
        assert!(find_backend_error("gpu", "").is_none());
        assert!(find_backend_error("all=metal,te=cpu", devices).is_none());
        // 探测开关：通用 token 无需探测，设备 token 需要。
        assert!(!backend_spec_needs_probe(""));
        assert!(!backend_spec_needs_probe("gpu"));
        assert!(!backend_spec_needs_probe("all=metal,te=cpu"));
        assert!(backend_spec_needs_probe("all=cuda0,te=cpu"));
    }

    /// 审查 §2.9：`--params-backend` 与 `--backend` 共享语法但取值约束不同——
    /// 这里 disk 是**合法**的（backend_spec_static_error 里它是错误），而 `&`
    /// 设备列表在 params 侧被上游明确拒绝（docs/backend.md）。
    #[test]
    fn params_backend_accepts_disk_and_rejects_device_lists() {
        assert!(params_backend_spec_error("").is_none());
        assert!(params_backend_spec_error("   ").is_none());
        assert!(params_backend_spec_error("disk").is_none());
        assert!(params_backend_spec_error("cpu").is_none());
        assert!(params_backend_spec_error("te=cpu,vae=cpu").is_none());
        assert!(params_backend_spec_error("diffusion=disk,clip=cpu").is_none());
        // 与 --backend 同口径：模块名交给上游判定，不在这里误杀。
        assert!(params_backend_spec_error("unknown-module=cpu").is_none());
        // 上游必然拒绝的形状。
        assert!(params_backend_spec_error("te=cpu&cuda0").is_some());
        assert!(params_backend_spec_error("=cpu").is_some());
        assert!(params_backend_spec_error("te=").is_some());
    }

    /// 审查 §2.9：`--rpc-servers` 写错端口在上游只打日志不中止，表现为
    /// “多机显卡没出现”，所以形状必须在 GUI 侧拦下。
    #[test]
    fn rpc_servers_requires_host_port_endpoints() {
        assert!(rpc_servers_spec_error("").is_none());
        assert!(rpc_servers_spec_error("  ").is_none());
        assert!(rpc_servers_spec_error("localhost:50052").is_none());
        assert!(rpc_servers_spec_error("127.0.0.1:50052,192.168.1.10:50053").is_none());
        assert!(rpc_servers_spec_error("[::1]:50052").is_none());
        assert!(rpc_servers_spec_error("gpu-host:1").is_none());
        // 缺端口 / 端口越界 / 缺 host / 未加方括号的 IPv6 / 混入空格。
        assert!(rpc_servers_spec_error("localhost").is_some());
        assert!(rpc_servers_spec_error("localhost:0").is_some());
        assert!(rpc_servers_spec_error("localhost:65536").is_some());
        assert!(rpc_servers_spec_error("localhost:port").is_some());
        assert!(rpc_servers_spec_error(":50052").is_some());
        assert!(rpc_servers_spec_error("::1:50052").is_some());
        assert!(rpc_servers_spec_error("host name:50052").is_some());
        assert!(rpc_servers_spec_error("ok:50052,bad").is_some());
    }

    #[test]
    fn backend_probe_skips_non_numeric_registry_name_tokens() {
        let devices = "CUDA0\tNVIDIA GeForce RTX\nCPU\tGeneric CPU\n";
        // registry 名（上游 sd_backend_resolve_name 接受，不以数字结尾）：
        // 旧实现会误报"不在设备列表中"，现在直接跳过交给上游（审查 P2）。
        assert!(find_backend_error("nvidia", devices).is_none());
        assert!(find_backend_error("cuda", devices).is_none());
        assert!(find_backend_error("all=metal,te=cpu", devices).is_none());
        assert!(!backend_spec_needs_probe("nvidia"));
        assert!(!backend_spec_needs_probe("mtl"));
        // 带编号的设备 token 仍被校验：拼错会被拦截。
        assert!(backend_spec_needs_probe("cuda9"));
        assert!(find_backend_error("all=cuda9,te=cpu", devices).is_some());
        assert!(find_backend_error("cuda0,te=rocm1", devices).is_some());
    }

    #[test]
    fn device_list_plausibility_requires_tab_separated_rows() {
        assert!(device_list_looks_plausible(
            "CUDA0\tNVIDIA GeForce RTX\nCPU\tGeneric CPU\n"
        ));
        assert!(device_list_looks_plausible("Metal\tabc\n"));
        assert!(!device_list_looks_plausible(""));
        assert!(!device_list_looks_plausible("no tabs here\n"));
        assert!(!device_list_looks_plausible("\tmissing name\n"));
        assert!(!device_list_looks_plausible("CUDA0\n"));
    }

    #[test]
    fn exe_name_check_accepts_sd_server_prefix_only() {
        assert!(exe_name_looks_like_sd_server(Path::new(
            "C:/x/sd-server.exe"
        )));
        assert!(exe_name_looks_like_sd_server(Path::new(
            "/x/sd-server-cuda"
        )));
        assert!(!exe_name_looks_like_sd_server(Path::new(
            "C:/x/notepad.exe"
        )));
        assert!(!exe_name_looks_like_sd_server(Path::new("/x/sd")));
    }

    #[test]
    fn refine_component_dirs_respects_flat_layout_embeddings() {
        let base = std::env::temp_dir().join(format!(
            "lumina-embd-{}-{}",
            std::process::id(),
            now_epoch_seconds()
        ));
        let embed_sub = base.join("embeddings");
        std::fs::create_dir_all(&embed_sub).unwrap();
        std::fs::write(embed_sub.join("sub.safetensors"), b"sub").unwrap();

        // 根目录有小 embedding 文件（扁平布局）→ 不收窄（审查 P4c）。
        std::fs::write(base.join("style.pt"), b"embedding").unwrap();
        let mut args = serde_json::json!({ "embd-dir": base.to_string_lossy() });
        refine_component_dirs(&mut args);
        assert_eq!(args["embd-dir"].as_str().unwrap(), base.to_string_lossy());

        // 根目录只有大文件（模型权重）→ 收窄到 embeddings/。
        std::fs::remove_file(base.join("style.pt")).unwrap();
        let big = base.join("model.safetensors");
        {
            // set_len 稀疏扩文件；块作用域保证句柄先释放再 remove
            // （Windows 打开中的文件无法删除）。
            let f = std::fs::File::create(&big).unwrap();
            f.set_len(EMBEDDING_SMALL_FILE_BYTES + 1).unwrap();
        }
        let mut args2 = serde_json::json!({ "embd-dir": base.to_string_lossy() });
        refine_component_dirs(&mut args2);
        assert_eq!(
            args2["embd-dir"].as_str().unwrap(),
            embed_sub.to_string_lossy()
        );

        // 根目录无 embedding 类文件 → 同样收窄。
        std::fs::remove_file(&big).unwrap();
        let mut args3 = serde_json::json!({ "embd-dir": base.to_string_lossy() });
        refine_component_dirs(&mut args3);
        assert_eq!(
            args3["embd-dir"].as_str().unwrap(),
            embed_sub.to_string_lossy()
        );

        let _ = std::fs::remove_dir_all(&base);
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
