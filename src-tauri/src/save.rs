use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub cancelled: bool,
}

impl SaveResult {
    pub fn saved(path: String) -> Self {
        Self {
            saved: true,
            path: Some(path),
            cancelled: false,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            saved: false,
            path: None,
            cancelled: true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommandError {
    pub code: &'static str,
    pub message: String,
}

impl SaveCommandError {
    pub fn output(error: anyhow::Error) -> Self {
        Self {
            code: "save_output_failed",
            message: error.to_string(),
        }
    }

    pub fn save_as(error: anyhow::Error) -> Self {
        Self {
            code: "save_as_failed",
            message: error.to_string(),
        }
    }
}

/// Strips anything that could escape the target directory or break the
/// filesystem. `name` and `ext` reach us from the frontend, so even though the
/// current callers only pass server-generated job ids (`[A-Za-z0-9_-]+`), a
/// future caller must not be able to turn a "save" into an arbitrary write.
/// Returns `None` when nothing usable is left.
fn sanitize_component(value: &str) -> Option<String> {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            // Path separators, drive/ADS colons, wildcards and shell-ish chars.
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            // Control characters would produce unopenable files.
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Leading dots would still allow ".." / "..." to address a parent.
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        return None;
    }
    // Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9, with any
    // extension) cannot be created as ordinary files; a leading underscore
    // keeps the name informative while staying creatable.
    let stem = cleaned.split('.').next().unwrap_or("").to_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    Some(if reserved {
        format!("_{}", cleaned)
    } else {
        cleaned
    })
}

/// 以 `create_new` 写入，同名已存在时追加 `_1`/`_2`…序号而不是截断覆盖：
/// 用户输出目录里已有的同名文件不能被静默覆盖（对抗性审查 C）。返回实际
/// 写入的路径。
fn write_with_suffix(
    dir: &std::path::Path,
    name: &str,
    ext: &str,
    data: &[u8],
) -> Result<std::path::PathBuf> {
    use std::io::Write;
    for i in 0..100 {
        let candidate = if i == 0 {
            format!("{}.{}", name, ext)
        } else {
            format!("{}_{}.{}", name, i, ext)
        };
        let path = dir.join(&candidate);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(data)?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    // 同名文件已存在 100 个的极端情况：回落时间戳名做最后一次尝试，仍冲突
    // 则报错（宁可失败也不覆盖未知文件）。
    let fallback = format!("sdcpp_{}_{}.{}", chrono_like_ts(), name, ext);
    let path = dir.join(&fallback);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(data)?;
    Ok(path)
}

/// `save_output` 允许的扩展名（上游图片/视频容器，与 `/sdcpp/v1` 的
/// `output_format` 取值域对齐）。`ext` 来自 webview：只做字符替换的话
/// `.bat` / `.ps1` / `.exe` 都能落盘，再配合 `start_server` 就是「任意写 →
/// 任意执行」（审查 S-2）。`save_as` 不在此列——落盘路径由用户在系统对话框
/// 里显式确认。
const ALLOWED_OUTPUT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm", "avi",
];

/// 归一化（去空白/前导点、转小写）并校验输出扩展名。空值沿用历史的 `png`
/// 兜底；不在白名单里的值直接报可读错误，而不是字符替换后静默写盘。
fn normalize_output_ext(ext: &str) -> Result<String> {
    let normalized = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let normalized = if normalized.is_empty() {
        "png".to_string()
    } else {
        normalized
    };
    if ALLOWED_OUTPUT_EXTENSIONS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(anyhow!(
            "输出格式不受支持：{}（允许 {}）",
            ext,
            ALLOWED_OUTPUT_EXTENSIONS.join("/")
        ))
    }
}

/// Decodes a base64 payload (with optional `data:...;base64,` prefix) and writes
/// it to `<dir>/<name>.<ext>`. sd-server itself never persists outputs, so this
/// is the launcher's responsibility — mirrors the webui `/api/save` endpoint.
pub fn save_output(b64: &str, ext: &str, name: &str, dir: &str) -> Result<String> {
    if dir.is_empty() {
        return Err(anyhow!("no output dir"));
    }
    // 白名单放在解码/建目录之前：非法格式不能有任何落盘副作用。
    let ext = normalize_output_ext(ext)?;
    let dir_path = PathBuf::from(dir);
    fs::create_dir_all(&dir_path)?;

    let raw = match b64.find(',') {
        Some(i) => &b64[i + 1..], // strip "data:...;base64,"
        None => b64,
    };
    let data = base64::engine::general_purpose::STANDARD.decode(raw)?;

    let name = sanitize_component(name).unwrap_or_else(|| format!("sdcpp_{}", chrono_like_ts()));
    let path = write_with_suffix(&dir_path, &name, &ext, &data)?;
    Ok(path.to_string_lossy().to_string())
}

/// Pops a native "Save As" dialog (rfd) and writes the decoded bytes to the
/// chosen path. Returns the path, or `None` if the user cancelled. Tauri's
/// WebView has no download manager, so `<a download>.click()` does nothing —
/// this is the only reliable way to "download" a generated image/video.
pub async fn save_as(b64: &str, ext: &str, name: &str) -> Result<Option<String>> {
    // The user picks the real path in the dialog; these only seed the default
    // file name, but a stray separator would make rfd show a broken suggestion.
    let ext = sanitize_component(ext).unwrap_or_else(|| "png".into());
    let stem = sanitize_component(name).unwrap_or_else(|| "lumina".into());
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(format!("{}.{}", stem, ext))
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .save_file()
        .await;
    let Some(handle) = file else {
        return Ok(None);
    };
    let raw = match b64.find(',') {
        Some(i) => &b64[i + 1..],
        None => b64,
    };
    let data = base64::engine::general_purpose::STANDARD.decode(raw)?;
    let path = handle.path().to_path_buf();
    fs::write(&path, data)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

fn chrono_like_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    // Build a compact YYYYMMDD_HHMMSS timestamp.
    // Using a simple arithmetic approach to avoid chrono dep.
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;
    // Compute date from days since epoch (simple, good enough for naming).
    // Approximate: use day count from epoch to compute year/month/day.
    let (y, mo, d) = days_to_date(days);
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, mo, d, h, m, s)
}

