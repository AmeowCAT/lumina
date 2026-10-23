import type {
  CacheOptionDraft,
  Capabilities,
  Features,
  GenImages,
  GenMode,
  GenParams,
  Job,
  LoraEntry,
  ModelFile,
  SampleParams,
  VaeTilingParams,
  VaeTilingProtocol,
} from "../types";
import { MEMORY_BUDGET } from "./memoryBudget";

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

/** 尺寸滑杆的像素步进默认值：每跳 1 像素，便于精确微调。 */
export const DEFAULT_SIZE_STEP = 1;
/** 步进上限：再大就超过了常见模型的尺寸上限，属于误填。 */
export const MAX_SIZE_STEP = 1024;

/** 把任意输入夹到合法步进区间（1–1024 的整数），非法值回落到默认。 */
export function normalizeSizeStep(value: unknown): number {
  const step = Math.trunc(Number(value));
  if (!Number.isFinite(step) || step < 1) return DEFAULT_SIZE_STEP;
  return Math.min(step, MAX_SIZE_STEP);
}

export const LINGBOT_PROMPT_TEMPLATE = JSON.stringify(
  {
    caption: {
      comprehensive_description: "描述主体、环境、动作、镜头运动、构图、光线和整体氛围",
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
  2,
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
export function getImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
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
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : undefined;
}

/** Read persisted draft lines defensively without stripping editing whitespace. */
export function imagePreprocessDraftLines(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string")
    : [];
}

/** 元数据 `image_preprocess` 可能是规则串（分号分隔）或字符串数组。 */
function metaRuleList(v: unknown): string[] | undefined {
  const split = (s: string) =>
    s
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
  if (typeof v === "string") {
    const rules = split(v);
    return rules.length ? rules : undefined;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    const rules = (v as string[]).flatMap(split);
    return rules.length ? rules : undefined;
  }
  return undefined;
}

/** 从新版 `ref_image_args` 反推「是否自动缩放参考图」，用于 UI 回填。
 * 上游 #2028 起元数据只写 ref_image_args，旧键 auto_resize_ref_image 不再出现。 */
export function refResizeFromRefImageArgs(value?: string): boolean | undefined {
  if (!value) return undefined;
  const m = /(?:^|,)\s*resize_before_vae\s*=\s*([^,]*)/.exec(value);
  if (!m) return undefined;
  const v = m[1].trim().toLowerCase();
  if (["false", "off", "0", "no"].includes(v)) return false;
  if (["true", "on", "1", "yes"].includes(v)) return true;
  return undefined;
}

/** 组装请求体里的 `ref_image_args`（上游 #2028）。
 *
 * 服务端把请求字段**整体赋值**到 `default_gen_params` 之上
 * （`routes_sdcpp.cpp` 的 `load_if_exists("ref_image_args", …)`），而不是追加，
 * 所以只有在确实需要改参考图缩放时才发这个字段，且必须把启动期的
 * `preset=…` 一并带上，否则会把启动参数里的 preset 顶掉。
 * 返回空串表示「保持启动期默认」。 */
export function buildRefImageArgs(
  params: Pick<GenParams, "ref_image_args" | "auto_resize_ref_image">,
  launchPreset?: string,
): string {
  const explicit = (params.ref_image_args || "").trim();
  const autoResize = params.auto_resize_ref_image !== false;
  if (autoResize && !explicit) return "";
  const hasPreset = /(?:^|,)\s*preset\s*=/.test(explicit);
  const hasResize = /(?:^|,)\s*resize_before_vae\s*=/.test(explicit);
  const preset = (launchPreset || "").trim();
  const parts: string[] = [];
  if (!hasPreset && preset) parts.push(`preset=${preset}`);
  if (explicit) parts.push(explicit);
  if (!autoResize && !hasResize) parts.push("resize_before_vae=false");
  return parts.join(",");
}

/**
 * 任务耗时的显示文案。
 *
 * 优先用内核时间戳 `completed - started`（真实采样时长）；旧内核不给
 * `started`/`completed` 时退回「created → 最近一次成功轮询」。旧实现一律用
 * created，把排队等待与 2s 轮询抖动都算进生成耗时（审查 30-api §2.8）。
 */
export function jobElapsed(job: Job, terminal: boolean): string {
  if (job.status === "queued") return "";
  const beginSec = job.started ?? job.created;
  if (!beginSec) return "";
  const endedAt = job.completed ? job.completed * 1000 : terminal ? job.lastPollSuccess : undefined;
  if (terminal && !endedAt) return "";
  const ms = (endedAt ?? Date.now()) - beginSec * 1000;
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * 任务的 `config.images` 字节预算：取自统一总账的 `jobs` 份额
 * （[memoryBudget](./memoryBudget.ts)，审查 20-frontend §2.2/§2.3）。
 *
 * `config.images` 是 dataURL：一张 1080p 输入 2–8 MB，VACE 家族的
 * `controlFrames` 是一整段条件帧序列，单条任务即可达数十 MB。用户换图后旧字符串
 * 仍被每条任务各钉住一份。
 */
export const MAX_JOB_CONFIG_BYTES = MEMORY_BUDGET.jobs;

function jobImagesBytes(job: Job): number {
  const images = job.config?.images;
  if (!images) return 0;
  const all = [
    images.initImage,
    images.maskImage,
    images.controlImage,
    images.ipAdapterImage,
    images.endImage,
    ...images.refImages,
    ...images.controlFrames,
  ];
  let total = 0;
  for (const src of all) if (src) total += b64ByteLength(src);
  return total;
}

/**
 * 从最旧的任务开始剥离 `config.images`，直到总字节回到预算内。
 * 剥离后「应用此配置」只能恢复参数（图片输入丢失），UI 会在 toast 里说明。
 * 最新的任务永远保留图片，避免刚提交就丢。
 */
export function trimJobsToBudget(jobs: Job[], maxBytes: number = MAX_JOB_CONFIG_BYTES): Job[] {
  let total = 0;
  for (const job of jobs) total += jobImagesBytes(job);
  if (total <= maxBytes) return jobs;
  const next = jobs.slice();
  for (let i = next.length - 1; i >= 1 && total > maxBytes; i--) {
    const job = next[i];
    if (!job.config?.images) continue;
    total -= jobImagesBytes(job);
    next[i] = { ...job, config: { ...job.config, images: undefined } };
  }
  return next;
}

/**
 * 读取/写入 `vae_tiling_params.extra_tiling_args` 里的单个键（审查 30-api §2.9）。
 *
 * 上游把视频时间维分块放在这个 `key=value,key=value` 串里
 * （`temporal_tile_frames` / `temporal_tile_overlap`）。界面此前完全没有入口，
 * 而它是长视频解码 OOM 的主要缓解手段。这里只做「定位一个键、就地改值、保留
 * 其余键与原顺序」的最小操作。
 */
export function tilingArgValue(extra: string | undefined, key: string): number | null {
  if (!extra) return null;
  for (const part of extra.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    const n = Number(part.slice(eq + 1).trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function setTilingArgValue(
  extra: string | undefined,
  key: string,
  value: number | null,
): string {
  const parts = (extra || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => {
    const eq = p.indexOf("=");
    return eq < 0 || p.slice(0, eq).trim() !== key;
  });
  if (value != null) kept.push(`${key}=${value}`);
  return kept.join(",");
}

// ── 缓存微调（cache_option）/ SCM 步掩码 / SLG 层索引（审查 F-18）────────
//
// 语义依据见 docs/audit/95-f18-semantics.md，全部来自上游源码：
//  · `cache_option` 是 `key=value` 逗号串，不是枚举；**同名键在不同
//    cache_mode 下写不同字段**（`threshold` → easycache/ucache 的
//    reuse_threshold、其余模式的 residual_diff_threshold；`warmup` →
//    spectrum_warmup_steps / max_warmup_steps），未知键直接 400
//    （examples/common/common.cpp:2434-2494）。
//  · `scm_mask` 是逗号分隔 0/1，按**步索引**逐位生效，仅 dbcache/
//    taylorseer/cache-dit 消费（src/runtime/sample-cache.cpp:122）。
//  · SLG 的 `layers` 写进独立的 skip_layers，**空数组等于关闭**
//    （src/pipeline/diffusion_engine.cpp:2490）。

/** 缓存模式分组：同名参数在不同分组下写入不同上游字段。 */
export type CacheModeGroup = "easy" | "ucache" | "block" | "spectrum";

export interface CacheOptionFieldSpec {
  /** 上游键名（必须逐字符一致）。 */
  key: keyof CacheOptionDraft;
  label: string;
  kind: "float" | "int" | "toggle";
  min: number;
  max: number;
  step: number;
  /** 上游默认值（`INFINITY` 哨兵按模式解析后的实际值，见 stable-diffusion.cpp:286 与
   *  src/runtime/sample-cache.cpp:5-15）。仅用于控件占位，不会自动发送。 */
  defaultValue: number | boolean;
  hint?: string;
}

/**
 * 上游每个缓存模式认哪些键。数组顺序 **就是** 拼串顺序，保证同一份草稿永远
 * 得到同一个字符串（快照/测试不随对象键序抖动）。
 */
const EASY_FIELDS: CacheOptionFieldSpec[] = [
  {
    key: "threshold",
    label: "复用阈值",
    kind: "float",
    min: 0,
    max: 3,
    step: 0.05,
    defaultValue: 0.2,
    hint: "输入变化低于该阈值就复用上一步；上游 EasyCache 默认 0.2",
  },
  {
    key: "start",
    label: "开始缓存（步数比例）",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.15,
    hint: "0.15 = 从 15% 步开始缓存",
  },
  {
    key: "end",
    label: "停止缓存（步数比例）",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.95,
    hint: "需要大于开始比例，否则上游静默禁用缓存",
  },
  {
    key: "decay",
    label: "误差衰减",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 1,
  },
  {
    key: "relative",
    label: "按输出范数缩放阈值",
    kind: "toggle",
    min: 0,
    max: 1,
    step: 1,
    defaultValue: true,
  },
  {
    key: "reset",
    label: "每步计算后重置误差",
    kind: "toggle",
    min: 0,
    max: 1,
    step: 1,
    defaultValue: true,
  },
];

const UCACHE_FIELDS: CacheOptionFieldSpec[] = [
  {
    // UCache 的阈值语义与 EasyCache 相同（都写 reuse_threshold），但默认值不同，
    // 且取值范围更大（文档示例 threshold=1.5）。
    key: "threshold",
    label: "复用阈值",
    kind: "float",
    min: 0,
    max: 5,
    step: 0.05,
    defaultValue: 1,
    hint: "上游 UCache 默认 1.0，文档示例 1.5",
  },
  ...EASY_FIELDS.slice(1),
];

const BLOCK_FIELDS: CacheOptionFieldSpec[] = [
  {
    key: "Fn",
    label: "前段强制计算块数",
    kind: "int",
    min: 0,
    max: 32,
    step: 1,
    defaultValue: 8,
    hint: "Fn；默认 8",
  },
  {
    key: "Bn",
    label: "后段强制计算块数",
    kind: "int",
    min: 0,
    max: 32,
    step: 1,
    defaultValue: 0,
    hint: "Bn；默认 0",
  },
  {
    key: "threshold",
    label: "残差阈值",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.08,
    hint: "L1 残差低于该值就复用；与 EasyCache 的同名键不是同一个字段",
  },
  {
    key: "warmup",
    label: "预热步数",
    kind: "int",
    min: 0,
    max: 32,
    step: 1,
    defaultValue: 8,
    hint: "前 N 步始终计算；默认 8",
  },
];

const SPECTRUM_FIELDS: CacheOptionFieldSpec[] = [
  {
    key: "w",
    label: "Chebyshev/Taylor 权重",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.4,
    hint: "0 = 只用 Taylor，1 = 只用 Chebyshev；默认 0.40",
  },
  {
    key: "m",
    label: "Chebyshev 阶数",
    kind: "int",
    min: 1,
    max: 8,
    step: 1,
    defaultValue: 3,
  },
  {
    key: "lam",
    label: "岭回归正则",
    kind: "float",
    min: 0.01,
    max: 10,
    step: 0.01,
    defaultValue: 1,
  },
  {
    key: "window",
    label: "初始窗口",
    kind: "int",
    min: 1,
    max: 16,
    step: 1,
    defaultValue: 2,
    hint: "每 N 步计算一次；默认 2",
  },
  {
    key: "flex",
    label: "窗口增长步长",
    kind: "float",
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 0.5,
  },
  {
    key: "warmup",
    label: "预热步数",
    kind: "int",
    min: 0,
    max: 32,
    step: 1,
    defaultValue: 4,
    hint: "Spectrum 默认 4（其余缓存模式是 8）",
  },
  {
    key: "stop",
    label: "停止缓存（步数比例）",
    kind: "float",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.9,
  },
];

/** 上游 6 个非 disabled 缓存模式对应的界面分组；`disabled`/未知值返回 null。 */
export function cacheModeGroup(mode: string | undefined): CacheModeGroup | null {
  switch (mode) {
    case "easycache":
      return "easy";
    case "ucache":
      return "ucache";
    case "dbcache":
    case "taylorseer":
    case "cache-dit":
      return "block";
    case "spectrum":
      return "spectrum";
    default:
      return null;
  }
}

/** 当前模式可调的缓存键（顺序即拼串顺序）；关闭/未知模式返回空数组。 */
export function cacheOptionFields(mode: string | undefined): CacheOptionFieldSpec[] {
  switch (cacheModeGroup(mode)) {
    case "easy":
      return EASY_FIELDS;
    case "ucache":
      return UCACHE_FIELDS;
    case "block":
      return BLOCK_FIELDS;
    case "spectrum":
      return SPECTRUM_FIELDS;
    default:
      return [];
  }
}

/** 上游解析器接受的**全部**缓存键（跨模式并集），用于区分「未知键」与「本模式不适用」。 */
const CACHE_OPTION_ALL_KEYS = new Set<string>([
  ...EASY_FIELDS.map((f) => f.key as string),
  ...BLOCK_FIELDS.map((f) => f.key as string),
  ...SPECTRUM_FIELDS.map((f) => f.key as string),
]);

/** 全部键的类型表（解析原始串时判断 toggle/数值）。 */
const CACHE_OPTION_KEY_KIND = new Map<string, CacheOptionFieldSpec["kind"]>();
for (const spec of [...EASY_FIELDS, ...BLOCK_FIELDS, ...SPECTRUM_FIELDS]) {
  CACHE_OPTION_KEY_KIND.set(spec.key as string, spec.kind);
}

/** 数值格式化：收窄浮点尾数，且保证不出现空格（上游 `=` 两侧有空格会被当未知键）。 */
function formatOptionNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 10000) / 10000);
}

/**
 * 结构化草稿 → `cache_option` 串（固定键序）。
 *
 * 规则：
 *  - 只拼**当前模式合法**的键，顺序 = spec 顺序；
 *  - 草稿里未设置的键**不拼**（`undefined` = 用内核默认，与「显式等于默认值」不同）；
 *  - 数值按 spec 的 `min/max` 夹取、`int` 截断，toggle 拼成 `0/1`；
 *  - `raw` 里界面不认识的键原样追加在已知键之后（保留旧内核/其它工具写入的
 *    参数，避免「恢复元数据 → 再生成」丢设置）。
 */
export function buildCacheOption(
  mode: string | undefined,
  draft: CacheOptionDraft | undefined,
  raw?: string,
): string | undefined {
  const parts: string[] = [];
  for (const spec of cacheOptionFields(mode)) {
    const value = draft?.[spec.key];
    if (value === undefined || value === null) continue;
    if (spec.kind === "toggle") {
      if (typeof value !== "boolean") continue;
      parts.push(`${spec.key}=${value ? 1 : 0}`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = Math.min(
      spec.max,
      Math.max(spec.min, spec.kind === "int" ? Math.trunc(value) : value),
    );
    parts.push(`${spec.key}=${formatOptionNumber(clamped)}`);
  }
  for (const pair of parseCacheOption(raw).unknownPairs) {
    if (!CACHE_OPTION_ALL_KEYS.has(pair.key)) {
      parts.push(`${pair.key}=${pair.value}`);
    }
  }
  return parts.length ? parts.join(",") : undefined;
}

/**
 * `cache_option` 串 → 结构化草稿 + 未知键对。
 *
 * 上游按**逗号**切分（不含分号），缺 `=` 的段会直接 400，这里直接丢弃；
 * 未知键保留在 `unknownPairs` 里，由 `buildCacheOption` 原样带回。
 */
export function parseCacheOption(raw?: string): {
  draft: CacheOptionDraft;
  unknownPairs: { key: string; value: string }[];
} {
  const draft: CacheOptionDraft = {};
  const unknownPairs: { key: string; value: string }[] = [];
  if (!raw) return { draft, unknownPairs };
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (!key || !value) continue;
    const kind = CACHE_OPTION_KEY_KIND.get(key);
    if (!kind) {
      unknownPairs.push({ key, value });
      continue;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    if (kind === "toggle") draft[key as "relative" | "reset"] = num !== 0;
    else draft[key as keyof CacheOptionDraft] = num as never;
  }
  return { draft, unknownPairs };
}

/**
 * 切换 `cache_mode` 时裁剪草稿：丢掉新模式不认的键（上游对「本模式不适用的
 * 合法键」不报错但也不生效，留着只会让人以为设置生效了）。
 *
 * `threshold` / `warmup` 是**跨模式同名键**，命中不同的上游字段
 * （`common.cpp:2446-2471`）：目标的语义变了就一起丢掉，否则会把 EasyCache 的
 * 0.2 当成 dbcache 的残差阈值（EasyCache↔UCache 之间可以保留，两者都写
 * `reuse_threshold`）。
 */
export function sanitizeCacheOptionsForMode(
  nextMode: string | undefined,
  draft: CacheOptionDraft | undefined,
  prevMode?: string | undefined,
): CacheOptionDraft {
  if (!draft) return {};
  const allowed = new Set(cacheOptionFields(nextMode).map((f) => f.key as string));
  const prevGroup = cacheModeGroup(prevMode);
  const nextGroup = cacheModeGroup(nextMode);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined || value === null) continue;
    if (!allowed.has(key)) continue;
    if (
      (key === "threshold" || key === "warmup") &&
      cacheOptionTarget(key, prevGroup) !== cacheOptionTarget(key, nextGroup)
    ) {
      continue;
    }
    next[key] = value;
  }
  return next as CacheOptionDraft;
}

/** 同名缓存键在各模式下真正写入的上游字段（语义漂移的判据）。 */
function cacheOptionTarget(key: "threshold" | "warmup", group: CacheModeGroup | null): string {
  if (key === "threshold") {
    return group === "easy" || group === "ucache" ? "reuse_threshold" : "residual_diff_threshold";
  }
  return group === "spectrum" ? "spectrum_warmup_steps" : "max_warmup_steps";
}

/**
 * 请求体里最终要发的 `cache_option`。
 *
 * 结构化草稿存在（界面改过）时以草稿为准；否则沿用原始串（旧版本设置、
 * PNG 元数据恢复）。两者都没有则不发送，让内核用启动参数/默认值。
 */
export function resolveCacheOption(
  params: Pick<GenParams, "cache_mode" | "cache_option" | "cache_options">,
): string | undefined {
  if (!params.cache_options) {
    const raw = (params.cache_option || "").trim();
    return raw || undefined;
  }
  return buildCacheOption(params.cache_mode, params.cache_options, params.cache_option);
}

/** SCM 步掩码只在块级缓存（dbcache/taylorseer/cache-dit）下有意义。 */
export const SCM_MASK_MODES = ["dbcache", "taylorseer", "cache-dit"] as const;

/** 当前缓存模式是否消费 `scm_mask`（上游 src/runtime/sample-cache.cpp:122 只走 CACHEDIT 路径）。 */
export function scmMaskAppliesToMode(mode: string | undefined): boolean {
  return !!mode && (SCM_MASK_MODES as readonly string[]).includes(mode);
}

/** 合法掩码：逗号分隔的 0/1，空串视为未设置。 */
export const SCM_MASK_PATTERN = /^[01](,[01])*$/;

/**
 * 校验 SCM 掩码，返回可读错误（null = 合法/未设置）。
 *
 * **这条校验是安全边界，不是体验优化**：上游 `parse_scm_mask`
 * （src/runtime/cache_dit.hpp:558-575）对每段直接 `std::stoi` 且没有 try/catch，
 * 非数字或空段（如 `1,,0`）会抛 `std::invalid_argument`；该代码跑在 sd-server 的
 * 工作线程里（examples/server/main.cpp:119，且 examples/server/async_jobs.cpp
 * 全文没有 try/catch），异常逸出即 `std::terminate()` —— 内核整个进程消失。
 * 所以非法值一律**不下发**，而不是等 400（这个场景等不到 400）。
 */
export function validateScmMask(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (!SCM_MASK_PATTERN.test(text)) {
    return "只允许 0/1，用逗号分隔（如 1,1,1,0,0,1）。非法掩码会让 sd-server 崩溃，已阻止下发。";
  }
  return null;
}

/** 只在合法时返回要下发的掩码串；非法/空 → undefined（= 不发该键）。 */
export function normalizeScmMask(value: string | undefined): string | undefined {
  if (validateScmMask(value) !== null) return undefined;
  const text = (value ?? "").trim();
  return text || undefined;
}

/** 跳层索引上限：上游按 block 索引使用，超过 255 一定是误填。 */
const MAX_SKIP_LAYER = 255;

/** 跳层索引数组 → 输入框文本（空数组/未设置 → 空串）。 */
export function formatLayerList(layers: number[] | undefined): string {
  if (!layers?.length) return "";
  return layers.filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_SKIP_LAYER).join(",");
}

export type LayerListParseResult = { ok: true; layers?: number[] } | { ok: false; error: string };

/**
 * 输入框文本 → 跳层索引数组。
 *
 * 空串 = **未设置**（`layers` 不下发，沿用服务端 `--skip-layers`）；注意空数组在
 * 上游等于关闭 SLG（diffusion_engine.cpp:2490），所以这里绝不返回 `[]`。
 */
export function parseLayerList(text: string): LayerListParseResult {
  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: true };
  const layers: number[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) return { ok: false, error: "有空项：请用逗号分隔整数，如 7,8,9" };
    if (!/^\d+$/.test(token)) return { ok: false, error: `「${token}」不是非负整数` };
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value > MAX_SKIP_LAYER) {
      return { ok: false, error: `层索引需在 0–255 之间：${token}` };
    }
    layers.push(value);
  }
  return { ok: true, layers: [...new Set(layers)] };
}

