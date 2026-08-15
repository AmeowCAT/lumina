use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::env;
use std::fs;
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
    /// Windows: KILL_ON_JOB_CLOSE 作业对象，随 child 一起创建/清理。
    #[cfg(windows)]
    job: Option<JobGuard>,
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

/// sd-server 参数中"值是文件路径"的参数名（与上游 common.cpp 的 ArgOptions
/// 对齐）。只有这些键（以及 -dir/_dir 结尾的目录键）才做存在性校验——
/// 旧的启发式（值含 '/'、'\\' 或带扩展名）会把 `1.5` 之类的数值误判为路径
/// 并要求其存在（对抗性审查 C）。
const PATH_VALUE_ARGS: &[&str] = &[
    "model",
    "diffusion-model",
    "high-noise-diffusion-model",
    "uncond-diffusion-model",
    "vae",
    "taesd",
    // 上游 --taesd 的别名（common.cpp ArgOptions）。
    "tae",
    "clip_l",
    "clip_g",
    "clip_vision",
    "t5xxl",
    "llm",
    "llm_vision",
    // --llm / --llm_vision 的旧别名。
    "qwen2vl",
    "qwen2vl_vision",
    "audio-vae",
    "embeddings-connectors",
    "control-net",
    "photo-maker",
    "pulid-weights",
    "motion-module",
    "ip-adapter",
    // ESRGAN 放大模型路径。
    "upscale-model",
    "lora-model-dir",
    "embd-dir",
    "hires-upscalers-dir",
];

fn is_path_arg(key: &str) -> bool {
    key.ends_with("-dir") || key.ends_with("_dir") || PATH_VALUE_ARGS.contains(&key)
}

