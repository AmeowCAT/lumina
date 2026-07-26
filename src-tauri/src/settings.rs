use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Persisted launcher settings (mirrors the webui `Settings` struct).
#[derive(Serialize, Deserialize, Clone, Default)]
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
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub offload_cpu: bool,
    #[serde(default)]
    pub quant_type: String,
    #[serde(default = "default_max_queue_size")]
    pub max_queue_size: u32,
    #[serde(default)]
    pub model_snapshots: HashMap<String, ModelConfigSnapshot>,
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
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub offload_cpu: bool,
    #[serde(default)]
    pub quant_type: String,
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
        return Err(error).context("atomically replace settings");
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

    let data = serde_json::to_vec_pretty(settings).context("serialize settings")?;
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
}
