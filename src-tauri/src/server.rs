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
    /// Unix: 非 Linux 平台的“父死看门狗”（sh 进程，见 spawn_unix_watchdog），
    /// 随 child 一起创建/清理。
    #[cfg(unix)]
    watchdog: Option<std::process::Child>,
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
    // 其余上游路径参数（common.cpp / runtime.cpp，不以 -dir 结尾的部分）。
    "ad-model",
    "init-img",
    "end-img",
    "mask",
    "control-image",
    "ip-adapter-image",
    "control-video",
    "pm-id-embed-path",
    "pulid-id-embedding",
    "ref-image",
    "ref-video",
    "ref-video-audio",
    "ref-audio",
    "prompt-file",
    "negative-prompt-file",
    "serve-html-path",
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
                                // 上游 parse_options（common.cpp）是精确字符串
                                // 匹配，不支持 `--key=value` 形式——原样透传会
                                // 让 sd-server 报 unknown argument 启动即退。
                                // 这里拆成两个 token 再传（对抗性审查）。
                                validate_path_arg(k, inline)?;
                                out.push(format!("--{}", k));
                                out.push(inline.to_string());
                                continue;
                            } else if is_path_arg(key_name)
                                && i + 1 < tokens.len()
                                && !tokens[i + 1].starts_with("--")
                            {
                                validate_path_arg(key_name, &tokens[i + 1])?;
                            }
                        } else if let Some(inline) = t.strip_prefix("-m=") {
                            // `-m=model.gguf` 与 `--key=value` 同理:上游
                            // parse_options 精确匹配,等值形式报 unknown
                            // argument 启动即退——拆成两个 token 再传,
                            // 并做与 -m 空格形式相同的路径校验(审查 L2)。
                            validate_path_arg("model", inline)?;
                            out.push("-m".into());
                            out.push(inline.to_string());
                            continue;
                        } else if t == "-m"
                            && i + 1 < tokens.len()
                            && !tokens[i + 1].starts_with('-')
                        {
                            // --model 的短别名（common.cpp {"-m", "--model"}），
                            // 单横线会绕过上面的 strip_prefix("--") 校验。
                            validate_path_arg("model", &tokens[i + 1])?;
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
    let Some(obj) = args.as_object_mut() else {
        return;
    };
    let Some(embd) = obj.get("embd-dir").and_then(|v| v.as_str()) else {
        return;
    };
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
const UNPROBABLE_BACKEND_TOKENS: &[&str] = &["", "default", "auto", "gpu", "cpu", "metal", "blas"];

/// 单个 token 是否需要经 `--list-devices` 设备列表校验。只校验**以数字
/// 结尾**的 token（cuda0/rocm2/vulkan1 这类带编号设备名）：上游
/// `sd_backend_resolve_name` 除设备名外还接受 registry 名（CUDA/ROCm/
/// Vulkan/SYCL/MUSA/OpenCL/Metal/…，大小写不敏感），这些名字不会以数字
/// 结尾、也不出现在设备列表里，旧实现会对它们整体误报。registry 名与
/// 其他非编号 token 交给上游启动时校验（审查 P2）。
fn backend_token_needs_probe(token: &str) -> bool {
    let token = token.trim();
    if token.is_empty() || UNPROBABLE_BACKEND_TOKENS.contains(&token.to_ascii_lowercase().as_str())
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

/// 不依赖设备探测的结构性校验（上游 SDBackendManager::validate）：
/// - `disk` 仅 params_backend 接受，出现在 --backend 里启动即退；
/// - `&` 设备列表内不允许 default/auto 这类默认 token。
fn backend_spec_static_error(spec: &str) -> Option<String> {
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let value = match part.split_once('=') {
            Some((_, value)) => value,
            None => part,
        };
        let is_list = value.contains('&');
        for device in value.split('&') {
            let device = device.trim().to_ascii_lowercase();
            if device == "disk" {
                return Some(
                    "--backend 不接受 disk（上游仅 params_backend 支持），请从 backend 配置中移除"
                        .into(),
                );
            }
            if is_list && matches!(device.as_str(), "default" | "auto" | "") {
                return Some(format!(
                    "--backend 的多设备列表（& 分隔）中不允许 default/auto/空 token：{}",
                    part
                ));
            }
        }
    }
    None
}

/// extra_args 中某个“取值型”参数的全部出现值（可能出现多次，逐次校验）。
/// 识别 `--key value`、`--key=value` 两种形式，以及 `-b` / `-b=value` 短
/// 别名（上游 ArgOptions 的 `-m`/`--model` 模式）。布尔 flag（无值）与
/// 其他参数一律跳过：下一个词元以 `-` 开头时不视为值，与 build_args 的
/// 路径校验口径一致。
fn extra_arg_values(tokens: &[String], names: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        let mut matched: Option<&str> = None;
        let mut inline: Option<&str> = None;
        if let Some(rest) = t.strip_prefix("--") {
            if let Some((key, value)) = rest.split_once('=') {
                if names.contains(&key) {
                    matched = Some(key);
                    inline = Some(value);
                }
            } else if names.contains(&rest) {
                matched = Some(rest);
            }
        } else if names.contains(&"b") {
            // `-b`/`-b=value`：short alias 只匹配精确 token 或 =value 形式，
            // 避免把 `-backend` 之类误当别名。
            if let Some(rest) = t.strip_prefix("-b") {
                if rest.is_empty() {
                    matched = Some("b");
                } else if let Some(value) = rest.strip_prefix('=') {
                    matched = Some("b");
                    inline = Some(value);
                }
            }
        }
        if let Some(name) = matched {
            if let Some(value) = inline {
                values.push(value.to_string());
            } else if i + 1 < tokens.len() && !tokens[i + 1].starts_with('-') {
                values.push(tokens[i + 1].clone());
                i += 1;
            } else {
                // 缺值（`--backend --verbose`）：交给上游报 unknown/缺值，
                // 这里不凭空造一个值去校验（保守口径）。
                let _ = name;
            }
        }
        i += 1;
    }
    values
}