/**
 * SLG 生效窗口校验（0–1 的总步数分数）。
 *
 * 上游按 `int(start*N) < step < int(end*N)` 判断（src/runtime/guidance.cpp:313-315），
 * `start >= end` 时窗口为空、SLG 永远不生效且**没有任何报错**——必须在界面上说清。
 */
export function validateSlgWindow(start?: number, end?: number): string | null {
  if (start == null || end == null) return null;
  if (!(start >= 0 && start <= 1) || !(end >= 0 && end <= 1)) {
    return "SLG 起止比例需要在 0–1 之间（总步数的分数）";
  }
  if (start >= end) {
    return "起始比例必须小于结束比例，否则 SLG 永远不会生效（上游静默跳过）";
  }
  return null;
}

/**
 * 统一的能力开关判定（审查 30-api §2.5）。
 *
 * 此前同一份 `features` 在两条路径上用了相反的极性：面板显隐用真值
 * （缺键即隐藏），提交裁剪用 `=== false`（缺键即照发），于是缺键的能力会
 * 变成「看不见但仍在生效」。这里把判定收成一处，显隐与提交必须用**同一个**
 * 调用（包括 fallback），缺键时由 fallback 决定，两边不会分叉。
 *
 * 注意 `features_by_mode` 在上游是硬编码常量（routes_sdcpp.cpp:195-225），
 * 缺键只可能出现在旧内核或裁剪过的实现里；`vae_tiling` 这类通用能力按
 * 历史行为保留 fallback = true。
 */
