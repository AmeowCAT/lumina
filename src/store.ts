import { create } from "zustand";
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

export interface ToastEntry {
  id: number;
  msg: string;
  error: boolean;
}

export interface ResultEntry {
  jobId: string;
  mode: GenMode;
  result: JobResult;
  created?: number;
  completedAt?: number;
  config?: JobConfig;
  saveStatus?: "not_configured" | "saving" | "saved" | "partial" | "failed";
  savePaths?: string[];
  saveError?: string;
}

interface StoreState {
  // toast
  toasts: ToastEntry[];
  toast: (msg: string, error?: boolean) => void;
  dismissToast: (id: number) => void;

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
  endImage: string | null;
  refImages: string[];
  setImage: (
    which: "initImage" | "maskImage" | "controlImage" | "endImage",
    v: string | null
  ) => void;
  setRefImages: (updater: (r: string[]) => string[]) => void;
  seedRandom: boolean;
  setSeedRandom: (v: boolean) => void;
  clearImages: () => void;

  // sd-server 日志（stdout/stderr 流式捕获，内置日志面板展示）
  logs: string[];
  lastProgress: boolean;
  appendLog: (text: string) => void;
  updateProgress: (text: string) => void;
  clearLogs: () => void;

  // 生成进度（解析 stdout 的 step X/Y 行）
  progressStep: number;
  progressTotal: number;
  progressStartedAt: number;
  setProgress: (step: number, total: number, startedAt: number) => void;
  clearProgress: () => void;
}

let toastSeq = 0;

export const useStore = create<StoreState>((set, get) => ({
  toasts: [],
  toast: (msg, error = false) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, msg, error }] }));
    setTimeout(() => get().dismissToast(id), error ? 12_000 : 4_000);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  settings: { exeDir: "", modelDir: "", outputDir: "", backend: "", refImagePreset: "", extraArgs: "", offloadCpu: false, quantType: "", maxQueueSize: 4, modelSnapshots: {} },
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
        if (cur[k[i]] == null || typeof cur[k[i]] !== "object" || Array.isArray(cur[k[i]])) {
          cur[k[i]] = {};
        } else {
          cur[k[i]] = { ...(cur[k[i]] as Record<string, unknown>) };
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
  endImage: null,
  refImages: [],
  setImage: (which, v) => set({ [which]: v } as Partial<StoreState>),
  setRefImages: (updater) =>
    set((s) => ({ refImages: updater(s.refImages) })),
  seedRandom: true,
  setSeedRandom: (v) => set({ seedRandom: v }),
  clearImages: () =>
    set({
      initImage: null,
      maskImage: null,
      controlImage: null,
      endImage: null,
      refImages: [],
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
      // 解析 "step X/Y" 格式用于进度条；Y>0 时设置进度。
      const m = text.match(/step\s+(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        const step = parseInt(m[1]);
        const total = parseInt(m[2]);
        if (total > 0) {
          const now = Date.now();
          const startedAt =
            step <= 1 || s.progressTotal !== total || s.progressStartedAt <= 0
              ? now
              : s.progressStartedAt;
          const logs = s.logs.slice();
          if (s.lastProgress && logs.length > 0) logs[logs.length - 1] = text;
          else logs.push(text);
          return {
            logs: logs.length >= 2000 ? logs.slice(-1500) : logs,
            lastProgress: true,
            progressStep: step,
            progressTotal: total,
            progressStartedAt: startedAt,
          };
        }
      }
      // 进度条（\r 刷新）：若上一条也是进度行则覆盖它，否则另起新行。
      if (s.lastProgress && s.logs.length > 0) {
        const logs = s.logs.slice();
        logs[logs.length - 1] = text;
        return { logs };
      }
      return { logs: [...s.logs, text], lastProgress: true };
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
useStore.subscribe((s) => {
  try {
    localStorage.setItem(SEED_KEY, s.seedRandom ? "true" : "false");
  } catch {
    /* ignore */
  }
});