/// 严格解析 C99 十进制/十六进制浮点（与上游 parse_strict_float 对齐）。
/// 返回 None 表示形状非法；inf/nan（如 1e999、0x1p9999）由调用方 is_finite
/// 拦截——与前端 isFiniteC99Float 同口径。
fn parse_strict_vram_number(s: &str) -> Option<f64> {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    if body.is_empty() {
        return None;
    }
    if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        let (mant, exp) = match hex.split_once(['p', 'P']) {
            Some((m, e)) => {
                let e = e.strip_prefix(['+', '-']).unwrap_or(e);
                if e.is_empty() || !e.chars().all(|c| c.is_ascii_digit()) {
                    return None;
                }
                (m, e.parse::<i32>().ok()?)
            }
            None => (hex, 0),
        };
        let (int_part, frac_part) = match mant.split_once('.') {
            Some((i, f)) => (i, f),
            None => (mant, ""),
        };
        if int_part.is_empty() && frac_part.is_empty() {
            return None;
        }
        if !(int_part.chars().all(|c| c.is_ascii_hexdigit()))
            || !frac_part.chars().all(|c| c.is_ascii_hexdigit())
        {
            return None;
        }
        let int_val = if int_part.is_empty() {
            0.0
        } else {
            u64::from_str_radix(int_part, 16).ok()? as f64
        };
        let mut frac_val = 0.0f64;
        let mut scale = 1.0f64 / 16.0;
        for c in frac_part.chars() {
            frac_val += c.to_digit(16)? as f64 * scale;
            scale /= 16.0;
        }
        let mant_val = int_val + frac_val;
        let value = if exp > 0 {
            mant_val * 2f64.powi(exp) // 溢出 → inf，由调用方拦截
        } else {
            mant_val / 2f64.powi(-exp)
        };
        return Some(value);
    }
    // 十进制（含 C99 的 .5 / 1. / 1e3 形式）
    let (mant, exp) = match body.split_once(['e', 'E']) {
        Some((m, e)) => {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            if e.is_empty() || !e.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            (m, Some(e))
        }
        None => (body, None),
    };
    let (int_part, frac_part) = match mant.split_once('.') {
        Some((i, f)) => (i, f),
        None => (mant, ""),
    };
    if (int_part.is_empty() && frac_part.is_empty())
        || !int_part.chars().all(|c| c.is_ascii_digit())
        || !frac_part.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    // 1e999 这类超出 f64 范围的十进制按 inf 解析，由 is_finite 拦截。
    let value: f64 = body.parse().ok()?;
    if exp.is_some() && !value.is_finite() {
        return None;
    }
    Some(value)
}

