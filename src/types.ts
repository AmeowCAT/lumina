// Types aligned with the Rust backend structs and the sd-server `/sdcpp/v1` API.

/** CLI arguments passed to sd-server. Handles bools (flag), strings/numbers
 *  (--key value), and arrays (repeated --key). */
export type ServerArgs = Record<string, string | number | boolean | string[]>;

/** Startup-only diagnostics; missing values in old settings mean engine defaults. */
export interface RuntimeDiagnostics {
  logLevel?: string;
  linearScale?: string;
  attnScale?: string;
}

export interface ModelConfigSnapshot extends RuntimeDiagnostics {
  familyOverride: string;
  components: Record<string, string>;
  backend: string;
  refImagePreset: string;
  /** PiD VAE latent layout override (flux / sd3 / flux2 / wan). */
  vaeFormat?: string;
  /** 外部 HuggingFace tokenizer.json（--tokenizer）；PiD / Lens / LLaDA-Image 必需。 */
  tokenizer?: string;
  /** 原生 CUDA SageAttention（--sage-attn）；不可用时内核会拒绝建上下文。 */
  sageAttn?: boolean;
  /** 条件结果缓存上限（--conditioning-cache-size）；空 = 走内核默认。 */
  conditioningCacheSize?: string;
  extraArgs: string;
  offloadCpu: boolean;
  quantType: string;
  /** Raw --max-vram value; empty/absent = 启动时不传该参数。 */
  maxVram?: string;
  maxQueueSize: number;
}

