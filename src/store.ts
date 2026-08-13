import { create } from "zustand";
import { DEFAULT_SD_PORT } from "./lib/utils";
import type {
  Capabilities,
  GenMode,
  GenParams,
  Job,
  JobConfig,
  JobResult,
  ScanResult,
  ServerStatus,
  Settings,
} from "./types";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastEntry {
  id: number;
  msg: string;
  error: boolean;
  action?: ToastAction;
}

/** 单张图片/视频保存到输出目录的状态 */
export interface ImageSaveState {
  status: "saving" | "saved" | "failed";
  path?: string;
  error?: string;
}

export interface ResultEntry {
  jobId: string;
  mode: GenMode;
  result: JobResult;
  created?: number;
  completedAt?: number;
  config?: JobConfig;
  /** 手动保存状态:key 为图片索引字符串(视频为 "v") */
  saves?: Record<string, ImageSaveState>;
}

/** server-log 流事件：progress（\r 原地刷新）与 line（\n 追加）按到达
 * 顺序批量落库（审查 P4e）。 */
export type LogEvent = { type: "line" | "progress"; text: string };

interface StoreState {
  // toast
  toasts: ToastEntry[];
  toast: (msg: string, error?: boolean, action?: ToastAction) => void;
  dismissToast: (id: number) => void;
  /** 悬停暂停自动消失;离开后按 error 与否重新计时 */
  pauseToasts: () => void;
  resumeToasts: () => void;

  // dashboard / server
  settings: Settings;
  setSettings: (updater: (s: Settings) => Settings) => void;
  serverStatus: ServerStatus | null;
  setServerStatus: (s: ServerStatus | null) => void;
  dashboardOpen: boolean;
  setDashboardOpen: (open: boolean) => void;
  scanResult: ScanResult | null;
  setScanResult: (r: ScanResult | null) => void;
  mainModel: string;
  setMainModel: (p: string) => void;
  familyOverride: string;
  setFamilyOverride: (f: string) => void;
  components: Record<string, string>;
  setComponents: (updater: (c: Record<string, string>) => Record<string, string>) => void;

  // generation
  caps: Capabilities | null;
  setCaps: (c: Capabilities | null) => void;
  mode: GenMode;
  setMode: (m: GenMode) => void;
  params: GenParams | null;
  setParams: (p: GenParams | null) => void;
  updateParam: (path: string, val: unknown) => void;
  jobs: Job[];
  setJobs: (updater: (j: Job[]) => Job[]) => void;
  results: ResultEntry[];
  setResults: (updater: (r: ResultEntry[]) => ResultEntry[]) => void;
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  ipAdapterImage: string | null;
  endImage: string | null;
  refImages: string[];
  controlFrames: string[];
  setImage: (
    which:
      | "initImage"
      | "maskImage"
      | "controlImage"
      | "ipAdapterImage"
      | "endImage",
    v: string | null
  ) => void;
  setRefImages: (updater: (r: string[]) => string[]) => void;
  setControlFrames: (updater: (r: string[]) => string[]) => void;
  seedRandom: boolean;
  setSeedRandom: (v: boolean) => void;
  clearImages: () => void;

  // sd-server 日志（stdout/stderr 流式捕获，内置日志面板展示）
  logs: string[];
  lastProgress: boolean;
  appendLog: (text: string) => void;
  updateProgress: (text: string) => void;
  /** 按帧批量落日志：App 级聚合高频 server-log 事件后一次写入。事件
   * 保持到达顺序，progress 与 line 交替时合并行为与逐条处理一致（审查 P4e）。 */
  flushLogs: (events: LogEvent[]) => void;
  clearLogs: () => void;

  // 生成进度（解析 stdout 的 step X/Y 行）
  progressStep: number;
  progressTotal: number;
  progressStartedAt: number;
  setProgress: (step: number, total: number, startedAt: number) => void;
  clearProgress: () => void;
}

let toastSeq = 0;
/** 每个 toast 的自动消失定时器;pause 时清空、resume 时按剩余条目重建 */
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** 同屏最多 3 条:超过时先让最旧的退场(避免完成风暴刷屏) */
const MAX_TOASTS = 3;

function scheduleToastDismiss(id: number, error: boolean) {
  const t = setTimeout(
    () => useStore.getState().dismissToast(id),
    error ? 12_000 : 4_000
  );
  toastTimers.set(id, t);
}

