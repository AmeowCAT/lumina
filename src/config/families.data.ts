// 家族数据表（审查 20-frontend-arch §2.11：从 families.ts 拆出）。
//
// 这里只有**数据**：采样器/调度器/预览模式名称、尺寸预设、视频帧预设、
// 空间对齐基数、外部 tokenizer 与 TAE 提示，以及 60 个家族的 `FAMILY_CONFIG`。
// 纯函数（对齐、缩放、按家族取默认值）留在 families.ts。
//
// 拆开的收益：这张表约 1700 行、几乎只在"选模型/改参数"时才被读到，
// 单独成模块后可以按 chunk 缓存，逻辑改动不再让整张表失效。

import type { Features, GenMode, ServerArgs } from "../types";

// ── Display name maps (sampler / scheduler indices come from capabilities) ──
export const SAMPLER_NAMES: Record<string, string> = {
  default: "默认（自动）",
  euler: "Euler",
  euler_a: "Euler A",
  heun: "Heun",
  dpm2: "DPM2",
  "dpm++2s_a": "DPM++ 2S A",
  "dpm++2m": "DPM++ 2M",
  "dpm++2mv2": "DPM++ 2M v2",
  ipndm: "iPNDM",
  ipndm_v: "iPNDM v",
  lcm: "LCM",
  ddim_trailing: "DDIM Trailing",
  tcd: "TCD",
  res_multistep: "Res MS",
  res_2s: "Res 2S",
  er_sde: "ER SDE",
  euler_cfg_pp: "Euler CFG++",
  euler_a_cfg_pp: "Euler A CFG++",
  euler_ge: "Euler GE",
  "dpm++2m_sde": "DPM++ 2M SDE",
  "dpm++2m_sde_bt": "DPM++ 2M SDE BT",
  lms: "LMS",
};

export const SCHEDULER_NAMES: Record<string, string> = {
  default: "默认（自动）",
  discrete: "Discrete",
  // capabilities 会在 discrete 之后额外返回 "normal" 别名（routes_sdcpp.cpp），
  // 上游 str_to_scheduler 把它解析成 DISCRETE——标注出来免得看着像两个调度器。
  normal: "Discrete (normal)",
  karras: "Karras",
  exponential: "Exp",
  ays: "AYS",
  gits: "GITS",
  smoothstep: "Smooth",
  sgm_uniform: "SGM",
  simple: "Simple",
  kl_optimal: "KL Opt",
  lcm: "LCM",
  bong_tangent: "Bong",
  ltx2: "LTX2",
  logit_normal: "Logit Normal",
  flux2: "Flux2",
  flux: "Flux",
  beta: "Beta",
  // LLaDA-Image 默认调度器（上游 #1968）：Kumaraswamy sigma 网格，
  // `--extra-sample-args uniform=1` 可切换成均匀网格。
  llada_image: "LLaDA-Image",
};

// TAE/VAE 在当前内核中共用启动时配置的解码器，不承诺选项间的画质差异。
export const PREVIEW_MODE_NAMES: Record<string, string> = {
  none: "关闭",
  proj: "潜空间投影",
  tae: "TAE 解码",
  vae: "VAE 解码",
};

export const BUILTIN_UPSCALERS = [
  "None",
  "Lanczos",
  "Nearest",
  "Latent",
  "Latent (nearest)",
  "Latent (nearest-exact)",
  "Latent (antialiased)",
  "Latent (bicubic)",
  "Latent (bicubic antialiased)",
];

export interface SizeGroup {
  label: string;
  sizes: [string, number, number][];
}

export const SIZE_PRESETS: Record<GenMode, SizeGroup[]> = {
  img_gen: [
    {
      label: "1:1 方形",
      sizes: [
        ["512", 512, 512],
        ["768", 768, 768],
        ["1024", 1024, 1024],
        ["1280", 1280, 1280],
        ["1536", 1536, 1536],
      ],
    },
    {
      label: "4:3 横版",
      sizes: [
        ["1024×768", 1024, 768],
        ["1280×960", 1280, 960],
      ],
    },
    {
      label: "3:4 竖版",
      sizes: [
        ["768×1024", 768, 1024],
        ["960×1280", 960, 1280],
      ],
    },
    {
      label: "16:9 宽屏",
      sizes: [
        ["1280×720", 1280, 720],
        ["1920×1080", 1920, 1080],
      ],
    },
    {
      label: "9:16 竖屏",
      sizes: [
        ["720×1280", 720, 1280],
        ["1080×1920", 1080, 1920],
      ],
    },
    {
      label: "3:2 摄影",
      sizes: [
        ["1216×832", 1216, 832],
        ["1536×1024", 1536, 1024],
      ],
    },
    {
      label: "2:3 摄影竖",
      sizes: [
        ["832×1216", 832, 1216],
        ["1024×1536", 1024, 1536],
      ],
    },
    {
      label: "21:9 超宽",
      sizes: [["1792×768", 1792, 768]],
    },
  ],
  vid_gen: [
    {
      label: "横版",
      sizes: [
        ["832×480", 832, 480],
        ["1280×720", 1280, 720],
        ["1920×1080", 1920, 1080],
      ],
    },
    {
      label: "竖版",
      sizes: [
        ["480×832", 480, 832],
        ["720×1280", 720, 1280],
      ],
    },
  ],
};

export const CACHE_MODES: { v: string; l: string }[] = [
  { v: "disabled", l: "Disabled" },
  { v: "easycache", l: "EasyCache (DiT)" },
  { v: "ucache", l: "UCache (UNet)" },
  { v: "dbcache", l: "DBCache (DiT)" },
  { v: "taylorseer", l: "TaylorSeer" },
  { v: "cache-dit", l: "Cache-DiT" },
  { v: "spectrum", l: "Spectrum" },
];

// Families whose diffusion runner actually consumes `distilled_guidance`.
// 与引擎判断保持一致（stable-diffusion.cpp run_condition:
// is_flux || is_flux2 || is_longcat || is_sefi_image），其中 is_flux 覆盖
// FLUX/FLUX_FILL/FLUX_CONTROLS/FLEX_2/OVIS_IMAGE/CHROMA_RADIANCE（含 Chroma、
// Kontext 等 flux 架构变体）。
export const DISTILL_FAMILIES = [
  "flux",
  "kontext",
  "chroma",
  "chroma-radiance",
  "ovis",
  "flux2",
  "flux2-klein",
  "flux2-klein-base",
  "longcat",
  "sefi",
  "sefi-turbo",
  "zimage-turbo",
];

// ── Family metadata ───────────────────────────────────────────────────
export interface FieldDef {
  key: string;
  label: string;
  arg: string;
  cat: string;
  required: boolean;
  description?: string;
}

