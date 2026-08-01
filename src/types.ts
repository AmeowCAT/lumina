// Types aligned with the Rust backend structs and the sd-server `/sdcpp/v1` API.

/** CLI arguments passed to sd-server. Handles bools (flag), strings/numbers
 *  (--key value), and arrays (repeated --key). */
export type ServerArgs = Record<string, string | number | boolean | string[]>;

export interface ModelConfigSnapshot {
  familyOverride: string;
  components: Record<string, string>;
  backend: string;
  refImagePreset: string;
  /** PiD VAE latent layout override (flux / sd3 / flux2 / wan). */
  vaeFormat?: string;
  extraArgs: string;
  offloadCpu: boolean;
  quantType: string;
  maxQueueSize: number;
}

export interface Settings {
  exeDir: string;
  modelDir: string;
  outputDir: string;
  backend: string;
  refImagePreset: string;
  /** PiD VAE latent layout override (flux / sd3 / flux2 / wan). */
  vaeFormat?: string;
  extraArgs: string;
  offloadCpu: boolean;
  quantType: string;
  /** Fallback queue size when server doesn't report max_queue_size. Default 4. */
  maxQueueSize: number;
  /** Port sd-server is launched on and proxied through. Default 1234. */
  sdPort: number;
  modelSnapshots: Record<string, ModelConfigSnapshot>;
  loadWarning?: {
    code: string;
    message: string;
    path?: string;
    backupPath?: string;
  };
}

export interface ModelFile {
  name: string;
  stem: string;
  path: string;
  relPath: string;
  sizeMb: number;
  dir: string;
  ext: string;
  category: string;
}

export interface ScanResult {
  files: ModelFile[];
  count: number;
  baseDir: string;
  families: Record<string, string>;
  warnings?: { code: string; path?: string; message: string }[];
  truncated?: boolean;
  durationMs?: number;
  partial?: boolean;
  stats?: {
    directoriesScanned: number;
    entriesInspected: number;
    skippedDirectories: number;
    readErrors: number;
    entryErrors: number;
    metadataErrors: number;
    depthLimitHits: number;
    warningsOmitted: number;
    elapsedMs: number;
  };
}

export interface ServerStatus {
  running: boolean;
  reachable: boolean;
  /** true when sd-server is responding but was started outside the GUI */
  external: boolean;
  pid: number | null;
  model: string;
  sdPort: number;
  phase?: "stopped" | "starting" | "ready" | "external" | "failed";
  lastError?: string;
  startedAt?: number;
}

export type GenMode = "img_gen" | "vid_gen";

export interface Features {
  init_image?: boolean;
  mask_image?: boolean;
  control_image?: boolean;
  ip_adapter_image?: boolean;
  end_image?: boolean;
  ref_images?: boolean;
  lora?: boolean;
  hires?: boolean;
  control_frames?: boolean;
  high_noise_sample_params?: boolean;
  vae_tiling?: boolean;
  cache?: boolean;
  cancel_queued?: boolean;
  cancel_generating?: boolean;
}

export interface SlgGuidance {
  layers?: number[];
  layer_start?: number;
  layer_end?: number;
  scale: number;
}

export interface Guidance {
  txt_cfg?: number;
  img_cfg?: number;
  distilled_guidance?: number;
  slg?: SlgGuidance;
}

export interface SampleParams {
  sample_method?: string;
  sample_steps?: number;
  scheduler?: string;
  /** 仅 scheduler === "beta" 时生效，对应上游 extra_sample_args 的 alpha（默认 0.6）。 */
  beta_alpha?: number;
  /** 仅 scheduler === "beta" 时生效，对应上游 extra_sample_args 的 beta（默认 0.6）。 */
  beta_beta?: number;
  eta?: number;
  flow_shift?: number;
  shifted_timestep?: number;
  custom_sigmas?: number[];
  guidance: Guidance;
}

export interface HighNoiseSampleParams {
  sample_method?: string;
  sample_steps?: number;
  scheduler?: string;
  /** 仅调度器为 beta 时生效，对应上游 extra_sample_args 的 alpha（默认 0.6）。 */
  beta_alpha?: number;
  /** 仅调度器为 beta 时生效，对应上游 extra_sample_args 的 beta（默认 0.6）。 */
  beta_beta?: number;
  eta?: number;
  flow_shift?: number;
  guidance: Guidance;
}

