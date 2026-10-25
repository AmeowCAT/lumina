//! Version-sensitive sd-server CLI preflight. Never rewrites saved settings or
//! guesses support from Lumina's version: inspect the selected executable.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoFitSyntax {
    Unknown,
    Unsupported,
    Flag,
    OnOff,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryMode {
    Unknown,
    Legacy,
    Automatic,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    pub executable: String,
    pub version: Option<String>,
    pub verified: bool,
    /// Long and short option names, including leading hyphens.
    pub options: Vec<String>,
    pub auto_fit: AutoFitSyntax,
    pub memory_mode: MemoryMode,
    pub warnings: Vec<String>,
    #[serde(skip)]
    value_options: HashSet<String>,
}

impl CliCapabilities {
    fn unknown() -> Self {
        Self {
            executable: String::new(),
            version: None,
            verified: false,
            options: Vec::new(),
            auto_fit: AutoFitSyntax::Unknown,
            memory_mode: MemoryMode::Unknown,
            warnings: vec!["无法确认内核 CLI 能力；保留原参数，由 sd-server 最终校验。".into()],
            value_options: HashSet::new(),
        }
    }

    /// `Some(_)` only when the executable's help was parsed; `None` means the
    /// capability is unknown, which must never be treated as "unsupported".
    pub fn supports(&self, name: &str) -> Option<bool> {
        self.verified
            .then(|| self.options.iter().any(|s| s == name))
    }
}

/// Test-only capability stub: the probe needs a real executable, but the
/// version-adaptive launch path only reads the parsed option names.
#[cfg(test)]
impl CliCapabilities {
    pub(crate) fn for_test(options: &[&str]) -> Self {
        Self {
            executable: String::new(),
            version: None,
            verified: true,
            options: options.iter().map(|name| (*name).to_string()).collect(),
            auto_fit: AutoFitSyntax::OnOff,
            memory_mode: MemoryMode::Automatic,
            warnings: Vec::new(),
            value_options: HashSet::new(),
        }
    }

    pub(crate) fn unknown_for_test() -> Self {
        Self::unknown()
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Parse declarations, not arbitrary mentions of flags in their descriptions.
/// Upstream ArgOptions prints declarations at column 3; wrapped descriptions
/// are indented much further. Typed options include <string>/<int>/<float>.
fn parse_help(help: &str) -> CliCapabilities {
    let clean = strip_ansi(help);
    let mut entries: BTreeMap<String, String> = BTreeMap::new();
    let mut value_options = HashSet::new();
    let mut current: Vec<String> = Vec::new();
    for line in clean.lines() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if indent <= 4 && trimmed.starts_with('-') {
            let mut names = Vec::new();
            // The padded description column may itself begin with a flag name.
            // Do not advertise that mention as another option declaration.
            let (declaration, detail) = trimmed.split_once("  ").unwrap_or((trimmed, ""));
            let mut words = declaration.split_whitespace().peekable();
            while let Some(word) = words.peek() {
                let name = word.trim_end_matches(',');
                if !(name.starts_with("--") || name.len() == 2 && name.starts_with('-'))
                    || !name
                        .trim_start_matches('-')
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    break;
                }
                names.push(name.to_string());
                words.next();
            }
            let typed = words
                .peek()
                .is_some_and(|s| matches!(*s, "<string>" | "<int>" | "<float>"));
            let description = format!("{} {}", words.collect::<Vec<_>>().join(" "), detail)
                .trim()
                .to_string();
            for name in &names {
                entries.insert(name.clone(), description.clone());
                if typed {
                    value_options.insert(name.clone());
                }
            }
            current = names;
        } else if indent > 4 && !trimmed.is_empty() {
            for name in &current {
                if let Some(description) = entries.get_mut(name) {
                    description.push(' ');
                    description.push_str(trimmed);
                }
            }
        } else {
            current.clear();
        }
    }
    // A CLI executable or an error mentioning flags is not valid server help.
    if !entries.contains_key("--model") || !entries.contains_key("--listen-port") {
        return CliCapabilities::unknown();
    }
    let auto_fit = match entries.get("--auto-fit") {
        Some(description) if description.contains("on|off") => AutoFitSyntax::OnOff,
        Some(_) => AutoFitSyntax::Flag,
        None => AutoFitSyntax::Unsupported,
    };
    let memory_mode = if entries.contains_key("--disable-segmented-compute") {
        MemoryMode::Automatic
    } else if entries.contains_key("--stream-layers") {
        MemoryMode::Legacy
    } else {
        MemoryMode::Unknown
    };
    // Manual options lack a typed hint in upstream help. These consume a value.
    for name in [
        "--type",
        "--tensor-type-rules",
        "--rng",
        "--sampler-rng",
        "--prediction",
        "--lora-apply-mode",
        "--sampling-method",
        "--scheduler",
        "--log-level",
        "--linear-scale",
        "--attn-scale",
        // 上游 #1973/#2034 新增：--tokenizer 收路径（可能含逗号赋值），
        // --conditioning-cache-size 收整数；都按取值选项处理，避免把紧随其后的
        // 以 `--` 开头的值误判成开关。
        "--tokenizer",
        "--conditioning-cache-size",
        // 上游 #2132/#2134：注意力与卷积的自动选择模式串（on/off/auto 或模块赋值），
        // --batched-cfg 收 on/off。都按取值选项处理，避免把注入的取值当成开关。
        "--flash-attn",
        "--conv-direct",
        "--batched-cfg",
        // 审查 §2.9 补的三个结构化控件同样是取值型：--threads（含短别名 -t）、
        // --params-backend、--rpc-servers。漏登记会把紧随其后的取值当成开关，
        // 导致"未知参数"假警报或漏掉真问题。
        "--threads",
        "-t",
        "--params-backend",
        "--rpc-servers",
    ] {
        value_options.insert(name.into());
    }
    if auto_fit == AutoFitSyntax::OnOff {
        value_options.insert("--auto-fit".into());
    }
    CliCapabilities {
        executable: String::new(),
        version: None,
        verified: true,
        options: entries.into_keys().collect(),
        auto_fit,
        memory_mode,
        warnings: Vec::new(),
        value_options,
    }
}

