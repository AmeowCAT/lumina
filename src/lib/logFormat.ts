/**
 * sd-server 日志行的等级判定。
 *
 * 上游 `examples/common/log.cpp` 的等级标签换过一次形状：
 *   · 基线（含 3f8527a）：`[%-7s] ` 填充到 7 字符 → `[WARN   ] `；
 *   · 上游 #2104 起：单字母 + 位置移到行尾 → `[W] message --- file:line`。
 * 新版正文里不再出现 "warn"/"error" 字样，若只按正文关键词判定，告警与错误
 * 会全部退化成普通行、失去高亮，所以必须先按标签判定，再用关键词兜底
 * （ggml 等第三方输出、以及不带标签的进度行都走兜底）。
 */
export type LogSeverity = "error" | "warn" | "other";

/** `[W] ` / `[WARN   ] ` / `[?] ` —— 标签里可能有尾部填充空格。 */
const LEVEL_TAG = /^\s*\[([A-Za-z?][A-Za-z? ]{0,9})\]/;

const ERROR_TAGS = new Set(["e", "err", "error", "fatal", "panic"]);
const WARN_TAGS = new Set(["w", "warn", "warning", "?"]);
const KNOWN_TAGS = new Set([
  ...ERROR_TAGS,
  ...WARN_TAGS,
  "d",
  "debug",
  "v",
  "verbose",
  "i",
  "info",
]);

const ERROR_TEXT = /error|failed|failure|panic|fatal|exception/i;
const WARN_TEXT = /warn/i;

/** 单行日志的高亮等级；正文关键词只在没有可识别标签时生效。 */
export function logSeverity(line: string): LogSeverity {
  const raw = LEVEL_TAG.exec(line)?.[1];
  const tag = raw?.trim().toLowerCase();
  if (tag && KNOWN_TAGS.has(tag)) {
    if (ERROR_TAGS.has(tag)) return "error";
    if (WARN_TAGS.has(tag)) return "warn";
    return "other";
  }
  // 标签缺失或不认识（例如 `[CUDA] error: ...`）：回到正文关键词。
  if (ERROR_TEXT.test(line)) return "error";
  if (WARN_TEXT.test(line)) return "warn";
  return "other";
}