export interface Settings extends RuntimeDiagnostics {
  exeDir: string;
  modelDir: string;
  outputDir: string;
  backend: string;
  refImagePreset: string;
  /** PiD VAE latent layout override (flux / sd3 / flux2 / wan). */
  vaeFormat?: string;
  /** 外部 HuggingFace tokenizer.json（--tokenizer）；PiD / Lens / LLaDA-Image 必需。 */
  tokenizer?: string;
  /** 原生 CUDA SageAttention（--sage-attn）。 */
  sageAttn?: boolean;
  /** 条件结果缓存上限（--conditioning-cache-size）；空 = 走内核默认。 */
  conditioningCacheSize?: string;
  extraArgs: string;
  offloadCpu: boolean;
  quantType: string;
  /** Raw --max-vram value（"6" / "-2" / "cuda0=6,vulkan0=4"）；空 = 不传。 */
  maxVram?: string;
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

export interface CliCapabilities {
  executable: string;
  version: string | null;
  verified: boolean;
  options: string[];
  autoFit: "unknown" | "unsupported" | "flag" | "on-off";
  memoryMode: "unknown" | "legacy" | "automatic";
  warnings: string[];
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
  /** 上游 #2093 起支持生成过程预览（请求体 `preview` / `preview_interval`）。 */
  preview?: boolean;
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
  /** 仅 sample_method === "lms" 时生效，extra_sample_args 的 lms_max_order
   *  （上游 #1885，默认 4，整数 ≥1；引擎再夹到步数，>12 可能出 NaN）。 */
  lms_max_order?: number;
  /** 仅 sample_method === "lms" 时生效，extra_sample_args 的 lms_shift
   *  （上游 #1885，默认 1，整数 ≥0；0 = 原始 k-diffusion 历史顺序）。 */
  lms_shift?: number;
  /** 仅 sample_method === "lms" 时生效，extra_sample_args 的 lms_divisions
   *  （黎曼积分分段数，默认 1000，整数 ≥1）。 */
  lms_divisions?: number;
  /** 用户自填的 extra_sample_args（结构化字段之外的 `key=value` 项）。
   *  发请求时拼在结构化项**之后**——上游 parse_key_value_args 后写覆盖先写，
   *  所以这里可以覆盖界面滑杆产生的同名键。 */
  extra_sample_args?: string;
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
  /** 仅采样器为 lms 时生效，extra_sample_args 的 lms_max_order（默认 4）。 */
  lms_max_order?: number;
  /** 仅采样器为 lms 时生效，extra_sample_args 的 lms_shift（默认 1）。 */
  lms_shift?: number;
  /** 仅采样器为 lms 时生效，extra_sample_args 的 lms_divisions（默认 1000）。 */
  lms_divisions?: number;
  /** 高噪段用户自填的 extra_sample_args，语义同 SampleParams.extra_sample_args。 */
  extra_sample_args?: string;
  eta?: number;
  flow_shift?: number;
  /** 上游 parse_sample_params_json 对高噪段同样解析 shifted_timestep。 */
  shifted_timestep?: number;
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

/**
 * 请求体 / capabilities / 图片元数据里 VAE 分块参数使用哪一套字段。
 *
 * 上游 #2059 起 `tile_size_x/y`、`rel_size_x/y` 更名为 `tile_size_w/h`、
 * `rel_size_w/h`，且绝对尺寸单位从 **latent 单位**改为**图像像素**
 * （0 = 内核默认 256 像素）。新版解析器不读旧键，旧版不读新键，因此必须
 * 按所选内核实际声明的键名决定发哪一套，不能按 Lumina 自身版本猜测。
 */
export type VaeTilingProtocol = "pixels" | "latent";

export interface VaeTilingParams {
  enabled?: boolean;
  temporal_tiling?: boolean;
  /** 空间分块宽（图像像素；0/缺省 = 内核默认 256）。仅 pixels 协议使用。 */
  tile_size_w?: number;
  /** 空间分块高（图像像素；0/缺省 = 内核默认 256）。仅 pixels 协议使用。 */
  tile_size_h?: number;
  target_overlap?: number;
  /** 相对宽度：≤1 为尺寸比例，>1 为目标分块数（覆盖绝对尺寸）。 */
  rel_size_w?: number;
  /** 相对高度：≤1 为尺寸比例，>1 为目标分块数（覆盖绝对尺寸）。 */
  rel_size_h?: number;
  extra_tiling_args?: string;
  /**
   * 旧内核（上游 #2059 之前）的 latent 单位字段。仅在 `latent` 协议下发，
   * 新版协议下这些值被**保留但不发送**（单位不同，换算需已知 VAE 缩放
   * 因子，猜测会产生错误分块）。
   */
  tile_size_x?: number;
  tile_size_y?: number;
  rel_size_x?: number;
  rel_size_y?: number;
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
  /** 旧字段（上游 #2028 起服务端不再读取，仅为兼容旧内核保留）。 */
  auto_resize_ref_image?: boolean;
  /** 新版参考图参数串（如 `preset=flux_kontext,resize_before_vae=false`）。 */
  ref_image_args?: string;
  /** 新版输入几何规则（上游 #2028 `--image-preprocess` / 请求体 image_preprocess）。 */
  image_preprocess?: string[];
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
  /**
   * 生成过程预览模式（上游 #2093 的请求体键 `preview`）：`none` 关闭，
   * 其余取值取自 capabilities 的 `preview_modes`（proj / tae / vae）。
   * 默认关闭；仅发送当前内核和模式支持的枚举值。
   */
  preview?: string;
  /** 预览间隔（采样步），上游默认 1 且非正值会被夹到 1。 */
  preview_interval?: number;
  high_noise_sample_params?: HighNoiseSampleParams;
}

export interface Limits {
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
  max_batch_count?: number;
  max_queue_size?: number;
  /** 独立放大（`/sdcpp/v1/upscale`）单轴像素上限（上游 #2026 的编译期常量，固定 8192）。 */
  max_upscale_width?: number;
  max_upscale_height?: number;
}

/**
 * capabilities 里的放大器条目。上游 #2026 起新增 `model` / `image_upscale`：
 * 只有 `image_upscale: true` 的模型能被独立的 `/sdcpp/v1/upscale` 使用
 * （内置滤镜与 latent 放大器仅用于 hires 生成）。
 */
export interface UpscalerInfo {
  name: string;
  path?: string;
  model?: boolean;
  image_upscale?: boolean;
}

export interface Capabilities {
  model: { name: string; stem: string; path: string };
  /** 上游两种模式都不支持时返回 ""（routes_sdcpp.cpp），不能假定必为合法模式 */
  current_mode: GenMode | "";
  supported_modes: GenMode[];
  /** 上游只包含支持的模式，缺键可能存在（routes_sdcpp.cpp） */
  defaults_by_mode: Partial<Record<GenMode, GenParams>>;
  limits: Limits;
  samplers: string[];
  schedulers: string[];
  output_formats_by_mode: Partial<Record<GenMode, string[]>>;
  features_by_mode: Partial<Record<GenMode, Features>>;
  loras: { name: string; path: string }[];
  upscalers: UpscalerInfo[];
  /**
   * 是否存在可用于 `POST /sdcpp/v1/upscale` 的 RGB ESRGAN 模型
   * （上游 #2026）。旧内核缺该键，视为不支持。
   */
  upscale?: boolean;
  /**
   * 可用的预览模式，如 `["none", "proj", "tae", "vae"]`（上游 #2093）。
   * 旧内核缺该键，界面不显示预览控件。
   */
  preview_modes?: string[];
}

/** `POST /sdcpp/v1/upscale` 的请求体（同步接口，不创建任务）。 */
export interface UpscaleRequest {
  /** base64 或 dataURL 图片。 */
  image: string;
  /** capabilities 中 `image_upscale: true` 的名字；缺省用第一个兼容模型。 */
  upscaler?: string;
  /** 重复次数 1–4（默认 1）。 */
  repeats?: number;
  /** 分块尺寸，缺省用内核 `--upscale-tile-size`。 */
  tile_size?: number;
  output_format?: string;
  output_compression?: number;
}

/** `POST /sdcpp/v1/upscale` 的响应体。 */
export interface UpscaleResponse {
  images: JobImage[];
  upscaler?: string;
  scale?: number;
  repeats?: number;
  width?: number;
  height?: number;
  output_format?: string;
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

/**
 * 生成中的预览帧（上游 #2093，仅 `status === "generating"` 的任务返回）。
 *
 * `step / total_steps` 描述的是**当前采样段**，不是整项任务的完成度：
 * 批次换图、高噪/低噪切换、二次放大都会让 `pass` 自增并把 `step` 清零。
 */
export interface JobPreview {
  /** 第几个采样段，从 1 开始。 */
  pass?: number;
  /** 本段内的逻辑采样步。 */
  step?: number;
  /** 本段的实际总步数（已含调度/强度调整）。 */
  total_steps?: number;
  /** 当前预览帧的 PNG base64。 */
  b64_json: string;
}

export interface Job {
  id: string;
  kind: GenMode;
  status: JobStatus;
  /** 任务创建时间。单位是**秒**（上游 unix_timestamp_now），不是毫秒——
   *  前端两处耗时换算（JobQueue `created*1000`、ResultsGrid
   *  `completedAt/1000 - created`）都依赖此约定,上游改单位要同步改。 */
  created?: number;
  result?: JobResult | null;
  error?: { code?: string; message?: string } | null;
  /** 生成中的最新预览帧；完成任务不再携带该键。 */
  preview?: JobPreview | null;
  prompt?: string;
  /** Frontend-only: snapshot of params used to submit, for task switching. */
  config?: JobConfig;
  /** Frontend-only: consecutive status polling failures. */
  pollFailures?: number;
  /** Frontend-only: last time the server confirmed this task, in ms. */
  lastPollSuccess?: number;
}
