//! 启动参数拼装与校验（审查 10-backend §2.22：从 server.rs 抽出）。
//!
//! 这些函数只做「JSON 设置 → sd-server argv」的纯变换与静态校验，不碰进程：
//! 拼装（`build_args`）、分词（`split_args`）、路径/显存/后端三类校验、
//! 以及组件目录与 FlashAttention 的内核适配。副作用只有读文件系统做存在性检查。

use anyhow::{anyhow, Result};
use std::fs;
use std::path::Path;

pub(crate) fn format_num(n: &serde_json::Number) -> String {
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
pub(crate) fn split_args(input: &str) -> Result<Vec<String>> {
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
        anyhow::bail!("附加启动参数里有未闭合的引号。请检查参数里的双引号/单引号是否成对。");
    }
    Ok(tokens)
}

/// sd-server 参数中"值是文件路径"的参数名（与上游 common.cpp 的 ArgOptions
/// 对齐）。只有这些键（以及 -dir/_dir 结尾的目录键）才做存在性校验——
/// 旧的启发式（值含 '/'、'\\' 或带扩展名）会把 `1.5` 之类的数值误判为路径
/// 并要求其存在（对抗性审查 C）。
pub(crate) const PATH_VALUE_ARGS: &[&str] = &[
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
    // 刻意不含 `ad-model`：ADetailer 只有 `-M adetailer` 的 CLI 模式，
    // `--ad-model` 被 common 解析后无人消费（HTTP 面是死键），列在这里做
    // 存在性校验只会给出「被支持」的假信号（审查 S-2d / 40-cli-families
    // §2.7）。
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

pub(crate) fn is_path_arg(key: &str) -> bool {
    key.ends_with("-dir") || key.ends_with("_dir") || PATH_VALUE_ARGS.contains(&key)
}

/// 「由 launcher 独占」的监听参数：上游 `runtime.cpp` 里 `--listen-ip` 的
/// 名字是 `{"-l", "--listen-ip", ...}` —— **短别名 `-l` 存在**。只判长名会
/// 让用户从上游 `--help` 原样粘来的 `-l 0.0.0.0` 一路透传；上游
/// `common.cpp` 对同名选项是覆盖赋值，最终绑定 0.0.0.0，而 `/sdcpp/v1`
/// 没有任何鉴权，界面却仍写着「监听 127.0.0.1」（审查 S-1）。
pub(crate) const LISTEN_OVERRIDE_FLAGS: &[&str] = &["-l", "--listen-ip", "--listen-port"];

/// 精确匹配 flag 本身或 `flag=value` 形式。`-log-level` 这类以 `-l` 开头的
/// 其它 token 不会被误伤（后缀不是 `=` 开头）。
pub(crate) fn is_listen_override(token: &str) -> bool {
    LISTEN_OVERRIDE_FLAGS.iter().any(|flag| {
        token == *flag
            || token
                .strip_prefix(flag)
                .is_some_and(|rest| rest.starts_with('='))
    })
}

pub(crate) fn validate_path_arg(key: &str, value: &str) -> Result<()> {
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
        anyhow::bail!(
            "--{} 指向的路径不存在：{}。请在设置里重新选择该文件/目录。",
            key,
            value
        );
    }
    if is_dir_arg && !path.is_dir() {
        anyhow::bail!("--{} expects a directory: {}", key, value);
    }
    Ok(())
}

/// Downgrade the structured `--flash-attn` launch argument for kernels that do
/// not declare it (upstream #2132). Only the two values Lumina emits have an
/// exact legacy equivalent, and only the structured key is rewritten — a
/// `--flash-attn` typed into extra_args is left for cli::validate_args to reject
/// with a readable message instead of being silently migrated.
pub(crate) fn adapt_flash_attn_for_kernel(
    args: &mut serde_json::Value,
    cli: &crate::cli::CliCapabilities,
) -> Option<String> {
    if cli.supports("--flash-attn") != Some(false) {
        return None;
    }
    let value = args.get("flash-attn")?.as_str()?.to_string();
    let legacy = match value.as_str() {
        "off,diffusion=on" => Some(("diffusion-fa", "--diffusion-fa")),
        "on" => Some(("fa", "--fa")),
        _ => None,
    };
    let Some((key, flag)) = legacy else {
        args.as_object_mut()?.remove("flash-attn");
        return Some(format!(
            "所选 sd-server 不支持 --flash-attn，已忽略该参数（{}）；请升级内核以指定注意力模式。",
            value
        ));
    };
    let object = args.as_object_mut()?;
    object.remove("flash-attn");
    object.insert(key.into(), serde_json::Value::Bool(true));
    Some(format!(
        "所选 sd-server 不支持 --flash-attn，已回退到 {}（语义等价）。",
        flag
    ))
}