fn days_to_date(mut days: u64) -> (u64, u64, u64) {
    // Days since 1970-01-01 to year/month/day.
    let mut year = 1970u64;
    loop {
        let diy = if is_leap(year) { 366 } else { 365 };
        if days < diy {
            break;
        }
        days -= diy;
        year += 1;
    }
    let md = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1;
    for &m in &md {
        if days < m {
            break;
        }
        days -= m;
        month += 1;
    }
    (year, month as u64, days + 1)
}

#[allow(clippy::manual_is_multiple_of)]
fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn save_output_reports_invalid_base64_as_an_error() {
        let dir = std::env::temp_dir().join(format!(
            "lumina-save-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let error = save_output("not base64!", "png", "bad", dir.to_str().unwrap()).unwrap_err();
        assert!(error.to_string().contains("Invalid symbol"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_result_distinguishes_cancel_from_failure() {
        let result = SaveResult::cancelled();
        assert!(!result.saved);
        assert!(result.cancelled);
        assert!(result.path.is_none());
    }

    #[test]
    fn sanitize_component_strips_traversal_and_separators() {
        assert_eq!(sanitize_component("..").as_deref(), None);
        assert_eq!(
            sanitize_component("../../evil").as_deref(),
            Some("_.._evil")
        );
        assert_eq!(
            sanitize_component(r"..\..\evil").as_deref(),
            Some("_.._evil")
        );
        assert_eq!(sanitize_component("C:/tmp/x").as_deref(), Some("C__tmp_x"));
        assert_eq!(sanitize_component("   ").as_deref(), None);
        assert_eq!(sanitize_component("").as_deref(), None);
        // Ordinary names must survive untouched.
        assert_eq!(
            sanitize_component("sdcpp_job_01HTXYZ_0").as_deref(),
            Some("sdcpp_job_01HTXYZ_0")
        );
    }

    #[test]
    fn save_output_keeps_the_file_inside_the_target_dir() {
        let dir = std::env::temp_dir().join(format!(
            "lumina-escape-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        // 1x1 transparent PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let written = save_output(png, "png", "../../escaped", dir.to_str().unwrap()).unwrap();
        let written_path = PathBuf::from(&written);
        // The separators are gone, so a residual ".." is just an ordinary
        // filename character — what matters is that the parent is still `dir`.
        assert_eq!(
            written_path.parent(),
            Some(dir.as_path()),
            "written outside the target dir: {}",
            written
        );
        assert!(written_path.is_file());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_output_does_not_overwrite_an_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "lumina-dup-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        // 1x1 transparent PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let first = save_output(png, "png", "dup", dir.to_str().unwrap()).unwrap();
        let second = save_output(png, "png", "dup", dir.to_str().unwrap()).unwrap();
        assert_ne!(first, second, "existing file must not be overwritten");
        assert!(second.ends_with("dup_1.png"), "second write got {}", second);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sanitize_component_neutralizes_windows_reserved_device_names() {
        assert_eq!(sanitize_component("CON").as_deref(), Some("_CON"));
        assert_eq!(sanitize_component("con.png").as_deref(), Some("_con.png"));
        assert_eq!(sanitize_component("NUL").as_deref(), Some("_NUL"));
        assert_eq!(sanitize_component("com1").as_deref(), Some("_com1"));
        assert_eq!(sanitize_component("LPT9.txt").as_deref(), Some("_LPT9.txt"));
        // Only COM1-9 / LPT1-9 are reserved; "com10" and "console" are ordinary.
        assert_eq!(sanitize_component("com10").as_deref(), Some("com10"));
        assert_eq!(sanitize_component("console").as_deref(), Some("console"));
    }

    /// 审查 S-2：`ext` 来自 webview，没有白名单时「保存结果图」可以变成往
    /// 输出目录写 `.bat`/`.exe`，再被 `start_server` 当内核启动。
    #[test]
    fn save_output_rejects_non_media_extensions() {
        let dir = std::env::temp_dir().join(format!(
            "lumina-ext-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        // 1x1 transparent PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        for ext in ["bat", "exe", "ps1", "cmd", "dll", "js", "html"] {
            let error = save_output(png, ext, "x", dir.to_str().unwrap())
                .unwrap_err()
                .to_string();
            assert!(error.contains("输出格式不受支持"), "{}: {}", ext, error);
        }
        // 被拒绝的保存不得产生任何落盘副作用（连目录都不创建）。
        assert!(!dir.exists(), "rejected save must not create the directory");

        // 大小写/前导点归一化后仍然放行（上游给小写，但旧前端可能带点）。
        let written = save_output(png, ".PNG", "upper", dir.to_str().unwrap()).unwrap();
        assert!(written.ends_with(".png"), "written: {}", written);
        let written = save_output(png, "webm", "vid", dir.to_str().unwrap()).unwrap();
        assert!(written.ends_with(".webm"), "written: {}", written);
        fs::remove_dir_all(dir).unwrap();
    }
}