/** 解析 "step X/Y" 进度行；Y>0 时返回 (step, total)，否则 null。 */
function parseStepProgress(text: string): { step: number; total: number } | null {
  const m = text.match(/step\s+(\d+)\s*\/\s*(\d+)/i);
  if (!m) return null;
  const step = parseInt(m[1]);
  const total = parseInt(m[2]);
  if (!(total > 0)) return null;
  return { step, total };
}

/** 进度行合并：若上一行也是进度行（\r 原地刷新）则覆盖，否则追加。 */
function mergeProgressLine(
  logs: string[],
  lastProgress: boolean,
  text: string
): { logs: string[]; lastProgress: boolean } {
  if (lastProgress && logs.length > 0) {
    const next = logs.slice();
    next[next.length - 1] = text;
    return { logs: next, lastProgress: true };
  }
  return { logs: [...logs, text], lastProgress: true };
}

/** 日志数组封顶：到 2000 条裁到 1500，避免无限增长。 */
function capLogs(logs: string[]): string[] {
  return logs.length >= 2000 ? logs.slice(-1500) : logs;
}

export const useStore = create<StoreState>((set, get) => ({
  toasts: [],
  toast: (msg, error = false, action) => {
    const id = ++toastSeq;
    set((s) => {
      const next = [...s.toasts, { id, msg, error, action }];
      const overflow = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
      for (const old of overflow) {
        const t = toastTimers.get(old.id);
        if (t) clearTimeout(t);
        toastTimers.delete(old.id);
      }
      return { toasts: next.slice(-MAX_TOASTS) };
    });
    scheduleToastDismiss(id, error);
  },
  dismissToast: (id) => {
    const t = toastTimers.get(id);
    if (t) {
      clearTimeout(t);
      toastTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
  pauseToasts: () => {
    toastTimers.forEach((t) => clearTimeout(t));
    toastTimers.clear();
  },
  resumeToasts: () => {
    for (const x of get().toasts) {
      if (!toastTimers.has(x.id)) scheduleToastDismiss(x.id, x.error);
    }
  },

  settings: {
    exeDir: "",
    modelDir: "",
    outputDir: "",
    backend: "",
    refImagePreset: "",
    vaeFormat: "",
    extraArgs: "",
    offloadCpu: false,
    quantType: "",
    maxVram: "",
    maxQueueSize: 4,
    sdPort: DEFAULT_SD_PORT,
    modelSnapshots: {},
  },
  setSettings: (updater) => set((s) => ({ settings: updater(s.settings) })),
  serverStatus: null,
  setServerStatus: (s) => set({ serverStatus: s }),
  dashboardOpen: false,
  setDashboardOpen: (open) => set({ dashboardOpen: open }),
  scanResult: null,
  setScanResult: (r) => set({ scanResult: r }),
  mainModel: "",
  setMainModel: (p) => set({ mainModel: p }),
  familyOverride: "",
  setFamilyOverride: (f) => set({ familyOverride: f }),
  components: {},
  setComponents: (updater) =>
    set((s) => ({ components: updater(s.components) })),

  caps: null,
  setCaps: (c) => set({ caps: c }),
  mode: "img_gen",
  setMode: (m) => set({ mode: m }),
  params: null,
  setParams: (p) => set({ params: p }),
  updateParam: (path, val) =>
    set((s) => {
      if (!s.params) return {};
      const k = path.split(".");
      const n: GenParams = { ...s.params };
      let cur = n as unknown as Record<string, unknown>;
      for (let i = 0; i < k.length - 1; i++) {
        const existing = cur[k[i]];
        if (existing == null || typeof existing !== "object") {
          // 缺失的中间节点补空对象；已存在的对象/数组都浅拷贝后继续下行。
          // 旧实现对数组也替换成 {}，经数组路径（如 lora.0.multiplier）
          // 更新会静默破坏数据（对抗性审查 B6）。
          cur[k[i]] = {};
        } else if (Array.isArray(existing)) {
          cur[k[i]] = [...existing];
        } else {
          cur[k[i]] = { ...(existing as Record<string, unknown>) };
        }
        cur = cur[k[i]] as Record<string, unknown>;
      }
      cur[k[k.length - 1]] = val;
      return { params: n };
    }),
  jobs: [],
  setJobs: (updater) => set((s) => ({ jobs: updater(s.jobs) })),
  results: [],
  setResults: (updater) => set((s) => ({ results: updater(s.results) })),
  initImage: null,
  maskImage: null,
  controlImage: null,
  ipAdapterImage: null,
  endImage: null,
  refImages: [],
  controlFrames: [],
  setImage: (which, v) => set({ [which]: v } as Partial<StoreState>),
  setRefImages: (updater) =>
    set((s) => ({ refImages: updater(s.refImages) })),
  setControlFrames: (updater) =>
    set((s) => ({ controlFrames: updater(s.controlFrames) })),
  seedRandom: true,
  setSeedRandom: (v) => set({ seedRandom: v }),
  clearImages: () =>
    set({
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: [],
      controlFrames: [],
    }),
  logs: [],
  lastProgress: false,
  appendLog: (text) =>
    set((s) => {
      const logs = s.logs.length >= 2000 ? s.logs.slice(-1500) : s.logs.slice();
      return { logs: [...logs, text], lastProgress: false };
    }),
  updateProgress: (text) =>
    set((s) => {
      const parsed = parseStepProgress(text);
      if (parsed) {
        const now = Date.now();
        const startedAt =
          parsed.step <= 1 ||
          s.progressTotal !== parsed.total ||
          s.progressStartedAt <= 0
            ? now
            : s.progressStartedAt;
        const merged = mergeProgressLine(s.logs, s.lastProgress, text);
        return {
          logs: capLogs(merged.logs),
          lastProgress: merged.lastProgress,
          progressStep: parsed.step,
          progressTotal: parsed.total,
          progressStartedAt: startedAt,
        };
      }
      const merged = mergeProgressLine(s.logs, s.lastProgress, text);
      return { logs: capLogs(merged.logs), lastProgress: merged.lastProgress };
    }),
  flushLogs: (events) =>
    set((s) => {
      // 按到达顺序逐条处理：line 追加、progress 解析步数并原地刷新/
      // 追加最后一行。旧实现把两类事件分容器收集、flush 时先 line 后
      // progress，同帧内到达顺序相反时合并结果与逐条处理不一致（审查 P4e）。
      let logs = s.logs.slice();
      let lastProgress = s.lastProgress;
      let progressStep = s.progressStep;
      let progressTotal = s.progressTotal;
      let progressStartedAt = s.progressStartedAt;
      for (const ev of events) {
        if (ev.type === "line") {
          if (ev.text === "") continue;
          logs.push(ev.text);
          lastProgress = false;
          continue;
        }
        const text = ev.text;
        if (text.trim() === "") continue;
        const parsed = parseStepProgress(text);
        if (parsed) {
          const now = Date.now();
          progressStartedAt =
            parsed.step <= 1 ||
            progressTotal !== parsed.total ||
            progressStartedAt <= 0
              ? now
              : progressStartedAt;
          progressStep = parsed.step;
          progressTotal = parsed.total;
        }
        const merged = mergeProgressLine(logs, lastProgress, text);
        logs = merged.logs;
        lastProgress = merged.lastProgress;
      }
      return {
        logs: capLogs(logs),
        lastProgress,
        progressStep,
        progressTotal,
        progressStartedAt,
      };
    }),
  clearLogs: () => set({ logs: [], lastProgress: false }),

  progressStep: 0,
  progressTotal: 0,
  progressStartedAt: 0,
  setProgress: (step, total, startedAt) =>
    set({ progressStep: step, progressTotal: total, progressStartedAt: startedAt }),
  clearProgress: () =>
    set({ progressStep: 0, progressTotal: 0, progressStartedAt: 0 }),
}));

// Persist seedRandom to mirror the webui behaviour.
const SEED_KEY = "sdcpp:seedRandom";
try {
  const saved = localStorage.getItem(SEED_KEY);
  if (saved !== null) useStore.getState().setSeedRandom(saved !== "false");
} catch {
  /* ignore */
}
// 只在该字段真正变化时写盘：旧实现订阅全局状态、每次变化（含每敲一个
// 字符、每条日志）都同步 setItem 同一个值（对抗性审查 B6）。
useStore.subscribe((s, prev) => {
  if (prev && s.seedRandom === prev.seedRandom) return;
  try {
    localStorage.setItem(SEED_KEY, s.seedRandom ? "true" : "false");
  } catch {
    /* ignore */
  }
});
