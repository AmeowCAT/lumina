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

/// Decodes a base64 payload (with optional `data:...;base64,` prefix) and writes
/// it to `<dir>/<name>.<ext>`. sd-server itself never persists outputs, so this
/// is the launcher's responsibility — mirrors the webui `/api/save` endpoint.
pub fn save_output(b64: &str, ext: &str, name: &str, dir: &str) -> Result<String> {
    if dir.is_empty() {
        return Err(anyhow!("no output dir"));
    }
    let dir_path = PathBuf::from(dir);
    fs::create_dir_all(&dir_path)?;

    let raw = match b64.find(',') {
        Some(i) => &b64[i + 1..], // strip "data:...;base64,"
        None => b64,
    };
    let data = base64::engine::general_purpose::STANDARD.decode(raw)?;

    let ext = if ext.is_empty() { "png" } else { ext };
    let name = if name.is_empty() {
        format!("sdcpp_{}", chrono_like_ts())
    } else {
        name.to_string()
    };
    let path = dir_path.join(format!("{}.{}", name, ext));
    fs::write(&path, data)?;
    Ok(path.to_string_lossy().to_string())
}

/// Pops a native "Save As" dialog (rfd) and writes the decoded bytes to the
/// chosen path. Returns the path, or `None` if the user cancelled. Tauri's
/// WebView has no download manager, so `<a download>.click()` does nothing —
/// this is the only reliable way to "download" a generated image/video.
pub async fn save_as(b64: &str, ext: &str, name: &str) -> Result<Option<String>> {
    let ext = if ext.is_empty() { "png" } else { ext };
    let stem = if name.is_empty() { "lumina" } else { name };
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(format!("{}.{}", stem, ext))
        .add_filter(ext.to_uppercase(), &[ext])
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
}