#[derive(PartialEq)]
struct ProbeKey {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

fn probe_key(path: &Path) -> Option<ProbeKey> {
    let metadata = path.metadata().ok()?;
    Some(ProbeKey {
        path: path.to_path_buf(),
        size: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

struct CachedProbe {
    key: ProbeKey,
    at: Instant,
    capabilities: CliCapabilities,
}

async fn read_capped(reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(256 * 1024 + 1).read_to_end(&mut bytes).await?;
    Ok(bytes)
}

/// Bounded output and deadline; dropping a timeout must not leave a probe child
/// alive. A nonzero --help exit is allowed when its output is valid help.
async fn probe_output(exe: &Path, arg: &str) -> Option<(String, bool)> {
    let mut command = Command::new(exe);
    command
        .arg(arg)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let (out, err) = tokio::try_join!(read_capped(stdout), read_capped(stderr))?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((out, err, status.success()))
    })
    .await;
    match result {
        Ok(Ok((out, err, success))) if out.len() <= 256 * 1024 && err.len() <= 256 * 1024 => {
            Some((
                format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&out),
                    String::from_utf8_lossy(&err)
                ),
                success,
            ))
        }
        _ => {
            let _ = child.kill().await;
            None
        }
    }
}

/// Cache one successful probe, keyed by the resolved file and its metadata.
/// Short TTL also covers in-place replacements preserving file size/mtime.
///
/// 锁只保护缓存读写，探测本身在锁外（审查 10 §2.13）。旧实现用一把
/// `tokio::sync::Mutex` 横跨「两次 spawn 子进程（各 5s 超时）」整段持锁，
/// 于是 `inspect_server` / `preflight_server` / `start_server` 三条命令被串行化：
/// 前端切模型走 `preflight → start`，用户会看到最多约 10s 的无响应。
/// 缓存也从「单条 Option」改成按 exe 路径索引的 HashMap——在
/// `sd-server-cuda` / `sd-server-vulkan` 之间来回切时不会每次必然 miss。
pub async fn probe(exe: &Path) -> CliCapabilities {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedProbe>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = probe_key(exe);
    // 读缓存：短暂持锁，命中即返回。
    if let Some(key) = key.as_ref() {
        let hit = {
            let guard = cache.lock().await;
            guard.get(&key.path).and_then(|cached| {
                (*key == cached.key && cached.at.elapsed() < Duration::from_secs(30))
                    .then(|| cached.capabilities.clone())
            })
        };
        if let Some(caps) = hit {
            return caps;
        }
    }
    let (help, version) = tokio::join!(probe_output(exe, "--help"), probe_output(exe, "--version"));
    let mut caps = help
        .map(|(text, _)| parse_help(&text))
        .unwrap_or_else(CliCapabilities::unknown);
    caps.executable = exe.to_string_lossy().into_owned();
    caps.version = version
        .filter(|(_, success)| *success)
        .and_then(|(text, _)| {
            strip_ansi(&text)
                .lines()
                .find(|s| !s.trim().is_empty())
                .map(|s| s.trim().chars().take(200).collect())
        });
    // 用 `if let` 取代 `key.is_some() && key.unwrap()`（clippy
    // unnecessary_unwrap）：判空与取用之间不再有第二次解包，同时保留
    // 「两次 metadata 一致才缓存」的防护——探测结果继续返回给本次调用。
    if let (true, Some(key)) = (caps.verified, key) {
        if probe_key(exe).as_ref() == Some(&key) {
            let mut guard = cache.lock().await;
            guard.insert(
                key.path.clone(),
                CachedProbe {
                    key,
                    at: Instant::now(),
                    capabilities: caps.clone(),
                },
            );
        }
    }
    caps
}