export interface LoraEntry {
  path: string;
  multiplier?: number;
  is_high_noise?: boolean;
}

export interface HiresParams {
  enabled?: boolean;
  upscaler?: string;
  steps?: number;
  scale?: number;
  denoising_strength?: number;
  /** 目标宽/高；0 表示改用 `scale` 换算（上游语义）。 */
  target_width?: number;
  target_height?: number;
  /** 覆盖二次采样的 sigma 表；留空则按 denoising_strength 裁剪。 */
  custom_sigmas?: number[];
  upscale_tile_size?: number;
}

export interface VaeTilingParams {
  enabled?: boolean;
  temporal_tiling?: boolean;
  tile_size_x?: number;
  tile_size_y?: number;
  target_overlap?: number;
  rel_size_x?: number;
  rel_size_y?: number;
  extra_tiling_args?: string;
}

/** Generation parameters — mirrors sd-server defaults + everything the UI edits. */
export interface GenParams {
  prompt?: string;
  negative_prompt?: string;
  width: number;
  height: number;
  seed: number;
  output_format?: string;
  output_compression?: number;
  clip_skip?: number;
  strength?: number;
  batch_count?: number;
  qwen_image_layers?: number;
  auto_resize_ref_image?: boolean;
  increase_ref_index?: boolean;
  control_strength?: number;
  ip_adapter_strength?: number;
  embed_image_metadata?: boolean;
  video_frames?: number;
  fps?: number;
  moe_boundary?: number;
  vace_strength?: number;
  sample_params: SampleParams;
  lora?: LoraEntry[];
  hires?: HiresParams;
  vae_tiling_params?: VaeTilingParams;
  cache_mode?: string;
  cache_option?: string;
  scm_mask?: string;
  scm_policy_dynamic?: boolean;
  high_noise_sample_params?: HighNoiseSampleParams;
}

export interface Limits {
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
  max_batch_count?: number;
  max_queue_size?: number;
}

export interface Capabilities {
  model: { name: string; stem: string; path: string };
  current_mode: GenMode;
  supported_modes: GenMode[];
  defaults_by_mode: Record<GenMode, GenParams>;
  limits: Limits;
  samplers: string[];
  schedulers: string[];
  output_formats_by_mode: Record<GenMode, string[]>;
  features_by_mode: Record<GenMode, Features>;
  loras: { name: string; path: string }[];
  upscalers: { name: string; path?: string }[];
}

export interface JobImage {
  index?: number;
  b64_json: string;
}

export interface JobResult {
  output_format?: string;
  mime_type?: string;
  fps?: number;
  frame_count?: number;
  b64_json?: string;
  images?: JobImage[];
}

export type JobStatus =
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * sd-server 的 **HTTP 层**错误响应体。注意 `error` 是字符串
 * （`{"error":"invalid generation parameters"}`），与 `Job.error` 的
 * `{code,message}` 对象形状不同——两者不可互换解析。
 * 见 upstream `examples/server/routes_sdcpp.cpp`。
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
}

/** 一次生成任务附带的全部图片输入（dataURL）。 */
export interface GenImages {
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  ipAdapterImage: string | null;
  endImage: string | null;
  refImages: string[];
  /** vid_gen 的 VACE 条件帧，按请求顺序作为条件帧序列。 */
  controlFrames: string[];
}

export interface JobConfig {
  mode: GenMode;
  params: GenParams;
  /** 提交时的图片输入快照，供"应用此配置"完整复现 img2img/inpaint 任务。 */
  images?: GenImages;
}

export interface Job {
  id: string;
  kind: GenMode;
  status: JobStatus;
  created?: number;
  result?: JobResult | null;
  error?: { code?: string; message?: string } | null;
  prompt?: string;
  /** Frontend-only: snapshot of params used to submit, for task switching. */
  config?: JobConfig;
  /** Frontend-only: consecutive status polling failures. */
  pollFailures?: number;
  /** Frontend-only: last time the server confirmed this task, in ms. */
  lastPollSuccess?: number;
}