export function featureEnabled(
  features: Features | undefined,
  key: keyof Features,
  fallback = false,
): boolean {
  const value = features?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 把 `output_format` 收敛到当前内核支持的枚举（审查 30-api §2.6）。
 *
 * 生成参数是按 **mode** 而不是按内核持久化的：从「编译了 WebP 的内核」切到
 * 没有 WebP 的内核后，localStorage 里的旧值仍会随每次提交发出，服务端
 * `assign_output_options` 直接拒绝（400），而 UI 下拉里根本没有这一项、当前值
 * 只显示成占位符，用户看不出原因。上游 webui 有同款收敛（App.vue:246-247）。
 */
export function reconcileOutputFormat(
  params: GenParams,
  caps:
    | {
        output_formats_by_mode?: Partial<Record<GenMode, string[]>>;
        output_formats?: string[];
      }
    | null
    | undefined,
  mode: GenMode,
): GenParams {
  const perMode = caps?.output_formats_by_mode?.[mode];
  const formats = perMode?.length ? perMode : caps?.output_formats;
  if (!formats?.length) return params;
  if (params.output_format && formats.includes(params.output_format)) return params;
  return { ...params, output_format: formats[0] };
}

/**
 * 所选内核使用哪一套 VAE 分块字段。
 *
 * capabilities 的 `defaults_by_mode[*].vae_tiling_params` 一定带键名，用它
 * 判别协议；上游 #2059 起为 w/h（图像像素），之前为 x/y（latent 单位）。
 * 两套都没有（旧内核或裁剪过的响应）时按最新内核处理——Lumina 的对齐目标
 * 是上游 master。
 */
export function vaeTilingProtocolFromCapabilities(
  caps?: {
    defaults_by_mode?: Partial<Record<GenMode, { vae_tiling_params?: VaeTilingParams }>>;
  } | null,
): VaeTilingProtocol {
  for (const mode of ["img_gen", "vid_gen"] as GenMode[]) {
    const tiling = caps?.defaults_by_mode?.[mode]?.vae_tiling_params;
    if (!tiling) continue;
    if (tiling.tile_size_w != null || tiling.tile_size_h != null) return "pixels";
    if (tiling.rel_size_w != null || tiling.rel_size_h != null) return "pixels";
    if (tiling.tile_size_x != null || tiling.tile_size_y != null) return "latent";
    if (tiling.rel_size_x != null || tiling.rel_size_y != null) return "latent";
  }
  return "pixels";
}

/** 该分块设置是否带旧内核的 latent 单位字段（x/y 命名）。 */
export function hasLegacyLatentTiling(params?: VaeTilingParams): boolean {
  if (!params) return false;
  return [params.tile_size_x, params.tile_size_y, params.rel_size_x, params.rel_size_y].some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

/** 该分块设置是否带新内核的像素单位字段（w/h 命名）。 */
export function hasPixelTiling(params?: VaeTilingParams): boolean {
  if (!params) return false;
  return [params.tile_size_w, params.tile_size_h, params.rel_size_w, params.rel_size_h].some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

/** 该分块设置里遗留的旧内核 latent 尺寸字段（按轴），用于逐轴提示与清除。 */
export function legacyLatentTilingAxes(params?: VaeTilingParams): {
  tileX?: number;
  tileY?: number;
  relX?: number;
  relY?: number;
} {
  if (!params) return {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    tileX: num(params.tile_size_x),
    tileY: num(params.tile_size_y),
    relX: num(params.rel_size_x),
    relY: num(params.rel_size_y),
  };
}

/** 移除旧内核的 latent 字段，保留像素字段（用户确认重设后使用）。 */
export function clearLegacyLatentTiling(params?: VaeTilingParams): VaeTilingParams {
  const next: VaeTilingParams = { ...params };
  delete next.tile_size_x;
  delete next.tile_size_y;
  delete next.rel_size_x;
  delete next.rel_size_y;
  return next;
}

/**
 * 像素协议下是否存在会被丢弃的旧 latent 数值。
 *
 * 只要旧值还在就提示——**不能**用"已经有新的像素值"来消除提示：那些像素值
 * 可能是 capabilities 的启动默认值，用户并没有真正迁移过旧设置；而且旧值是
 * 逐轴的，只重设了宽度不代表高度也不用管。提示里提供"清除旧值"出口，
 * 用户确认后才消失。
 */
export function legacyTilingDroppedOnPixels(params?: VaeTilingParams): boolean {
  return !!params?.enabled && hasLegacyLatentTiling(params);
}

/**
 * 反方向：旧内核（latent 协议）下像素数值是否会被丢弃。
 *
 * 与 `legacyTilingDroppedOnPixels` 对称。用新内核出图后把 PNG 元数据回填、
 * 又切回旧内核时会走到这里：`resolveVaeTilingForProtocol` 会删掉 w/h，
 * 所以界面必须给出同样的提示，而不是让设置静默消失。
 */
export function pixelTilingDroppedOnLatent(params?: VaeTilingParams): boolean {
  if (!params?.enabled || !hasPixelTiling(params)) return false;
  return ![params.tile_size_x, params.tile_size_y, params.rel_size_x, params.rel_size_y].some(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

/**
 * 生成该协议下的 `vae_tiling_params` 请求体。
 *
 * 只发送内核能识别的键：新版内核不读 x/y，旧版不读 w/h，混发会让"设置了
 * 但没生效"变得无法解释。关闭时显式发 `enabled:false`，避免沿用服务端默认。
 */
export function resolveVaeTilingForProtocol(
  params: VaeTilingParams | undefined,
  protocol: VaeTilingProtocol,
): Record<string, unknown> {
  if (!params?.enabled) return { enabled: false };
  const next: Record<string, unknown> = { ...params };
  const legacyKeys = ["tile_size_x", "tile_size_y", "rel_size_x", "rel_size_y"];
  const pixelKeys = ["tile_size_w", "tile_size_h", "rel_size_w", "rel_size_h"];
  for (const key of protocol === "pixels" ? legacyKeys : pixelKeys) {
    delete next[key];
  }
  return next;
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

/** 取路径/文件名的 stem（去目录、去扩展名）；Windows 分隔符一并处理。 */ function fileStem(
  name: string,
): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 把元数据里的 LoRA 名字匹配回 capabilities 的条目。
 *
 * 两侧 `name` 语义不同：元数据写的是**含扩展名的文件名**（上游
 * `common.cpp:3146` 用 `sd_basename`），capabilities 给的是 **stem**
 * （上游 `runtime.cpp:286` 用 `p.stem()`）。直接 `a.name === name` 会让所有
 * LoRA 静默匹配失败（审查 S-10），所以这里按「原名 → 去扩展名 → 路径尾部」
 * 逐级归一化比较。
 */
export function matchAvailableLora(
  available: { name: string; path: string }[],
  metaName: string,
): { name: string; path: string } | undefined {
  const target = fileStem(metaName);
  const basenameOf = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;
  return (
    available.find((a) => a.name === metaName) ||
    available.find((a) => a.name === target) ||
    available.find((a) => fileStem(a.name) === target) ||
    available.find((a) => {
      const base = basenameOf(a.path);
      return base === metaName || fileStem(base) === target;
    })
  );
}

/** 把 sd-server 嵌入图片的 `sdcpp.image.params/v1` 元数据映射为 GenParams。
 * 元数据中的 LoRA 只有文件名，需用 `availableLoras` 按名字匹配回完整路径，
 * 匹配不到的 LoRA 跳过（无法恢复路径）。 */
export function sdcppMetadataToGenParams(
  meta: Record<string, unknown>,
  availableLoras?: { name: string; path: string }[],
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
    // 新内核（上游 #2028 起）元数据只写 ref_image_args；旧图仍是布尔键。
    auto_resize_ref_image:
      metaBool(meta.auto_resize_ref_image) ??
      refResizeFromRefImageArgs(metaStr(meta.ref_image_args)),
    ref_image_args: metaStr(meta.ref_image_args),
    image_preprocess: metaRuleList(meta.image_preprocess),
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
    const rawCacheOption = metaStr(cache.requested_option);
    out.cache_option = rawCacheOption;
    // 结构化草稿同步回填（F-18）：控件读的是 `cache_options`，只回填原始串的话
    // 「从历史恢复参数」看起来像没生效（界面上全是默认值）。未知键仍留在
    // `cache_option` 原文里，下次发送由 buildCacheOption 原样带回。
    if (rawCacheOption) {
      const parsed = parseCacheOption(rawCacheOption);
      if (Object.keys(parsed.draft).length) out.cache_options = parsed.draft;
    }
    out.scm_mask = metaStr(cache.scm_mask);
    out.scm_policy_dynamic = metaBool(cache.scm_policy_dynamic);
  }
  // 上游只在 enabled / temporal_tiling 为真、或写了 extra_tiling_args 时
  // 才写 vae_tiling 段（common.cpp build_sdcpp_image_metadata_json），
  // 键名与请求体一致。
  if (vaeTiling) {
    // 上游 #2059 起元数据写 tile_size_w/h、rel_size_w/h（图像像素）；旧图仍是
    // x/y（latent 单位）。**两套键各自按存在性回填，不做交叉回退**：单位不同，
    // 把 latent 数值当成像素会得到完全错误的分块。发送时由协议决定用哪一套
    // （见 resolveVaeTilingForProtocol），旧图在新内核上会提示重设。
    const pixelKeys = {
      tile_size_w: metaNum(vaeTiling.tile_size_w),
      tile_size_h: metaNum(vaeTiling.tile_size_h),
      rel_size_w: metaNum(vaeTiling.rel_size_w),
      rel_size_h: metaNum(vaeTiling.rel_size_h),
    };
    const latentKeys = {
      tile_size_x: metaNum(vaeTiling.tile_size_x),
      tile_size_y: metaNum(vaeTiling.tile_size_y),
      rel_size_x: metaNum(vaeTiling.rel_size_x),
      rel_size_y: metaNum(vaeTiling.rel_size_y),
    };
    const present = (keys: Record<string, number | undefined>) =>
      Object.values(keys).some((v) => typeof v === "number" && Number.isFinite(v));
    out.vae_tiling_params = {
      enabled: metaBool(vaeTiling.enabled) ?? true,
      temporal_tiling: metaBool(vaeTiling.temporal_tiling),
      target_overlap: metaNum(vaeTiling.target_overlap),
      extra_tiling_args: metaStr(vaeTiling.extra_tiling_args),
      ...(present(pixelKeys) ? pixelKeys : {}),
      ...(present(latentKeys) ? latentKeys : {}),
    };
  }
  if (Array.isArray(meta.loras) && availableLoras?.length) {
    const loras: LoraEntry[] = [];
    for (const raw of meta.loras) {
      if (!isMetaObj(raw)) continue;
      const name = metaStr(raw.name);
      if (!name) continue;
      const found = matchAvailableLora(availableLoras, name);
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

/** 预览枚举是协议级能力；模式本身也必须声明支持预览。 */
export function previewModesFromCapabilities(caps: Capabilities, mode: GenMode): string[] {
  if (caps.features_by_mode?.[mode]?.preview !== true) return [];
  if (!Array.isArray(caps.preview_modes)) return [];
  return [...new Set(caps.preview_modes.filter((value) => typeof value === "string"))];
}

/** 旧设置中不受当前内核支持的预览模式只关闭，不补成可选项。 */
export function resolvePreviewMode(
  value: string | undefined,
  modes: string[] = ["none", "proj", "tae", "vae"],
): string {
  return typeof value === "string" && modes.includes(value) ? value : "none";
}

/** 预览间隔（采样步）：上游把非正值夹到 1，界面缺省也按 1 发送。 */
function previewInterval(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1;
  const n = Math.trunc(value);
  if (n <= 0) return 1;
  // 间隔大于总步数等于没有预览；给一个远高于常见步数的上限，挡住异常输入。
  return Math.min(n, 1000);
}

/** Build the `/sdcpp/v1/img_gen|vid_gen` request body (mirrors webui). */
export interface BuildRequestBodyOptions {
  /** 启动期 `--ref-image-args preset=…`（来自设置的 refImagePreset）。 */
  refImagePreset?: string;
  /**
   * 所选内核的 VAE 分块字段协议（见 `vaeTilingProtocolFromCapabilities`）。
   * 缺省按最新内核（图像像素 w/h）。
   */
  vaeTilingProtocol?: VaeTilingProtocol;
  /** 当前模式实际支持的预览枚举；空数组禁用预览。 */
  previewModes?: string[];
}

export function buildRequestBody(
  mode: GenMode,
  params: GenParams,
  images: GenImages,
  options: BuildRequestBodyOptions = {},
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
    (sampleParams.guidance as Record<string, unknown>).distilled_guidance = distilled;
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

  if (params.clip_skip != null && params.clip_skip !== -1) b.clip_skip = params.clip_skip;
  if (params.strength != null) b.strength = params.strength;
  // 上游 #2028：img_gen 与 vid_gen 都接受 image_preprocess（规则串数组）。
  // 编辑态保留空行与空白，避免受控文本框吞掉 Enter；仅在请求边界清理。
  const imagePreprocess = imagePreprocessDraftLines(params.image_preprocess)
    .map((line) => line.trim())
    .filter(Boolean);
  if (imagePreprocess.length) b.image_preprocess = imagePreprocess;

  if (mode === "img_gen") {
    b.batch_count = params.batch_count || 1;
    if (params.qwen_image_layers != null) b.qwen_image_layers = params.qwen_image_layers;
    // 缩放开关新旧双发：旧内核只认布尔键，新内核（#2028 起）只认
    // ref_image_args，未知键在两边都只被忽略、不会报错。
    b.auto_resize_ref_image = params.auto_resize_ref_image !== false;
    const refImageArgs = buildRefImageArgs(params, options.refImagePreset);
    if (refImageArgs) b.ref_image_args = refImageArgs;
    b.increase_ref_index = !!params.increase_ref_index;
    b.control_strength = params.control_strength ?? 0.9;
    b.ip_adapter_strength = params.ip_adapter_strength ?? 1.0;
    b.embed_image_metadata = params.embed_image_metadata !== false;
  }
  if (mode === "vid_gen") {
    b.video_frames = params.video_frames || 33;
    // 上游 SDGenerationParams::fps 缺省是 16（common.h:249），上游 webui 也用 16。
    // 这里写 24 会在参数缺失时强加一个与「按内核默认」不同的值（审查 30-api §2.6）。
    b.fps = params.fps || 16;
    // vid_gen 同样接受 embed_image_metadata（审查 30-api §2.10）：此前只有
    // img_gen 会发，视频结果永远带元数据、用户关不掉。
    b.embed_image_metadata = params.embed_image_metadata !== false;
    if (params.moe_boundary != null) b.moe_boundary = params.moe_boundary;
    if (params.vace_strength != null) b.vace_strength = params.vace_strength;
  }

  if (images.initImage) b.init_image = images.initImage;
  if (mode === "img_gen" && images.maskImage) b.mask_image = images.maskImage;
  if (mode === "img_gen" && images.controlImage) b.control_image = images.controlImage;
  if (mode === "img_gen" && images.ipAdapterImage) b.ip_adapter_image = images.ipAdapterImage;
  if (mode === "vid_gen" && images.endImage) b.end_image = images.endImage;
  // 参考图同时服务于 img_gen（Kontext/PiD 等）与声明支持的 vid 家族
  // （MiniMax-H3 Ref2VA）。调用方按家族能力裁剪后再传入，此处不按 mode 硬过滤。
  if (images.refImages?.length) b.ref_images = images.refImages;
  // VACE 条件帧：顺序即条件帧顺序，上游按请求顺序保留。
  if (mode === "vid_gen" && images.controlFrames?.length) b.control_frames = images.controlFrames;

  if (sp?.eta != null) sampleParams.eta = sp.eta;
  if (sp?.flow_shift != null) sampleParams.flow_shift = sp.flow_shift;
  if (sp?.shifted_timestep != null) sampleParams.shifted_timestep = sp.shifted_timestep;
  if (sp?.custom_sigmas?.length) sampleParams.custom_sigmas = sp.custom_sigmas;
  if (sp?.guidance?.img_cfg != null)
    (sampleParams.guidance as Record<string, unknown>).img_cfg = sp.guidance.img_cfg;
  const slg = sp?.guidance?.slg;
  if (slg && slg.scale > 0) {
    // 只发用户真正设置过的子项：`layers` 缺省时**省略该键**，让服务端沿用
    // `--skip-layers`（capabilities 的默认值里带着启动参数的真实取值，硬塞
    // [7,8,9] 会把它顶掉）。空数组在上游等于关闭 SLG（diffusion_engine.cpp:2490），
    // 所以也绝不能发 `layers: []`。
    const slgBody: Record<string, unknown> = { scale: slg.scale };
    if (slg.layers?.length) slgBody.layers = slg.layers;
    if (slg.layer_start != null) slgBody.layer_start = slg.layer_start;
    if (slg.layer_end != null) slgBody.layer_end = slg.layer_end;
    (sampleParams.guidance as Record<string, unknown>).slg = slgBody;
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
    if (h.upscale_tile_size != null && h.upscale_tile_size <= 0) delete h.upscale_tile_size;
    b.hires = h;
  } else {
    // 显式关闭：省略字段会沿用服务端默认（可能是开启）。
    b.hires = { enabled: false };
  }
  // 上游 #2059 改动字段名与单位（latent → 图像像素），按内核协议只发一套键。
  b.vae_tiling_params = resolveVaeTilingForProtocol(
    params.vae_tiling_params,
    options.vaeTilingProtocol ?? "pixels",
  );

  if (params.cache_mode && params.cache_mode !== "disabled") {
    b.cache_mode = params.cache_mode;
    // cache_option：结构化草稿优先（固定键序、按模式裁剪），否则沿用原始串
    // （旧设置 / PNG 元数据恢复）。见 docs/audit/95-f18-semantics.md §2。
    const cacheOption = resolveCacheOption(params);
    if (cacheOption) b.cache_option = cacheOption;
    // scm_mask：**非法内容一律不下发**。上游解析器无 try/catch 且跑在 worker
    // 线程，坏掩码会让 sd-server terminate（见 validateScmMask 注释）。
    const scmMask = normalizeScmMask(params.scm_mask);
    if (scmMask) b.scm_mask = scmMask;
    // scm_policy_dynamic 不发送：上游 from_json_str（common.cpp）只解析
    // cache_mode/cache_option/scm_mask，该键在请求体中会被静默忽略——
    // 真正的开关是服务端启动参数 --scm-policy。capabilities 的默认值里
    // 仍会携带该键，但发送它只会制造"已生效"的假象。
  } else {
    // 上游接受 "disabled"（common.cpp validate），显式覆盖服务端默认。
    b.cache_mode = "disabled";
  }

  // 切换内核/模式后，持久化的旧预览选项不能绕过能力检查。
  b.preview = resolvePreviewMode(params.preview, options.previewModes);
  if (b.preview !== "none") {
    b.preview_interval = previewInterval(params.preview_interval);
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
    // 高噪段 SLG 只在真的开启时发送（审查 95 §5.3）。此前恒发 `{scale:0}`，
    // 会把服务端启动参数 `--high-noise-slg-scale` 每条请求都打回关闭；
    // 「要关掉服务端默认」只能靠启动参数表达，不能靠恒发 0 去猜。
    const hnSlg = h.guidance?.slg;
    if (hnSlg && hnSlg.scale > 0) {
      const hnSlgBody: Record<string, unknown> = { scale: hnSlg.scale };
      if (hnSlg.layers?.length) hnSlgBody.layers = hnSlg.layers;
      if (hnSlg.layer_start != null) hnSlgBody.layer_start = hnSlg.layer_start;
      if (hnSlg.layer_end != null) hnSlgBody.layer_end = hnSlg.layer_end;
      (hn.guidance as Record<string, unknown>).slg = hnSlgBody;
    }
    const hnExtraArgs = buildExtraSampleArgs(h);
    if (hnExtraArgs) hn.extra_sample_args = hnExtraArgs;
    b.high_noise_sample_params = hn;
  }

  return b;
}
