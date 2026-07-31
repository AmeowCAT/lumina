import type { GenImages, GenMode, GenParams, ModelFile } from "../types";

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

/** Build the `/sdcpp/v1/img_gen|vid_gen` request body (mirrors webui). */
export function buildRequestBody(
  mode: GenMode,
  params: GenParams,
  images: GenImages
): Record<string, unknown> {
  const sp = params.sample_params;
  const sampleParams: Record<string, unknown> = {
    sample_method: sp?.sample_method,
    sample_steps: sp?.sample_steps,
    scheduler: sp?.scheduler,
    guidance: {
      txt_cfg: sp?.guidance?.txt_cfg,
      distilled_guidance: sp?.guidance?.distilled_guidance ?? 0,
    },
  };
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
  if (mode === "img_gen" && images.refImages?.length)
    b.ref_images = images.refImages;
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
  if (slg && slg.scale > 0)
    (sampleParams.guidance as Record<string, unknown>).slg = {
      layers: slg.layers || [7, 8, 9],
      layer_start: slg.layer_start ?? 0.01,
      layer_end: slg.layer_end ?? 0.2,
      scale: slg.scale,
    };

  const vl = (params.lora || []).filter((l) => l.path);
  if (vl.length)
    b.lora = vl.map((l) => {
      const e: Record<string, unknown> = {
        path: l.path,
        multiplier: l.multiplier ?? 1.0,
      };
      if (mode === "vid_gen") e.is_high_noise = !!l.is_high_noise;
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
  }
  if (params.vae_tiling_params?.enabled)
    b.vae_tiling_params = { ...params.vae_tiling_params };

  if (params.cache_mode && params.cache_mode !== "disabled") {
    b.cache_mode = params.cache_mode;
    if (params.cache_option) b.cache_option = params.cache_option;
    if (params.scm_mask) b.scm_mask = params.scm_mask;
    b.scm_policy_dynamic = params.scm_policy_dynamic !== false;
  }

  if (mode === "vid_gen" && params.high_noise_sample_params) {
    const h = params.high_noise_sample_params;
    const hn: Record<string, unknown> = {
      sample_method: h.sample_method,
      sample_steps: h.sample_steps,
      scheduler: h.scheduler,
      guidance: {
        txt_cfg: h.guidance?.txt_cfg,
        distilled_guidance: h.guidance?.distilled_guidance,
      },
    };
    if (h.eta != null) hn.eta = h.eta;
    if (h.flow_shift != null) hn.flow_shift = h.flow_shift;
    if (h.guidance?.img_cfg != null)
      (hn.guidance as Record<string, unknown>).img_cfg = h.guidance.img_cfg;
    if ((h.guidance?.slg?.scale ?? 0) > 0)
      (hn.guidance as Record<string, unknown>).slg = { ...h.guidance?.slg };
    b.high_noise_sample_params = hn;
  }

  return b;
}
