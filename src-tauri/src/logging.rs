//! 文件日志（审查 10-backend-rust §2.5）。
//!
//! release 构建没有控制台（`windows_subsystem = "windows"`），`env_logger` 写
//! stderr 等于丢弃；sd-server 的 stdout/stderr 只经 `server-log` 事件进前端内存
//! 环形缓冲（上限 2000 行）。于是 GUI 崩溃或误关后，一次启动失败的完整证据就没了，
//! 而 README 恰恰让用户「先看日志面板」。
//!
//! 这里做最小可用版本：`%LOCALAPPDATA%/lumina/logs/lumina.log`（Linux 为
//! `~/.local/share/lumina/logs/`），单文件 8 MB 滚动、保留 3 份历史，零新依赖。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单文件上限；超过就滚动到 `lumina.N.log`。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 历史文件份数（`lumina.1.log` … `lumina.3.log`）。
const KEEP_BACKUPS: u32 = 3;

static SINK: OnceLock<Mutex<Option<File>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<File>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// 日志目录；拿不到系统数据目录时返回 `None`（日志功能静默失效，不影响主流程）。
pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("lumina").join("logs"))
}

/// 初始化文件日志。幂等：重复调用只会重新打开同一个文件。
pub fn init() {
    let Some(dir) = log_dir() else { return };
    init_at(&dir);
}

/// 把 sink 指向 `dir/lumina.log`（拆出来是为了能在临时目录里测真实落盘）。
fn init_at(dir: &Path) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join("lumina.log");
    // 超过上限先滚动，避免单文件无限增长。
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
        rollover(dir, &path);
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    if let Ok(mut guard) = sink().lock() {
        *guard = Some(file);
    }
    info("app", "===== Lumina 启动 =====");
}

fn rollover(dir: &Path, path: &Path) {
    // lumina.3.log 丢掉，2→3、1→2，当前→1。
    for i in (1..=KEEP_BACKUPS).rev() {
        let from: PathBuf = if i == 1 {
            path.to_path_buf()
        } else {
            dir.join(format!("lumina.{}.log", i - 1))
        };
        let to = dir.join(format!("lumina.{}.log", i));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

/// 只写日志行的实际落盘动作；调用方保证 `sink` 已初始化。
fn write_raw(line: &str) {
    let Ok(mut guard) = sink().lock() else { return };
    let Some(file) = guard.as_mut() else { return };
    let _ = writeln!(file, "{}", line);
    let _ = file.flush();
}

/// 当前 UTC 时间的 `YYYY-MM-DD HH:MM:SS` 前缀（不引 chrono，20 行足够）。
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// 写一条日志。`tag` 用来区分来源（app / sdcpp / ui）。
pub fn info(tag: &str, message: &str) {
    for line in message.lines() {
        write_raw(&format!("{} [{}] {}", utc_stamp(), tag, line));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_is_under_the_platform_data_dir() {
        if let Some(dir) = log_dir() {
            assert!(dir.ends_with("logs"), "日志目录应以 logs 结尾: {dir:?}");
        }
    }

    #[test]
    fn utc_stamp_has_expected_shape() {
        let stamp = utc_stamp();
        // "YYYY-MM-DD HH:MM:SS"
        assert_eq!(stamp.len(), 19, "时间戳格式不对: {stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], " ");
        assert_eq!(&stamp[13..14], ":");
    }

    #[test]
    fn writes_lines_to_the_log_file() {
        // 唯一会碰全局 sink 的测试：用独立临时目录，避免污染真实日志。
        let dir = std::env::temp_dir().join(format!("lumina-log-test-{}", std::process::id()));
        init_at(&dir);
        info("sdcpp", "line one\nline two");
        let text = fs::read_to_string(dir.join("lumina.log")).unwrap_or_default();
        let _ = fs::remove_dir_all(&dir);
        assert!(text.contains("[sdcpp] line one"), "日志内容缺失: {text}");
        assert!(text.contains("[sdcpp] line two"));
        assert!(text.contains("===== Lumina 启动 ====="));
    }
}
