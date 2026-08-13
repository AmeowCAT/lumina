import {
  getCurrentWindow,
  ProgressBarStatus,
  UserAttentionType,
} from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * 系统集成(Tauri):任务栏进度、窗口注意力、原生通知。
 * 所有调用防御式 try/catch——dev 模式/平台差异(如 macOS 无任务栏
 * 进度、Windows dev 模式 toast 无 AUMID)都不应影响主流程。
 */

// ── 任务栏进度 ─────────────────────────────────────────────
// 生成期间按步数更新任务栏图标进度;step/total 为 0 时清除。
// 节流 250ms:每步一次 setProgressBar 会让 Windows 任务栏动画抽风。
let lastProgressSent = 0;
let lastProgressValue = -1;

export function setTaskbarProgress(step: number, total: number): void {
  try {
    const now = Date.now();
    if (total <= 0 || step <= 0) {
      if (lastProgressValue === 0) return;
      lastProgressValue = 0;
      lastProgressSent = now;
      void getCurrentWindow()
        .setProgressBar({ status: ProgressBarStatus.None })
        .catch(() => {});
      return;
    }
    const pct = Math.min(100, Math.round((step / total) * 100));
    if (pct === lastProgressValue) return;
    if (now - lastProgressSent < 250 && pct < 100) return;
    lastProgressValue = pct;
    lastProgressSent = now;
    void getCurrentWindow()
      .setProgressBar({ status: ProgressBarStatus.Normal, progress: pct })
      .catch(() => {});
  } catch {
    /* 平台不支持:静默 */
  }
}

// ── 窗口注意力(完成/失败时闪任务栏) ─────────────────────────
export function flashWindow(): void {
  if (document.hasFocus()) return;
  try {
    void getCurrentWindow()
      .requestUserAttention(UserAttentionType.Critical)
      .catch(() => {});
  } catch {
    /* 平台不支持:静默 */
  }
}

// ── 原生通知 ───────────────────────────────────────────────
let permissionState: "unknown" | "granted" | "denied" = "unknown";

async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true;
  if (permissionState === "denied") return false;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    permissionState = granted ? "granted" : "denied";
    return granted;
  } catch {
    permissionState = "denied";
    return false;
  }
}

/**
 * 仅当窗口失焦时才打扰(聚焦时界面内的 toast/结果动画已足够)。
 * 权限在首次调用时按需请求,拒绝后本次会话不再尝试。
 */
export async function notifyIfUnfocused(title: string, body: string): Promise<void> {
  if (document.hasFocus()) return;
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    /* dev 模式/平台限制:静默 */
  }
}