/// Parse finite C99 scale overrides (including hex floats accepted by stof).
/// Validate in f32, matching sd_ctx_params_t, not only JavaScript/f64 precision.
pub fn parse_scale(raw: &str) -> Option<f32> {
    if raw.is_empty() || raw.trim() != raw {
        return None;
    }
    let negative = raw.starts_with('-');
    let unsigned = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let number = if let Some(hex) = unsigned
        .strip_prefix("0x")
        .or_else(|| unsigned.strip_prefix("0X"))
    {
        let (mantissa, exponent) = match hex.split_once(['p', 'P']) {
            Some((m, e)) => (m, e.parse::<i32>().ok()?),
            None => (hex, 0),
        };
        let mut value = 0.0f64;
        let mut fractional = false;
        let mut scale = 1.0;
        let mut digits = 0;
        for ch in mantissa.chars() {
            if ch == '.' && !fractional {
                fractional = true;
                continue;
            }
            let digit = ch.to_digit(16)? as f64;
            digits += 1;
            if fractional {
                scale /= 16.0;
                value += digit * scale;
            } else {
                value = value * 16.0 + digit;
            }
        }
        if digits == 0 {
            return None;
        }
        let value = value * 2f64.powi(exponent);
        if negative {
            -value
        } else {
            value
        }
    } else {
        raw.parse::<f64>().ok()?
    };
    let hex = unsigned.starts_with("0x") || unsigned.starts_with("0X");
    let mantissa = if hex {
        unsigned[2..].split(['p', 'P']).next()?
    } else {
        unsigned.split(['e', 'E']).next()?
    };
    let nonzero_mantissa = mantissa
        .chars()
        .any(|c| matches!(c, '1'..='9') || hex && matches!(c, 'a'..='f' | 'A'..='F'));
    let value = number as f32;
    if !number.is_finite()
        || number < 0.0
        || !value.is_finite()
        || nonzero_mantissa && (value == 0.0 || !(1.0f32 / value).is_finite())
    {
        return None;
    }
    Some(value)
}

/// Validate a `--flash-attn` / `--conv-direct` assignment string: `on|off|auto`
/// plus optional `module=on|off|auto` segments. Module names are left to the
/// kernel (it accepts backend-style aliases); only the mode token is checked
/// here so typos like `--flash-attn yes` are caught before launch.
fn validate_mode_spec(name: &str, spec: &str) -> Result<()> {
    if spec.trim().is_empty() {
        bail!("{} 需要 on、off、auto 或模块赋值。", name);
    }
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            bail!("{} 中存在空的赋值段：{}。", name, spec);
        }
        let mode = part.rsplit_once('=').map_or(part, |(_, mode)| mode.trim());
        if !matches!(mode.to_ascii_lowercase().as_str(), "on" | "off" | "auto") {
            bail!("{} 的取值必须为 on、off 或 auto：{}。", name, part);
        }
    }
    Ok(())
}

/// True when a `--flash-attn` assignment can enable flash attention for the
/// diffusion module (explicit `diffusion=` wins over the default segment).
fn flash_attn_selects_diffusion(spec: &str) -> bool {
    let mut default_mode = "auto";
    let mut diffusion_mode: Option<&str> = None;
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            Some((module, mode)) => {
                let module = module.trim().to_ascii_lowercase();
                let mode = mode.trim();
                if matches!(module.as_str(), "all" | "default" | "*") {
                    default_mode = mode;
                } else if matches!(module.as_str(), "diffusion" | "model" | "unet" | "dit") {
                    diffusion_mode = Some(mode);
                }
            }
            None => default_mode = part,
        }
    }
    !diffusion_mode
        .unwrap_or(default_mode)
        .eq_ignore_ascii_case("off")
}

