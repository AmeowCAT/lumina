import type {
  CacheOptionDraft,
  Capabilities,
  Features,
  GenImages,
  GenMode,
  GenParams,
  Job,
  JobProgress,
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

/**
 * 递归剥离 plain object 中值为 `null` / `undefined` 的键（保留数组与非空原始值）。
 *
 * 上游 #2365/#2396 起 `SDGenerationParams` / `SDSampleParams` 的大多数成员改为
 * `std::optional<T>`，`/capabilities` 的 `defaults_by_mode` 对启动期未显式配置的
 * 字段统一输出 JSON `null`。直接 `deepMerge` 会把家族推荐值和中性默认值冲成
 * `null`（导致宽/高/步数/种子全部失效），合并前必须先过滤空值。
 */
export function stripNullish<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const nested = stripNullish(raw as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else {
      out[key] = raw;
    }
  }
  return out as T;
}

/** 各生成模式的中性兜底默认值（当 capabilities 字段为 null 且无家族预设时兜住界面）。 */
export function neutralModeDefaults(mode: GenMode): GenParams {
  if (mode === "vid_gen") {
    return {
      prompt: "",
      negative_prompt: "",
      width: 832,
      height: 480,
      seed: -1,
      video_frames: 33,
      fps: 16,
      sample_params: {
        sample_steps: 20,
        guidance: { txt_cfg: 6 },
      },
    };
  }
  return {
    prompt: "",
    negative_prompt: "",
    width: 1024,
    height: 1024,
    seed: -1,
    batch_count: 1,
    sample_params: {
      sample_steps: 20,
      guidance: { txt_cfg: 7 },
    },
  };
}

/**
 * 合并生成页初始化参数：中性兜底 → 家族推荐 → 服务端非空默认 → localStorage 持久化。
 *
 * 所有层级先过 `stripNullish`，确保 `#2396+` 内核 `defaults_by_mode` 里的 `null`
 * 不会把家族推荐值或中性默认值覆盖掉，同时显式写在启动参数里的非空默认值仍然生效。
 */
export function resolveInitialParams(
  mode: GenMode,
  capsDefaults: Partial<GenParams> | undefined,
  familyRecommended: Record<string, unknown> | undefined,
  persisted?: Record<string, unknown> | null,
): GenParams {
  let merged = neutralModeDefaults(mode);
  if (familyRecommended) merged = deepMerge(merged, stripNullish(deepClone(familyRecommended)));
  if (capsDefaults) merged = deepMerge(merged, stripNullish(deepClone(capsDefaults)));
  if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
    merged = deepMerge(merged, stripNullish(deepClone(persisted)));
  }
  if (!merged.sample_params) merged.sample_params = { guidance: {} };
  if (!merged.sample_params.guidance) merged.sample_params.guidance = {};
  return merged;
}

/**
 * 合并「重置为推荐值」参数：中性兜底 → 服务端非空默认 → 家族推荐。
 * 显式重置时家族推荐优先于服务端通用默认，且保留非空输出格式等服务端默认。
 */
export function resolveResetParams(
  mode: GenMode,
  capsDefaults: Partial<GenParams> | undefined,
  familyRecommended: Record<string, unknown> | undefined,
): GenParams {
  let merged = neutralModeDefaults(mode);
  if (capsDefaults) merged = deepMerge(merged, stripNullish(deepClone(capsDefaults)));
  if (familyRecommended) merged = deepMerge(merged, stripNullish(deepClone(familyRecommended)));
  if (!merged.sample_params) merged.sample_params = { guidance: {} };
  if (!merged.sample_params.guidance) merged.sample_params.guidance = {};
  return merged;
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
 * 内核任务时间戳归一成毫秒。
 *
 * 上游 #2176（recipe 模型管理）起 `created` / `started` / `completed` 从秒改成
 * **毫秒**（`examples/server/runtime.cpp` 的 `unix_timestamp_now_ms`，
 * `api.md` 里写明 "integer Unix timestamps in milliseconds"），旧内核仍是秒。
 * 两代内核都会出现在用户机器上，因此按量级判定：秒制时间戳约 1.7e9，毫秒制约
 * 1.7e12；阈值取 1e11（秒制要到公元 5138 年才越过，毫秒制 1973 年就已超过），
 * 两边都不会误判。
 */
export function toEpochMs(value?: number | null): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? value : value * 1000;
}

/**
 * 数字输入框/滑杆的显示格式：整数原样，小数按 6 位有效数字收敛。
 *
 * 上游（C++ float + nlohmann json）和 PNG 元数据里的浮点常带出
 * `0.00999999999776482582` / `0.20000000298023224` 这类尾巴，直接 `String(value)`
 * 塞进 number input 会又长又难读——而这些值的语义就是 0.01 / 0.2。6 位有效数字
 * 足够覆盖界面上的所有参数（步数、比例、强度、缩放），也不会碰整数（如
 * lms_divisions 的 12345678）。
 */
export function formatNumberForInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toPrecision(6));
  if (!Number.isFinite(rounded)) return "";
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * 任务耗时的显示文案。
 *
 * 优先用内核时间戳 `completed - started`（真实采样时长）；旧内核不给
 * `started`/`completed` 时退回「created → 最近一次成功轮询」。旧实现一律用
 * created，把排队等待与 2s 轮询抖动都算进生成耗时（审查 30-api §2.8）。
 *
 * 时间戳单位由 [`toEpochMs`] 归一，兼容上游 #2176 前后的秒/毫秒两代内核。
 */
