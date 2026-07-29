import { invoke } from "@tauri-apps/api/core";
import type {
  ApiErrorBody,
  Capabilities,
  GenMode,
  Job,
  ScanResult,
  ServerArgs,
  ServerStatus,
  Settings,
} from "./types";

/**
 * Typed wrappers around Tauri commands. Tauri converts JS camelCase keys to the
 * Rust functions' snake_case parameters automatically.
 */
export const api = {
  startServer: (
    exePath: string,
    modelName: string,
    mode: GenMode | null,
    args: ServerArgs,
    port: number
  ) =>
    invoke<{ pid: number; sdPort: number }>("start_server", {
      exePath,
      modelName,
      mode,
      args,
      port,
    }),

  stopServer: () =>
    invoke<{ stopped: boolean; alreadyStopped: boolean; pid?: number | null }>(
      "stop_server"
    ),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  scanModels: (dir: string) => invoke<ScanResult>("scan_models", { dir }),
  /** 家族检测的唯一实现在 Rust family.rs，前端不再维护正则副本。 */
  detectFamily: (path: string) => invoke<string>("detect_family", { path }),

  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings", { settings }),

  pickFolder: () => invoke<string | null>("pick_folder"),
  pickFile: () => invoke<string | null>("pick_file"),

  saveOutput: (b64: string, ext: string, name: string, dir: string) =>
    invoke<{ saved: boolean; path?: string; reason?: string; cancelled?: boolean }>("save_output", {
      b64,
      ext,
      name,
      dir,
    }),

  saveAs: (b64: string, ext: string, name: string) =>
    invoke<{ saved: boolean; path?: string; cancelled?: boolean }>("save_as", { b64, ext, name }),

  sdcppCapabilities: () => invoke<Capabilities>("sdcpp_capabilities"),

  /**
   * 提交失败时 sd-server 返回的是 `{"error":"...", "message"?:"..."}`——`error`
   * 是**字符串**（routes_sdcpp.cpp），与 job 对象内 `{code,message}` 的形状不同，
   * 不可混用。解析统一走 `extractApiError`。
   */
  sdcppSubmit: (mode: GenMode, body: Record<string, unknown>) =>
    invoke<{ status: number; body: Job | ApiErrorBody }>("sdcpp_submit", {
      mode,
      body,
    }),

  sdcppJob: (id: string) =>
    invoke<{ status: number; body: Job | ApiErrorBody }>("sdcpp_job", {
      id,
    }),
  sdcppCancel: (id: string) =>
    invoke<{ status: number; body: unknown }>("sdcpp_cancel", { id }),

  parsePngMetadata: (path: string) =>
    invoke<Record<string, unknown> | null>("parse_png_metadata", { path }),

  listOutputFiles: (dir: string) =>
    invoke<{ path: string; name: string; size: number; modified: number; ext: string; metadata?: Record<string, unknown> }[]>("list_output_files", { dir }),

  readFileB64: (path: string) => invoke<string>("read_file_b64", { path }),
};
