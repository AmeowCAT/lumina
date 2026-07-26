import type { GenMode, ServerArgs } from "../types";

// ── Display name maps (sampler / scheduler indices come from capabilities) ──
export const SAMPLER_NAMES: Record<string, string> = {
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
};

export const SCHEDULER_NAMES: Record<string, string> = {
	discrete: "Discrete",
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
}

export type RequiredInput = "init_image" | "end_image" | "ref_images";

export const PID_VAE_FORMATS = [
	{ value: "flux", label: "Flux / Z-Image" },
	{ value: "sd3", label: "SD3" },
	{ value: "flux2", label: "Flux.2" },
	{ value: "wan", label: "Qwen-Image / Wan" },
] as const;

/** Frame shortcuts for models whose native temporal context is known. */
export const VIDEO_FRAME_PRESETS: Record<string, number[]> = {
	sd: [8, 16, 24, 32],
	"lingbot-video": [33, 49, 81],
	"hunyuan-video": [17, 33, 49],
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Diffusion + VAE + LLM (4B/9B) — 基础模型（cfg 4 / 20 步）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
	sdxl: {
		name: "SDXL",
		hint: "完整模型 + 可选 VAE",
		mode: "img",
		fields: [
			F("model", "完整模型", "model", "model"),
			F("vae", "VAE (可选)", "vae", "vae"),
			F("control-net", "ControlNet (可选)", "control-net", "control_net"),
			F("photo-maker", "PhotoMaker (可选)", "photo-maker", "photo_maker"),
			F("pulid-weights", "PuLID (可选)", "pulid-weights", "pulid"),
			F("taesd", "TAESD (可选)", "taesd", "taesd"),
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
				"支持 AnimateDiff SD 1.5 v2/v3；加载后服务端会开放视频生成模式",
			),
			F("photo-maker", "PhotoMaker (可选)", "photo-maker", "photo_maker"),
			F("pulid-weights", "PuLID (可选)", "pulid-weights", "pulid"),
			F("taesd", "TAESD (可选)", "taesd", "taesd"),
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
			F(
				"diffusion-model",
				"Diffusion 模型 (LowNoise)",
				"diffusion-model",
				"model",
			),
			F(
				"high-noise-diffusion-model",
				"高噪 Diffusion (HighNoise)",
				"high-noise-diffusion-model",
				"high_noise_model",
			),
			F("vae", "VAE", "vae", "vae"),
			F("t5xxl", "UMT5-XXL", "t5xxl", "t5xxl"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
	// Mage-Flow 默认参数来自官方模型卡（microsoft/Mage-Flow）：非 Turbo cfg 5.0，
	// Turbo 4 步 / cfg 1.0；RL 版 20 步、Base / Edit 版 30 步；尺寸需为 16 的倍数。
	"mage-flow": {
		name: "Mage-Flow",
		hint: "T2I：Diffusion + Mage-VAE + Qwen3-VL（Base 模型建议 30 步）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "Mage-VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
	"mage-flow-turbo": {
		name: "Mage-Flow Turbo",
		hint: "T2I：Diffusion + Mage-VAE + Qwen3-VL",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "Mage-VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "图像编辑（参考图）+ Mage-VAE + Qwen3-VL",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "Mage-VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "图像编辑（参考图）+ Mage-VAE + Qwen3-VL",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "Mage-VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "视频生成 + Gemma",
		mode: "vid",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "视频 VAE", "vae", "vae"),
			F("audio_vae", "音频 VAE", "audio-vae", "audio_vae"),
			F("llm", "LLM (Gemma)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
			F("embeddings", "嵌入连接器", "embeddings-connectors", "embeddings"),
		],
		fixedArgs: { "diffusion-fa": true },
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
	ideogram: {
		name: "Ideogram4",
		hint: "Diffusion + Uncond + LLM",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F(
				"uncond_model",
				"Uncond 模型",
				"uncond-diffusion-model",
				"uncond_model",
			),
			F("vae", "VAE", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Diffusion + VAE + Ministral（base：cfg 5 / 20 步）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE", "vae", "vae"),
			F("llm", "LLM (Ministral)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Turbo 模型 + VAE + Ministral（8 步 cfg 1）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE", "vae", "vae"),
			F("llm", "LLM (Ministral)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Krea2 Raw + Wan VAE + Qwen3-VL 4B",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (Wan 2.1)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL 4B)", "llm", "llm"),
			F("llm_vision", "LLM Vision (编辑可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
		genDefaults: {
			seed: -1,
			width: 1024,
			height: 1024,
			sample_params: {
				sample_steps: 20,
				sample_method: "euler",
				guidance: { txt_cfg: 1.0 },
				flow_shift: 1.15,
			},
		},
	},
	"krea2-turbo": {
		name: "Krea2 Turbo",
		hint: "Krea2 Turbo + Wan VAE + Qwen3-VL 4B (少步数)",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (Wan 2.1)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL 4B)", "llm", "llm"),
			F("llm_vision", "LLM Vision (编辑可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
		genDefaults: {
			seed: -1,
			width: 1024,
			height: 1024,
			sample_params: {
				sample_steps: 4,
				sample_method: "euler",
				guidance: { txt_cfg: 1.0 },
				flow_shift: 1.15,
			},
		},
	},
	sefi: {
		name: "SeFi-Image",
		hint: "Diffusion + Flux2 VAE + Qwen3-VL（base/RL，50 步 cfg 4）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (Flux2)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Turbo 模型 + Flux2 VAE + Qwen3-VL（4 步 cfg 1）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (Flux2)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Turbo 模型 + VAE + GPT-OSS（4 步 cfg 1）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE", "vae", "vae"),
			F("llm", "LLM (GPT-OSS)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		hint: "图像编辑 + FLUX VAE + Qwen3-VL (需要 LLM Vision)",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (FLUX)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (mmproj)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Turbo 模型 + FLUX VAE + Qwen3-VL (少步数)",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("vae", "VAE (FLUX)", "vae", "vae"),
			F("llm", "LLM (Qwen3-VL)", "llm", "llm"),
			F("llm_vision", "LLM Vision (可选)", "llm_vision", "llm_vision"),
		],
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		fixedArgs: { "diffusion-fa": true },
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
		hint: "Diffusion + flan-t5-large（512, 100 步 cfg 6，无 VAE）",
		mode: "img",
		fields: [
			F("diffusion-model", "Diffusion 模型", "diffusion-model", "model"),
			F("t5xxl", "T5 (flan-t5-large)", "t5xxl", "t5xxl"),
		],
		fixedArgs: {},
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
		hint: "SSD-1B / SDXS / 蒸馏模型",
		mode: "img",
		fields: [F("model", "完整模型", "model", "model")],
		fixedArgs: {},
		genDefaults: {
			seed: -1,
			width: 512,
			height: 512,
			sample_params: { sample_steps: 1, guidance: { txt_cfg: 1 } },
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

// 家族检测唯一实现在 Rust（family.rs），前端经 api.detectFamily() 调用；
// 此处不再保留正则副本（曾与 Rust 逻辑反复漂移）。
