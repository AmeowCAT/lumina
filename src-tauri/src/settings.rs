use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Persisted launcher settings (mirrors the webui `Settings` struct).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub exe_dir: String,
    #[serde(default)]
    pub model_dir: String,
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub ref_image_preset: String,
    #[serde(default)]
    pub vae_format: String,
    /// 外部 HuggingFace tokenizer.json（--tokenizer）；PiD / Lens / LLaDA-Image 必需。
    #[serde(default)]
    pub tokenizer: String,
    /// 原生 CUDA SageAttention（--sage-attn）。
    #[serde(default)]
    pub sage_attn: bool,
    /// 条件结果缓存上限（--conditioning-cache-size）；空 = 走内核默认。
    #[serde(default)]
    pub conditioning_cache_size: String,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub offload_cpu: bool,
    #[serde(default)]
    pub quant_type: String,
    /// Raw --max-vram spec; empty = 启动时不传该参数。
    #[serde(default)]
    pub max_vram: String,
    /// Startup diagnostics; absent/empty fields preserve the executable defaults.
    #[serde(default)]
    pub log_level: String,
    #[serde(default)]
    pub linear_scale: String,
    #[serde(default)]
    pub attn_scale: String,
    #[serde(default = "default_max_queue_size")]
    pub max_queue_size: u32,
    /// Port sd-server listens on. Configurable from the dashboard; older
    /// settings files without this key fall back to the historical 1234.
    #[serde(default = "default_sd_port")]
    pub sd_port: u16,
    #[serde(default)]
    pub model_snapshots: HashMap<String, ModelConfigSnapshot>,
    /// 配置文件结构版本（迁移用）。旧文件没有该键 → 0；任何一次写入都会补成
    /// [`CURRENT_SCHEMA_VERSION`]，后续迁移函数表按此值选择升级路径
    /// （审查 S-6 / 2.15）。
    #[serde(default)]
    pub schema_version: u32,
    /// 生成完成后自动把结果落盘到输出目录（审查 S-5）。
    ///
    /// **默认关**（用户确认的产品意图）：未显式打开前不会向输出目录写入任何东西，
    /// 避免"我只想看看"变成磁盘上的惊喜。打开后若未配置输出目录，前端会跳过——
    /// 后端 `save_output` 会以「no output dir」拒绝。
    /// 只属于全局行为，`ModelConfigSnapshot` 是「每个模型的启动配置」，不包含该项。
    #[serde(default)]
    pub auto_save_results: bool,
}