export interface FamilyConfig {
  name: string;
  hint: string;
  mode: "img" | "vid";
  fields: FieldDef[];
  /** Startup arguments that are not selected from a model-file field. */
  fixedArgs: ServerArgs;
  genDefaults?: Record<string, unknown>;
  /** Optional mode-specific defaults for families such as SD + AnimateDiff. */
  genDefaultsByMode?: Partial<Record<GenMode, Record<string, unknown>>>;
  /** Inputs that must be present before a request can be submitted. */
  requiredInputsByMode?: Partial<Record<GenMode, RequiredInput[]>>;
  /**
   * 「任一即可」的必备输入组：每组里至少出现一个非空输入才算满足。
   *
   * 上游 MiniMax-H3 Ref2VA 的判据是 `ref_images_count > 0 || ref_videos_count
   * > 0 || ref_audios_count > 0`（src/pipeline/video.cpp 的 has_references），
   * 只给参考视频/音频同样成立——若写成 requiredInputsByMode 的「全部必需」，
   * 只用参考媒体的用户会被界面误拦。组内每项仍然各自可选。
   */
  requiredAnyInputGroupsByMode?: Partial<Record<GenMode, RequiredInput[][]>>;
  /**
   * 互斥输入组：同组里出现多于一个非空输入时当前模型无法生成（上游在
   * 生成阶段直接报错返回），提交前拦下能省一次往返并给出可读原因。
   */
  exclusiveInputGroups?: { inputs: RequiredInput[]; message: string }[];
  /** Protocol capabilities are generic; these model-specific restrictions win. */
  disabledFeatures?: (keyof Features)[];
  generationHint?: string;
  /**
   * 提示词的硬上限（token）。只收录上游明确以"截断而不是报错"方式限制的家族
   * （目前仅 Iris-3B 的 300 token，含模板后缀）；其余家族不填 = 无已知上限。
   * 界面据此做实时计数与超限提示（审查 F-17）。
   */
  promptTokenLimit?: number;
  /**
   * 内核强制固定的生成尺寸（宽、高）。目前只有 MiniT2I：上游 #2189 在
   * `GenerationRequest::resolve` 最前面把宽高硬改成 512×512 并打警告，界面
   * 必须同步锁定，否则显示尺寸与实际输出不一致。
   */
  fixedSize?: { width: number; height: number };
  sizePresetsByMode?: Partial<Record<GenMode, SizeGroup[]>>;
  /**
   * 非空表示该家族已被识别但暂时无法经 sd-server 使用，值为展示给用户的原因；
   * 启动检查单保持 NO-GO 并阻断启动（如 MiniMax-H3 Ref2VA 的参考视频/音频
   * 输入目前只有 sd-cli 通道，server HTTP 未开放）。
   */
  unsupported?: string;
}

/**
 * 输入位标识。图片输入之外有两个伪输入：`hires` 是参数开关（二次放大），
 * `ref_videos` / `ref_audios` 是 Ref2VA 参考媒体（上游 #2194），都只用于
 * 互斥声明，不会出现在 requiredInputsByMode 里。
 */
export type RequiredInput =
  "init_image" | "end_image" | "ref_images" | "hires" | "ref_videos" | "ref_audios";

export const PID_VAE_FORMATS = [
  { value: "flux", label: "Flux / Z-Image" },
  { value: "sd3", label: "SD3" },
  { value: "flux2", label: "Flux.2" },
  { value: "wan", label: "Qwen-Image / Wan" },
] as const;

/**
 * 上游 #1974 / #1968 起，这些家族不再内嵌词表，必须提供外部 HuggingFace
 * tokenizer.json（`--tokenizer`）；缺省会在建文本编码器时初始化失败。
 * PiD/PiD 1.5 用 Gemma 2 的 tokenizer，Lens/Lens Turbo 用 GPT-OSS 的，
 * LLaDA-Image 两个 checkpoint 共用同一个 LLaDA2 tokenizer。
 */
export const EXTERNAL_TOKENIZER_FAMILIES = [
  "pid",
  "lens",
  "lens-turbo",
  "llada-image",
  "llada-image-turbo",
  // Ming-Image（上游 #2063）：Ling 词表不再内嵌，缺 tokenizer 时上游在
  // 建文本编码器阶段直接抛错。
  "ming-image",
  // MOSS-Image（上游 #2148）：Qwen3.5 的词表与内嵌 Qwen 不同，必须用官方
  // tokenizer.json，否则建文本编码器时直接抛错。
  "moss-image",
] as const;

/** 家族专属的 --tokenizer 说明（没有条目时用通用文案）。 */
export const EXTERNAL_TOKENIZER_HINT: Record<string, string> = {
  pid: "需配合 Gemma 2 配套的 tokenizer.json",
  lens: "需配合 GPT-OSS 配套的 tokenizer.json",
  "lens-turbo": "需配合 GPT-OSS 配套的 tokenizer.json",
  "llada-image": "需配合 LLaDA2 的 tokenizer.json（基础版与 Turbo 共用）",
  "llada-image-turbo": "需配合 LLaDA2 的 tokenizer.json（基础版与 Turbo 共用）",
  "ming-image": "需配合 Ming-Image 仓库 mllm/ 目录下的 tokenizer.json",
  "moss-image": "需配合 MOSS-Image 官方 tokenizer.json（与 Qwen3 不通用）",
};

/** Frame shortcuts for models whose native temporal context is known. */
export const VIDEO_FRAME_PRESETS: Record<string, number[]> = {
  sd: [8, 16, 24, 32],
  "lingbot-video": [33, 49, 81],
  "hunyuan-video": [17, 33, 49],
  // 全部落在 17k+5 网格上（约 1 / 2.3 / 5.2 / 10.1 / 15.1 秒 @24fps）。
  "minimax-h3-fl2va": [22, 56, 124, 243, 362],
  // HyperFlow H3 Flash 与 H3 共用 17k+5 帧网格（上游 #2299）。
  "hyperflow-h3-flash": [22, 56, 124, 243, 362],
};

/** 帧数滑杆上限（家族缺省 121）。MiniMax-H3 放宽到 481（17×28+5 ≈ 20s @24fps）。 */
export const VIDEO_FRAME_MAX: Record<string, number> = {
  sd: 32,
  "minimax-h3-fl2va": 481,
  "minimax-h3-ref2va": 481,
  "hyperflow-h3-flash": 481,
  "hyperflow-h3-flash-ref2va": 481,
};

/**
 * 视频帧数的对齐步长。上游 `aligned_frames`（`src/model/vae/geometry.hpp`）会按
 * `step·n + 1` 归一化请求帧数，步长依模型版本而定：
 *   - LTX-AV：8
 *   - Wan / LingBot-Video / Hunyuan-Video：4
 *   - 其余（含 AnimateDiff）：不对齐，原样使用
 *
 * 取整方向随内核代际变化：上游 #2396+（DGL 架构）改为**向上**取整
 * （34 → 37、32 → 33、LTX 40 → 41）；前 DGL 内核（<= 32d516c）为**向下**取整
 * （34 → 33、32 → 29）。
 *
 * 例外：MiniMax-H3 / HyperFlow H3 在两代内核里均为 `17k+5` 网格**向上**取整、
 * 最小 5，在 `alignVideoFrames` 里特判，不放进本表。
 */
export const VIDEO_FRAME_ALIGN: Record<string, number> = {
  "wan-t2v": 4,
  "wan-i2v": 4,
  "wan-ti2v": 4,
  "wan-a14b": 4,
  "lingbot-video": 4,
  "hunyuan-video": 4,
  ltx: 8,
  // LTX-2.5 与 2.3 共用视频 VAE 架构（上游 #1893），latent 对齐同为 8n+1。
  ltx25: 8,
};

/**
 * 宽高的空间对齐基数。上游 `align_image_size`（src/stable-diffusion.cpp）
 * 把请求宽高**向上**对齐到 `vae_scale_factor × diffusion_model_down_factor`。
 * MiniMax-H3（16×2）与 SenseNova U1.5（RGB 像素块）均按 32 对齐；
 * 常用尺寸 720/1080 实际为 736/1088。
 */
export const SIZE_SPATIAL_ALIGN: Record<string, number> = {
  "sensenova-u1": 32,
  "minimax-h3-fl2va": 32,
  "minimax-h3-ref2va": 32,
  // H3 图像家族与 HyperFlow 蒸馏权重同为 32 对齐（上游 #2324 / #2272 / #2299）。
  "minimax-h3-image": 32,
  "p-h3-image": 32,
  "hyperflow-h3-flash": 32,
  "hyperflow-h3-flash-ref2va": 32,
  // Qwen Image 2.1：上游要求宽高为 32 的倍数（docs/qwen_image_2.1.md）。
  "qwen-image-2.1": 32,
  // LLaDA-Image：文生图按 16 向上取整，但编辑路径要求 32 整除，统一按 32
  // 对齐同时满足两者。
  "llada-image": 32,
  "llada-image-turbo": 32,
  // PixArt（VAE 8 × DiT 2）与 Ming-Image（VAE 8 × DiT 2）：上游 align_image_size
  // 向上对齐到 16，常用 1080 实际为 1088。
  "pixart-sigma": 16,
  "pixart-alpha": 16,
  "ming-image": 16,
  // Z-Image L2P：FakeVAE 缩放因子 1、DiT 下采样 16（上游 vae.hpp /
  // diffusion_engine.cpp），宽高必须是 16 的倍数——1080 实际为 1088。
  "zimage-l2p": 16,
  // Iris-3B：同样是 FakeVAE（scale 1、下采样 16），上游 docs/iris.md 要求宽高
  // 为 16 的倍数。
  iris: 16,
  // MOSS-Image：FLUX.2 VAE（scale 16）+ DiT 下采样 1，上游 docs/moss_image.md
  // 要求宽高可被 16 整除。
  "moss-image": 16,
  // Mage-Flow：上游 docs/mage_flow.md:15 “dimensions must be multiples of 16”。
  // 此前漏登记，`alignSizeUp` 对未登记家族原样返回，手填 1000 不会被对齐到
  // 1008（审查 40-cli §2.11）。
  "mage-flow": 16,
  "mage-flow-turbo": 16,
  "mage-flow-edit": 16,
  "mage-flow-edit-turbo": 16,
};