fn validate_path_arg(key: &str, value: &str) -> Result<()> {
    let is_dir_arg = key.ends_with("-dir") || key.ends_with("_dir");
    if !is_path_arg(key) {
        return Ok(());
    }
    let path = Path::new(value);
    // 相对路径以 sd-server 的工作目录（exe 所在目录）为基准解析，GUI 以自身
    // CWD 检查存在性会误报（基准不一致）——相对路径放行，只校验绝对路径。
    if !path.is_absolute() {
        return Ok(());
    }
    if !path.exists() {
        anyhow::bail!("--{} path does not exist: {}", key, value);
    }
    if is_dir_arg && !path.is_dir() {
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
                    let tokens = split_args(s)?;
                    for (i, t) in tokens.iter().enumerate() {
                        // The launcher owns the listen address: it proxies every
                        // API call to `port`, so an override buried in the extra
                        // args would silently point sd-server somewhere the GUI
                        // never talks to.  Also reject the `--flag=value` form —
                        // a literal comparison alone could be bypassed.
                        let listen_flag = t == "--listen-port"
                            || t == "--listen-ip"
                            || t.starts_with("--listen-port=")
                            || t.starts_with("--listen-ip=");
                        if listen_flag {
                            anyhow::bail!(
                                "附加启动参数不能包含 {}，请在控制台的“启动端口”中修改",
                                t
                            );
                        }
                        // 路径类参数与结构化参数同样做存在性校验：拼错的路径
                        // 会让 sd-server 启动即退，提前拦截并给出可读错误
                        // （对抗性审查 A3）。
                        if let Some(key_name) = t.strip_prefix("--") {
                            if let Some((k, inline)) = key_name.split_once('=') {
                                validate_path_arg(k, inline)?;
                            } else if is_path_arg(key_name)
                                && i + 1 < tokens.len()
                                && !tokens[i + 1].starts_with("--")
                            {
                                validate_path_arg(key_name, &tokens[i + 1])?;
                            }
                        }
                        out.push(t.clone());
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

/// 根目录里 ≤ 该大小的 embedding 类文件视为用户真实放置的 embedding
/// （扁平布局）；模型权重动辄数百 MB 以上，不会命中。
const EMBEDDING_SMALL_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 目录顶层是否存在"小"的 embedding 类文件（.gguf/.safetensors/.pt/.ckpt）。
fn dir_has_small_embedding_files(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                if !path.is_file() {
                    return false;
                }
                let ok_ext = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "gguf" | "safetensors" | "pt" | "ckpt"
                        )
                    })
                    .unwrap_or(false);
                if !ok_ext {
                    return false;
                }
                path.metadata()
                    .map(|m| m.len() < EMBEDDING_SMALL_FILE_BYTES)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 收窄 embd-dir：上游 `build_embedding_map`（common.cpp）会把 embd-dir 下所有
/// `.gguf/.safetensors/.pt/.ckpt` 文件的 stem 注册为 embedding 键。指向整个
/// 模型目录时，模型权重文件本身也会被注册进去（对抗性审查 A2）。仅在专用
/// `embeddings/` 子目录**实际包含 embedding 类文件**、且根目录**没有**小
/// embedding 类文件时才改指子目录：根目录有真实 embedding（扁平布局）时
/// 收窄会把它们从注册集合丢掉（上游只非递归扫描 embd-dir 顶层），此时
/// 保持原值（审查 P4c）。
fn refine_component_dirs(args: &mut serde_json::Value) {
    let Some(obj) = args.as_object_mut() else { return };
    let Some(embd) = obj.get("embd-dir").and_then(|v| v.as_str()) else { return };
    let base = Path::new(embd);
    if !base.is_dir() {
        return;
    }
    // 扁平布局守卫：根目录存在小 embedding 文件时不收窄（审查 P4c）。
    if dir_has_small_embedding_files(base) {
        return;
    }
    for candidate in ["embeddings", "embedding"] {
        let dir = base.join(candidate);
        if !dir.is_dir() {
            continue;
        }
        let has_embedding_files = fs::read_dir(&dir)
            .map(|entries| {
                entries.flatten().any(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            matches!(
                                ext.to_ascii_lowercase().as_str(),
                                "gguf" | "safetensors" | "pt" | "ckpt"
                            )
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if has_embedding_files {
            obj.insert(
                "embd-dir".into(),
                serde_json::Value::String(dir.to_string_lossy().into_owned()),
            );
        }
        break;
    }
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

/// 从 backend spec 提取需要校验的设备名 token。上游
/// `sd_parse_backend_assignment`（ggml_extend_backend.cpp）的格式：
/// 逗号分段，`key=value` 中 **value 是后端名**（key 是模块名
/// all/default/*/te/clip/llm/...），无 `=` 的段本身就是后端名。
/// 只校验 value / 裸 token；key 侧的非法模块名由上游启动时报出。
///
/// value 还可以是 `&` 分隔的多设备列表（如 `diffusion=cuda0&cuda1`，
/// 上游 `split_device_list` / ArgOptions 的 `--backend` 示例）。这里先
/// 拆成单设备 token 再逐个校验，避免把整个列表当一个名字误杀。
fn backend_spec_tokens(spec: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let value = match part.split_once('=') {
            Some((_, value)) => value,
            None => part,
        };
        for device in value.split('&') {
            let device = device.trim();
            if !device.is_empty() {
                tokens.push(device.to_string());
            }
        }
    }
    tokens
}

/// 不经设备列表校验的 token：通用 token（上游 is_default_backend_token /
/// "gpu"）以及设备名不含 registry 名的后端（Metal/BLAS）。这些交给上游
/// 解析，探测只拦"明显不存在的设备"（对抗性审查 A3）。
const UNPROBABLE_BACKEND_TOKENS: &[&str] =
    &["", "default", "auto", "gpu", "cpu", "metal", "blas"];

/// 单个 token 是否需要经 `--list-devices` 设备列表校验。只校验**以数字
/// 结尾**的 token（cuda0/rocm2/vulkan1 这类带编号设备名）：上游
/// `sd_backend_resolve_name` 除设备名外还接受 registry 名（CUDA/ROCm/
/// Vulkan/SYCL/MUSA/OpenCL/Metal/…，大小写不敏感），这些名字不会以数字
/// 结尾、也不出现在设备列表里，旧实现会对它们整体误报。registry 名与
/// 其他非编号 token 交给上游启动时校验（审查 P2）。
fn backend_token_needs_probe(token: &str) -> bool {
    let token = token.trim();
    if token.is_empty()
        || UNPROBABLE_BACKEND_TOKENS.contains(&token.to_ascii_lowercase().as_str())
    {
        return false;
    }
    token.ends_with(|c: char| c.is_ascii_digit())
}

/// spec 里是否存在需要探测的设备 token。
fn backend_spec_needs_probe(spec: &str) -> bool {
    backend_spec_tokens(spec)
        .iter()
        .any(|token| backend_token_needs_probe(token))
}

/// 模拟上游 sd_backend_resolve_name 的宽松匹配（不区分大小写、token 为
/// 设备名前缀；反向前缀一并接受以容忍设备名差异）。复合 spec
/// （`all=cuda0,te=cpu`）逐 value 校验，未命中的 token 汇总报错。
fn find_backend_error(spec: &str, devices_output: &str) -> Option<String> {
    let names: Vec<String> = devices_output
        .lines()
        .filter_map(|line| line.split('\t').next())
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty())
        .collect();
    let mut missing: Vec<String> = Vec::new();
    for raw in backend_spec_tokens(spec) {
        if !backend_token_needs_probe(&raw) {
            continue;
        }
        let token = raw.trim().to_ascii_lowercase();
        let matched = names
            .iter()
            .any(|name| name == &token || name.starts_with(&token) || token.starts_with(name));
        if !matched {
            missing.push(raw);
        }
    }
    if missing.is_empty() {
        None
    } else {
        Some(format!(
            "backend 设备 {} 不在已编译的后端设备中（可用：{}）；请改用已编译的后端或重新编译 sd-server",
            missing.join(", "),
            if names.is_empty() { "无".into() } else { names.join(", ") }
        ))
    }
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
            AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JobObjectExtendedLimitInformation,
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
        let mut args_json = args;
        refine_component_dirs(&mut args_json);
        let backend_spec = args_json
            .get("backend")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let cmd_args = build_args(&args_json, port)?;

        // 二进制身份与 backend 预探测共用一次 `--list-devices` 调用：
        // - 文件名不是 sd-server 前缀时，探测输出形状（name<TAB>description）
        //   作为身份兜底——防止把任意可执行文件当 sd-server 启动，同时允许
        //   重命名二进制的旧配置继续工作（对抗性审查 C / 审查 P4a）。
        // - 设备型 backend token（cuda0/rocm/...）在二进制未编译对应后端时
        //   会让 sd-server 启动即退，先探测给出可读错误（对抗性审查 A3）。
        // 旧版二进制不支持该参数时（探测返回 None）跳过校验、维持旧行为。
        let name_ok = exe_name_looks_like_sd_server(&exe);
        let need_probe = !name_ok || backend_spec_needs_probe(&backend_spec);
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
                    "{} 不是 sd-server（文件名不以 sd-server 开头，且 --list-devices 探测未返回设备列表）",
                    exe.display()
                );
            }
        }
        if let Some(output) = &probe_output {
            if let Some(error) = find_backend_error(&backend_spec, output) {
                anyhow::bail!(error);
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

        #[cfg(windows)]
        let job = JobGuard::attach(pid);

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

/// 日志文本清洗：剥离 ANSI 序列并移除其余控制字符（保留 \t）。sd-server
/// 会回显用户输入的 prompt/文件名，其中混入的控制字符（\r、\x1b 之外的
/// C0 序列）可伪造进度行/日志行（对抗性审查 C）；行拆分后不应再残留 \r。
fn sanitize_log_text(s: &str) -> String {
    strip_ansi(s)
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .collect()
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
        let clean = sanitize_log_text(t);
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
                                let clean = sanitize_log_text(after_cr);
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
    fn build_args_validates_upstream_path_aliases_too() {
        for key in ["tae", "qwen2vl", "qwen2vl_vision", "upscale-model"] {
            let missing = std::env::temp_dir().join(format!(
                "lumina-missing-alias-{}-{}.bin",
                key,
                now_epoch_seconds()
            ));
            let mut map = serde_json::Map::new();
            map.insert(key.to_string(), serde_json::Value::String(missing.to_string_lossy().into_owned()));
            let args = serde_json::Value::Object(map);
            let error = build_args(&args, DEFAULT_SD_PORT).unwrap_err().to_string();
            assert!(error.contains("path does not exist"), "key {}: {}", key, error);
        }
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

        // `--flag=value` 等价形式同样必须被拦截，不能被字面量比较绕过。
        let args = serde_json::json!({ "extra_args": "--listen-port=9000" });
        assert!(build_args(&args, 1234).is_err());
        let args = serde_json::json!({ "extra_args": "--listen-ip=0.0.0.0" });
        assert!(build_args(&args, 1234).is_err());
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
    fn sanitize_log_text_strips_controls_but_keeps_tabs_and_text() {
        assert_eq!(sanitize_log_text("a\tb"), "a\tb");
        assert_eq!(sanitize_log_text("x\x1b[31mred\x1b[0m"), "xred");
        assert_eq!(sanitize_log_text("bad\x07bell\x0b"), "badbell");
        assert_eq!(sanitize_log_text("中文 日志"), "中文 日志");
    }

    #[test]
    fn backend_spec_validation_splits_key_value_assignments() {
        let devices = "CUDA0\tNVIDIA GeForce RTX\nCPU\tGeneric CPU\n";
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
        // 通用/不可探测 token 不拦截。
        assert!(find_backend_error("gpu", "").is_none());
        assert!(find_backend_error("all=metal,te=cpu", devices).is_none());
        // 探测开关：通用 token 无需探测，设备 token 需要。
        assert!(!backend_spec_needs_probe(""));
        assert!(!backend_spec_needs_probe("gpu"));
        assert!(!backend_spec_needs_probe("all=metal,te=cpu"));
        assert!(backend_spec_needs_probe("all=cuda0,te=cpu"));
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
        assert!(exe_name_looks_like_sd_server(Path::new("C:/x/sd-server.exe")));
        assert!(exe_name_looks_like_sd_server(Path::new("/x/sd-server-cuda")));
        assert!(!exe_name_looks_like_sd_server(Path::new("C:/x/notepad.exe")));
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
