//! Version-sensitive sd-server CLI preflight. Never rewrites saved settings or
//! guesses support from Lumina's version: inspect the selected executable.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
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

    fn supports(&self, name: &str) -> Option<bool> {
        self.verified
            .then(|| self.options.iter().any(|s| s == name))
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
pub async fn probe(exe: &Path) -> CliCapabilities {
    static CACHE: OnceLock<Mutex<Option<CachedProbe>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    let key = probe_key(exe);
    if let (Some(key), Some(cached)) = (&key, cache.as_ref()) {
        if *key == cached.key && cached.at.elapsed() < Duration::from_secs(30) {
            return cached.capabilities.clone();
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
    if caps.verified && key.is_some() && key == probe_key(exe) {
        *cache = Some(CachedProbe {
            key: key.unwrap(),
            at: Instant::now(),
            capabilities: caps.clone(),
        });
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

/// Validate the *effective argv*, including extra_args after --key=value has
/// been normalized by server::build_args. Do not silently drop or migrate flags.
pub fn validate_args(args: &[String], caps: &CliCapabilities) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    let mut index = 0;
    let mut attention_override = false;
    let mut flash_attention = false;
    let mut manual_placement = false;
    let mut auto_fit_on = false;
    while index < args.len() {
        let name = args[index].as_str();
        let value = args.get(index + 1).map(String::as_str);
        if matches!(
            name,
            "--backend"
                | "-b"
                | "--params-backend"
                | "--offload-to-cpu"
                | "--clip-on-cpu"
                | "--vae-on-cpu"
                | "--control-net-cpu"
        ) {
            manual_placement = true;
        }
        if matches!(name, "--fa" | "--diffusion-fa") {
            flash_attention = true;
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
            | "--disable-segmented-compute" => {
                if caps.supports(name) == Some(false) {
                    bail!(
                        "所选 sd-server 不支持 {}；请清空对应诊断设置/附加启动参数，或升级内核。",
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
            )
            || name == "--auto-fit"
                && (caps.auto_fit == AutoFitSyntax::OnOff
                    || caps.auto_fit == AutoFitSyntax::Unknown
                        && matches!(value, Some("on" | "off")));
        index += if takes_value && value.is_some() { 2 } else { 1 };
    }
    if attention_override && !flash_attention {
        warnings.push(
            "attn-scale 仅在启用 --fa / --diffusion-fa 且后端支持 Flash Attention 时生效。".into(),
        );
    }
    if auto_fit_on && manual_placement {
        warnings.push("显式 backend / params-backend 或 CPU 卸载配置会关闭新版 auto-fit，即使指定 --auto-fit on。".into());
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
        parse_help(&help("  --auto-fit            on|off (default: on)\n  --disable-segmented-compute   force monolithic\n  --disable-prefetch    disable prefetch\n  --linear-scale        scale\n  --attn-scale          scale\n  --log-level           level\n"))
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
        let warnings = validate_args(
            &argv(&[
                "--attn-scale",
                "0.5",
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
}