const F = (
  key: string,
  label: string,
  arg: string,
  cat: string,
  required = !label.includes("可选"),
  description?: string,
): FieldDef => ({ key, label, arg, cat, required, description });

export const FAMILY_CONFIG: Record<string, FamilyConfig> = {
  "sensenova-u1": {
    name: "SenseNova U1.5",
    hint: "一体化模型，无需单独配置文本编码器或 VAE",
    mode: "img",
    fields: [F("model", "完整模型 / 分片索引", "model", "model")],
    fixedArgs: { "flash-attn": "on", rng: "cuda" },
    generationHint:
      "仅支持 non-thinking 文生图，不支持参考图编辑；建议留空负向提示词，2048×2048 为训练分辨率，低分辨率仅适合快速试跑。",
    disabledFeatures: [
      "init_image",
      "mask_image",
      "control_image",
      "ip_adapter_image",
      "end_image",
      "ref_images",
      "control_frames",
      "vae_tiling",
      "hires",
      "prompt_images",
    ],
    sizePresetsByMode: {
      img_gen: [
        { label: "训练尺寸", sizes: [["2048", 2048, 2048]] },
        {
          label: "快速测试",
          sizes: [
            ["512", 512, 512],
            ["1024", 1024, 1024],
          ],
        },
      ],
    },
    genDefaults: {
      seed: -1,
      width: 2048,
      height: 2048,
      sample_params: {
        sample_steps: 50,
        sample_method: "euler",
        flow_shift: 3,
        guidance: { txt_cfg: 4 },
      },
    },
  },
  flux: {
    name: "Flux.1",
    hint: "Diffusion + VAE + CLIP-L + T5-XXL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("clip_l", "CLIP-L", "clip_l", "clip_l"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  kontext: {
    name: "Kontext",
    hint: "Flux 图像编辑",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("clip_l", "CLIP-L", "clip_l", "clip_l"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  flux2: {
    name: "Flux.2-dev",
    hint: "Diffusion + VAE + LLM",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Mistral)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      // docs/flux2.md：dev 推荐 cfg 4.0（cfg 1.0 是 klein 蒸馏版的参数）
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.0 },
      },
    },
  },
  "flux2-klein": {
    name: "Flux.2-klein",
    hint: "Diffusion + VAE + LLM (4B/9B)",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "flux2-klein-base": {
    name: "Flux.2-klein Base",
    hint: "Diffusion + VAE + Qwen3（基础版）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.0 },
      },
    },
  },
  // FLUX.3 Image Klein / Klein Base（上游 #2143）：DiT + FLUX.2 VAE + Qwen3-VL-4B。
  // 两版默认值不同（蒸馏 16 步 / CFG 1.0，基础 20 步 / CFG 3.5），共用同一套
  // 组件但权重不可混用，所以拆成两族；参考图编辑走 Flux.2 的同一路径。
  "flux3-klein": {
    name: "Flux.3 Image Klein",
    hint: "Diffusion + FLUX.2 VAE + Qwen3-VL-4B（蒸馏版）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX.2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL-4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (编辑用，可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint:
      "蒸馏版请保持 CFG 1.0，调高会劣化画质；参考图编辑需配置视觉编码器，最多 10 张。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 16,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "flux3-klein-base": {
    name: "Flux.3 Image Klein Base",
    hint: "Diffusion + FLUX.2 VAE + Qwen3-VL-4B（基础版）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX.2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL-4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (编辑用，可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint: "与蒸馏版权重不通用；参考图编辑需配置视觉编码器，最多 10 张。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 3.5 },
      },
    },
  },
  // Fibo 2.0 Dev / Edit Turbo（上游 #2180）：Fibo DiT + FLUX.2 VAE + Qwen3-VL-4B。
  // 参考图 preset 由内核按模型定义自动选 `fibo2`（src/model/integrations/fibo2.cpp
  // 的 ref_image_preset），界面不用传 --ref-image-args；宽高按 16 对齐。Dev 支持
  // 文生图与参考图编辑，Edit Turbo 只做参考图编辑（4 步 / CFG 1）。
  fibo2: {
    name: "Fibo 2.0 Dev",
    hint: "Diffusion + FLUX.2 VAE + Qwen3-VL-4B，支持文生图与参考图编辑",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX.2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL-4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (mmproj，GGUF 编码器必需)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: {},
    generationHint: "使用独立 GGUF 文本编码器时需另配视觉投影（mmproj），BF16 完整权重可留空。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "fibo2-edit": {
    name: "Fibo 2.0 Edit Turbo",
    hint: "专用于参考图编辑（需提供参考图）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX.2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL-4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (mmproj，GGUF 编码器必需)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: {},
    requiredInputsByMode: { img_gen: ["ref_images"] },
    generationHint:
      "仅用于参考图编辑，建议保持 4 步与 CFG 1；提示词可用 <image_1>、<image_2> 指代对应参考图。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  // Iris-3B（上游 #2117）：像素空间 DiT（FakeVAE：scale 1、下采样 16），
  // Qwen3-VL-4B 文本编码器，不需要 VAE；宽高按 16 对齐。
  iris: {
    name: "Iris-3B",
    hint: "像素空间模型，无需 VAE",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("llm", "LLM (Qwen3-VL-4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint: "无需配置 VAE；单条提示词上限 300 token，超出部分会自动截断。",
    promptTokenLimit: 300,
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 3.0 },
      },
    },
  },
  // MOSS-Image Base / SFT（上游 #2148 / #2203）：5B DiT + FLUX.2 VAE + Qwen3.5-9B。
  // Qwen3.5 的词表与内嵌 Qwen 不同，必须另配外部 tokenizer.json。
  // 上游 #2203 起支持编辑 LoRA（HQ 编辑配合 SFT + armV5-moss-edit-lora + ref_images）
  // 与独立 Qwen3.5 视觉投影（--llm_vision mmproj-BF16.gguf，亦供 #2341 内联提示图使用）。
  "moss-image": {
    name: "MOSS-Image (Base / SFT)",
    hint: "Diffusion + FLUX.2 VAE + Qwen3.5-9B，需配合外部 tokenizer",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX.2)", "vae", "vae"),
      F("llm", "LLM (Qwen3.5-9B)", "llm", "llm"),
      F(
        "llm_vision",
        "LLM Vision (mmproj，编辑 / 内联图用，可选)",
        "llm_vision",
        "llm_vision",
        false,
        "参考图编辑或使用 <image:ID> 内联图时需配置",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint:
      "需单独指定 Qwen3.5 的 tokenizer.json。图像编辑可配合编辑 LoRA 与参考图；配置视觉投影后支持在提示词中使用 <image:ID> 引用图片。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 3.0 },
      },
    },
  },
  sdxl: {
    name: "SDXL",
    hint: "完整模型 + 可选 VAE",
    mode: "img",
    fields: [
      F("model", "完整模型", "model", "model"),
      F("vae", "VAE (可选)", "vae", "vae"),
      F("control-net", "ControlNet (可选)", "control-net", "control_net"),
      F(
        "clip_vision",
        "CLIP-Vision (可选)",
        "clip_vision",
        "clip_vision",
        false,
        "配合下方 IP-Adapter 成对使用（如 clip_vision_h）",
      ),
      F(
        "ip-adapter",
        "IP-Adapter (可选)",
        "ip-adapter",
        "ip_adapter",
        false,
        "图像参考权重（如 ip-adapter_sdxl_vit-h），仅旧版内核直接生效",
      ),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: { sample_steps: 20, guidance: { txt_cfg: 7 } },
    },
  },
  sd: {
    name: "SD 1.x / 2.x",
    hint: "完整模型 + 可选组件",
    mode: "img",
    fields: [
      F("model", "完整模型", "model", "model"),
      F("vae", "VAE (可选)", "vae", "vae"),
      F("control-net", "ControlNet (可选)", "control-net", "control_net"),
      F(
        "motion-module",
        "AnimateDiff Motion Module (可选，仅 SD 1.5)",
        "motion-module",
        "motion_module",
        false,
        "AnimateDiff SD 1.5 v2/v3 权重，仅旧版内核支持原生视频模式",
      ),
      F(
        "clip_vision",
        "CLIP-Vision (可选)",
        "clip_vision",
        "clip_vision",
        false,
        "配合下方 IP-Adapter 成对使用（如 clip_vision_h）",
      ),
      F(
        "ip-adapter",
        "IP-Adapter (可选)",
        "ip-adapter",
        "ip_adapter",
        false,
        "图像参考权重（如 ip-adapter_sd15），仅旧版内核直接生效",
      ),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 512,
      height: 512,
      sample_params: { sample_steps: 20, guidance: { txt_cfg: 7 } },
    },
    genDefaultsByMode: {
      // AnimateDiff is exposed as vid_gen only when a motion module is loaded.
      // Keep its trained temporal context and sampler defaults separate from
      // the ordinary SD image-generation defaults above.
      vid_gen: {
        seed: -1,
        width: 512,
        height: 512,
        strength: 0.75,
        sample_params: {
          sample_steps: 20,
          sample_method: "euler",
          scheduler: "discrete",
          guidance: { txt_cfg: 8 },
        },
        video_frames: 16,
        fps: 8,
      },
    },
  },
  sd3: {
    name: "SD3 / 3.5",
    hint: "模型 + CLIP-L + CLIP-G + T5-XXL",
    mode: "img",
    fields: [
      F("model", "完整模型", "model", "model"),
      F("clip_l", "CLIP-L", "clip_l", "clip_l"),
      F("clip_g", "CLIP-G", "clip_g", "clip_g"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.5 },
      },
    },
  },
  pid: {
    name: "PiD / PiD 1.5",
    hint: "PixelDiT + Gemma 2 2B + 匹配 VAE（需要参考图）",
    mode: "img",
    fields: [
      F("diffusion-model", "PiD Diffusion 模型", "diffusion-model", "model"),
      F("vae", "匹配 VAE", "vae", "vae"),
      F("llm", "Gemma 2 2B", "llm", "llm"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    requiredInputsByMode: { img_gen: ["ref_images"] },
    genDefaults: {
      seed: -1,
      width: 2048,
      height: 2048,
      sample_params: {
        sample_steps: 4,
        sample_method: "lcm",
        scheduler: "lcm",
        flow_shift: 1.5,
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "wan-t2v": {
    name: "Wan T2V",
    hint: "文本生成视频",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("t5xxl", "UMT5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 832,
      height: 480,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 6.0 },
        flow_shift: 3,
      },
      video_frames: 33,
    },
  },
  "wan-i2v": {
    name: "Wan I2V / FLF2V",
    hint: "图片/首尾帧生成视频",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("t5xxl", "UMT5-XXL", "t5xxl", "t5xxl"),
      F("clip_vision", "CLIP Vision", "clip_vision", "clip_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 832,
      height: 480,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 6.0 },
        flow_shift: 3,
      },
      video_frames: 33,
    },
  },
  "wan-ti2v": {
    name: "Wan TI2V",
    hint: "Wan2.2 TI2V 5B",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("t5xxl", "UMT5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 832,
      height: 480,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 6.0 },
        flow_shift: 3,
      },
      video_frames: 33,
    },
  },
  "wan-a14b": {
    name: "Wan2.2 A14B",
    hint: "Diffusion (LowNoise) + 高噪 Diffusion (HighNoise) + VAE + UMT5",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型 (LowNoise)", "diffusion-model", "model"),
      F(
        "high-noise-diffusion-model",
        "高噪 Diffusion (HighNoise)",
        "high-noise-diffusion-model",
        "high_noise_model",
      ),
      F("vae", "VAE", "vae", "vae"),
      F("t5xxl", "UMT5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 832,
      height: 480,
      sample_params: {
        sample_steps: 10,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 3.5 },
        flow_shift: 3,
      },
      high_noise_sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 3.5 },
        eta: 1,
        flow_shift: 3,
      },
      video_frames: 33,
      moe_boundary: 0.8,
    },
  },
  "lingbot-video": {
    name: "LingBot Video",
    hint: "LingBot Diffusion + Wan 2.1 VAE + Qwen3-VL 4B",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Wan 2.1)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL 4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 832,
      height: 480,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 3.0 },
      },
      video_frames: 33,
      fps: 24,
    },
  },
  "hunyuan-video": {
    name: "HunyuanVideo 1.5",
    hint: "Diffusion + Hunyuan VAE + Qwen2.5-VL + ByT5 GlyphXL",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "HunyuanVideo VAE", "vae", "vae"),
      F("llm", "Qwen2.5-VL 7B", "llm", "llm"),
      F("t5xxl", "ByT5 Small GlyphXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1280,
      height: 720,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 6.0 },
      },
      video_frames: 33,
      fps: 24,
      vae_tiling_params: { enabled: true },
    },
  },
  // docs/minimax_h3.md 示例参数：864×480、56 帧、24 fps、cfg 1.0。
  // 采样器（DiT 默认 euler）与 flow shift（引擎对 minimax-h3 默认 12）
  // 交由上游默认值，不重复硬编码；缺省 --audio-vae 仍可出片但无音轨。
  "minimax-h3-fl2va": {
    name: "MiniMax-H3 (FL2VA)",
    hint: "音视频联合生成：Diffusion + 视频 VAE + 音频 VAE + Qwen3-VL 32B / P-H3 4B",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "视频 VAE", "vae", "vae"),
      F(
        "audio_vae",
        "音频 VAE (可选)",
        "audio-vae",
        "audio_vae",
        false,
        "不填也可生成视频，但成品不含音轨",
      ),
      F(
        "llm",
        "LLM (Qwen3-VL 32B / P-H3 4B)",
        "llm",
        "llm",
        true,
        "可选 Qwen3-VL 32B，或更轻量的 P-H3 Qwen3-VL 4B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "使用裸 Qwen3-VL 4B 时需选配文本连接器，用 32B 或内置版请留空",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 864,
      height: 480,
      sample_params: {
        sample_steps: 20,
        guidance: { txt_cfg: 1.0 },
      },
      video_frames: 56,
      fps: 24,
    },
    // 上游 video.cpp：MiniMax-H3 只要给了参考图/参考视频/参考音频，就
    // 不允许再给首帧或尾帧（"keyframes and Ref2VA references cannot be
    // used together"），并在生成阶段直接判失败。首尾帧彼此可以共存，
    // 所以拆成两条二元互斥声明（相同文案会被去重）。
    exclusiveInputGroups: [
      {
        inputs: ["ref_images", "init_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_images", "end_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      // 上游 #2249：latent hires 二段采样与首尾帧互斥（首尾帧 latent 按
      // 一段分辨率编码，二段画布无法复用），内核直接判失败。
      {
        inputs: ["hires", "init_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["hires", "end_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
    ],
    generationHint:
      "二次放大不可与首尾帧同时开启；使用 Sol-H3-VAE 时时间分块帧数与重叠需为 5 的倍数。长视频显存紧张时可在附加启动参数添加 --model-args minimax_h3_attn_chunk_budget=0.25。",
  },
  "minimax-h3-ref2va": {
    name: "MiniMax-H3 (Ref2VA)",
    hint: "支持参考图、参考视频与参考音频的音视频生成",
    mode: "vid",
    // 上游 #2194 起 /sdcpp/v1 vid_gen 接受 ref_videos（24fps 帧数组）/
    // ref_audios / ref_video_audios（WAV），参考媒体可完整走 HTTP。
    // 必填口径与内核一致：参考图 / 参考视频 / 参考音频**任一**即可
    // （src/pipeline/video.cpp 的 has_references），避免只用参考媒体的人被拦。
    requiredAnyInputGroupsByMode: {
      vid_gen: [["ref_images", "ref_videos", "ref_audios"]],
    },
    // 同 FL2VA：上游对 MiniMax-H3 统一要求参考条件与首尾帧互斥
    // （首尾帧彼此可以共存，故拆成两条二元声明）；hires 二段采样同样
    // 与首尾帧互斥（上游 #2249）。参考视频/音频也属于 Ref2VA 参考条件，
    // 同样不能与首尾帧同用（上游 #2194）。
    exclusiveInputGroups: [
      {
        inputs: ["ref_images", "init_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_images", "end_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["hires", "init_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["hires", "end_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["ref_videos", "init_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_videos", "end_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_audios", "init_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_audios", "end_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
    ],
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "视频 VAE", "vae", "vae"),
      F("audio_vae", "音频 VAE (可选)", "audio-vae", "audio_vae", false),
      F(
        "llm",
        "LLM (Qwen3-VL 32B / P-H3 4B)",
        "llm",
        "llm",
        true,
        "可选 Qwen3-VL 32B，或更轻量的 P-H3 Qwen3-VL 4B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "使用裸 Qwen3-VL 4B 时需选配文本连接器，用 32B 或内置版请留空",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
  },
  // MiniMax-H3-Image（上游 #2324 / #2337 / #2340，docs/models/minimax_h3_image.md）：
  // 文生图 + 参考图编辑共用一个 checkpoint。文本编码器支持 Qwen3-VL-32B 或
  // P-H3 Qwen3-VL-4B（配可选 --embeddings-connectors），VAE 必须用图像专用版。
  "minimax-h3-image": {
    name: "MiniMax-H3-Image",
    hint: "文生图 + 参考图编辑：Diffusion + 图像专用 VAE + Qwen3-VL 32B / P-H3 4B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "图像 VAE", "vae", "vae"),
      F(
        "llm",
        "LLM (Qwen3-VL 32B / P-H3 4B)",
        "llm",
        "llm",
        true,
        "可选 Qwen3-VL 32B，或更轻量的 P-H3 Qwen3-VL 4B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision", false),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "使用裸 Qwen3-VL 4B 时需选配文本连接器，用 32B 或内置版请留空",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 6,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        custom_sigmas: [
          1.0, 0.9675236940383911, 0.8875485062599182, 0.75, 0.5327739119529724,
          0.23200887441635132, 0.0,
        ],
      },
    },
    generationHint:
      "使用 6 步固定调度表（手动改步数不生效），且需搭配图像专用 VAE。编辑时可用 <Picture N> 指代参考图，最多 16 张。",
  },
  // P-H3-Image（上游 #2272，docs/p_h3_image.md）：H3 DiT + 单帧 VAE +
  // Qwen3-VL-4B + 文本连接器。官方 PrunaAI 包的编码器已内置连接器；复用裸
  // Qwen3-VL-4B 时才需要 --embeddings-connectors 单独传。上游默认 2912²
  // （8.5MP）极吃显存，按 docs 口径采用并在提示里建议小画布起步。
  "p-h3-image": {
    name: "P-H3-Image",
    hint: "文生图 + 参考图编辑：Diffusion + 单帧 VAE + Qwen3-VL 4B / 32B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "图像 VAE", "vae", "vae"),
      F(
        "llm",
        "LLM (Qwen3-VL 4B / 32B)",
        "llm",
        "llm",
        true,
        "可选 P-H3 Qwen3-VL 4B 或 Qwen3-VL 32B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision", false),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "官方整合编码器或 32B 可留空，使用裸 Qwen3-VL 4B 时需选配",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 2912,
      height: 2912,
      sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        custom_sigmas: [
          1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0,
        ],
      },
      // docs：保持默认 VAE 分块 256px。
      vae_tiling_params: { enabled: true, tile_size_w: 256, tile_size_h: 256 },
    },
    generationHint:
      "使用 8 步固定调度表（手动改步数不生效）。默认 2912×2912 显存开销极高，建议先从 1024×1024 试跑，并保持 VAE 分块 256px。",
  },
  // HyperFlow H3 Flash（上游 #2299，docs/minimax_h3.md §HyperFlow）：
  // MiniMax-H3 的蒸馏视频权重，组件与输入同 H3，采样换 4/6/8 步专用调度
  // （预设已含 flow shift 12，保持默认）。FL2VA / Ref2VA 两支拆族。
  "hyperflow-h3-flash": {
    name: "HyperFlow H3 Flash",
    hint: "H3 快速蒸馏视频版（默认 6 步，组件同 MiniMax-H3）",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "视频 VAE", "vae", "vae"),
      F("audio_vae", "音频 VAE (可选)", "audio-vae", "audio_vae", false),
      F(
        "llm",
        "LLM (Qwen3-VL 32B / P-H3 4B)",
        "llm",
        "llm",
        true,
        "可选 Qwen3-VL 32B，或更轻量的 P-H3 Qwen3-VL 4B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "使用裸 Qwen3-VL 4B 时需选配文本连接器，用 32B 或内置版请留空",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 864,
      height: 480,
      sample_params: {
        sample_steps: 6,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        custom_sigmas: [1.0, 0.982655942, 0.914642572, 0.674755692, 0.385223746, 0.159055337, 0.0],
      },
      video_frames: 56,
      fps: 24,
    },
    exclusiveInputGroups: [
      {
        inputs: ["ref_images", "init_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_images", "end_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["hires", "init_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["hires", "end_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
    ],
    generationHint:
      "默认使用 6 步专用调度表（含预设 Flow Shift），保持 CFG 1 即可；也可在高级采样中替换为 4 步或 8 步自定义 sigma。",
  },
  "hyperflow-h3-flash-ref2va": {
    name: "HyperFlow H3 Flash (Ref2VA)",
    hint: "H3 快速蒸馏版（参考图 / 视频 / 音频，默认 6 步）",
    mode: "vid",
    // 同 MiniMax-H3 Ref2VA：参考图 / 视频 / 音频任一即可。
    requiredAnyInputGroupsByMode: {
      vid_gen: [["ref_images", "ref_videos", "ref_audios"]],
    },
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "视频 VAE", "vae", "vae"),
      F("audio_vae", "音频 VAE (可选)", "audio-vae", "audio_vae", false),
      F(
        "llm",
        "LLM (Qwen3-VL 32B / P-H3 4B)",
        "llm",
        "llm",
        true,
        "可选 Qwen3-VL 32B，或更轻量的 P-H3 Qwen3-VL 4B",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F(
        "embeddings",
        "文本连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "使用裸 Qwen3-VL 4B 时需选配文本连接器，用 32B 或内置版请留空",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 864,
      height: 480,
      sample_params: {
        sample_steps: 6,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        custom_sigmas: [1.0, 0.982655942, 0.914642572, 0.674755692, 0.385223746, 0.159055337, 0.0],
      },
      video_frames: 56,
      fps: 24,
    },
    exclusiveInputGroups: [
      {
        inputs: ["ref_images", "init_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_images", "end_image"],
        message: "MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["hires", "init_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["hires", "end_image"],
        message: "MiniMax-H3 的二次放大（hires）暂不支持与首帧 / 尾帧同时使用",
      },
      {
        inputs: ["ref_videos", "init_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_videos", "end_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_audios", "init_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
      {
        inputs: ["ref_audios", "end_image"],
        message: "MiniMax-H3 的参考视频 / 音频不能与初始图片 / 结束帧同时使用",
      },
    ],
    generationHint: "参考素材及二次放大均不可与首尾帧同时使用；参考音频仅支持 WAV 格式。",
  },
  zimage: {
    name: "Z-Image",
    hint: "Base 模型 + VAE + Qwen3",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "zimage-turbo": {
    name: "Z-Image Turbo",
    hint: "Turbo 模型 + VAE + Qwen3",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  // Z-Image L2P（上游 #2075）：把 Z-Image-Turbo 迁到 RGB 像素空间——16×16
  // patch 化 + 小型卷积解码器取代 VAE，文本编码器仍是 Qwen3-4B。上游按权重
  // 张量 local_decoder.out_conv.weight 自动识别架构，因此这里**只列真正需要
  // 的组件**：没有任何 VAE / TAE 槽位，传了也只会白读文件（FakeVAE 分支优先）。
  // 参考参数取上游 docs/z_image_l2p.md：1024×1024、Euler、30 步、CFG 2.0；
  // 该文档还建议以 `--type bf16` 载入（控制台"加载时量化"里可选）。
  "zimage-l2p": {
    name: "Z-Image L2P",
    hint: "DiT + Qwen3-4B，无需 VAE",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    // 上游 runner 对非空参考潜变量直接报错返回（z_image_l2p.hpp），而
    // capabilities 的 ref_images 是协议级通用值、不会为它自动收窄，
    // 因此必须在这里关掉，避免旧任务/别的模型残留的参考图被提交。
    disabledFeatures: ["ref_images"],
    generationHint: "不支持参考图；建议使用 BF16 加载，减少内存占用。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 30,
        sample_method: "euler",
        guidance: { txt_cfg: 2.0 },
      },
    },
  },
  "qwen-image": {
    name: "Qwen-Image",
    hint: "Diffusion + VAE + Qwen2.5-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen2.5-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 2.5 },
        flow_shift: 3,
      },
    },
  },
  "qwen-image-layered": {
    name: "Qwen-Image Layered",
    hint: "分层图像生成 + VAE + Qwen2.5-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen2.5-VL)", "llm", "llm"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      qwen_image_layers: 3,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 2.5 },
        flow_shift: 3,
      },
    },
  },
  "qwen-image-edit": {
    name: "Qwen-Image-Edit",
    hint: "图像编辑 + Qwen2.5-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen2.5-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "discrete",
        guidance: { txt_cfg: 2.5 },
        flow_shift: 3,
      },
    },
  },
  // Qwen Image 2.1（上游 #1994）：单独的 VAE 与 Qwen3-VL-8B 文本编码器，
  // 与旧 Qwen Image / Wan2.2 的 VAE 权重不通用；宽高按 32 对齐；
  // RGBA 输出由提示词决定，且只在 png / webp 下保留 alpha。
  "qwen-image-2.1": {
    name: "Qwen Image 2.1",
    hint: "Diffusion + 专用 VAE + Qwen3-VL-8B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (qwen_image_2.1)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL-8B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (编辑用，可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint:
      "需使用配套专用 VAE，图像编辑需另配视觉编码器；导出透明背景请在提示词中说明 RGBA 并选择 PNG / WebP。显存紧张时可在附加启动参数添加 --model-args qwen_image_2_1_prefix_cache_type=q8_0。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 6.0 },
      },
    },
  },
  // LLaDA-Image（上游 #1968）：NextDiT + LLaDA2-MoE 文本编码器 + Flux.2 VAE
  // + 预合并的 connectors（编辑版还需含 SigVQ 权重），并且强制要求外部
  // LLaDA2 tokenizer.json。两个 checkpoint 的文件不可混用。
  "llada-image": {
    name: "LLaDA-Image (50 步)",
    hint: "Diffusion + LLaDA2-MoE + Flux.2 VAE + 连接器；需外部 tokenizer",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Flux.2)", "vae", "vae"),
      F("llm", "LLM (LLaDA2-MoE)", "llm", "llm"),
      F(
        "embeddings",
        "嵌入连接器（QueryFormer + 文本投影，编辑需含 SigVQ）",
        "embeddings-connectors",
        "embeddings",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint: "参考图编辑需使用含 SigVQ 的连接器，显存占用约为文生图的两倍。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 50,
        sample_method: "euler",
        scheduler: "llada_image",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "llada-image-turbo": {
    name: "LLaDA-Image Turbo (4 步)",
    hint: "Diffusion + LLaDA2-MoE + Flux.2 VAE + 连接器；需外部 tokenizer",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Flux.2)", "vae", "vae"),
      F("llm", "LLM (LLaDA2-MoE Turbo)", "llm", "llm"),
      F(
        "embeddings",
        "嵌入连接器（QueryFormer + 文本投影，编辑需含 SigVQ）",
        "embeddings-connectors",
        "embeddings",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint: "请保持 4 步与 CFG 1.0，调高 CFG 会劣化画质；与基础版权重不可混用。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        scheduler: "llada_image",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  // Mage-Flow 默认参数来自官方模型卡（microsoft/Mage-Flow）：非 Turbo cfg 5.0，
  // Turbo 4 步 / cfg 1.0；RL 版 20 步、Base / Edit 版 30 步；尺寸需为 16 的倍数。
  "mage-flow": {
    name: "Mage-Flow",
    hint: "Diffusion + Mage-VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "Mage-VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        // 上游 docs/mage_flow.md:15：Base 模型 30 步、Turbo 4 步 + cfg 1。
        // 此前 Base 填了 20（与自身 hint、文件头注释、同族 Edit Base 的 30
        // 三处矛盾），属复制 Turbo/RL 档参数时漏改（审查 40-cli §2.3）。
        sample_steps: 30,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "mage-flow-turbo": {
    name: "Mage-Flow Turbo",
    hint: "Diffusion + Mage-VAE + Qwen3-VL（4 步快速版）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "Mage-VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "mage-flow-edit": {
    name: "Mage-Flow Edit",
    hint: "图像编辑 + Mage-VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "Mage-VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 30,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "mage-flow-edit-turbo": {
    name: "Mage-Flow Edit Turbo",
    hint: "图像编辑 + Mage-VAE + Qwen3-VL（4 步快速版）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "Mage-VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  chroma: {
    name: "Chroma",
    hint: "Diffusion + VAE + T5-XXL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.0 },
      },
    },
  },
  "chroma-radiance": {
    name: "Chroma-Radiance",
    hint: "Diffusion + T5-XXL (无 VAE)",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.0 },
      },
    },
  },
  ltx: {
    name: "LTX-Video",
    hint: "视频生成 + Gemma 3",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "视频 VAE", "vae", "vae"),
      F("audio_vae", "音频 VAE", "audio-vae", "audio_vae"),
      F("llm", "LLM (Gemma 3 12B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F("embeddings", "嵌入连接器", "embeddings-connectors", "embeddings"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1280,
      height: 720,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "ltx2",
        guidance: { txt_cfg: 6.0 },
      },
      video_frames: 33,
      fps: 24,
    },
  },
  // 上游 #1893 / docs/ltx2.md：LTX-2.5 与 2.3 共用 transformer 与视频/音频
  // VAE 架构、由引擎按权重自动区分；组件差异在文本编码器——配套的 Gemma 4
  // 12B 为 LTX 微调版、文本投影内置，不再需要 --embeddings-connectors。
  // 推荐参数取自上游 T2V 示例：cfg 3.0、121 帧 @24fps（2.3 为 cfg 6.0、33 帧）。
  ltx25: {
    name: "LTX-2.5",
    hint: "视频生成 + Gemma 4（无需嵌入连接器）",
    mode: "vid",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F(
        "vae",
        "视频 VAE",
        "vae",
        "vae",
        true,
        "请选择 conv 变体（ltx-2.5-video-vae-conv），标准 video-vae 暂不支持",
      ),
      F("audio_vae", "音频 VAE", "audio-vae", "audio_vae"),
      F(
        "llm",
        "LLM (Gemma 4 12B)",
        "llm",
        "llm",
        true,
        "需使用 LTX 微调版 gemma4-12b-with-proj-ltx-2.5，原版 Gemma 4 不兼容",
      ),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F(
        "embeddings",
        "嵌入连接器 (可选)",
        "embeddings-connectors",
        "embeddings",
        false,
        "LTX-2.5 已内置投影，此处留空即可",
      ),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1280,
      height: 720,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        scheduler: "ltx2",
        guidance: { txt_cfg: 3.0 },
      },
      video_frames: 121,
      fps: 24,
    },
  },
  ideogram: {
    name: "Ideogram4",
    hint: "Diffusion + Uncond + LLM",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("uncond_model", "Uncond 模型", "uncond-diffusion-model", "uncond_model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 7 },
      },
    },
  },
  hidream: {
    name: "HiDream-O1",
    hint: "自包含模型",
    mode: "img",
    fields: [F("model", "完整模型", "model", "model")],
    fixedArgs: {},
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "ernie-image": {
    name: "ERNIE-Image",
    hint: "Diffusion + VAE + Ministral",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Ministral)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      // docs/ernie_image.md：base 推荐 cfg 5.0；8 步 cfg 1.0 是 turbo 的参数
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "ernie-image-turbo": {
    name: "ERNIE-Image Turbo",
    hint: "Turbo 版 + VAE + Ministral",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Ministral)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  anima: {
    name: "Anima",
    hint: "Diffusion + VAE + Qwen3-0.6B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen3)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 6.0 },
      },
    },
  },
  krea2: {
    name: "Krea2",
    hint: "Krea2 + Wan VAE + Qwen3-VL 4B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Wan 2.1)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL 4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (编辑可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 52,
        sample_method: "euler",
        guidance: { txt_cfg: 3.5 },
        flow_shift: 1.15,
      },
    },
  },
  "krea2-turbo": {
    name: "Krea2 Turbo",
    hint: "Krea2 Turbo + Wan VAE + Qwen3-VL 4B",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Wan 2.1)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL 4B)", "llm", "llm"),
      F("llm_vision", "LLM Vision (编辑可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        flow_shift: 1.15,
      },
    },
  },
  sefi: {
    name: "SeFi-Image",
    hint: "Diffusion + Flux.2 VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Flux2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 50,
        sample_method: "euler",
        guidance: { txt_cfg: 4.0 },
      },
    },
  },
  "sefi-turbo": {
    name: "SeFi-Image Turbo",
    hint: "Turbo 版 + Flux.2 VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (Flux2)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  lens: {
    name: "Lens",
    hint: "Diffusion + VAE + GPT-OSS",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (GPT-OSS)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  "lens-turbo": {
    name: "Lens Turbo",
    hint: "Turbo 版 + VAE + GPT-OSS",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (GPT-OSS)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 4,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
      },
    },
  },
  "boogu-base": {
    name: "Boogu Image Base",
    hint: "文生图 + FLUX VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
        flow_shift: 3.16,
      },
    },
  },
  "boogu-edit": {
    name: "Boogu Image Edit",
    hint: "图像编辑 + FLUX VAE + Qwen3-VL（需配置视觉编码器）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (mmproj)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
        flow_shift: 3.16,
      },
    },
  },
  "boogu-turbo": {
    name: "Boogu Image Turbo",
    hint: "Turbo 版 + FLUX VAE + Qwen3-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE (FLUX)", "vae", "vae"),
      F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 8,
        sample_method: "euler",
        guidance: { txt_cfg: 1.0 },
        flow_shift: 3.16,
      },
    },
  },
  longcat: {
    name: "LongCat",
    hint: "Diffusion + VAE + Qwen2.5-VL",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Qwen2.5-VL)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
        flow_shift: 3,
      },
    },
  },
  ovis: {
    name: "Ovis-Image",
    hint: "Diffusion + VAE + Ovis",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("llm", "LLM (Ovis)", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 5.0 },
      },
    },
  },
  minit2i: {
    name: "MiniT2I",
    hint: "Diffusion + flan-t5-large，无需 VAE（固定 512×512）",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("t5xxl", "T5 (flan-t5-large)", "t5xxl", "t5xxl"),
    ],
    fixedArgs: {},
    // 上游 #2189：内核把宽高硬夹到 512×512（request.cpp 的
    // `align to fixed size 512x512 for MiniT2I`），界面不能再让用户改。
    fixedSize: { width: 512, height: 512 },
    generationHint: "无需 VAE，输出分辨率固定为 512×512，如需更高分辨率可启用二次放大。",
    genDefaults: {
      seed: -1,
      width: 512,
      height: 512,
      sample_params: {
        sample_steps: 100,
        sample_method: "euler",
        guidance: { txt_cfg: 6.0 },
      },
    },
  },
  "distilled-sd": {
    name: "Distilled SD",
    hint: "SSD-1B / SDXS 等蒸馏模型（SDXS 需改 1 步 / CFG 1）",
    mode: "img",
    fields: [F("model", "完整模型", "model", "model")],
    fixedArgs: {},
    // 上游 docs/distilled_sd.md：`--cfg-scale 1 --steps 1` 是 **SDXS 专属且
    // mandatory**；同族的 SSD-1B / Vega 是 "out-of-the-box" 的常规蒸馏模型
    // （仍需 CFG 与二三十步），且两者都是 SDXL 架构、默认 1024²。此前这里
    // 填 1 步 / CFG 1 / 512²，SSD-1B 用户一进生成页就是错参数且出糊图
    // （审查 S-4）。改成中性默认值，SDXS 用户在提示里被明确告知要手改。
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: { sample_steps: 20, guidance: { txt_cfg: 7 } },
    },
    generationHint:
      "SDXS-512 系列请改为 512×512、1 步、CFG 1；SSD-1B 与 Vega 直接使用默认参数即可。",
  },
  // PixArt-α / PixArt-Σ（上游 #2047）：DiT + T5-XXL + 4 通道 VAE。两者
  // checkpoint 的 DiT 张量布局相同，但默认 VAE 缩放因子不同（Σ 0.13025，
  // α 常用 0.18215），所以拆成两族。T5 词表内嵌，不要配外部 tokenizer。
  "pixart-sigma": {
    name: "PixArt-Σ",
    hint: "Diffusion (Σ) + T5-XXL + SDXL 对应的 VAE",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
      F("vae", "VAE (SDXL latent)", "vae", "vae"),
    ],
    fixedArgs: {},
    generationHint: "请搭配 SDXL 对应的 VAE（勿混用 SD1.x 的 VAE），无需外部 tokenizer。",
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.5 },
      },
    },
  },
  "pixart-alpha": {
    name: "PixArt-α",
    hint: "Diffusion (α) + T5-XXL + SD1.x 对应的 VAE",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
      F("vae", "VAE (SD1.x latent)", "vae", "vae"),
    ],
    fixedArgs: {},
    generationHint:
      '请搭配 SD1.x 对应的 VAE，无需外部 tokenizer。使用 α-512 权重时，请在附加启动参数中添加 --model-args "pixart_vae_scale_factor=0.18215,pixart_pos_embed_base_size=32,pixart_interpolation_scale=1"。',
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 20,
        sample_method: "euler",
        guidance: { txt_cfg: 4.5 },
      },
    },
  },
  // Ming-Image 0.1 Design（上游 #2063）：DiT + Ling-mini-2.0 BF16 文本编码器
  // + Ming 专用 VAE + 外部 Ling tokenizer。当前只有文生图：参考图会被
  // conditioner 直接拒绝，负向提示词不参与编码（上游用全零 uncond）。
  "ming-image": {
    name: "Ming-Image 0.1 Design",
    hint: "Diffusion + Ling-mini-2.0 BF16 + Ming VAE；需外部 Ling tokenizer",
    mode: "img",
    fields: [
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("llm", "文本编码器 (Ling-mini-2.0 BF16)", "llm", "llm"),
      F("vae", "VAE (Ming)", "vae", "vae"),
    ],
    fixedArgs: { "flash-attn": "off,diffusion=on" },
    generationHint:
      "仅支持文生图，负向提示词不生效；需使用 Ling-mini-2.0 BF16 完整编码器与 Ming 专用 VAE。导出透明背景请选择 PNG 或 WebP。",
    // 协议层的图片 features 是通用的（对所有模型都报 true），而 Ming 的
    // 实现明确拒绝参考图，必须按家族关闭并在提交前过滤旧图。
    disabledFeatures: ["ref_images"],
    genDefaults: {
      seed: -1,
      width: 1024,
      height: 1024,
      sample_params: {
        sample_steps: 12,
        sample_method: "euler",
        guidance: { txt_cfg: 1 },
      },
    },
  },
  custom: {
    name: "自定义",
    hint: "手动配置所有组件",
    mode: "img",
    fields: [
      F("model", "完整模型 (-m)", "model", "model"),
      F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
      F("vae", "VAE", "vae", "vae"),
      F("clip_l", "CLIP-L", "clip_l", "clip_l"),
      F("clip_g", "CLIP-G", "clip_g", "clip_g"),
      F("t5xxl", "T5-XXL", "t5xxl", "t5xxl"),
      F("llm", "LLM", "llm", "llm"),
      F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
      F("clip_vision", "CLIP Vision", "clip_vision", "clip_vision"),
    ],
    fixedArgs: {},
  },
};