export function jobElapsed(job: Job, terminal: boolean): string {
  if (job.status === "queued") return "";
  const beginMs = toEpochMs(job.started ?? job.created);
  if (!beginMs) return "";
  const endedAt = toEpochMs(job.completed) ?? (terminal ? job.lastPollSuccess : undefined);
  if (terminal && !endedAt) return "";
  const ms = (endedAt ?? Date.now()) - beginMs;
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * 结构化进度的阶段文案（上游 #2303）。api.md 明确要求客户端容忍未知
 * stage/detail/unit：未知值原样返回，不猜、不吞。
 */
const PROGRESS_STAGE_LABELS: Record<string, string> = {
  queued: "排队中",
  waiting: "等待执行",
  preparing: "准备中",
  executing: "执行中",
  conditioning: "条件编码",
  sampling: "采样",
  vae_encode: "VAE 编码",
  vae_decode: "VAE 解码",
  audio_decode: "音频解码",
  upscaling: "放大",
  adetailer: "细节修复",
  encoding: "输出编码",
};

export function progressStageLabel(stage: string): string {
  return PROGRESS_STAGE_LABELS[stage] ?? stage;
}

const PROGRESS_DETAIL_LABELS: Record<string, string> = {
  positive_prompt: "正向提示词",
  negative_prompt: "负向提示词",
  image_condition: "图像条件",
  high_noise: "高噪段",
  low_noise: "低噪段",
  image: "图片",
  video: "视频",
  dgl: "DGL 脚本",
};

export function progressDetailLabel(detail: string): string {
  return PROGRESS_DETAIL_LABELS[detail] ?? detail;
}

/**
 * 任务行/结果卡的进度摘要：阶段 + 细节 + 段号 + 段内计数。
 * 计数只在 `unit=steps` 且 total 已知时显示（上游：未知计数是 null，
 * 不是估算百分比）；pass>1 才显示段号，避免单段任务噪音。
 */
export function jobProgressSummary(p: JobProgress): string {
  const parts = [progressStageLabel(p.stage)];
  if (p.detail) parts.push(progressDetailLabel(p.detail));
  if ((p.pass ?? 0) > 1) parts.push(`第${p.pass}段`);
  if (p.unit === "steps" && p.total != null && p.total > 0) {
    parts.push(`${p.completed ?? 0}/${p.total}`);
  }
  return parts.join(" · ");
}

/**
 * 结果项 `generation_info` 里的实际 seed：
 *  - 上游 #2206–32d516c：`sdcpp.generation/v1` JSON 对象，`seed` 为十进制字符串
 *    （保全 int64 范围），宽松兼容 number；
 *  - 上游 #2396+：UTF-8 DGL 源码字符串（或由 Rust 包装的 `sdcpp.dgl/v1` 对象），
 *    从 `var { seed = <int> }` 提取。
 * 解析失败/负值返回 undefined，调用方回落「请求 seed + 批次偏移」的旧逻辑。
 */
export function generationInfoSeed(
  info?: Record<string, unknown> | string | null,
): number | undefined {
  if (!info) return undefined;
  if (typeof info === "string") {
    const vars = parseDglVarBlock(info);
    return generationInfoSeed(vars);
  }
  const raw = info.seed;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  if (typeof info.dgl === "string") {
    return generationInfoSeed(info.dgl);
  }
  return undefined;
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
    // Ref2VA 参考媒体（上游 #2194）：抽帧数组可达数十 MB，必须计入预算，
    // 否则任务输入层会悄悄超出总账。
    ...(images.refVideos ?? []).flat(),
    ...(images.refAudios ?? []),
    ...(images.refVideoAudios ?? []),
    // 内联提示图片（上游 #2341）：最多 32 张 base64 图，必须计入预算。
    ...Object.values(images.promptImages ?? {}),
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

/** 读取 `key=value` 串里的字符串值（`ref_image_args` 的 `ref_image_size` 这类非数值键）。 */
export function stringArgValue(extra: string | undefined, key: string): string | null {
  if (!extra) return null;
  for (const part of extra.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/** 设置/删除 `key=value` 串里的字符串键，保留其它键与顺序（新键追加在末尾）。 */
export function setStringArgValue(
  extra: string | undefined,
  key: string,
  value: string | null,
): string {
  const parts = (extra || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => {
    const eq = p.indexOf("=");
    return eq < 0 || p.slice(0, eq).trim() !== key;
  });
  if (value != null && value !== "") kept.push(`${key}=${value}`);
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

/**
 * 当前模式可调的缓存键（顺序即拼串顺序）；关闭/未知模式返回空数组。
 * 上游 #2396+（DGL 架构）改为条件级缓存，`Fn`/`Bn` 在 common.cpp 里只打告警并忽略，
 * 因此 `dglBackend` 为 true 时隐藏并跳过这两个键。
 */
export function cacheOptionFields(
  mode: string | undefined,
  options?: { dglBackend?: boolean },
): CacheOptionFieldSpec[] {
  switch (cacheModeGroup(mode)) {
    case "easy":
      return EASY_FIELDS;
    case "ucache":
      return UCACHE_FIELDS;
    case "block":
      return options?.dglBackend
        ? BLOCK_FIELDS.filter((f) => f.key !== "Fn" && f.key !== "Bn")
        : BLOCK_FIELDS;
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
  options?: { dglBackend?: boolean },
): string | undefined {
  const parts: string[] = [];
  for (const spec of cacheOptionFields(mode, options)) {
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
  options?: { dglBackend?: boolean },
): string | undefined {
  if (!params.cache_options) {
    const raw = (params.cache_option || "").trim();
    if (!raw) return undefined;
    if (options?.dglBackend) {
      const kept = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => {
          if (!part) return false;
          const eq = part.indexOf("=");
          const key = eq > 0 ? part.slice(0, eq).trim() : "";
          return key !== "Fn" && key !== "Bn";
        });
      return kept.length ? kept.join(",") : undefined;
    }
    return raw;
  }
  return buildCacheOption(params.cache_mode, params.cache_options, params.cache_option, options);
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
    // 上游 #2365/#2396 起 std::optional 未设置时输出 JSON null，键存在即表明协议类型。
    if (
      "tile_size_w" in tiling ||
      "tile_size_h" in tiling ||
      "rel_size_w" in tiling ||
      "rel_size_h" in tiling
    ) {
      return "pixels";
    }
    if (
      "tile_size_x" in tiling ||
      "tile_size_y" in tiling ||
      "rel_size_x" in tiling ||
      "rel_size_y" in tiling
    ) {
      return "latent";
    }
  }
  return "pixels";
}

/**
 * 判断所连接的 `sd-server` 是否为上游 #2396+ DGL 架构内核。
 *
 * 判据取自上游 `routes_sdcpp.cpp` + `model_catalog.cpp` 的确定性协议指纹，绝不按
 * Lumina 自身版本猜测：
 *  1. 若 `defaults_by_mode` / `defaults` 仍含 `image_preprocess` 或 `ref_image_args`，
 *     一定是 #2028–32d516c 的前 DGL 内核 → `false`（先早退，避免前 DGL recipe
 *     偶发关闭 `slg` 时误判）；
 *  2. 否则，以下任一指纹成立即确认是 #2396+ DGL 内核：
 *     - `defaults_by_mode.img_gen`（或 `defaults`）含 `control_type`（#2284 新增，
 *       晚于 `image_preprocess`）却不含 `image_preprocess` / `ref_image_args`；
 *     - `features_by_mode.vid_gen.high_noise_sample_params === false`（#2396 从 true 改 false）；
 *     - `generation_features` 同时将 `slg`、`shifted_timestep`、`ip_adapter` 置为 `false`
 *       （#2396 `resolve_recipe_features` 强制清零这三项）。
 */
export function isDglBackend(caps?: Capabilities | null): boolean {
  if (!caps) return false;
  const imgDefaults = caps.defaults_by_mode?.img_gen ?? caps.defaults;
  const vidDefaults = caps.defaults_by_mode?.vid_gen;
  const hasPreDglDefaults = (d?: GenParams) =>
    !!d && ("image_preprocess" in d || "ref_image_args" in d || "increase_ref_index" in d);
  if (hasPreDglDefaults(imgDefaults) || hasPreDglDefaults(vidDefaults)) return false;

  if (imgDefaults && "control_type" in imgDefaults) return true;
  if (caps.features_by_mode?.vid_gen?.high_noise_sample_params === false) return true;
  const gf = caps.generation_features;
  if (gf && gf.slg === false && gf.shifted_timestep === false && gf.ip_adapter === false) {
    return true;
  }
  return false;
}

/** 当前内核是否支持在原生请求体里发送 SLG（#2396+ 已迁至 DGL，发送即 400）。 */
export function supportsSlg(caps?: Capabilities | null): boolean {
  if (isDglBackend(caps)) return false;
  if (caps?.generation_features && typeof caps.generation_features.slg === "boolean") {
    return caps.generation_features.slg;
  }
  return true;
}

/** 当前内核是否支持在原生请求体里发送 `shifted_timestep`（#2396+ 已迁至 DGL，发送即 400）。 */
export function supportsShiftedTimestep(caps?: Capabilities | null): boolean {
  if (isDglBackend(caps)) return false;
  if (caps?.generation_features && typeof caps.generation_features.shifted_timestep === "boolean") {
    return caps.generation_features.shifted_timestep;
  }
  return true;
}

/** 当前内核是否支持原生 `image_preprocess`（#2396+ 出现即 400）。 */
export function supportsImagePreprocess(caps?: Capabilities | null): boolean {
  return !isDglBackend(caps);
}

/** 当前内核是否支持原生 `ref_image_args` / `increase_ref_index`（#2396+ 非空/true 即 400）。 */
export function supportsRefImageOverrides(caps?: Capabilities | null): boolean {
  return !isDglBackend(caps);
}

/** 当前内核是否支持原生 IP-Adapter 请求字段（#2396+ 发送 `ip_adapter_strength` 即 400）。 */
export function supportsIpAdapter(caps?: Capabilities | null, features?: Features): boolean {
  if (isDglBackend(caps)) return false;
  if (features && typeof features.ip_adapter_image === "boolean") {
    return features.ip_adapter_image;
  }
  if (caps?.generation_features && typeof caps.generation_features.ip_adapter === "boolean") {
    return caps.generation_features.ip_adapter;
  }
  return true;
}

/**
 * 当前内核是否支持高噪段完整独立采样参数（采样器/调度器/CFG/Eta/Flow Shift/额外参数）。
 * 上游 #2396+ 只允许 `high_noise_sample_params.sample_steps`（配 `moe_boundary`），
 * 发送其它高噪段字段会被 `dgl_only_parameter` 拒绝（400）。
 */
export function supportsFullHighNoiseSampling(
  caps?: Capabilities | null,
  features?: Features,
): boolean {
  if (isDglBackend(caps)) return false;
  if (features && typeof features.high_noise_sample_params === "boolean") {
    return features.high_noise_sample_params;
  }
  return true;
}

/** 上游 #2341 单次请求最多允许的唯一内联提示图片数（generation_prompt.cpp:93）。 */
export const MAX_PROMPT_IMAGES = 32;

/**
 * 提取提示词里所有未转义的 `<image:ID>` 引用（对齐上游 `generation_prompt.cpp`）。
 * 奇数个反斜杠前缀（如 `\<image:foo>`）表示字面文本，不计为图片引用；
 * 未闭合的 `<image:` 或空 `<image:>` 返回可读错误。
 */
export function extractPromptImageRefs(text: string): { ids: string[]; error: string | null } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<image:", cursor);
    if (start < 0) break;
    let slashes = 0;
    while (start > slashes && text[start - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 1) {
      cursor = start + 7;
      continue;
    }
    const end = text.indexOf(">", start + 7);
    if (end < 0 || end === start + 7) {
      return { ids, error: "提示词中的 <image:ID> 标记未闭合或缺少图片 ID" };
    }
    const id = text.slice(start + 7, end);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    cursor = end + 1;
  }
  return { ids, error: null };
}

/**
 * 提交前校验 `prompt_images`（上游 #2341 + `common.cpp:1938`）：
 *  - ID 不能为空，且不能包含 `>`；
 *  - 正/反向提示词引用的唯一 ID 总数不超过 32；
 *  - 若已附加 `prompt_images` 或启用严格检查（`strictUnbound`），未闭合标记或
 *    找不到对应 ID 的 `<image:ID>` 在提交前拦截并给出可读原因。
 */
export function validatePromptImages(
  prompt: string,
  negativePrompt: string,
  promptImages?: Record<string, string>,
  options?: { strictUnbound?: boolean },
): string | null {
  const entries = Object.entries(promptImages ?? {});
  for (const [id, src] of entries) {
    if (!id) return "提示内联图片的 ID 不能为空";
    if (id.includes(">")) return `提示内联图片 ID 不能包含 ">"：${id}`;
    if (!src) return `提示内联图片「${id}」缺少图片数据`;
  }
  const shouldCheckMarkers = entries.length > 0 || options?.strictUnbound === true;
  if (!shouldCheckMarkers) return null;

  const pos = extractPromptImageRefs(prompt);
  if (pos.error) return pos.error;
  const neg = extractPromptImageRefs(negativePrompt);
  if (neg.error) return neg.error;

  const unique = new Set([...pos.ids, ...neg.ids]);
  if (unique.size > MAX_PROMPT_IMAGES) {
    return `单次请求最多支持 ${MAX_PROMPT_IMAGES} 张提示内联图片（当前引用了 ${unique.size} 张）`;
  }
  const map = promptImages ?? {};
  for (const id of unique) {
    if (!(id in map)) {
      return `提示词引用了 <image:${id}>，但未在「提示内联图片」中提供该 ID（如需字面文本请写 \\<image:${id}>）`;
    }
  }
  return null;
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

/**
 * 新 schema（上游 #2206，`sdcpp.generation/v1`）的采样参数段：键名与请求体
 * 一致（sample_method / sample_steps / guidance.slg.layer_start…），不同于
 * 旧 schema 的 `sampling`（method / steps / slg.start…）。
 */
function mapGenerationSampleParams(s: unknown): SampleParams | undefined {
  if (!isMetaObj(s)) return undefined;
  const g = isMetaObj(s.guidance) ? s.guidance : {};
  const slg = isMetaObj(g.slg) ? g.slg : undefined;
  return {
    sample_steps: metaNum(s.sample_steps),
    eta: metaNum(s.eta),
    flow_shift: metaNum(s.flow_shift),
    shifted_timestep: metaNum(s.shifted_timestep),
    sample_method: metaStr(s.sample_method),
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
            layer_start: metaNum(slg.layer_start),
            layer_end: metaNum(slg.layer_end),
          }
        : undefined,
    },
  };
}

/**
 * 新 schema 的 cache 段只存结构化参数（没有旧 schema 的 requested_option
 * 原始串），按 F-18 草稿键重建；taylorseer 的 n_derivatives / skip_interval
 * 草稿无法表达，恢复时丢弃（见 docs/UPSTREAM-SYNC-2026-11-11.md §9.3）。
 * 注意 mode 枚举差异：元数据写 `cache_dit`（下划线），请求体只认
 * `cache-dit`（连字符），必须归一，否则恢复后提交会被内核 400。
 */
function mapGenerationCache(cache: Record<string, unknown>): {
  mode?: string;
  draft: CacheOptionDraft;
  scmMask?: string;
  scmPolicyDynamic?: boolean;
} {
  const rawMode = metaStr(cache.mode);
  const mode = rawMode === "cache_dit" ? "cache-dit" : rawMode;
  const draft: CacheOptionDraft = {};
  if (mode === "easycache" || mode === "ucache") {
    draft.threshold = metaNum(cache.reuse_threshold);
    draft.start = metaNum(cache.start_percent);
    draft.end = metaNum(cache.end_percent);
    draft.decay = metaNum(cache.error_decay_rate);
    draft.relative = metaBool(cache.use_relative_threshold);
    draft.reset = metaBool(cache.reset_error_on_compute);
  } else if (mode === "dbcache" || mode === "taylorseer" || mode === "cache-dit") {
    draft.threshold = metaNum(cache.residual_diff_threshold);
    draft.Fn = metaNum(cache.Fn_compute_blocks);
    draft.Bn = metaNum(cache.Bn_compute_blocks);
    draft.warmup = metaNum(cache.max_warmup_steps);
  } else if (mode === "spectrum") {
    draft.w = metaNum(cache.spectrum_w);
    draft.m = metaNum(cache.spectrum_m);
    draft.lam = metaNum(cache.spectrum_lam);
    draft.window = metaNum(cache.spectrum_window_size);
    draft.flex = metaNum(cache.spectrum_flex_window);
    draft.warmup = metaNum(cache.spectrum_warmup_steps);
    draft.stop = metaNum(cache.spectrum_stop_percent);
  }
  return {
    mode,
    // prevMode 传同一模式：sanitize 在 prev/next 的 threshold/warmup 目标字段
    // 不同时会丢弃这两键（防跨模式串值），元数据恢复不存在模式切换。
    draft: sanitizeCacheOptionsForMode(mode, draft, mode),
    scmMask: metaStr(cache.scm_mask),
    scmPolicyDynamic: metaBool(cache.scm_policy_dynamic),
  };
}

/**
 * `sdcpp.generation/v1`（上游 #2206 起，src/generation_info.cpp）→ GenParams。
 * 与旧 schema 的关键差异：prompt 扁平化、seed 是十进制字符串、采样段叫
 * sample_params、video 帧数在顶层、image_preprocess 包一层 rules、
 * LoRA 记 path（相对 lora-model-dir）而非 basename。
 */
function generationV1ToGenParams(
  meta: Record<string, unknown>,
  availableLoras?: { name: string; path: string }[],
): Partial<GenParams> {
  const seedRaw = meta.seed;
  const seed =
    typeof seedRaw === "string" && seedRaw.trim() !== "" ? Number(seedRaw) : metaNum(seedRaw);
  const preprocess = isMetaObj(meta.image_preprocess) ? meta.image_preprocess : {};
  const hires = isMetaObj(meta.hires) ? meta.hires : undefined;
  const cache = isMetaObj(meta.cache) ? meta.cache : undefined;
  const vaeTiling = isMetaObj(meta.vae_tiling_params) ? meta.vae_tiling_params : undefined;

  const out: Partial<GenParams> = {
    prompt: metaStr(meta.prompt),
    negative_prompt: metaStr(meta.negative_prompt),
    width: metaNum(meta.width),
    height: metaNum(meta.height),
    seed: seed != null && Number.isFinite(seed) ? seed : undefined,
    sample_params: mapGenerationSampleParams(meta.sample_params),
    high_noise_sample_params: mapGenerationSampleParams(meta.high_noise_sample_params),
    video_frames: metaNum(meta.video_frames),
    fps: metaNum(meta.fps),
    moe_boundary: metaNum(meta.moe_boundary),
    vace_strength: metaNum(meta.vace_strength),
    clip_skip: metaNum(meta.clip_skip),
    strength: metaNum(meta.strength),
    control_strength: metaNum(meta.control_strength),
    // 内核把「未设置」序列化成字符串 "none"（src/stable-diffusion.cpp 的
    // control_type_to_str[] 首项，sd_control_type_name 恒返回合法名）。
    // 原样回填会让每张没设控制类型的图都带上 control_type="none"，
    // 提交时把一个界面里不存在的取值发给内核；按「未设置」丢弃。
    control_type: controlTypeFromMetadata(meta.control_type),
    ip_adapter_strength: metaNum(meta.ip_adapter_strength),
    qwen_image_layers: metaNum(meta.qwen_image_layers),
    auto_resize_ref_image: refResizeFromRefImageArgs(metaStr(meta.ref_image_args)),
    ref_image_args: metaStr(meta.ref_image_args),
    image_preprocess: metaRuleList(preprocess.rules),
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
    const mapped = mapGenerationCache(cache);
    out.cache_mode = mapped.mode;
    if (Object.keys(mapped.draft).length) out.cache_options = mapped.draft;
    out.scm_mask = mapped.scmMask;
    out.scm_policy_dynamic = mapped.scmPolicyDynamic;
  }
  if (vaeTiling) {
    // 新 schema 恒写像素键（tile_size_w/h），与请求体同名；旧图兼容分支
    // 在 sdcppMetadataToGenParams 的旧映射里保留 latent 键处理。
    out.vae_tiling_params = {
      enabled: metaBool(vaeTiling.enabled) ?? true,
      temporal_tiling: metaBool(vaeTiling.temporal_tiling),
      target_overlap: metaNum(vaeTiling.target_overlap),
      extra_tiling_args: metaStr(vaeTiling.extra_tiling_args),
      tile_size_w: metaNum(vaeTiling.tile_size_w),
      tile_size_h: metaNum(vaeTiling.tile_size_h),
      rel_size_w: metaNum(vaeTiling.rel_size_w),
      rel_size_h: metaNum(vaeTiling.rel_size_h),
    };
  }
  if (Array.isArray(meta.loras) && availableLoras?.length) {
    const loras: LoraEntry[] = [];
    for (const raw of meta.loras) {
      if (!isMetaObj(raw)) continue;
      // path 可能是相对 lora-model-dir 的子目录路径或原始绝对路径；
      // matchAvailableLora 按 stem 逐级归一，传整路径即可命中文件名。
      const path = metaStr(raw.path) ?? metaStr(raw.name);
      if (!path) continue;
      const found = matchAvailableLora(availableLoras, path);
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

/** 跳过空白与 DGL `# ...` 行注释，返回下一个有效字符索引。 */
function skipDglTrivia(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "#") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    break;
  }
  return i;
}

/** 从 `start` 起扫描单个 JSON 字面量（字符串/数组/对象/数值/布尔/null）。 */
function scanJsonLiteral(src: string, start: number): { value: unknown; end: number } | null {
  const i = skipDglTrivia(src, start);
  if (i >= src.length) return null;
  const first = src[i];
  if (first === '"') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === '"') {
        try {
          return { value: JSON.parse(src.slice(i, j + 1)), end: j + 1 };
        } catch {
          return null;
        }
      }
      j++;
    }
    return null;
  }
  if (first === "[" || first === "{") {
    const open = first;
    const close = first === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let j = i;
    while (j < src.length) {
      const ch = src[j];
      if (inString) {
        if (ch === "\\") j += 2;
        else {
          if (ch === '"') inString = false;
          j++;
        }
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return { value: JSON.parse(src.slice(i, j + 1)), end: j + 1 };
          } catch {
            return null;
          }
        }
      }
      j++;
    }
    return null;
  }
  const rest = src.slice(i);
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,)}\]#]|$)/.exec(rest);
  if (!m) return null;
  try {
    return { value: JSON.parse(m[0]), end: i + m[0].length };
  } catch {
    return null;
  }
}