pub(crate) fn build_args(args: &serde_json::Value, port: u16) -> Result<Vec<String>> {
    let mut out = vec![
        "--listen-port".into(),
        port.to_string(),
        "--listen-ip".into(),
        "127.0.0.1".into(),
    ];
    if let Some(obj) = args.as_object() {
        // Explicit extra args are last, so their precedence is consistent for
        // all options (not dependent on serde_json's alphabetical map order).
        for (key, val) in obj
            .iter()
            .filter(|(key, _)| key.as_str() != "extra_args")
            .chain(obj.iter().filter(|(key, _)| key.as_str() == "extra_args"))
        {
            if key == "extra_args" {
                if let Some(s) = val.as_str() {
                    let tokens = split_args(s)?;
                    for (i, t) in tokens.iter().enumerate() {
                        // The launcher owns the listen address: it proxies every
                        // API call to `port`, so an override buried in the extra
                        // args would silently point sd-server somewhere the GUI
                        // never talks to.  Also reject the `--flag=value` form —
                        // a literal comparison alone could be bypassed.
                        // 上游 `--listen-ip` 的短别名 `-l` 与长名同等拦截
                        // （审查 S-1：漏掉它就能把 sd-server 暴露到局域网）。
                        if is_listen_override(t) {
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

/// 根目录里 ≤ 该大小的 embedding 类文件视为用户真实放置的 embedding
/// （扁平布局）；模型权重动辄数百 MB 以上，不会命中。
pub(crate) const EMBEDDING_SMALL_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 目录顶层是否存在"小"的 embedding 类文件（.gguf/.safetensors/.pt/.ckpt）。
pub(crate) fn dir_has_small_embedding_files(dir: &Path) -> bool {
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
pub(crate) fn refine_component_dirs(args: &mut serde_json::Value) {
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

/// 从 backend spec 提取需要校验的设备名 token。上游
/// `sd_parse_backend_assignment`（ggml_extend_backend.cpp）的格式：
/// 逗号分段，`key=value` 中 **value 是后端名**（key 是模块名
/// all/default/*/te/clip/llm/...），无 `=` 的段本身就是后端名。
/// 只校验 value / 裸 token；key 侧的非法模块名由上游启动时报出。
///
/// value 还可以是 `&` 分隔的多设备列表（如 `diffusion=cuda0&cuda1`，
/// 上游 `split_device_list` / ArgOptions 的 `--backend` 示例）。这里先
/// 拆成单设备 token 再逐个校验，避免把整个列表当一个名字误杀。
pub(crate) fn backend_spec_tokens(spec: &str) -> Vec<String> {
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
pub(crate) const UNPROBABLE_BACKEND_TOKENS: &[&str] =
    &["", "default", "auto", "gpu", "cpu", "metal", "blas"];

/// 单个 token 是否需要经 `--list-devices` 设备列表校验。只校验**以数字
/// 结尾**的 token（cuda0/rocm2/vulkan1 这类带编号设备名）：上游
/// `sd_backend_resolve_name` 除设备名外还接受 registry 名（CUDA/ROCm/
/// Vulkan/SYCL/MUSA/OpenCL/Metal/…，大小写不敏感），这些名字不会以数字
/// 结尾、也不出现在设备列表里，旧实现会对它们整体误报。registry 名与
/// 其他非编号 token 交给上游启动时校验（审查 P2）。
pub(crate) fn backend_token_needs_probe(token: &str) -> bool {
    let token = token.trim();
    if token.is_empty() || UNPROBABLE_BACKEND_TOKENS.contains(&token.to_ascii_lowercase().as_str())
    {
        return false;
    }
    token.ends_with(|c: char| c.is_ascii_digit())
}

/// spec 里是否存在需要探测的设备 token。
pub(crate) fn backend_spec_needs_probe(spec: &str) -> bool {
    backend_spec_tokens(spec)
        .iter()
        .any(|token| backend_token_needs_probe(token))
}

/// 不依赖设备探测的结构性校验（上游 SDBackendManager::validate）：
/// - `disk` 仅 params_backend 接受，出现在 --backend 里启动即退；
/// - `&` 设备列表内不允许 default/auto 这类默认 token。
pub(crate) fn backend_spec_static_error(spec: &str) -> Option<String> {
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

/// 结构性校验 `--params-backend`（上游 `sd_parse_backend_assignment`，
/// ggml_extend_backend.cpp）：逗号分段的 `[模块=]后端`。模块名交给上游判定
/// （与 `--backend` 同口径，见 [`backend_spec_tokens`] 的注释），这里只拦上游
/// 必然拒绝的形状——空模块/空后端，以及该参数明确不接受的 `&` 设备列表
/// （上游 docs/backend.md："`--params-backend` accepts no device lists"）。
/// `disk` 是这个参数独有的合法值，因此**不能**复用
/// [`backend_spec_static_error`]（那里 disk 是错误）。
pub(crate) fn params_backend_spec_error(spec: &str) -> Option<String> {
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part.contains('&') {
            return Some(format!(
                "--params-backend 不接受设备列表（& 分隔），只能写单个后端：{}",
                part
            ));
        }
        if let Some((key, value)) = part.split_once('=') {
            if key.trim().is_empty() || value.trim().is_empty() {
                return Some(format!(
                    "--params-backend 应为 模块=后端 或单个后端名：{}",
                    part
                ));
            }
        }
    }
    None
}

/// 校验 `--rpc-servers` 的 `host:port` 形状。上游 `add_rpc_devices`
/// （ggml_extend_backend.cpp）把每一项原样交给 `ggml_backend_rpc_add_server`：
/// 连不上只打日志、不中止启动，写错的端口表现成“多机显卡没出现”，很难自查。
/// 端口范围与 `server::validate_port` 一致。
pub(crate) fn rpc_servers_spec_error(spec: &str) -> Option<String> {
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let malformed = || {
            Some(format!(
                "--rpc-servers 应为 host:port，如 localhost:50052：{}",
                part
            ))
        };
        let (host, port) = match part.strip_prefix('[') {
            Some(rest) => match rest.split_once("]:") {
                Some((host, port)) => (host, port),
                None => return malformed(),
            },
            None => match part.rsplit_once(':') {
                Some((host, port)) => (host, port),
                None => return malformed(),
            },
        };
        if host.is_empty()
            || part.chars().any(char::is_whitespace)
            // 非方括号写法里出现冒号说明是 IPv6 却没加方括号。
            || (host.contains(':') && !part.starts_with('['))
        {
            return malformed();
        }
        let ok = !port.is_empty()
            && port.len() <= 5
            && port.chars().all(|c| c.is_ascii_digit())
            && port.parse::<u16>().map(|p| p > 0).unwrap_or(false);
        if !ok {
            return Some(format!("--rpc-servers 端口必须在 1–65535 之间：{}", part));
        }
    }
    None
}

/// extra_args 中某个“取值型”参数的全部出现值（可能出现多次，逐次校验）。
/// 识别 `--key value`、`--key=value` 两种形式，以及 `-b` / `-b=value` 短
/// 别名（上游 ArgOptions 的 `-m`/`--model` 模式）。布尔 flag（无值）与
/// 其他参数一律跳过：下一个词元以 `-` 开头时不视为值，与 build_args 的
/// 路径校验口径一致。
pub(crate) fn extra_arg_values(tokens: &[String], names: &[&str]) -> Vec<String> {
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
pub(crate) fn parse_strict_vram_number(s: &str) -> Option<f64> {
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
pub(crate) fn is_valid_vram_device(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '*' | '-'))
}

/// 预校验 `--max-vram` 原始 spec（上游 ggml_graph_cut 解析失败会让
/// sd-server 启动即退，GUI 提前拦截给出可读错误）。与前端
/// `validateMaxVramSpec` 对齐：逗号分段，无 `=` 的段是全局默认预算
/// （后写覆盖先写），`设备=数值` 段设置单设备预算，空段跳过。
pub(crate) fn validate_max_vram_spec(spec: &str) -> Result<()> {
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
pub(crate) fn find_backend_error(spec: &str, devices_output: &str) -> Option<String> {
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