/// Validate the *effective argv*, including extra_args after --key=value has
/// been normalized by server::build_args. Do not silently drop or migrate flags.
pub fn validate_args(args: &[String], caps: &CliCapabilities) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    let mut index = 0;
    let mut attention_override = false;
    // 上游 #2132：--flash-attn 取代 --fa / --diffusion-fa（后两者仍被接受并写同一
    // 模式串，最后一次出现生效）。这里只记录最终模式串，遍历结束后再判定
    // diffusion 模块是否可能启用 Flash Attention。
    let mut flash_attn_spec: Option<String> = None;
    // 上游 #1967 起只有 --params-backend 会关闭 auto-fit；显式 --backend 改为
    // 被 auto-fit 保留、用于约束计算设备，因此两者必须分开判定。
    let mut params_placement = false;
    let mut backend_placement = false;
    let mut auto_fit_on = false;
    while index < args.len() {
        let name = args[index].as_str();
        let value = args.get(index + 1).map(String::as_str);
        if name == "--backend" || name == "-b" {
            backend_placement = true;
        }
        if matches!(
            name,
            "--params-backend"
                | "--offload-to-cpu"
                | "--clip-on-cpu"
                | "--vae-on-cpu"
                | "--control-net-cpu"
        ) {
            params_placement = true;
        }
        if matches!(name, "--fa" | "--diffusion-fa") {
            flash_attn_spec = Some(if name == "--fa" {
                "on".into()
            } else {
                "off,diffusion=on".into()
            });
        }
        match name {
            "--stream-layers" if caps.supports(name) == Some(false) => {
                bail!("所选 sd-server 不支持 --stream-layers；新版已自动分段/预取，请从附加启动参数或该模型快照中删除它（不要替换为 --disable-prefetch）。");
            }
            "--auto-fit" => match caps.auto_fit {
                AutoFitSyntax::OnOff => {
                    if !matches!(value, Some("on" | "off")) {
                        bail!("新版 --auto-fit 必须写为 --auto-fit on 或 --auto-fit off；请更新附加启动参数中的旧裸开关。");
                    }
                    auto_fit_on = value == Some("on");
                }
                AutoFitSyntax::Flag if value.is_some_and(|s| !s.starts_with('-')) => {
                    bail!("所选旧版 sd-server 的 --auto-fit 是裸开关：开启请只写 --auto-fit；关闭请删除该开关，不要传 on/off。");
                }
                AutoFitSyntax::Unsupported => {
                    bail!("所选 sd-server 不支持 --auto-fit，请删除该参数或升级内核。")
                }
                _ => {}
            },
            "--log-level"
            | "--linear-scale"
            | "--attn-scale"
            | "--disable-prefetch"
            | "--disable-segmented-compute"
            | "--tokenizer"
            | "--sage-attn"
            | "--taesd-preview-only"
            | "--conditioning-cache-size" => {
                if caps.supports(name) == Some(false) {
                    bail!(
                        "所选 sd-server 不支持 {}；请清空对应设置/附加启动参数，或升级内核。",
                        name
                    );
                }
                if name == "--log-level"
                    && !matches!(value, Some("debug" | "verbose" | "info" | "warn" | "error"))
                {
                    bail!("--log-level 必须为 debug、verbose、info、warn 或 error。");
                }
                if matches!(name, "--linear-scale" | "--attn-scale") {
                    let parsed = value.and_then(parse_scale).ok_or_else(|| anyhow!("{} 必须为有限正数（或 0 保留模型默认），不能为负值、NaN、溢出或过小值。", name))?;
                    if name == "--attn-scale" {
                        attention_override = parsed > 0.0;
                    }
                }
                if name == "--conditioning-cache-size"
                    && !value
                        .is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
                {
                    bail!("--conditioning-cache-size 必须是非负整数（0 表示关闭条件缓存）。");
                }
            }
            "--flash-attn" | "--conv-direct" | "--batched-cfg" => {
                if caps.supports(name) == Some(false) {
                    // 结构化的 flash-attn 已在 server::start 里按能力回退到旧参数，
                    // 走到这里说明它是用户写在附加启动参数里的。
                    let hint = if name == "--flash-attn" {
                        "该内核请改用 --fa 或 --diffusion-fa"
                    } else {
                        "请删除该参数"
                    };
                    bail!("所选 sd-server 不支持 {}；{}。", name, hint);
                }
                let value = value.ok_or_else(|| anyhow!("{} 缺少取值。", name))?;
                if name == "--batched-cfg" {
                    if !matches!(value, "on" | "off") {
                        bail!("--batched-cfg 必须为 on 或 off。");
                    }
                } else {
                    validate_mode_spec(name, value)?;
                    if name == "--flash-attn" {
                        flash_attn_spec = Some(value.to_string());
                    }
                }
            }
            // 审查 §2.9 新增的三个结构化控件：形状校验放在这里，能力校验按长名
            // 查（-t 是 --threads 的短别名，help 里只有长名）。
            "--threads" | "-t" => {
                if caps.supports("--threads") == Some(false) {
                    bail!("所选 sd-server 不支持 --threads；请清空“计算线程数”或升级内核。");
                }
                let value = value.ok_or_else(|| anyhow!("{} 缺少取值。", name))?;
                if value.parse::<i64>().is_err() {
                    bail!("{} 必须为整数（<= 0 表示按 CPU 物理核数自动决定）。", name);
                }
            }
            "--params-backend" => {
                if caps.supports(name) == Some(false) {
                    bail!(
                        "所选 sd-server 不支持 --params-backend；请清空“参数驻留后端”或升级内核。"
                    );
                }
                let value = value.ok_or_else(|| anyhow!("{} 缺少取值。", name))?;
                if let Some(error) = crate::args::params_backend_spec_error(value) {
                    bail!("{}", error);
                }
            }
            "--rpc-servers" => {
                if caps.supports(name) == Some(false) {
                    bail!("所选 sd-server 不支持 --rpc-servers；请清空“RPC 服务器”或升级内核。");
                }
                let value = value.ok_or_else(|| anyhow!("{} 缺少取值。", name))?;
                if let Some(error) = crate::args::rpc_servers_spec_error(value) {
                    bail!("{}", error);
                }
            }
            // 上游 #2164：ADetailer 检测器。老内核只把该参数当 sd-cli 的配置，
            // sd-server 会直接报 unknown argument 退出；新内核则每次 img_gen
            // 后自动跑一遍检测 + 局部重绘（下面还会补一条提示）。
            // 用 match guard 而不是嵌套 if：新版 clippy 的 collapsible_match
            // 会把「单一 if + 空分支」判为可折叠，CI 上是 -D warnings。
            "--ad-model" if caps.supports(name) == Some(false) => {
                bail!("所选 sd-server 不支持 --ad-model（ADetailer）；请升级内核或移除该参数。");
            }
            _ => {}
        }
        // Typed value options must consume their value even if it starts with
        // '--': e.g. --prompt "--stream-layers" is text, not a removed flag.
        let takes_value = caps.value_options.contains(name)
            || matches!(
                name,
                "--model"
                    | "-m"
                    | "--diffusion-model"
                    | "--prompt"
                    | "-p"
                    | "--negative-prompt"
                    | "-n"
                    | "--backend"
                    | "-b"
                    | "--params-backend"
                    | "--max-vram"
                    | "--log-level"
                    | "--linear-scale"
                    | "--attn-scale"
                    | "--tokenizer"
                    | "--conditioning-cache-size"
                    | "--flash-attn"
                    | "--conv-direct"
                    | "--batched-cfg"
                    | "--threads"
                    | "-t"
                    | "--rpc-servers"
            )
            || name == "--auto-fit"
                && (caps.auto_fit == AutoFitSyntax::OnOff
                    || caps.auto_fit == AutoFitSyntax::Unknown
                        && matches!(value, Some("on" | "off")));
        index += if takes_value && value.is_some() { 2 } else { 1 };
    }
    // 新内核（声明了 --flash-attn）不写该参数时默认 auto，仍可能启用 Flash
    // Attention；旧内核不写就是关。能力未知时不猜，避免假警报。
    let flash_attention_possible = match flash_attn_spec.as_deref() {
        Some(spec) => flash_attn_selects_diffusion(spec),
        None => caps.supports("--flash-attn") != Some(false),
    };
    if attention_override && !flash_attention_possible {
        warnings.push(
            "attn-scale 仅在 Flash Attention 被选中（--flash-attn，或旧版 --fa / --diffusion-fa）且后端支持时生效。".into(),
        );
    }
    if auto_fit_on && params_placement {
        warnings.push(
            "显式 params-backend 或 CPU 卸载配置会关闭新版 auto-fit，即使指定 --auto-fit on。"
                .into(),
        );
    } else if auto_fit_on && backend_placement {
        warnings.push(
            "新版 auto-fit 会保留显式 --backend 作为计算设备分配，不再因它关闭 auto-fit（上游 #1967）。".into(),
        );
    }
    // 上游 #2164：`--ad-model` 不再只是 `-M adetailer` 的 CLI 配置——sd-server
    // 会给每次 img_gen 结束后的结果自动做检测 + 局部重绘（runtime.cpp 的
    // apply_server_adetailer）；请求体里的同名检测器字段反而不参与选检测器。
    // 界面本轮还没有这块控件，写进附加启动参数的用户必须在出图结果与耗时
    // 变化之前知道这件事（审查 docs/UPSTREAM-SYNC-2026-10-24.md §2.3）。
    if args
        .iter()
        .any(|arg| arg == "--ad-model" || arg.starts_with("--ad-model="))
    {
        warnings.push(
            "已配置 ADetailer 检测器（--ad-model）：内核会在每次图片生成后自动检测并局部重绘，出图结果与耗时会变化；当前界面没有该功能的控件，如非本意请从附加启动参数中移除。"
                .into(),
        );
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn help(extra: &str) -> String {
        format!("Options:\n  -m, --model <string>          model path\n  -p, --prompt <string>         prompt\n  --listen-port <int>           port\n{extra}")
    }
    fn old() -> CliCapabilities {
        parse_help(&help("  --stream-layers       stream weights\n  --auto-fit            pick placements\n  -v, --verbose         print extra info\n"))
    }
    fn new() -> CliCapabilities {
        parse_help(&help("  --auto-fit            on|off (default: on)\n  --disable-segmented-compute   force monolithic\n  --disable-prefetch    disable prefetch\n  --linear-scale        scale\n  --attn-scale          scale\n  --log-level           level\n  --tokenizer <string>  tokenizer.json path\n  --sage-attn           use native CUDA SageAttention\n  --taesd-preview-only  TAE for previews only\n  --ad-model <string>   ADetailer detector path\n  --conditioning-cache-size <int>   conditioning cache capacity\n  --flash-attn          on|off|auto or module assignments (default: auto)\n  --conv-direct         on|off|auto or diffusion/vae/controlnet assignments\n  --batched-cfg         on|off (default: on)\n  --params-backend      disk, cpu, or module=backend assignments\n  --rpc-servers         host:port list\n  -t, --threads <int>   thread count (<=0 uses physical cores)\n"))
    }
    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn distinguishes_legacy_and_current_help() {
        assert!(old().verified);
        assert_eq!(old().auto_fit, AutoFitSyntax::Flag);
        assert_eq!(old().memory_mode, MemoryMode::Legacy);
        assert_eq!(new().auto_fit, AutoFitSyntax::OnOff);
        assert_eq!(new().memory_mode, MemoryMode::Automatic);
    }
    #[test]
    fn mentions_and_wrapped_descriptions_are_not_declarations() {
        let caps = parse_help(&help("  --auto-fit    pick placements\n                   --linear-scale is mentioned, not declared\n"));
        assert_eq!(caps.supports("--linear-scale"), Some(false));
        let caps = parse_help(&help(
            "  --example     --linear-scale is only a description\n",
        ));
        assert_eq!(caps.supports("--linear-scale"), Some(false));
        let caps = parse_help(&help(
            "  --auto-fit    accepts\n                   on|off (default: on)\n",
        ));
        assert_eq!(caps.auto_fit, AutoFitSyntax::OnOff);
    }
    #[test]
    fn invalid_help_is_unknown_not_unsupported() {
        let caps = parse_help("error: unknown argument --linear-scale\n  --help  usage");
        assert!(!caps.verified);
        assert_eq!(caps.supports("--linear-scale"), None);
        assert!(validate_args(&argv(&["--stream-layers"]), &caps).is_ok());
    }
    #[test]
    fn preserves_legacy_flags_but_explains_new_syntax() {
        assert!(validate_args(&argv(&["--auto-fit", "--stream-layers"]), &old()).is_ok());
        assert!(validate_args(&argv(&["--auto-fit", "on"]), &old())
            .unwrap_err()
            .to_string()
            .contains("旧版"));
        assert!(validate_args(&argv(&["--auto-fit"]), &new())
            .unwrap_err()
            .to_string()
            .contains("on 或"));
        assert!(validate_args(&argv(&["--stream-layers"]), &new())
            .unwrap_err()
            .to_string()
            .contains("删除"));
        assert!(validate_args(&argv(&["--auto-fit", "off"]), &new()).is_ok());
    }
    #[test]
    fn validates_every_occurrence_and_skips_literal_prompt_values() {
        assert!(validate_args(
            &argv(&["--prompt", "--stream-layers", "--auto-fit", "on"]),
            &new()
        )
        .is_ok());
        assert!(validate_args(
            &argv(&["--linear-scale", "1", "--linear-scale", "nan"]),
            &new()
        )
        .is_err());
        assert!(validate_args(&argv(&["--auto-fit", "off", "--auto-fit"]), &new()).is_err());
    }
    #[test]
    fn rejects_new_options_on_old_executables() {
        for flag in [
            "--log-level",
            "--linear-scale",
            "--attn-scale",
            "--disable-prefetch",
            "--disable-segmented-compute",
        ] {
            assert!(validate_args(&argv(&[flag, "1"]), &old())
                .unwrap_err()
                .to_string()
                .contains("不支持"));
        }
        assert!(validate_args(&argv(&["--verbose"]), &old()).is_ok());
    }
    #[test]
    fn scale_values_match_float_context_constraints() {
        for value in ["0", "-0", "1", "0.0078125", "1e-3", "+.5", "0x1p-7"] {
            assert!(parse_scale(value).is_some(), "{value}");
        }
        assert_eq!(parse_scale("0x1p-7"), Some(0.0078125));
        for value in [
            "",
            "-1",
            "-0x1p-7",
            "NaN",
            "inf",
            "1e39",
            "1e-50",
            "1e-40",
            "1e-999",
            "0x1p-9999",
            "1.0junk",
            "0x.p1",
            " 1",
        ] {
            assert!(parse_scale(value).is_none(), "{value}");
        }
    }
    #[test]
    fn explains_attention_and_auto_fit_conflicts() {
        // --flash-attn off 才让 attn-scale 的提示成立（新内核默认 auto）。
        let warnings = validate_args(
            &argv(&[
                "--attn-scale",
                "0.5",
                "--flash-attn",
                "off",
                "--auto-fit",
                "on",
                "--offload-to-cpu",
            ]),
            &new(),
        )
        .unwrap();
        assert_eq!(warnings.len(), 2);
        assert!(
            validate_args(&argv(&["--attn-scale", "0.5", "--fa"]), &new())
                .unwrap()
                .is_empty()
        );
    }

    /// 上游 #1967：只有 --params-backend（含 CPU 卸载）会关闭 auto-fit；
    /// 显式 --backend 现在被 auto-fit 保留为计算设备分配，不能再报"会关闭"。
    #[test]
    fn distinguishes_backend_from_params_backend_for_auto_fit() {
        let warns_about_closing = |args: &[&str]| {
            validate_args(&argv(args), &new())
                .unwrap()
                .iter()
                .any(|w| w.contains("关闭新版 auto-fit"))
        };
        let warns_about_preserving = |args: &[&str]| {
            validate_args(&argv(args), &new())
                .unwrap()
                .iter()
                .any(|w| w.contains("保留显式 --backend"))
        };

        let backend_only = ["--auto-fit", "on", "--backend", "cuda0"];
        assert!(!warns_about_closing(&backend_only));
        assert!(warns_about_preserving(&backend_only));

        let params_backend = ["--auto-fit", "on", "--params-backend", "cpu"];
        assert!(warns_about_closing(&params_backend));
        assert!(!warns_about_preserving(&params_backend));

        let offload = ["--auto-fit", "on", "--offload-to-cpu"];
        assert!(warns_about_closing(&offload));
        assert!(!warns_about_preserving(&offload));

        // 两者同时出现时只报"关闭"，避免同一条命令给两条互相矛盾的提示。
        let both = [
            "--auto-fit",
            "on",
            "--backend",
            "cuda0",
            "--params-backend",
            "cpu",
        ];
        assert!(warns_about_closing(&both));
        assert!(!warns_about_preserving(&both));
    }

    /// 上游新增的启动参数在老内核上会被拒绝（"unknown argument"），必须在
    /// 送进 argv 之前报出来，而不是让 sd-server 直接退出。
    #[test]
    fn rejects_new_options_on_kernels_that_do_not_declare_them() {
        let old_help = help("  --stream-layers       stream weights\n");
        let old_caps = parse_help(&old_help);
        let old_cases: [&[&str]; 5] = [
            &["--tokenizer", "/models/tokenizer.json"],
            &["--sage-attn"],
            &["--taesd-preview-only"],
            &["--ad-model", "face.safetensors"],
            &["--conditioning-cache-size", "4"],
        ];
        for args in old_cases {
            let err = validate_args(&argv(args), &old_caps).unwrap_err();
            assert!(
                err.to_string().contains("不支持"),
                "{} 应报不支持：{err}",
                args[0]
            );
        }

        // 新内核上放行，并校验条件缓存必须是非负整数。
        let new_caps = new();
        let new_cases: [&[&str]; 5] = [
            &["--tokenizer", "/models/tokenizer.json"],
            &["--sage-attn"],
            &["--taesd-preview-only"],
            &["--ad-model", "face.safetensors"],
            &["--conditioning-cache-size", "0"],
        ];
        for args in new_cases {
            assert!(validate_args(&argv(args), &new_caps).is_ok(), "{args:?}");
        }
        assert!(
            validate_args(&argv(&["--conditioning-cache-size", "-1"]), &new_caps)
                .unwrap_err()
                .to_string()
                .contains("非负整数")
        );
        // help 不可判定（Unknown）时按"不静默丢弃"处理：透传不报错。
        let unknown = CliCapabilities::unknown();
        assert!(validate_args(&argv(&["--tokenizer", "/x.json"]), &unknown).is_ok());
    }

    /// 上游 #2132：--flash-attn 取代 --fa / --diffusion-fa。旧的裸开关仍被接受，
    /// 新的模式串只校验取值；老内核上的 --flash-attn 必须报"不支持"而不是让
    /// sd-server 启动即退。
    #[test]
    fn validates_flash_attention_modes_and_legacy_aliases() {
        let legit = [
            vec!["--flash-attn", "on"],
            vec!["--flash-attn", "off"],
            vec!["--flash-attn", "auto"],
            vec!["--flash-attn", "off,diffusion=on"],
            vec!["--flash-attn", "auto,te=off,vae=on"],
            vec!["--flash-attn", "all=on,default=off"],
            vec!["--fa"],
            vec!["--diffusion-fa"],
        ];
        for args in &legit {
            assert!(validate_args(&argv(args), &new()).is_ok(), "{args:?}");
        }
        for bad in ["yes", "", "on,", "diffusion", "diffusion=maybe"] {
            let args = ["--flash-attn", bad];
            let err = validate_args(&argv(&args), &new()).unwrap_err();
            assert!(
                err.to_string().contains("on、off") || err.to_string().contains("空"),
                "{bad:?}：{err}"
            );
        }
        // 老内核：结构化参数由 server::start 回退，这里报出用户写进附加参数的场景。
        let old_caps = parse_help(&help("  --stream-layers       stream weights\n"));
        let err = validate_args(&argv(&["--flash-attn", "on"]), &old_caps).unwrap_err();
        assert!(err.to_string().contains("不支持"), "{err}");
        assert!(err.to_string().contains("--fa"), "{err}");
        // --conv-direct / --batched-cfg 同样只接受合法取值。
        assert!(validate_args(&argv(&["--conv-direct", "auto,vae=off"]), &new()).is_ok());
        assert!(validate_args(&argv(&["--conv-direct", "vae"]), &new()).is_err());
        assert!(validate_args(&argv(&["--batched-cfg", "on"]), &new()).is_ok());
        assert!(validate_args(&argv(&["--batched-cfg", "auto"]), &new()).is_err());
    }

    /// attn-scale 只在 diffusion 模块**确定**关掉 Flash Attention 时才有意义：
    /// 新内核不写 --flash-attn 即 auto（可能启用），不能报警；旧内核不写就是关。
    #[test]
    fn attn_scale_warning_follows_effective_flash_attention_mode() {
        let warns_with = |caps: &CliCapabilities, args: &[&str]| {
            validate_args(&argv(args), caps)
                .unwrap()
                .iter()
                .any(|w| w.contains("attn-scale"))
        };
        let new_caps = new();
        // 新内核默认 auto：不写 --flash-attn 时不再误报"不生效"。
        assert!(!warns_with(&new_caps, &["--attn-scale", "0.5"]));
        assert!(!warns_with(
            &new_caps,
            &["--attn-scale", "0.5", "--flash-attn", "on"]
        ));
        assert!(!warns_with(
            &new_caps,
            &["--attn-scale", "0.5", "--flash-attn", "auto"]
        ));
        assert!(!warns_with(
            &new_caps,
            &["--attn-scale", "0.5", "--flash-attn", "off,diffusion=on"]
        ));
        assert!(warns_with(
            &new_caps,
            &["--attn-scale", "0.5", "--flash-attn", "off"]
        ));
        assert!(warns_with(
            &new_caps,
            &["--attn-scale", "0.5", "--flash-attn", "off,diffusion=off"]
        ));
        // 上游语义：多个写法写同一模式串，最后一次生效。
        assert!(warns_with(
            &new_caps,
            &[
                "--attn-scale",
                "0.5",
                "--flash-attn",
                "off,diffusion=on",
                "--flash-attn",
                "off",
            ]
        ));
        // 旧内核（声明了 --attn-scale、没有 --flash-attn）不写开关时默认关。
        let old_caps = parse_help(&help(
            "  --stream-layers       stream weights\n  --attn-scale          scale\n",
        ));
        assert!(warns_with(&old_caps, &["--attn-scale", "0.5"]));
        assert!(!warns_with(&old_caps, &["--attn-scale", "0.5", "--fa"]));
        assert!(!warns_with(
            &old_caps,
            &["--attn-scale", "0.5", "--diffusion-fa"]
        ));
        // scale 为 0 表示保留模型默认，不产生提示。
        assert!(!warns_with(&new_caps, &["--attn-scale", "0"]));
    }

    /// 上游 #2164：`--ad-model` 会让 sd-server 在每次 img_gen 后自动检测 +
    /// 局部重绘。界面还没有这块控件，写进附加启动参数的人必须在启动前收到
    /// 提示，否则出图结果和耗时会莫名变化。
    #[test]
    fn warns_about_the_automatic_adetailer_pass() {
        let warns = |args: &[&str]| {
            validate_args(&argv(args), &new())
                .unwrap()
                .iter()
                .any(|w| w.contains("ADetailer"))
        };
        assert!(warns(&["--ad-model", "face_yolov8n.safetensors"]));
        assert!(warns(&["--ad-model=D:/models/face_yolov8n.safetensors"]));
        assert!(!warns(&["--prompt", "no detector here"]));
    }
}
