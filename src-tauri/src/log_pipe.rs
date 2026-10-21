//! 日志管道（审查 10-backend §2.22 从 server.rs 抽出）。
//!
//! 负责把 sd-server 的 stdout/stderr 逐行/逐进度转成前端 `server-log` 事件，
//! 并同步落盘（`crate::logging`）。与 ServerManager 的生命周期无关，
//! 单独成模块后 server.rs 只剩进程管理与启动参数拼装。

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};

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
pub(crate) fn emit_line(app: &AppHandle, line: &str) {
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
        // 同步落盘（审查 10 §2.5）：前端环形缓冲只有 2000 行，GUI 崩溃或误关后
        // 这次启动的全部证据都会消失，而 README 让用户「先看日志面板」。
        crate::logging::info("sdcpp", &clean);
        let _ = app.emit(
            "server-log",
            serde_json::json!({ "type": kind, "text": clean }),
        );
    }
}

/// 单行日志的硬上限（审查 10 §2.7）。
///
/// sd-server 的进度行以 `\r` 结尾且一直不换行；`--verbose` 下的 ggml 张量表、
/// 或损坏权重导致的二进制垃圾，可以长时间不含 `\n`，此时 `pending` 会无界增长
/// 到整个输出流的体积。
const MAX_PENDING_LINE: usize = 8 * 1024;

/// `pending` 里没有任何换行却已超过上限时，强制切出一行（截断并标注）。
/// 返回 `Some(line)` 表示调用方应当把它当作普通日志行 emit。
fn drain_oversized_pending(pending: &mut String) -> Option<String> {
    if pending.len() <= MAX_PENDING_LINE {
        return None;
    }
    let mut head: String = pending.chars().take(MAX_PENDING_LINE).collect();
    head.push_str("…(truncated)");
    pending.clear();
    Some(head)
}

/// progress 去重：sd-server 的 `\r` 原地刷新行会随**每个 chunk** 重复到达，
/// 旧实现每次都重新 emit 同一段文本，前端只能靠去重吃掉（审查 10 §2.7）。
fn should_emit_progress(last: &mut String, next: &str) -> bool {
    if next.is_empty() || last.as_str() == next {
        return false;
    }
    last.clear();
    last.push_str(next);
    true
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
/// 3. Emit a capped line when the buffer has no newline but is oversized.
/// 4. If the remaining partial data contains `\r`, emit the text after the
///    *last* `\r` as a progress update — this is the current in-place state.
/// 5. On EOF, flush whatever is left as a final line.
pub(crate) fn spawn_log_reader<R>(app: AppHandle, out: Option<R>)
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
        let mut last_progress = String::new();
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
                        // 新的一行意味着上下文变了，progress 去重状态必须重置。
                        last_progress.clear();
                        emit_line(&app, &line);
                    }

                    // 不含任何换行的超长输出：强制切行，避免 pending 无界增长。
                    if let Some(oversized) = drain_oversized_pending(&mut pending) {
                        emit_line(&app, &oversized);
                        last_progress.clear();
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
                                if should_emit_progress(&mut last_progress, &clean) {
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
    fn oversized_pending_is_force_split() {
        let mut pending = "x".repeat(MAX_PENDING_LINE + 10);
        let line = drain_oversized_pending(&mut pending).expect("should split");
        assert!(line.ends_with("…(truncated)"));
        assert!(pending.is_empty());
        let mut small = String::from("short line");
        assert!(drain_oversized_pending(&mut small).is_none());
        assert_eq!(small, "short line");
    }

    #[test]
    fn progress_is_deduped_until_content_changes() {
        let mut last = String::new();
        assert!(should_emit_progress(&mut last, "step 1/20"));
        assert!(!should_emit_progress(&mut last, "step 1/20"));
        assert!(should_emit_progress(&mut last, "step 2/20"));
        assert!(!should_emit_progress(&mut last, ""));
    }

    #[test]
    fn sanitize_log_text_strips_controls_but_keeps_tabs_and_text() {
        assert_eq!(sanitize_log_text("a\tb"), "a\tb");
        assert_eq!(sanitize_log_text("x\x1b[31mred\x1b[0m"), "xred");
        assert_eq!(sanitize_log_text("bad\x07bell\x0b"), "badbell");
        assert_eq!(sanitize_log_text("中文 日志"), "中文 日志");
    }
}