/// 设备名侧校验：与上游 ggml_extend_backend MaxVramAssignment 一致
/// （字母数字 + `_ . + * -`）。
fn is_valid_vram_device(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '*' | '-'))
}

/// 预校验 `--max-vram` 原始 spec（上游 ggml_graph_cut 解析失败会让
/// sd-server 启动即退，GUI 提前拦截给出可读错误）。与前端
/// `validateMaxVramSpec` 对齐：逗号分段，无 `=` 的段是全局默认预算
/// （后写覆盖先写），`设备=数值` 段设置单设备预算，空段跳过。
fn validate_max_vram_spec(spec: &str) -> Result<()> {
    if spec.trim().is_empty() {
        return Ok(());
    }
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (value, label) = match part.split_once('=') {
            None => (part, format!("全局默认预算 {}", part)),
            Some((device_raw, value_raw)) => {
                // 与前端一致：'=' 两侧允许空白（`cuda0 = 6`）。
                let device = device_raw.trim();
                let value = value_raw.trim();
                if device.is_empty() {
                    anyhow::bail!("设备分配项格式应为 设备=数值：{}", part);
                }
                if !is_valid_vram_device(device) {
                    anyhow::bail!("设备名包含非法字符：{}", device);
                }
                (value, format!("设备 {} 的预算 {}", device, value))
            }
        };
        let parsed = parse_strict_vram_number(value)
            .ok_or_else(|| anyhow!("{} 应为数字（GiB）或负的保留余量，如 6 或 -2", label))?;
        if !parsed.is_finite() {
            anyhow::bail!("{} 超出可表示范围（溢出为 inf）", label);
        }
    }
    Ok(())
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
        #[cfg(unix)]
        kill_unix_process_group(pid);
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
        for spec in &extra_backend_specs {
            if let Some(error) = backend_spec_static_error(spec) {
                anyhow::bail!("附加启动参数中的 --backend 无效：{}", error);
            }
        }
        for spec in extra_arg_values(&extra_tokens, &["max-vram"]) {
            validate_max_vram_spec(&spec)
                .map_err(|e| anyhow!("附加启动参数中的 --max-vram 格式无效：{}", e))?;
        }
        let cmd_args = build_args(&args_json, port)?;
        // 结构性 backend 错误（disk / 列表内 default）不需要探测即可拦截。
        if let Some(error) = backend_spec_static_error(&backend_spec) {
            anyhow::bail!(error);
        }

        // 二进制身份与 backend 预探测共用一次 `--list-devices` 调用：
        // - 文件名不是 sd-server 前缀时，探测输出形状（name<TAB>description）
        //   作为身份兜底——防止把任意可执行文件当 sd-server 启动，同时允许
        //   重命名二进制的旧配置继续工作（对抗性审查 C / 审查 P4a）。
        // - 设备型 backend token（cuda0/rocm/...）在二进制未编译对应后端时
        //   会让 sd-server 启动即退，先探测给出可读错误（对抗性审查 A3）。
        // 旧版二进制不支持该参数时（探测返回 None）跳过校验、维持旧行为。
        let name_ok = exe_name_looks_like_sd_server(&exe);
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
                    "{} 不是 sd-server（文件名不以 sd-server 开头，且 --list-devices 探测未返回设备列表）",
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
            map.insert(
                key.to_string(),
                serde_json::Value::String(missing.to_string_lossy().into_owned()),
            );
            let args = serde_json::Value::Object(map);
            let error = build_args(&args, DEFAULT_SD_PORT).unwrap_err().to_string();
            assert!(
                error.contains("path does not exist"),
                "key {}: {}",
                key,
                error
            );
        }
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