/**
 * TAE（Tiny AutoEncoder）快速解码 —— 上游对**除 FakeVAE 家族外**的所有版本都会
 * 构建 TAE（src/stable-diffusion.cpp `create_tae`、src/model/vae/tae.hpp）：
 *   · SD 1.x / 2.x / XL（4ch latent）→ taesd / taesdxl
 *   · 其余 DiT（16ch latent）→ 同 latent 空间的 TAE（taef1 / taesd3 …）
 *   · Flux.2 VAE（32ch + patch 2）→ taef2
 *   · Wan VAE 系（Wan / Qwen-Image / LingBot-Video / Krea2 / Anima）→ TAEHV
 *   · HunyuanVideo（32ch）/ LTX-AV（128ch）→ 各自的视频 TAE
 *   · MiniMax-H3（24ch）→ taeh3（上游 #1874 新增，此前引擎会拒绝 --taesd）
 * Chroma-Radiance / HiDream-O1 / MiniT2I / SenseNova U1.5 走 FakeVAE（不解码 latent），
 * FakeVAE 分支优先于 use_tae，传 --taesd 无意义，故不暴露该组件。
 * Z-Image L2P 同理：它的"VAE"是 RGB 像素空间的恒等映射（上游 #2075 的
 * FakeVAE 分支同样优先于 TAE），给 TAE 只会白读权重。
 * 权重不匹配时上游只告警并回落到完整 VAE，不会启动失败。
 */
