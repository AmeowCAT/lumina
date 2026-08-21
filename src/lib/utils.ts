import type {
  GenImages,
  GenMode,
  GenParams,
  LoraEntry,
  ModelFile,
  SampleParams,
} from "../types";

/** sd-server 的历史默认端口；与 Rust 侧 `server::DEFAULT_SD_PORT` 保持一致。 */
export const DEFAULT_SD_PORT = 1234;
/** 启动端口可选范围：<1024 在 Unix 上需要提权，0 会让系统随机选端口。 */
export const MIN_SD_PORT = 1024;
export const MAX_SD_PORT = 65535;

/** 把任意输入夹到合法端口区间，非法值回落到默认端口。 */
export function normalizeSdPort(port: unknown): number {
  const value = Math.trunc(Number(port));
  if (!Number.isFinite(value) || value < MIN_SD_PORT || value > MAX_SD_PORT) {
    return DEFAULT_SD_PORT;
  }
  return value;
}

export const LINGBOT_PROMPT_TEMPLATE = JSON.stringify(
  {
    caption: {
      comprehensive_description:
        "描述主体、环境、动作、镜头运动、构图、光线和整体氛围",
      camera_info: {
        color: "自然色彩",
        frame_size: "中景",
        shot_type_angle: "平视",
        lens_size: "标准镜头",
        composition: "主体居中",
        lighting: "柔和光线",
        lighting_type: "自然光",
      },
      world_knowledge: [],
      prominent_elements: [],
    },
  },
  null,
  2
);

export function validateLingbotPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "LingBot JSON 提示词必须是一个对象";
    }
    if (
      "caption" in parsed &&
      (!parsed.caption || typeof parsed.caption !== "object" || Array.isArray(parsed.caption))
    ) {
      return "LingBot JSON 中的 caption 必须是一个对象";
    }
    return null;
  } catch (error) {
    return `LingBot JSON 格式无效：${formatError(error)}`;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; code?: unknown };
    if (typeof candidate.message === "string") {
      return typeof candidate.code === "string"
        ? `${candidate.message}（${candidate.code}）`
        : candidate.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * 从 sd-server 响应体中取出人类可读的错误原因。
 *
 * 上游有两种**形状不同**的错误载体，必须都能解析：
 *  - HTTP 层（提交/查询被拒）：`{"error":"invalid generation parameters"}`
 *    —— `error` 是字符串，`invalid json` 时另带 `message`
 *  - Job 对象内（任务失败/取消）：`{"error":{"code":"...","message":"..."}}`
 *
 * 早期实现只按对象形状读 `.error.message`，导致 400/429/500 的真实原因
 * （模式不支持、参数非法、webm 未编译等）全部退化成 "错误 400"。
 */
export function extractApiError(body: unknown, status?: number): string {
  const fallback = status != null ? `错误 ${status}` : "未知错误";
  if (!body || typeof body !== "object") return fallback;
  const b = body as { error?: unknown; message?: unknown };

  if (typeof b.error === "string" && b.error.trim()) {
    // `invalid json` 会附带更具体的 message，拼在一起更好定位。
    const detail = typeof b.message === "string" ? b.message.trim() : "";
    return detail ? `${b.error}：${detail}` : b.error;
  }
  if (b.error && typeof b.error === "object") {
    const inner = b.error as { message?: unknown; code?: unknown };
    if (typeof inner.message === "string" && inner.message.trim()) {
      return typeof inner.code === "string" && inner.code
        ? `${inner.message}（${inner.code}）`
        : inner.message;
    }
    if (typeof inner.code === "string" && inner.code) return inner.code;
  }
  if (typeof b.message === "string" && b.message.trim()) return b.message;
  return fallback;
}

export type { GenImages } from "../types";

export function deepClone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

/** Recursive object merge (arrays & scalars are replaced, not concatenated). */
export function deepMerge<T extends object>(target: T, source: object): T {
  const r = { ...target } as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    const tv = r[k];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      r[k] = deepMerge(tv as object, sv as object);
    } else {
      r[k] = sv;
    }
  }
  return r as T;
}

export function b64ToBlobUrl(b64: string, mime: string): string {
  const b = atob(b64.includes(",") ? b64.split(",")[1] : b64);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return URL.createObjectURL(new Blob([u], { type: mime }));
}