/**
 * 解析上游 #2396+ DGL 源码顶层 `var { key = <JSON literal> }` 块。
 * 上游 `generation_program.cpp` 用 JSON 序列化写每个变量值，因此扫描器可安全
 * 处理含 `}` / `=` / 转义引号的多行字符串与数组，不被正则误截断。
 */
export function parseDglVarBlock(source: string): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  if (!source) return vars;
  const header = /(?:^|\n)[ \t]*var[ \t]*\{/m.exec(source);
  if (!header) return vars;
  let i = header.index + header[0].length;
  while (i < source.length) {
    i = skipDglTrivia(source, i);
    if (i >= source.length || source[i] === "}") break;
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (!ident) {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    const key = ident[0];
    i = skipDglTrivia(source, i + key.length);
    if (source[i] !== "=") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    const parsed = scanJsonLiteral(source, i + 1);
    if (parsed) {
      vars[key] = parsed.value;
      i = parsed.end;
    } else {
      const nl = source.indexOf("\n", i + 1);
      i = nl < 0 ? source.length : nl + 1;
    }
  }
  return vars;
}

/** 扫描 DGL 源码中指定函数调用里的具名常量参数（`key = <JSON literal>`）。 */
function parseDglNamedCallArgs(source: string, callName: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let cursor = 0;
  const token = `${callName}(`;
  while (cursor < source.length) {
    const idx = source.indexOf(token, cursor);
    if (idx < 0) break;
    const prev = idx > 0 ? source[idx - 1] : "";
    if (prev && /[A-Za-z0-9_:]/.test(prev)) {
      cursor = idx + token.length;
      continue;
    }
    // 找平衡的调用右括号，同时跳过字符串与嵌套括号。
    let i = idx + token.length;
    let depth = 1;
    let inString = false;
    const args: Record<string, unknown> = {};
    while (i < source.length && depth > 0) {
      if (inString) {
        if (source[i] === "\\") i += 2;
        else {
          if (source[i] === '"') inString = false;
          i++;
        }
        continue;
      }
      if (depth === 1) {
        i = skipDglTrivia(source, i);
        if (i >= source.length || source[i] === ")") {
          i++;
          break;
        }
        if (source[i] === ",") {
          i++;
          continue;
        }
        const kw = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(source.slice(i));
        if (kw) {
          const valStart = i + kw[0].length;
          const literal = scanJsonLiteral(source, valStart);
          if (literal) {
            args[kw[1]] = literal.value;
            i = literal.end;
            continue;
          }
          // 非常量实参（如嵌套调用或变量引用）：跳到同层逗号或右括号。
          i = valStart;
          continue;
        }
      }
      const ch = source[i];
      if (ch === '"') inString = true;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      i++;
    }
    results.push(args);
    cursor = i;
  }
  return results;
}

function hiresUpscalerFromDgl(
  source: string,
  mode: string | undefined,
  antialias: boolean | undefined,
  modelPath: string | undefined,
): string | undefined {
  if (modelPath) return fileStem(modelPath);
  if (!mode) return undefined;
  const pixelSpace = /\bhires_pixels\s*=/.test(source);
  if (mode === "lanczos") return "Lanczos";
  if (mode === "nearest") return pixelSpace ? "Nearest" : "Latent (nearest)";
  if (mode === "nearest_exact") return "Latent (nearest-exact)";
  if (mode === "bicubic") {
    return antialias ? "Latent (bicubic antialiased)" : "Latent (bicubic)";
  }
  if (mode === "bilinear") {
    return antialias ? "Latent (antialiased)" : "Latent";
  }
  return undefined;
}

/**
 * 上游 #2396+ DGL 源码（PNG `iTXt` `dgl` / WebP XMP `<sdcpp:dgl>` / JPEG COM `dgl`
 * / HTTP `generation_info` 字符串）→ `GenParams`。
 *
 * `var { ... }` 提供主参数；调用点（`encode_prompt` / `make_sigmas` / `predictor` /
 * `sample` / `tiling` / `cache` / `controlnet::apply` / `load_lora`+`apply_lora`）
 * 补齐其余未进 `var` 块的设置，实现与前 DGL 元数据等价的「从历史图恢复参数」。
 */
export function dglGenerationToGenParams(
  source: string,
  availableLoras?: { name: string; path: string }[],
): Partial<GenParams> {
  const vars = parseDglVarBlock(source);
  const encodeCalls = parseDglNamedCallArgs(source, "encode_prompt");
  const sigmaCalls = parseDglNamedCallArgs(source, "make_sigmas");
  const predictorCalls = parseDglNamedCallArgs(source, "predictor");
  const sampleCalls = [
    ...parseDglNamedCallArgs(source, "sample"),
    ...parseDglNamedCallArgs(source, "sefi::sample"),
  ];
  const controlCalls = parseDglNamedCallArgs(source, "controlnet::apply");
  const tilingCalls = parseDglNamedCallArgs(source, "tiling");
  const cacheCalls = parseDglNamedCallArgs(source, "cache");
  const upscalerCalls = parseDglNamedCallArgs(source, "load_upscaler");

  const firstNum = (calls: Record<string, unknown>[], key: string): number | undefined => {
    for (const c of calls) {
      const v = metaNum(c[key]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const firstStr = (calls: Record<string, unknown>[], key: string): string | undefined => {
    for (const c of calls) {
      const v = metaStr(c[key]);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const totalSteps = metaNum(vars.steps);
  const highNoiseSteps = metaNum(vars.high_noise_steps);
  // 双专家 Wan2.2 显式配置 high_noise_steps >= 0 时，上游把 var.steps 写成
  // low_steps + high_steps（generation_video.cpp:73），恢复时拆回两段步数。
  const sampleSteps =
    totalSteps != null &&
    highNoiseSteps != null &&
    highNoiseSteps >= 0 &&
    totalSteps >= highNoiseSteps
      ? totalSteps - highNoiseSteps
      : totalSteps;

  const extraArgs = firstStr(sampleCalls, "extra_args") ?? firstStr(sigmaCalls, "extra_args");
  const flowShift =
    firstNum(sigmaCalls, "flow_shift") ?? firstNum(predictorCalls, "video_sigma_shift");
  const distilledGuidance = firstNum(predictorCalls, "guidance");
  const clipSkip = firstNum(encodeCalls, "clip_skip");
  const vaceStrength = firstNum(predictorCalls, "vace_strength");
  const controlType = controlTypeFromMetadata(firstStr(controlCalls, "type"));
  const layers = metaNum(vars.layers);

  const sampleParams: SampleParams = {
    sample_steps: sampleSteps,
    sample_method: metaStr(vars.method),
    scheduler: metaStr(vars.scheduler),
    eta: metaNum(vars.eta),
    flow_shift: flowShift,
    custom_sigmas: metaNumArr(vars.custom_sigmas),
    ...parseExtraSampleArgs(extraArgs),
    guidance: {
      txt_cfg: metaNum(vars.cfg_scale),
      img_cfg: metaNum(vars.image_cfg_scale),
      distilled_guidance: distilledGuidance,
    },
  };

  const hasSampleFields =
    sampleParams.sample_steps != null ||
    sampleParams.sample_method != null ||
    sampleParams.scheduler != null ||
    sampleParams.eta != null ||
    sampleParams.flow_shift != null ||
    sampleParams.custom_sigmas != null ||
    sampleParams.extra_sample_args != null ||
    sampleParams.guidance.txt_cfg != null ||
    sampleParams.guidance.img_cfg != null ||
    sampleParams.guidance.distilled_guidance != null;

  const out: Partial<GenParams> = {
    prompt: metaStr(vars.source_prompt) ?? metaStr(vars.prompt),
    negative_prompt: metaStr(vars.source_negative_prompt) ?? metaStr(vars.negative_prompt),
    width: metaNum(vars.width),
    height: metaNum(vars.height),
    seed: generationInfoSeed(vars),
    sample_params: hasSampleFields ? sampleParams : undefined,
    video_frames: metaNum(vars.frames),
    fps: metaNum(vars.fps),
    moe_boundary: metaNum(vars.moe_boundary),
    vace_strength: vaceStrength,
    clip_skip: clipSkip,
    strength: metaNum(vars.strength),
    control_strength: metaNum(vars.control_strength),
    control_type: controlType,
    // generation_image.cpp:210：DGL 的 var.layers 等于 qwen_image_layers + 1。
    qwen_image_layers: layers != null ? Math.max(0, Math.trunc(layers) - 1) : undefined,
  };

  if (highNoiseSteps != null) {
    out.high_noise_sample_params = {
      sample_steps: highNoiseSteps,
      guidance: {},
    };
  }

  if (
    vars.hires_target_width != null ||
    vars.hires_target_height != null ||
    vars.hires_steps != null ||
    vars.hires_mode != null
  ) {
    const hiresSteps = metaNum(vars.hires_steps);
    const hiresSchedSteps = metaNum(vars.hires_scheduler_steps);
    const derivedDenoise =
      hiresSteps != null && hiresSchedSteps != null && hiresSteps > 0 && hiresSchedSteps > 0
        ? Math.min(1, Math.round((hiresSteps / hiresSchedSteps) * 10000) / 10000)
        : undefined;
    out.hires = {
      enabled: true,
      upscaler: hiresUpscalerFromDgl(
        source,
        metaStr(vars.hires_mode),
        metaBool(vars.hires_antialias),
        metaStr(vars.hires_model_path),
      ),
      target_width: metaNum(vars.hires_target_width),
      target_height: metaNum(vars.hires_target_height),
      steps: hiresSteps,
      denoising_strength: derivedDenoise,
      custom_sigmas: metaNumArr(vars.hires_custom_sigmas),
      upscale_tile_size: firstNum(upscalerCalls, "tile_size"),
    };
  }

  if (tilingCalls.length) {
    const t = tilingCalls[0];
    out.vae_tiling_params = {
      enabled: metaBool(t.enabled) ?? true,
      temporal_tiling: metaBool(t.temporal_tiling),
      tile_size_w: metaNum(t.tile_size_w),
      tile_size_h: metaNum(t.tile_size_h),
      target_overlap: metaNum(t.target_overlap),
      rel_size_w: metaNum(t.rel_size_w),
      rel_size_h: metaNum(t.rel_size_h),
      extra_tiling_args: metaStr(t.extra_args),
    };
  }

  if (cacheCalls.length) {
    const mapped = mapGenerationCache(cacheCalls[0]);
    out.cache_mode = mapped.mode;
    if (Object.keys(mapped.draft).length) out.cache_options = mapped.draft;
    out.scm_mask = mapped.scmMask;
    out.scm_policy_dynamic = mapped.scmPolicyDynamic;
  }

  if (availableLoras?.length) {
    const loaded = new Map<string, { path: string; isHighNoise: boolean }>();
    const loadRe = /\b((?:high_)?lora_\d+)\s*=\s*load_lora\(\s*("(?:\\.|[^"\\])*")/g;
    for (const m of source.matchAll(loadRe)) {
      try {
        const path = JSON.parse(m[2]) as string;
        if (path) loaded.set(m[1], { path, isHighNoise: m[1].startsWith("high_") });
      } catch {
        /* ignore malformed path literal */
      }
    }
    if (loaded.size) {
      const weights = new Map<string, number>();
      const applyRe =
        /apply_lora\([^)\n]*?,\s*((?:high_)?lora_\d+)\s*,\s*weight\s*=\s*(-?\d+(?:\.\d+)?)/g;
      for (const m of source.matchAll(applyRe)) {
        const w = Number(m[2]);
        if (Number.isFinite(w) && !weights.has(m[1])) weights.set(m[1], w);
      }
      const loras: LoraEntry[] = [];
      for (const [varName, info] of loaded) {
        const found = matchAvailableLora(availableLoras, info.path);
        if (found) {
          loras.push({
            path: found.path,
            multiplier: weights.get(varName) ?? 1,
            is_high_noise: info.isHighNoise || undefined,
          });
        }
      }
      if (loras.length) out.lora = loras;
    }
  }

  return out;
}

/** 把 sd-server 嵌入图片的元数据映射为 GenParams：
 *  - `sdcpp.dgl/v1`（上游 #2396+，PNG `iTXt` / WebP XMP `<sdcpp:dgl>` / JPEG COM `dgl`）
 *  - `sdcpp.generation/v1`（上游 #2206–32d516c）
 *  - `sdcpp.image.params/v1`（更早旧图）
 * 三代格式按 schema 分流。元数据中的 LoRA 只有文件名/相对路径，需用
 * `availableLoras` 匹配回完整路径，匹配不到的跳过。 */
export function sdcppMetadataToGenParams(
  meta: Record<string, unknown>,
  availableLoras?: { name: string; path: string }[],
): Partial<GenParams> {
  if (meta.schema === "sdcpp.dgl/v1" && typeof meta.dgl === "string") {
    return dglGenerationToGenParams(meta.dgl, availableLoras);
  }
  if (meta.schema === "sdcpp.generation/v1") {
    return generationV1ToGenParams(meta, availableLoras);
  }
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

/**
 * 元数据里的 `control_type` → 界面取值。
 *
 * 内核 `sd_control_type_name()` 对 `SD_CONTROL_TYPE_NONE` 返回 **`"none"`**，
 * 且该键在图片记录里恒定存在（`info["control_type"]`），所以「没设控制类型」
 * 与「设成 none」在元数据里是同一个值。界面枚举不含 none，回填时必须丢弃，
 * 否则恢复参数后会发出一个恒真的伪设置。
 */
export function controlTypeFromMetadata(value: unknown): string | undefined {
  const v = metaStr(value);
  if (!v || v === "none") return undefined;
  return CONTROL_TYPES.some((o) => o.value === v) ? v : undefined;
}

/**
 * 控制图类型枚举（上游 #2284 `--control-type` / 请求体 control_type）。
 * 别名（hed/softedge/pidi/ted→scribble，lineart/anime_lineart/mlsd→canny，
 * seg→segment，inpaint/outpaint→repaint）内核也认，界面只列正名。
 * tile / repaint 仅 SDXL Union ProMax 变体支持。
 */
export const CONTROL_TYPES: { value: string; label: string }[] = [
  { value: "openpose", label: "OpenPose 姿态" },
  { value: "depth", label: "Depth 深度" },
  { value: "scribble", label: "Scribble 涂鸦" },
  { value: "canny", label: "Canny 边缘" },
  { value: "normal", label: "Normal 法线" },
  { value: "segment", label: "Segment 分割" },
  { value: "tile", label: "Tile 分块（ProMax）" },
  { value: "repaint", label: "Repaint 重绘（ProMax）" },
];

/**
 * 内核是否接受 control_type：capabilities 的 img_gen 默认值里出现该键
 * （上游 #2284 起）才显示控件。旧内核缺键 → 隐藏，避免发出死键。
 * 注意这只代表「内核认识该字段」，模型是否 Union 由用户自行判断。
 */
export function controlTypeSupported(caps: Capabilities | null | undefined): boolean {
  const defaults = caps?.defaults_by_mode?.img_gen ?? caps?.defaults;
  return !!defaults && "control_type" in defaults;
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
  /**
   * 所选内核是否为上游 #2396+ DGL 架构（由 `isDglBackend(caps)` 判定）。
   * DGL 内核对若干已迁入 DGL 的原生字段（SLG / shifted_timestep / ip_adapter /
   * image_preprocess / ref_image_args / increase_ref_index / 高噪段采样器与 CFG）
   * 直接返回 HTTP 400，启用此项后请求体不再发送这些字段。
   */
  dglBackend?: boolean;
  /** 当前模型家族 ID（用于裁剪模型专属字段如 `qwen_image_layers`，避免非分层模型在 #2396+ 报 400）。 */
  family?: string;
  /** 以下细粒度能力开关缺省按 `!dglBackend` 判定，便于调用方与单测按需覆写。 */
  supportsSlg?: boolean;
  supportsShiftedTimestep?: boolean;
  supportsImagePreprocess?: boolean;
  supportsRefImageOverrides?: boolean;
  supportsIpAdapter?: boolean;
  supportsFullHighNoise?: boolean;
}

export function buildRequestBody(
  mode: GenMode,
  params: GenParams,
  images: GenImages,
  options: BuildRequestBodyOptions = {},
): Record<string, unknown> {
  const dgl = options.dglBackend === true;
  const allowSlg = options.supportsSlg ?? !dgl;
  const allowShiftedTimestep = options.supportsShiftedTimestep ?? !dgl;
  const allowImagePreprocess = options.supportsImagePreprocess ?? !dgl;
  const allowRefOverrides = options.supportsRefImageOverrides ?? !dgl;
  const allowIpAdapter = options.supportsIpAdapter ?? !dgl;
  const allowFullHighNoise = options.supportsFullHighNoise ?? !dgl;

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
  // 上游 #2028：img_gen 与 vid_gen 都接受 image_preprocess（规则串数组）；
  // #2396+ DGL 架构改为直接拒绝（400），仅前 DGL 内核发送。
  if (allowImagePreprocess) {
    const imagePreprocess = imagePreprocessDraftLines(params.image_preprocess)
      .map((line) => line.trim())
      .filter(Boolean);
    if (imagePreprocess.length) b.image_preprocess = imagePreprocess;
  }

  if (mode === "img_gen") {
    b.batch_count = params.batch_count || 1;
    // 上游 #2396 `generation_image.cpp:188`：非 Qwen Image Layered 模型收到
    // `qwen_image_layers` 直接报 SD_STATUS_UNSUPPORTED（400）。切模型后 localStorage
    // 可能残留旧值，按 family 过滤。
    if (
      params.qwen_image_layers != null &&
      (!options.family || options.family === "qwen-image-layered")
    ) {
      b.qwen_image_layers = params.qwen_image_layers;
    }
    if (allowRefOverrides) {
      // 缩放开关新旧双发：旧内核只认布尔键，#2028–32d516c 内核只认 ref_image_args。
      // #2396+ DGL 内核对非空 ref_image_args / increase_ref_index=true 直接 400，整段跳过。
      b.auto_resize_ref_image = params.auto_resize_ref_image !== false;
      const refImageArgs = buildRefImageArgs(params, options.refImagePreset);
      if (refImageArgs) b.ref_image_args = refImageArgs;
      b.increase_ref_index = !!params.increase_ref_index;
    }
    b.control_strength = params.control_strength ?? 0.9;
    // 上游 #2284：SDXL ControlNet Union 必需的控制类型；其它 ControlNet
    // 忽略该键。空串不发（等价于未设置），非法枚举由控件侧拦截。
    if (params.control_type) b.control_type = params.control_type;
    // 上游 #2396 `options.cpp:481`：ip_adapter_strength 属于 DGL 专属参数，
    // 在原生 img_gen 里发送会直接 400。
    if (allowIpAdapter) {
      b.ip_adapter_strength = params.ip_adapter_strength ?? 1.0;
    }
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
    // 上游 #2177 起 ref_image_args 也作用于 vid_gen（MiniMax-H3 的 ref_image_size），
    // #2396+ 改为 DGL 专属参数（非空即 400），仅前 DGL 内核发送。
    if (allowRefOverrides) {
      const videoRefArgs = (params.ref_image_args || "").trim();
      if (videoRefArgs) b.ref_image_args = videoRefArgs;
    }
  }

  if (images.initImage) b.init_image = images.initImage;
  if (mode === "img_gen" && images.maskImage) b.mask_image = images.maskImage;
  if (mode === "img_gen" && images.controlImage) b.control_image = images.controlImage;
  if (mode === "img_gen" && allowIpAdapter && images.ipAdapterImage) {
    b.ip_adapter_image = images.ipAdapterImage;
  }
  if (mode === "vid_gen" && images.endImage) b.end_image = images.endImage;
  // 参考图同时服务于 img_gen（Kontext/PiD 等）与声明支持的 vid 家族
  // （MiniMax-H3 Ref2VA）。调用方按家族能力裁剪后再传入，此处不按 mode 硬过滤。
  if (images.refImages?.length) b.ref_images = images.refImages;
  // 上游 #2341：提示词内联图片（`<image:ID>`），img_gen 与 vid_gen 均支持。
  if (images.promptImages) {
    const validEntries = Object.entries(images.promptImages).filter(
      ([id, src]) => !!id && !id.includes(">") && !!src,
    );
    if (validEntries.length) b.prompt_images = Object.fromEntries(validEntries);
  }
  // VACE 条件帧：顺序即条件帧顺序，上游按请求顺序保留。
  if (mode === "vid_gen" && images.controlFrames?.length) b.control_frames = images.controlFrames;
  // 上游 #2194：Ref2VA 参考视频（帧数组的数组，JSON 通道固定按 24fps 解释）
  // 与参考音频 / 视频音轨（base64 WAV）。调用方按家族能力裁剪后传入。
  if (mode === "vid_gen") {
    if (images.refVideos?.length) b.ref_videos = images.refVideos;
    if (images.refAudios?.length) b.ref_audios = images.refAudios;
    if (images.refVideoAudios?.length) b.ref_video_audios = images.refVideoAudios;
  }

  if (sp?.eta != null) sampleParams.eta = sp.eta;
  if (sp?.flow_shift != null) sampleParams.flow_shift = sp.flow_shift;
  if (allowShiftedTimestep && sp?.shifted_timestep != null) {
    sampleParams.shifted_timestep = sp.shifted_timestep;
  }
  if (sp?.custom_sigmas?.length) sampleParams.custom_sigmas = sp.custom_sigmas;
  if (sp?.guidance?.img_cfg != null)
    (sampleParams.guidance as Record<string, unknown>).img_cfg = sp.guidance.img_cfg;
  if (allowSlg) {
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
      // 前 DGL 内核显式发 scale:0 关闭，覆盖外部 server 默认开启的 SLG；
      // #2396+ DGL 内核对任何 `sample.guidance.slg.*`（含 scale:0）直接 400，
      // 由外层 allowSlg 分支整块省略。
      (sampleParams.guidance as Record<string, unknown>).slg = { scale: 0 };
    }
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
    const cacheOption = resolveCacheOption(params, { dglBackend: dgl });
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
    if (!allowFullHighNoise) {
      // 上游 #2396+（options.cpp:476）：除 `high_noise_sample.steps`（-1=按
      // moe_boundary 自动分段，≥0=显式高噪段步数）外，其余高噪段采样字段全部
      // 属于 DGL 专属参数，下发即 400。
      if (h.sample_steps != null && Number.isFinite(h.sample_steps)) {
        b.high_noise_sample_params = { sample_steps: Math.trunc(h.sample_steps) };
      }
    } else {
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
      if (allowShiftedTimestep && h.shifted_timestep != null) {
        hn.shifted_timestep = h.shifted_timestep;
      }
      if (h.guidance?.img_cfg != null)
        (hn.guidance as Record<string, unknown>).img_cfg = h.guidance.img_cfg;
      // 高噪段 SLG 只在真的开启时发送（审查 95 §5.3）。此前恒发 `{scale:0}`，
      // 会把服务端启动参数 `--high-noise-slg-scale` 每条请求都打回关闭；
      // 「要关掉服务端默认」只能靠启动参数表达，不能靠恒发 0 去猜。
      const hnSlg = allowSlg ? h.guidance?.slg : undefined;
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
  }

  return b;
}