/// Hand-written so that `Settings::default()` (used on a corrupt/missing file)
/// agrees with the serde `#[serde(default = …)]` fallbacks — a derived Default
/// would hand out `max_queue_size: 0` / `sd_port: 0`.
impl Default for Settings {
    fn default() -> Self {
        Self {
            exe_dir: String::new(),
            model_dir: String::new(),
            output_dir: String::new(),
            backend: String::new(),
            ref_image_preset: String::new(),
            vae_format: String::new(),
            tokenizer: String::new(),
            sage_attn: false,
            conditioning_cache_size: String::new(),
            extra_args: String::new(),
            offload_cpu: false,
            quant_type: String::new(),
            max_vram: String::new(),
            log_level: String::new(),
            linear_scale: String::new(),
            attn_scale: String::new(),
            max_queue_size: default_max_queue_size(),
            sd_port: default_sd_port(),
            model_snapshots: HashMap::new(),
            schema_version: 0,
            auto_save_results: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfigSnapshot {
    #[serde(default)]
    pub family_override: String,
    #[serde(default)]
    pub components: HashMap<String, String>,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub ref_image_preset: String,
    #[serde(default)]
    pub vae_format: String,
    /// 外部 tokenizer.json（--tokenizer），与顶层同名设置一致。
    #[serde(default)]
    pub tokenizer: String,
    /// 原生 CUDA SageAttention（--sage-attn）。
    #[serde(default)]
    pub sage_attn: bool,
    /// 条件结果缓存上限（--conditioning-cache-size）。
    #[serde(default)]
    pub conditioning_cache_size: String,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub offload_cpu: bool,
    #[serde(default)]
    pub quant_type: String,
    /// Raw --max-vram spec; empty = 启动时不传该参数。
    #[serde(default)]
    pub max_vram: String,
    /// Startup diagnostics; absent/empty fields preserve the executable defaults.
    #[serde(default)]
    pub log_level: String,
    #[serde(default)]
    pub linear_scale: String,
    #[serde(default)]
    pub attn_scale: String,
    #[serde(default = "default_max_queue_size")]
    pub max_queue_size: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Keeps the original settings fields at the top level for older frontends,
/// while exposing a recoverable startup warning to newer clients.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    #[serde(flatten)]
    pub settings: Settings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_warning: Option<SettingsWarning>,
}

pub struct LoadedSettings {
    pub settings: Settings,
    pub warning: Option<SettingsWarning>,
}

fn default_max_queue_size() -> u32 {
    4
}

/// 当前配置文件结构版本。写盘时低于该值的文件会被补成它（迁移由后续
/// 版本按 `schemaVersion` 展开）。
const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Historical sd-server port — the value the upstream webui also defaults to.
pub fn default_sd_port() -> u16 {
    crate::server::DEFAULT_SD_PORT
}

fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("lumina");
    p.push("settings.json");
    p
}

/// Pre-rename config location ("sdcpp-gui"), read-only for migration.
fn legacy_config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("sdcpp-gui");
    p.push("settings.json");
    p
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// `output_dir` 校验：它是 `save_output` / `read_file_b64` /
/// `list_output_files` / `delete_output_file` 的白名单根
/// （`lib::dir_is_within`），因此不能让 webview 用一次 `save_settings` 把它
/// 指向任意位置——否则「目录必须位于已配置的输出目录内」这条控制项等于自
/// 证（审查 S-2）。
///
/// - 空串（含纯空白）保留「未配置」语义：此时所有读写命令一律被拒，不能
///   因为清空配置而被阻断。
/// - 其余必须是绝对路径、且不含 `..` 分量与 NUL：相对路径会让前缀比较失去
///   意义，`..` 是词法逃逸的入口。
///
/// 这里不要求目录已存在：用户可以预先配置一个稍后才创建的目录，而且
/// `save_output` 自己会 `create_dir_all`。
pub fn validate_output_dir(dir: &str) -> Result<()> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.contains('\0') {
        anyhow::bail!("输出目录包含非法字符（NUL）：{}", dir);
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        anyhow::bail!("输出目录必须是绝对路径：{}", dir);
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        anyhow::bail!("输出目录不能包含 `..` 分量：{}", dir);
    }
    Ok(())
}

/// 把覆盖层（本次要写入的结构体序列化结果）合并进底层（磁盘上的旧 JSON）：
/// 覆盖层同名键胜出、对象递归合并、覆盖层没有的未知键原样保留。
///
/// 这样三个会静默丢配置的场景都被堵住（审查 S-6）：降级版本写的字段、
/// 「前端先加字段、Rust 后补」窗口期里的字段、以及 `save_settings({})` 这类
/// 部分载荷——后者的 `"modelSnapshots":{}` 在深合并后**不会**清空用户为每个
/// 模型手调的家族/组件/VAE 配置。
fn merge_json(base: &mut serde_json::Value, overlay: serde_json::Value) {
    match (base, overlay) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                match base_map.get_mut(&key) {
                    // 两边都是对象才递归；数组/标量一律由覆盖层整值替换。
                    Some(slot) if slot.is_object() && value.is_object() => merge_json(slot, value),
                    _ => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (slot, overlay) => *slot = overlay,
    }
}

/// 写盘前把 `schemaVersion` 补到当前版本（只升不降：更高版本写的文件保持
/// 原值，避免降级运行时把版本号改小、让下次升级走错迁移分支）。
fn ensure_schema_version(value: &mut serde_json::Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let existing = object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if existing < u64::from(CURRENT_SCHEMA_VERSION) {
        object.insert(
            "schemaVersion".into(),
            serde_json::Value::from(CURRENT_SCHEMA_VERSION),
        );
    }
}

fn unique_sibling(path: &Path, suffix: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    path.with_file_name(format!(
        "{}.{}.{}.{}",
        name,
        suffix,
        std::process::id(),
        stamp
    ))
}

fn backup_corrupt(path: &Path) -> Result<PathBuf> {
    let backup = unique_sibling(path, "corrupt");
    fs::rename(path, &backup).or_else(|rename_error| {
        fs::copy(path, &backup)
            .and_then(|_| fs::remove_file(path))
            .map_err(|copy_error| {
                anyhow!(
                    "rename failed: {}; copy fallback failed: {}",
                    rename_error,
                    copy_error
                )
            })
    })?;
    Ok(backup)
}

#[cfg(windows)]
fn replace_existing(temp: &Path, target: &Path, backup: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let previous_backup = if backup.exists() {
        let previous = unique_sibling(backup, "previous");
        fs::rename(backup, &previous)
            .with_context(|| format!("rotate backup {}", backup.display()))?;
        Some(previous)
    } else {
        None
    };
    let replaced = wide(target);
    let replacement = wide(temp);
    let backup_wide = wide(backup);
    let ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            backup_wide.as_ptr(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        if let Some(previous) = previous_backup {
            let _ = fs::rename(previous, backup);
        }
        return Err(error).context("原子替换 settings.json 失败");
    }
    if let Some(previous) = previous_backup {
        let _ = fs::remove_file(previous);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_existing(temp: &Path, target: &Path, backup: &Path) -> Result<()> {
    let backup_temp = unique_sibling(backup, "tmp");
    fs::copy(target, &backup_temp).with_context(|| format!("backup {}", target.display()))?;
    fs::rename(&backup_temp, backup)
        .with_context(|| format!("publish backup {}", backup.display()))?;
    fs::rename(temp, target).with_context(|| format!("replace {}", target.display()))?;
    Ok(())
}

fn save_to(settings: &Settings, path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    // 写前 merge：见 merge_json。旧文件读不出来（不存在/损坏）时按「没有旧
    // 数据」处理，保持原有的原子写行为。
    let mut value = serde_json::to_value(settings).context("序列化设置失败")?;
    if let Ok(bytes) = fs::read(path) {
        if let Ok(mut previous) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            merge_json(&mut previous, value);
            value = previous;
        }
    }
    ensure_schema_version(&mut value);
    let data = serde_json::to_vec_pretty(&value).context("序列化设置失败")?;
    let temp = unique_sibling(path, "tmp");
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(&data)
            .with_context(|| format!("write {}", temp.display()))?;
        file.write_all(b"\n")
            .with_context(|| format!("write {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("flush {}", temp.display()))?;
        drop(file);

        if path.exists() {
            let backup = path.with_extension("json.bak");
            replace_existing(&temp, path, &backup)?;
        } else {
            fs::rename(&temp, path).with_context(|| format!("publish {}", path.display()))?;
        }

        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

fn load_file(path: &Path) -> Result<Settings> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

impl Settings {
    pub fn load() -> LoadedSettings {
        let path = config_path();
        if path.exists() {
            return match load_file(&path) {
                Ok(settings) => LoadedSettings {
                    settings,
                    warning: None,
                },
                Err(error) => {
                    let backup = backup_corrupt(&path);
                    let (message, backup_path) = match backup {
                        Ok(backup) => (
                            format!("设置文件无法读取，已恢复默认设置并备份原文件：{}", error),
                            Some(path_string(&backup)),
                        ),
                        Err(backup_error) => (
                            format!(
                                "设置文件无法读取，已恢复默认设置；原文件备份失败：{}；{}",
                                error, backup_error
                            ),
                            None,
                        ),
                    };
                    LoadedSettings {
                        settings: Self::default(),
                        warning: Some(SettingsWarning {
                            code: "settings_corrupt".into(),
                            message,
                            path: Some(path_string(&path)),
                            backup_path,
                        }),
                    }
                }
            };
        }

        let legacy = legacy_config_path();
        if legacy.exists() {
            return match load_file(&legacy) {
                Ok(settings) => match save_to(&settings, &path) {
                    Ok(()) => LoadedSettings {
                        settings,
                        warning: None,
                    },
                    Err(error) => LoadedSettings {
                        settings,
                        warning: Some(SettingsWarning {
                            code: "settings_migration_save_failed".into(),
                            message: format!("已读取旧版设置，但无法保存到新位置：{}", error),
                            path: Some(path_string(&path)),
                            backup_path: None,
                        }),
                    },
                },
                Err(error) => LoadedSettings {
                    settings: Self::default(),
                    warning: Some(SettingsWarning {
                        code: "legacy_settings_corrupt".into(),
                        message: format!("旧版设置文件无法读取，已使用默认设置：{}", error),
                        path: Some(path_string(&legacy)),
                        backup_path: None,
                    }),
                },
            };
        }

        LoadedSettings {
            settings: Self::default(),
            warning: None,
        }
    }

    pub fn save(&self) -> Result<()> {
        save_to(self, &config_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lumina-settings-test-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_is_valid_and_keeps_previous_backup() {
        let dir = test_dir("atomic");
        let path = dir.join("settings.json");
        let first = Settings {
            model_dir: "first".into(),
            ..Settings::default()
        };
        save_to(&first, &path).unwrap();

        let mut second = first.clone();
        second.model_dir = "second".into();
        save_to(&second, &path).unwrap();

        let current = load_file(&path).unwrap();
        let backup = load_file(&path.with_extension("json.bak")).unwrap();
        assert_eq!(current.model_dir, "second");
        assert_eq!(backup.model_dir, "first");

        let mut third = second.clone();
        third.model_dir = "third".into();
        save_to(&third, &path).unwrap();
        let current = load_file(&path).unwrap();
        let backup = load_file(&path.with_extension("json.bak")).unwrap();
        assert_eq!(current.model_dir, "third");
        assert_eq!(backup.model_dir, "second");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_is_moved_out_of_the_way() {
        let dir = test_dir("corrupt");
        let path = dir.join("settings.json");
        fs::write(&path, b"{not json").unwrap();

        assert!(load_file(&path).is_err());
        let backup = backup_corrupt(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read(backup).unwrap(), b"{not json");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn older_settings_without_snapshots_remain_compatible() {
        let settings: Settings =
            serde_json::from_str(r#"{"modelDir":"models","backend":"cuda0","maxQueueSize":4}"#)
                .unwrap();
        assert!(settings.model_snapshots.is_empty());
        assert_eq!(settings.backend, "cuda0");
        assert!(settings.ref_image_preset.is_empty());
        assert!(settings.vae_format.is_empty());
        // Pre-0.7.4 files have no `sdPort` key — they must keep the old port.
        assert_eq!(settings.sd_port, 1234);
    }

    #[test]
    fn diagnostic_settings_and_snapshots_round_trip_with_legacy_defaults() {
        let settings: Settings = serde_json::from_str(
            r#"{
            "logLevel":"debug", "linearScale":"0.0078125", "attnScale":"0",
            "modelSnapshots": {
                "new": {"logLevel":"verbose", "linearScale":"0x1p-7", "attnScale":"1"},
                "legacy": {"components":{}}
            }
        }"#,
        )
        .unwrap();
        let encoded = serde_json::to_value(&settings).unwrap();
        assert_eq!(encoded["logLevel"], "debug");
        assert_eq!(encoded["linearScale"], "0.0078125");
        assert_eq!(encoded["attnScale"], "0");
        assert_eq!(encoded["modelSnapshots"]["new"]["linearScale"], "0x1p-7");
        let legacy = &settings.model_snapshots["legacy"];
        assert!(
            legacy.log_level.is_empty()
                && legacy.linear_scale.is_empty()
                && legacy.attn_scale.is_empty()
        );
        let defaults: Settings = serde_json::from_str("{}").unwrap();
        assert!(
            defaults.log_level.is_empty()
                && defaults.linear_scale.is_empty()
                && defaults.attn_scale.is_empty()
        );
    }

    #[test]
    fn custom_port_round_trips_and_default_matches_serde_fallback() {
        let settings: Settings = serde_json::from_str(r#"{"sdPort":8188}"#).unwrap();
        assert_eq!(settings.sd_port, 8188);

        let encoded = serde_json::to_string(&settings).unwrap();
        assert!(encoded.contains("\"sdPort\":8188"));

        let fallback = Settings::default();
        assert_eq!(fallback.sd_port, default_sd_port());
        assert_eq!(fallback.max_queue_size, default_max_queue_size());
    }

    #[test]
    fn older_model_snapshots_without_vae_format_remain_compatible() {
        let settings: Settings = serde_json::from_str(
            r#"{"modelSnapshots":{"models/pid.safetensors":{"familyOverride":"pid","components":{}}}}"#,
        )
        .unwrap();
        let snapshot = settings
            .model_snapshots
            .get("models/pid.safetensors")
            .unwrap();
        assert_eq!(snapshot.family_override, "pid");
        assert!(snapshot.vae_format.is_empty());
    }

    /// tokenizer / sageAttn / conditioningCacheSize 曾经只存在于前端类型里，
    /// 保存时被 serde 静默丢弃：重启后外部 tokenizer 家族会因为缺 main 槽而
    /// 无法启动。此处锁定顶层与快照两处的往返，并确认旧文件缺键仍是默认值。
    #[test]
    fn tokenizer_sage_attn_and_cache_size_round_trip() {
        let settings: Settings = serde_json::from_str(
            r#"{
            "tokenizer":"main=/models/tok.json,clip-l=/models/clip.json",
            "sageAttn":true,
            "conditioningCacheSize":"8",
            "modelSnapshots": {
                "models/pid.safetensors": {
                    "tokenizer":"/models/pid-tok.json",
                    "sageAttn":true,
                    "conditioningCacheSize":"12"
                },
                "models/legacy.safetensors": {"components":{}}
            }
        }"#,
        )
        .unwrap();
        assert_eq!(
            settings.tokenizer,
            "main=/models/tok.json,clip-l=/models/clip.json"
        );
        assert!(settings.sage_attn);
        assert_eq!(settings.conditioning_cache_size, "8");

        let encoded = serde_json::to_value(&settings).unwrap();
        assert_eq!(encoded["sageAttn"], true);
        assert_eq!(encoded["conditioningCacheSize"], "8");
        assert_eq!(
            encoded["modelSnapshots"]["models/pid.safetensors"]["sageAttn"],
            true
        );
        assert_eq!(
            encoded["modelSnapshots"]["models/pid.safetensors"]["conditioningCacheSize"],
            "12"
        );
        let dir = test_dir("runtime-fields");
        let path = dir.join("settings.json");
        save_to(&settings, &path).unwrap();
        let reparsed = load_file(&path).unwrap();
        assert_eq!(reparsed.tokenizer, settings.tokenizer);
        assert!(reparsed.sage_attn);
        assert_eq!(reparsed.conditioning_cache_size, "8");
        let snapshot = reparsed
            .model_snapshots
            .get("models/pid.safetensors")
            .unwrap();
        assert_eq!(snapshot.tokenizer, "/models/pid-tok.json");
        assert!(snapshot.sage_attn);
        assert_eq!(snapshot.conditioning_cache_size, "12");

        let legacy = &reparsed.model_snapshots["models/legacy.safetensors"];
        assert!(
            legacy.tokenizer.is_empty()
                && !legacy.sage_attn
                && legacy.conditioning_cache_size.is_empty()
        );
        let defaults: Settings = serde_json::from_str("{}").unwrap();
        assert!(
            defaults.tokenizer.is_empty()
                && !defaults.sage_attn
                && defaults.conditioning_cache_size.is_empty()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// 审查 S-6：写盘是「反序列化 → 整体序列化 → 覆盖」，旧文件里的未知键
    /// （降级版本写的字段、前端先加、Rust 后补的窗口期）以及用户手调的
    /// `modelSnapshots` 都不能因为一次保存而消失。
    #[test]
    fn save_merges_unknown_keys_and_keeps_model_snapshots() {
        let dir = test_dir("merge");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            br#"{
                "modelDir":"old-models",
                "futureField":{"nested":true},
                "modelSnapshots":{"models/a.safetensors":{"familyOverride":"pid","components":{"vae":"x"}}}
            }"#,
        )
        .unwrap();

        // 1) 「load → save」往返（降级版本/字段漂移的真实路径）：未知键必须
        //    原样回到文件里，modelSnapshots 不能因为重新序列化而消失。
        let loaded = load_file(&path).unwrap();
        save_to(&loaded, &path).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["futureField"]["nested"], true);
        assert_eq!(
            saved["modelSnapshots"]["models/a.safetensors"]["familyOverride"],
            "pid"
        );
        assert_eq!(
            saved["modelSnapshots"]["models/a.safetensors"]["components"]["vae"],
            "x"
        );
        // 首次写入补上 schemaVersion（旧文件没有该键 → 0）。
        assert_eq!(saved["schemaVersion"], 1);

        // 2) 部分载荷（模拟 `save_settings({})`，所有字段走 serde 默认值）：
        //    未知键与用户快照仍然保留。
        save_to(&Settings::default(), &path).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["futureField"]["nested"], true);
        assert_eq!(
            saved["modelSnapshots"]["models/a.safetensors"]["familyOverride"],
            "pid"
        );
        // merge 不是「保留旧值」：同名键仍由本次的新值覆盖。
        assert_eq!(saved["modelDir"], "");
        assert_eq!(saved["schemaVersion"], 1);

        // 3) 再次保存：新值生效，未知键依旧保留。
        let updated = Settings {
            model_dir: "new-models".into(),
            ..Settings::default()
        };
        save_to(&updated, &path).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["modelDir"], "new-models");
        assert_eq!(saved["futureField"]["nested"], true);
        assert_eq!(saved["schemaVersion"], 1);
        fs::remove_dir_all(dir).unwrap();
    }

    /// 审查 S-5：自动保存结果**默认关**（用户确认）；旧文件缺键必须是 false，
    /// 显式 true 要能往返保存。
    #[test]
    fn auto_save_results_defaults_to_false_and_round_trips() {
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert!(!legacy.auto_save_results);
        // 旧文件缺 `schemaVersion` → 0，写盘时才补成 1。
        assert_eq!(legacy.schema_version, 0);
        assert!(!Settings::default().auto_save_results);

        let enabled: Settings = serde_json::from_str(r#"{"autoSaveResults":true}"#).unwrap();
        assert!(enabled.auto_save_results);
        assert_eq!(
            serde_json::to_value(&enabled).unwrap()["autoSaveResults"],
            true
        );

        let dir = test_dir("auto-save");
        let path = dir.join("settings.json");
        save_to(&enabled, &path).unwrap();
        let reparsed = load_file(&path).unwrap();
        assert!(reparsed.auto_save_results);
        assert_eq!(reparsed.schema_version, 1);
        fs::remove_dir_all(dir).unwrap();
    }

    /// 审查 S-2：`output_dir` 是 webview 可调用命令的白名单根，必须由后端
    /// 校验成「空或干净的绝对路径」，否则白名单的取值权等于交给了 webview。
    #[test]
    fn output_dir_validation_requires_an_absolute_path_without_parent_components() {
        // 清空配置 = 未配置：允许，不能因为新增校验阻断用户清空。
        assert!(validate_output_dir("").is_ok());
        assert!(validate_output_dir("   ").is_ok());

        // `..` 分量一律拒绝（绝对路径也不例外）。
        assert!(validate_output_dir("/tmp/../etc").is_err());
        assert!(validate_output_dir("D:/out/../evil").is_err());
        // NUL 是明显的畸形输入。
        assert!(validate_output_dir("D:/out\0x").is_err());

        #[cfg(windows)]
        {
            assert!(validate_output_dir("D:/outputs").is_ok());
            assert!(validate_output_dir(r"D:\outputs").is_ok());
            assert!(validate_output_dir(r"\\server\share\outputs").is_ok());
            // 相对路径与「盘符相对」（无根）形式必须拒绝。
            assert!(validate_output_dir("outputs").is_err());
            assert!(validate_output_dir(r"D:outputs").is_err());
            assert!(validate_output_dir(r"\outputs").is_err());
        }
        #[cfg(not(windows))]
        {
            assert!(validate_output_dir("/tmp/outputs").is_ok());
            assert!(validate_output_dir("outputs").is_err());
            assert!(validate_output_dir("~/outputs").is_err());
            assert!(validate_output_dir(r"D:\outputs").is_err());
        }
    }
}