/** 原始 base64（可含 data: 前缀）→ dataURL。结果图用作 img2img 输入时必须
 * 转成 dataURL 而非 blob: URL——blob: 只在本页面生命周期内有效（切回控制台
 * 即被 revoke），且 sd-server 无法解码 blob: 协议。 */
export function b64ToDataUrl(b64: string, mime: string): string {
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return `data:${mime};base64,${raw}`;
}

/** base64 字符串（可含 data: 前缀）对应的近似原始字节数：每 4 个字符
 * ≈ 3 字节。只用于内存预算估算，不要求精确。 */
export function b64ByteLength(b64: string): number {
  const comma = b64.indexOf(",");
  const raw = comma >= 0 ? b64.slice(comma + 1) : b64;
  return Math.floor((raw.length * 3) / 4);
}

/** 结果 / 任务记录的内存上限：每条记录持有 base64，无上限会在长会话中
 * 耗尽内存（对抗性审查 B5）。超出时丢弃最旧的记录，blob 缓存随之剪枝。 */
export const MAX_RESULTS = 60;
export const MAX_JOBS = 300;

export function fmtSize(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  if (mb >= 1) return Math.round(mb) + " MB";
  return (mb * 1024).toFixed(0) + " KB";
}

export function modelFileOptionLabel(file: ModelFile): string {
  const indexLabel = file.ext === "safetensors.index.json" ? " [分片索引]" : "";
  return `${file.name}${indexLabel} (${fmtSize(file.sizeMb)})`;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (ev) => resolve(ev.target?.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** 读取 dataURL 图片的真实像素尺寸（用于按初始图片自动填充生成尺寸）。 */
export function getImageSize(
  dataUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** 上游 sample_params.extra_sample_args 是 `key=value` 列表，逗号或分号分隔
 * （src/core/util.cpp parse_key_value_args，键值两侧空白被 trim，缺 `=` 的段
 * 只告警并忽略）。common.cpp parse_sample_params_json 读取该字符串
 * （api.md 未列但解析器支持），各采样器 / 调度器只取用自己认识的键：
 *  - beta 调度器：alpha / beta（denoiser.hpp BetaScheduler，要求 > 0，默认 0.6）
 *  - lms 采样器：lms_max_order / lms_shift / lms_divisions（上游 #1885，
 *    parse_strict_int，非整数整条忽略；默认 4 / 1 / 1000）
 * 其余键（flux base_shift、lcm noise_*、euler_ge gamma、apg_*、slg_uncond、
 * guidance_schedule、logit_normal、ltx2、sefi_* 等）没有专门的界面控件，
 * 由「额外采样参数」自由文本兜底。
 */
export const LMS_DEFAULTS = { maxOrder: 4, shift: 1, divisions: 1000 } as const;
/** 结构化字段已覆盖的键：解析元数据时归位到具体字段，不再留在自由文本里。 */
const STRUCTURED_EXTRA_KEYS = new Set([
  "alpha",
  "beta",
  "lms_max_order",
  "lms_shift",
  "lms_divisions",
]);

interface ExtraArgsSource {
  scheduler?: string;
  sample_method?: string;
  beta_alpha?: number;
  beta_beta?: number;
  lms_max_order?: number;
  lms_shift?: number;
  lms_divisions?: number;
  extra_sample_args?: string;
}

/** 只保留形如 `key=value` 的段（上游对缺 `=` 的段只告警并丢弃），顺序不变。 */
function sanitizeExtraSampleArgs(raw?: string): string {
  if (!raw) return "";
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      return eq > 0 && part.slice(eq + 1).trim().length > 0;
    })
    .join(",");
}

/** 拼装 extra_sample_args：结构化项在前，用户自由文本在后（后写覆盖先写）。 */
function buildExtraSampleArgs(p?: ExtraArgsSource): string | undefined {
  if (!p) return undefined;
  const parts: string[] = [];
  // 滑动条可能产生浮点尾数（如 0.6000000000000001），发请求前收窄到 4 位小数。
  const fmt = (v: number) => String(Math.round(v * 10000) / 10000);
  if (p.scheduler === "beta") {
    if (p.beta_alpha != null && p.beta_alpha > 0) parts.push(`alpha=${fmt(p.beta_alpha)}`);
    if (p.beta_beta != null && p.beta_beta > 0) parts.push(`beta=${fmt(p.beta_beta)}`);
  }
  if (p.sample_method === "lms") {
    // 上游 parse_strict_int：小数 / 带单位的值会被整条忽略，这里先截成整数。
    const int = (v: number | undefined, min: number) => {
      if (v == null || !Number.isFinite(v)) return undefined;
      const i = Math.trunc(v);
      return i < min ? undefined : i;
    };
    const maxOrder = int(p.lms_max_order, 1);
    const shift = int(p.lms_shift, 0);
    const divisions = int(p.lms_divisions, 1);
    if (maxOrder != null) parts.push(`lms_max_order=${maxOrder}`);
    if (shift != null) parts.push(`lms_shift=${shift}`);
    if (divisions != null) parts.push(`lms_divisions=${divisions}`);
  }
  const free = sanitizeExtraSampleArgs(p.extra_sample_args);
  if (free) parts.push(free);
  return parts.length ? parts.join(",") : undefined;
}

/** 解析 extra_sample_args（"alpha=0.8,lms_shift=0,gamma=3"）回结构化字段，
 *  未被结构化字段吃掉的键原样留在 extra_sample_args 里，保证往返不丢参数。 */
function parseExtraSampleArgs(extra?: unknown): {
  beta_alpha?: number;
  beta_beta?: number;
  lms_max_order?: number;
  lms_shift?: number;
  lms_divisions?: number;
  extra_sample_args?: string;
} {
  if (typeof extra !== "string") return {};
  const out: {
    beta_alpha?: number;
    beta_beta?: number;
    lms_max_order?: number;
    lms_shift?: number;
    lms_divisions?: number;
    extra_sample_args?: string;
  } = {};
  const rest: string[] = [];
  // 上游同时接受 `,` 与 `;` 作为分隔符。
  for (const part of extra.split(/[,;]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    const value = Number(rawValue);
    if (!STRUCTURED_EXTRA_KEYS.has(key)) {
      if (key && rawValue) rest.push(`${key}=${rawValue}`);
      continue;
    }
    if (!Number.isFinite(value)) continue;
    // 上游 BetaScheduler 只接受 > 0；lms_* 走 parse_strict_int（lms_shift 允许 0）。
    if (key === "alpha") {
      if (value > 0) out.beta_alpha = value;
    } else if (key === "beta") {
      if (value > 0) out.beta_beta = value;
    } else if (Number.isInteger(value)) {
      if (key === "lms_max_order" && value >= 1) out.lms_max_order = value;
      else if (key === "lms_shift" && value >= 0) out.lms_shift = value;
      else if (key === "lms_divisions" && value >= 1) out.lms_divisions = value;
    }
  }
  if (rest.length) out.extra_sample_args = rest.join(",");
  return out;
}

function isMetaObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function metaNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function metaStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function metaBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function metaNumArr(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "number")
    ? (v as number[])
    : undefined;
}

/** 元数据 `sampling` / `high_noise_sampling` 对象 → GUI 的采样参数。 */
function mapSamplingMetadata(s: unknown): SampleParams | undefined {
  if (!isMetaObj(s)) return undefined;
  const g = isMetaObj(s.guidance) ? s.guidance : {};
  const slg = isMetaObj(g.slg) ? g.slg : undefined;
  return {
    sample_steps: metaNum(s.steps),
    eta: metaNum(s.eta),
    flow_shift: metaNum(s.flow_shift),
    shifted_timestep: metaNum(s.shifted_timestep),
    sample_method: metaStr(s.method),
    scheduler: metaStr(s.scheduler),
    custom_sigmas: metaNumArr(s.custom_sigmas),
    ...parseExtraSampleArgs(s.extra_sample_args),
    guidance: {
      txt_cfg: metaNum(g.txt_cfg),
      img_cfg: metaNum(g.img_cfg),
      distilled_guidance: metaNum(g.distilled_guidance),
      slg: slg
        ? {
            scale: metaNum(slg.scale) ?? 0,
            layers: metaNumArr(slg.layers),
            layer_start: metaNum(slg.start),
            layer_end: metaNum(slg.end),
          }
        : undefined,
    },
  };
}

/** 把 sd-server 嵌入图片的 `sdcpp.image.params/v1` 元数据映射为 GenParams。
 * 元数据中的 LoRA 只有文件名，需用 `availableLoras` 按名字匹配回完整路径，
 * 匹配不到的 LoRA 跳过（无法恢复路径）。 */
export function sdcppMetadataToGenParams(
  meta: Record<string, unknown>,
  availableLoras?: { name: string; path: string }[]
): Partial<GenParams> {
  const prompt = isMetaObj(meta.prompt) ? meta.prompt : {};
  const sampling = mapSamplingMetadata(meta.sampling);
  const highNoise = mapSamplingMetadata(meta.high_noise_sampling);
  const video = isMetaObj(meta.video) ? meta.video : {};
  const hires = isMetaObj(meta.hires) ? meta.hires : undefined;
  const cache = isMetaObj(meta.cache) ? meta.cache : undefined;
  const vaeTiling = isMetaObj(meta.vae_tiling) ? meta.vae_tiling : undefined;

  const out: Partial<GenParams> = {
    prompt: metaStr(prompt.positive),
    negative_prompt: metaStr(prompt.negative),
    width: metaNum(meta.width),
    height: metaNum(meta.height),
    seed: metaNum(meta.seed),
    sample_params: sampling,
    high_noise_sample_params: highNoise,
    video_frames: metaNum(video.frame_count),
    fps: metaNum(video.fps),
    moe_boundary: metaNum(meta.moe_boundary),
    vace_strength: metaNum(meta.vace_strength),
    clip_skip: metaNum(meta.clip_skip),
    strength: metaNum(meta.strength),
    control_strength: metaNum(meta.control_strength),
    ip_adapter_strength: metaNum(meta.ip_adapter_strength),
    auto_resize_ref_image: metaBool(meta.auto_resize_ref_image),
    increase_ref_index: metaBool(meta.increase_ref_index),
  };

  if (hires) {
    out.hires = {
      enabled: metaBool(hires.enabled) ?? true,
      upscaler: metaStr(hires.upscaler),
      steps: metaNum(hires.steps),
      scale: metaNum(hires.scale),
      target_width: metaNum(hires.target_width),
      target_height: metaNum(hires.target_height),
      denoising_strength: metaNum(hires.denoising_strength),
      custom_sigmas: metaNumArr(hires.custom_sigmas),
      upscale_tile_size: metaNum(hires.upscale_tile_size),
    };
  }
  if (cache) {
    out.cache_mode = metaStr(cache.requested_mode);
    out.cache_option = metaStr(cache.requested_option);
    out.scm_mask = metaStr(cache.scm_mask);
    out.scm_policy_dynamic = metaBool(cache.scm_policy_dynamic);
  }
  // 上游只在启用（或写了 extra_tiling_args）时才写 vae_tiling 段
  // （common.cpp build_sdcpp_image_metadata_json），键名与请求体一致。
  if (vaeTiling) {
    out.vae_tiling_params = {
      enabled: metaBool(vaeTiling.enabled) ?? true,
      temporal_tiling: metaBool(vaeTiling.temporal_tiling),
      tile_size_x: metaNum(vaeTiling.tile_size_x),
      tile_size_y: metaNum(vaeTiling.tile_size_y),
      target_overlap: metaNum(vaeTiling.target_overlap),
      rel_size_x: metaNum(vaeTiling.rel_size_x),
      rel_size_y: metaNum(vaeTiling.rel_size_y),
      extra_tiling_args: metaStr(vaeTiling.extra_tiling_args),
    };
  }
  if (Array.isArray(meta.loras) && availableLoras?.length) {
    const loras: LoraEntry[] = [];
    for (const raw of meta.loras) {
      if (!isMetaObj(raw)) continue;
      const name = metaStr(raw.name);
      if (!name) continue;
      const found = availableLoras.find((a) => a.name === name);
      if (found) {
        loras.push({
          path: found.path,
          multiplier: metaNum(raw.multiplier) ?? 1,
          is_high_noise: metaBool(raw.is_high_noise),
        });
      }
    }
    if (loras.length) out.lora = loras;
  }

  return out;
}

/** Build the `/sdcpp/v1/img_gen|vid_gen` request body (mirrors webui). */
export function buildRequestBody(
  mode: GenMode,
  params: GenParams,
  images: GenImages
): Record<string, unknown> {
  const sp = params.sample_params;
  // capabilities 把"未设置"序列化为 "default"（routes_sdcpp.cpp
  // capability_*_name）；请求体里省略字段等价于让服务端用模型默认，
  // 比显式透传 "default" 更准确。
  const noDefault = (v?: string) => (v && v !== "default" ? v : undefined);
  const sampleParams: Record<string, unknown> = {
    sample_method: noDefault(sp?.sample_method),
    sample_steps: sp?.sample_steps,
    scheduler: noDefault(sp?.scheduler),
    guidance: {
      txt_cfg: sp?.guidance?.txt_cfg,
    },
  };
  // 仅在显式提供数值时才发送 distilled_guidance：`?? 0` 会在参数缺失时
  // 用 0 覆盖服务端默认值（持久化参数过期时可达）。
  const distilled = sp?.guidance?.distilled_guidance;
  if (distilled != null && Number.isFinite(distilled)) {
    (sampleParams.guidance as Record<string, unknown>).distilled_guidance =
      distilled;
  }
  const extraArgs = buildExtraSampleArgs(sp);
  if (extraArgs) sampleParams.extra_sample_args = extraArgs;
  const b: Record<string, unknown> = {
    prompt: params.prompt || "",
    negative_prompt: params.negative_prompt || "",
    width: params.width,
    height: params.height,
    seed: params.seed,
    output_format: params.output_format,
    output_compression: params.output_compression,
    sample_params: sampleParams,
  };

  if (params.clip_skip != null && params.clip_skip !== -1)
    b.clip_skip = params.clip_skip;
  if (params.strength != null) b.strength = params.strength;

  if (mode === "img_gen") {
    b.batch_count = params.batch_count || 1;
    if (params.qwen_image_layers != null)
      b.qwen_image_layers = params.qwen_image_layers;
    b.auto_resize_ref_image = params.auto_resize_ref_image !== false;
    b.increase_ref_index = !!params.increase_ref_index;
    b.control_strength = params.control_strength ?? 0.9;
    b.ip_adapter_strength = params.ip_adapter_strength ?? 1.0;
    b.embed_image_metadata = params.embed_image_metadata !== false;
  }
  if (mode === "vid_gen") {
    b.video_frames = params.video_frames || 33;
    b.fps = params.fps || 24;
    if (params.moe_boundary != null) b.moe_boundary = params.moe_boundary;
    if (params.vace_strength != null) b.vace_strength = params.vace_strength;
  }

  if (images.initImage) b.init_image = images.initImage;
  if (mode === "img_gen" && images.maskImage) b.mask_image = images.maskImage;
  if (mode === "img_gen" && images.controlImage)
    b.control_image = images.controlImage;
  if (mode === "img_gen" && images.ipAdapterImage)
    b.ip_adapter_image = images.ipAdapterImage;
  if (mode === "vid_gen" && images.endImage) b.end_image = images.endImage;
  // 参考图同时服务于 img_gen（Kontext/PiD 等）与声明支持的 vid 家族
  // （MiniMax-H3 Ref2VA）。调用方按家族能力裁剪后再传入，此处不按 mode 硬过滤。
  if (images.refImages?.length) b.ref_images = images.refImages;
  // VACE 条件帧：顺序即条件帧顺序，上游按请求顺序保留。
  if (mode === "vid_gen" && images.controlFrames?.length)
    b.control_frames = images.controlFrames;

  if (sp?.eta != null) sampleParams.eta = sp.eta;
  if (sp?.flow_shift != null) sampleParams.flow_shift = sp.flow_shift;
  if (sp?.shifted_timestep != null) sampleParams.shifted_timestep = sp.shifted_timestep;
  if (sp?.custom_sigmas?.length) sampleParams.custom_sigmas = sp.custom_sigmas;
  if (sp?.guidance?.img_cfg != null)
    (sampleParams.guidance as Record<string, unknown>).img_cfg =
      sp.guidance.img_cfg;
  const slg = sp?.guidance?.slg;
  if (slg && slg.scale > 0) {
    (sampleParams.guidance as Record<string, unknown>).slg = {
      layers: slg.layers || [7, 8, 9],
      layer_start: slg.layer_start ?? 0.01,
      layer_end: slg.layer_end ?? 0.2,
      scale: slg.scale,
    };
  } else {
    // 显式发 scale:0 关闭：请求体是在服务端 default_gen_params 之上合并
    // （routes_sdcpp.cpp），省略字段会沿用服务端默认——外部 server 若默认
    // 开启 SLG，省略无法关闭（对抗性审查）。
    (sampleParams.guidance as Record<string, unknown>).slg = { scale: 0 };
  }

  const vl = (params.lora || []).filter((l) => l.path);
  if (vl.length)
    b.lora = vl.map((l) => {
      const e: Record<string, unknown> = {
        path: l.path,
        multiplier: l.multiplier ?? 1.0,
      };
      // 上游 img/vid 两种模式的解析器都读取 is_high_noise；只在其为 true
      // 时发送（false 与省略等价），避免 img 模式丢掉已配置的高噪声标记。
      if (l.is_high_noise) e.is_high_noise = true;
      return e;
    });

  if (params.hires?.enabled) {
    const h = { ...params.hires };
    // 上游（common.cpp from_json_str + validate）：
    //  - 空数组解析为 custom_sigmas_count=0，等价于未设置；
    //  - 长度 1 会让 validate 直接失败（"must contain at least two values"），
    //    提交返回 400；生成层同样忽略 count==1。
    // 因此长度 <2 一律省略，避免提交失败与语义歧义。
    if (h.custom_sigmas && h.custom_sigmas.length < 2) delete h.custom_sigmas;
    // 兼容旧版已持久化的 0；上游要求该值为正，省略后沿用服务端默认值。
    if (h.upscale_tile_size != null && h.upscale_tile_size <= 0)
      delete h.upscale_tile_size;
    b.hires = h;
  } else {
    // 显式关闭：省略字段会沿用服务端默认（可能是开启）。
    b.hires = { enabled: false };
  }
  b.vae_tiling_params = params.vae_tiling_params?.enabled
    ? { ...params.vae_tiling_params }
    : { enabled: false };

  if (params.cache_mode && params.cache_mode !== "disabled") {
    b.cache_mode = params.cache_mode;
    if (params.cache_option) b.cache_option = params.cache_option;
    if (params.scm_mask) b.scm_mask = params.scm_mask;
    // scm_policy_dynamic 不发送：上游 from_json_str（common.cpp）只解析
    // cache_mode/cache_option/scm_mask，该键在请求体中会被静默忽略——
    // 真正的开关是服务端启动参数 --scm-policy。capabilities 的默认值里
    // 仍会携带该键，但发送它只会制造"已生效"的假象。
  } else {
    // 上游接受 "disabled"（common.cpp validate），显式覆盖服务端默认。
    b.cache_mode = "disabled";
  }

  if (mode === "vid_gen" && params.high_noise_sample_params) {
    const h = params.high_noise_sample_params;
    const hn: Record<string, unknown> = {
      sample_method: noDefault(h.sample_method),
      sample_steps: h.sample_steps,
      scheduler: noDefault(h.scheduler),
      guidance: {
        txt_cfg: h.guidance?.txt_cfg,
        distilled_guidance: h.guidance?.distilled_guidance,
      },
    };
    if (h.eta != null) hn.eta = h.eta;
    if (h.flow_shift != null) hn.flow_shift = h.flow_shift;
    // 上游 parse_sample_params_json 对高噪段同样解析 shifted_timestep
    // （capabilities 的 high_noise_sample_params 默认值里也带这个键）。
    if (h.shifted_timestep != null) hn.shifted_timestep = h.shifted_timestep;
    if (h.guidance?.img_cfg != null)
      (hn.guidance as Record<string, unknown>).img_cfg = h.guidance.img_cfg;
    if ((h.guidance?.slg?.scale ?? 0) > 0)
      (hn.guidance as Record<string, unknown>).slg = { ...h.guidance?.slg };
    else
      // 与主采样 SLG 对等（见上方 sampleParams.guidance.slg）：显式发
      // scale:0 关闭——请求体在服务端默认值之上合并，省略会沿用服务端
      // 默认，外部 server 默认开启 SLG 时高噪声阶段无法真正关闭（审查 L3
      // 的对称缺口）。
      (hn.guidance as Record<string, unknown>).slg = { scale: 0 };
    const hnExtraArgs = buildExtraSampleArgs(h);
    if (hnExtraArgs) hn.extra_sample_args = hnExtraArgs;
    b.high_noise_sample_params = hn;
  }

  return b;
}