const FAKE_VAE_FAMILIES = [
  "chroma-radiance",
  "hidream",
  "minit2i",
  "sensenova-u1",
  "zimage-l2p",
  // Iris-3B 直接在像素空间生成（scale 1、3 通道 latent），上游 docs/iris.md
  // 明确要求不要传 --vae。
  "iris",
];

const TAE_WEIGHT_GROUPS: { hint: string; families: string[] }[] = [
  { hint: "taesd（SD 1.x / 2.x）", families: ["sd"] },
  {
    hint: "taesdxl（SDXS 已内置，无需另选）",
    families: ["sdxl", "distilled-sd"],
  },
  {
    hint: "taesdxl（与 SDXL 同空间）",
    families: ["pixart-sigma"],
  },
  {
    hint: "taesd（与 SD 1.x 同空间）",
    families: ["pixart-alpha"],
  },
  {
    // Ming 复用 Wan 系 VAE 架构但缩放因子与通道数自定义；上游没有为它
    // 记录 TAE 组合，别让默认文案暗示存在现成权重。
    hint: "使用自己的 VAE，暂无兼容 TAE；显存紧张时建议降低分辨率",
    families: ["ming-image"],
  },
  { hint: "taesd3", families: ["sd3"] },
  {
    hint: "taef1",
    families: ["flux", "kontext", "chroma", "ovis", "zimage", "zimage-turbo"],
  },
  {
    // PiD 的 latent 布局随 --vae-format 变，TAE 也要跟着换。
    hint: "按 --vae-format 选择对应 TAE（flux 用 taef1，sd3 用 taesd3，wan 用 taew2_1）",
    families: ["pid"],
  },
  {
    hint: "Flux.2 专用 TAE",
    families: [
      "flux2",
      "flux2-klein",
      "flux2-klein-base",
      // FLUX.3 两族与 MOSS-Image 复用 Flux.2 VAE（上游 #2143 / #2148）。
      "flux3-klein",
      "flux3-klein-base",
      "moss-image",
      // LLaDA-Image 复用 Flux.2 的 VAE（上游 docs/llada_image.md）。
      "llada-image",
      "llada-image-turbo",
      // Fibo 2.0 复用 Flux.2 VAE（上游 docs/fibo2.md）。
      "fibo2",
      "fibo2-edit",
    ],
  },
  {
    hint: "taew2_1（Wan2.1 / Qwen-Image 通用）",
    families: [
      "wan-t2v",
      "wan-i2v",
      "wan-a14b",
      "lingbot-video",
      "krea2",
      "krea2-turbo",
      "anima",
      "qwen-image",
      "qwen-image-layered",
      "qwen-image-edit",
    ],
  },
  {
    hint: "taew2_2（Wan2.2 TI2V 5B 专用）",
    families: ["wan-ti2v"],
  },
  { hint: "HunyuanVideo 专用 TAE", families: ["hunyuan-video"] },
  { hint: "LTX-AV 专用 TAE", families: ["ltx", "ltx25"] },
  {
    hint: "taeh3（MiniMax-H3 视频专用）",
    families: [
      "minimax-h3-fl2va",
      "minimax-h3-ref2va",
      // HyperFlow H3 Flash 共用 H3 组件与 latent 空间（上游 #2299）。
      "hyperflow-h3-flash",
      "hyperflow-h3-flash-ref2va",
    ],
  },
  {
    // H3-Image 用专用图像 VAE，上游没有为它记录 TAE 组合；视频 taeh3
    // 是否兼容图像 latent 未经确认，别让默认文案暗示存在现成权重。
    hint: "暂无已确认兼容的 TAE 权重，显存紧张时建议启用 VAE 分块",
    families: ["minimax-h3-image"],
  },
  {
    hint: "暂无已确认兼容的 TAE 权重，显存紧张时建议降低分辨率",
    families: ["p-h3-image"],
  },
  {
    // Qwen Image 2.1 用专门的 TAEQI2.1（64ch latent、16x 空间缩放、支持
    // RGBA），旧 Qwen Image 的 taew2_1 不能拿来做替代。
    hint: "taeqi2_1（Qwen Image 2.1 专用）",
    families: ["qwen-image-2.1"],
  },
];

const DEFAULT_TAE_HINT = "按主模型 latent 空间选择对应 TAE，可降低显存占用";

const TAE_HINT_BY_FAMILY: Record<string, string> = {};
for (const group of TAE_WEIGHT_GROUPS) {
  for (const family of group.families) TAE_HINT_BY_FAMILY[family] = group.hint;
}

for (const [family, config] of Object.entries(FAMILY_CONFIG)) {
  if (FAKE_VAE_FAMILIES.includes(family)) continue;
  if (config.fields.some((field) => field.arg === "taesd")) continue;
  config.fields.push(
    F(
      "taesd",
      "TAE 快速解码 (可选)",
      "taesd",
      "taesd",
      false,
      TAE_HINT_BY_FAMILY[family] || DEFAULT_TAE_HINT,
    ),
  );
}

// 家族检测唯一实现在 Rust（family.rs），前端经 api.detectFamily() 调用；
// 此处不再保留正则副本（曾与 Rust 逻辑反复漂移）。
