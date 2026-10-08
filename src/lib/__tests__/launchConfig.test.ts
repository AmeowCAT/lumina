import { beforeEach, describe, expect, it } from "vitest";
import {
  alignSizeUp,
  alignVideoFrames,
  FAMILY_CONFIG,
  familyNeedsExternalTokenizer,
  SAMPLER_NAMES,
  SCHEDULER_NAMES,
  scaleSize,
  VIDEO_FRAME_MAX,
  VIDEO_FRAME_PRESETS,
} from "../../config/families";
import type { Features, GenImages } from "../../types";
import type { LaunchRuntime } from "../launchConfig";
import {
  applyFamilyFeatureLimits,
  buildLaunchConfig,
  exclusiveInputConflicts,
  familyDefaults,
  filterFamilyInputs,
  hasMainTokenizerSlot,
  inferPidVaeFormat,
  missingRequiredInputs,
  persistFamilyDefaults,
  validateMaxVramSpec,
  validateTokenizerSpec,
} from "../launchConfig";

// 上游 #1887 给 sample_method_to_str / scheduler_to_str 加了 static_assert，
// 这里做等价的对照：GUI 的显示名表必须与 include/stable-diffusion.h 的枚举
// 顺序及 src/stable-diffusion.cpp 的字符串表一一对应，不多不少。
describe("sampler / scheduler token coverage", () => {
  const UPSTREAM_SAMPLERS = [
    "euler",
    "euler_a",
    "heun",
    "dpm2",
    "dpm++2s_a",
    "dpm++2m",
    "dpm++2mv2",
    "ipndm",
    "ipndm_v",
    "lcm",
    "ddim_trailing",
    "tcd",
    "res_multistep",
    "res_2s",
    "er_sde",
    "euler_cfg_pp",
    "euler_a_cfg_pp",
    "euler_ge",
    "dpm++2m_sde",
    "dpm++2m_sde_bt",
    "lms",
  ];
  // capabilities 在 discrete 之后额外返回 normal 别名（routes_sdcpp.cpp），
  // "default" 是 GUI 自己的"未设置"哨兵。
  const UPSTREAM_SCHEDULERS = [
    "discrete",
    "karras",
    "exponential",
    "ays",
    "gits",
    "sgm_uniform",
    "simple",
    "smoothstep",
    "kl_optimal",
    "lcm",
    "bong_tangent",
    "ltx2",
    "logit_normal",
    "flux2",
    "flux",
    "beta",
    // 上游 #1968 随 LLaDA-Image 新增（scheduler_to_str 末尾）。
    "llada_image",
  ];

  it("names every upstream sampler and nothing else", () => {
    expect(Object.keys(SAMPLER_NAMES).sort()).toEqual(
      ["default", ...UPSTREAM_SAMPLERS].sort()
    );
  });

  it("names every upstream scheduler plus the normal alias", () => {
    expect(Object.keys(SCHEDULER_NAMES).sort()).toEqual(
      ["default", "normal", ...UPSTREAM_SCHEDULERS].sort()
    );
  });
});

// 对齐步长依模型版本而定（src/stable-diffusion.cpp video_frames_to_latent_frames）。
// api.md 笼统写作 "4n+1"，但 LTX-AV 实为 8，AnimateDiff 根本不对齐。
describe("alignVideoFrames", () => {
  it("aligns Wan / LingBot / Hunyuan to 4n+1", () => {
    for (const family of [
      "wan-t2v",
      "wan-i2v",
      "wan-ti2v",
      "wan-a14b",
      "lingbot-video",
      "hunyuan-video",
    ]) {
      expect(alignVideoFrames(family, 33)).toBe(33);
      expect(alignVideoFrames(family, 34)).toBe(33);
      expect(alignVideoFrames(family, 32)).toBe(29);
    }
  });

  it("aligns LTX to 8n+1, not 4n+1", () => {
    // LTX-2.5 与 2.3 共用视频 VAE 架构（上游 #1893），latent 对齐同为 8n+1。
    for (const family of ["ltx", "ltx25"]) {
      expect(alignVideoFrames(family, 33)).toBe(33);
      expect(alignVideoFrames(family, 34)).toBe(33);
      // 4n+1 会得到 37；8n+1 必须回落到 33。
      expect(alignVideoFrames(family, 40)).toBe(33);
      expect(alignVideoFrames(family, 41)).toBe(41);
    }
  });

  it("aligns MiniMax-H3 upward to 17k+5 with a floor of 5", () => {
    // 上游 align_video_frames：max(frames,5) 后递增到 %17==5（src/stable-diffusion.cpp）。
    for (const family of ["minimax-h3-fl2va", "minimax-h3-ref2va"]) {
      expect(alignVideoFrames(family, 5)).toBe(5);
      expect(alignVideoFrames(family, 1)).toBe(5);
      expect(alignVideoFrames(family, 6)).toBe(22);
      expect(alignVideoFrames(family, 56)).toBe(56);
      // 与其他家族相反：向上而不是向下取整（50 → 56，不是 39）。
      expect(alignVideoFrames(family, 50)).toBe(56);
      expect(alignVideoFrames(family, 57)).toBe(73);
      // 15 秒 @24fps 的 360 帧向上对齐为 362（17×21+5）。
      expect(alignVideoFrames(family, 360)).toBe(362);
    }
  });

  it("keeps MiniMax-H3 frame presets on the 17k+5 grid and within the slider cap", () => {
    const presets = VIDEO_FRAME_PRESETS["minimax-h3-fl2va"];
    expect(presets).toContain(362); // 15 秒档必须直达
    for (const frames of presets) {
      expect(alignVideoFrames("minimax-h3-fl2va", frames)).toBe(frames);
      expect(frames).toBeLessThanOrEqual(VIDEO_FRAME_MAX["minimax-h3-fl2va"]);
    }
  });

  it("leaves unaligned families alone", () => {
    // AnimateDiff 的 8/16/24/32 预设正是因为它不走对齐路径。
    for (const frames of [8, 16, 24, 32]) {
      expect(alignVideoFrames("sd", frames)).toBe(frames);
    }
    expect(alignVideoFrames("custom", 34)).toBe(34);
  });

  it("handles degenerate input", () => {
    expect(alignVideoFrames("wan-t2v", 1)).toBe(1);
    expect(alignVideoFrames("wan-t2v", 0)).toBe(0);
  });
});

// 对齐基数 = vae_scale_factor × diffusion_model_down_factor（MiniMax-H3 为 32），
// 上游 align_image_size 向上进位（src/stable-diffusion.cpp）。
describe("alignSizeUp", () => {
  it("aligns MiniMax-H3 dimensions up to a multiple of 32", () => {
    for (const family of ["minimax-h3-fl2va", "minimax-h3-ref2va"]) {
      expect(alignSizeUp(family, 864)).toBe(864);
      expect(alignSizeUp(family, 480)).toBe(480);
      // 通用视频预设里会被静默改动的尺寸：720 → 736、1080 → 1088。
      expect(alignSizeUp(family, 720)).toBe(736);
      expect(alignSizeUp(family, 1080)).toBe(1088);
      expect(alignSizeUp(family, 833)).toBe(864);
    }
  });

  it("leaves families without a spatial multiple alone", () => {
    expect(alignSizeUp("wan-t2v", 1080)).toBe(1080);
    expect(alignSizeUp("sd", 720)).toBe(720);
    expect(alignSizeUp("custom", 833)).toBe(833);
  });

  it("handles degenerate input", () => {
    expect(alignSizeUp("minimax-h3-fl2va", 0)).toBe(0);
    expect(alignSizeUp("minimax-h3-fl2va", -32)).toBe(-32);
    expect(alignSizeUp("minimax-h3-fl2va", Number.NaN)).toBeNaN();
  });
});

// 尺寸缩放滑块：相对基准等比缩放，就近对齐到家族空间基数（缺省 16），
// 再 clamp 到 limits——与 alignSizeUp 的向上对齐刻意不同，拖动 0.95×
// 不应得到比 1× 还大的尺寸。
describe("scaleSize", () => {
  it("returns the base size at 1×", () => {
    expect(scaleSize("wan-i2v", 832, 480, 1)).toEqual({ w: 832, h: 480 });
  });

  it("scales proportionally and rounds to the nearest multiple of 16", () => {
    // 864×480 的 0.5× = 432×240 → 就近 16 对齐仍是 432×240。
    expect(scaleSize("wan-i2v", 864, 480, 0.5)).toEqual({ w: 432, h: 240 });
    // 1.5× = 1296×720 → 1296/16=81、720/16=45，天然满足。
    expect(scaleSize("wan-i2v", 864, 480, 1.5)).toEqual({ w: 1296, h: 720 });
    // 0.95× = 820.8×456 → 就近 816×464（而非向上 832×464）。
    expect(scaleSize("wan-i2v", 864, 480, 0.95)).toEqual({ w: 816, h: 464 });
  });

  it("rounds MiniMax-H3 to the nearest multiple of 32", () => {
    // 0.9× = 777.6×432 → 就近 32 对齐为 768×448。
    expect(scaleSize("minimax-h3-fl2va", 864, 480, 0.9)).toEqual({ w: 768, h: 448 });
  });

  it("clamps to limits at the slider extremes", () => {
    const limits = {
      min_width: 256,
      max_width: 1920,
      min_height: 256,
      max_height: 1080,
    };
    expect(scaleSize("wan-i2v", 864, 480, 0, limits)).toEqual({ w: 256, h: 256 });
    expect(scaleSize("wan-i2v", 864, 480, 2, limits)).toEqual({ w: 1728, h: 960 });
    expect(scaleSize("wan-i2v", 1440, 810, 2, limits)).toEqual({ w: 1920, h: 1080 });
  });

  it("falls back to the built-in floor of 64 without limits", () => {
    expect(scaleSize("wan-i2v", 320, 240, 0)).toEqual({ w: 64, h: 64 });
  });
});

const runtime: LaunchRuntime = {
  backend: "cuda0",
  refImagePreset: "",
  vaeFormat: "",
  tokenizer: "",
  sageAttn: false,
  conditioningCacheSize: "",
  extraArgs: "",
  offloadCpu: false,
  quantType: "",
  maxVram: "",
};

describe("launch configuration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("builds PiD component arguments and the selected VAE format", () => {
    const result = buildLaunchConfig({
      family: "pid",
      modelPath: "/models/pid_flux1_512_to_2048.safetensors",
      components: {
        vae: "/models/ae.sft",
        llm: "/models/gemma_2_2b.safetensors",
      },
      runtime: {
        ...runtime,
        vaeFormat: "flux",
        tokenizer: "/models/tokenizers/tokenizer_gemma2.json",
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.args).toEqual(
      expect.objectContaining({
        "diffusion-model": "/models/pid_flux1_512_to_2048.safetensors",
        vae: "/models/ae.sft",
        llm: "/models/gemma_2_2b.safetensors",
        tokenizer: "/models/tokenizers/tokenizer_gemma2.json",
        "diffusion-fa": true,
        "vae-format": "flux",
      })
    );
  });

  // 上游 #1974：PiD / Lens 不再内嵌词表，缺 --tokenizer 会在初始化文本编码器时
  // 失败，因此必须在启动前就报出来，而不是等内核报错。
  it("requires an external tokenizer for PiD and Lens families", () => {
    const pid = buildLaunchConfig({
      family: "pid",
      modelPath: "/models/pid_flux1_512_to_2048.safetensors",
      components: { vae: "/models/ae.sft", llm: "/models/gemma_2_2b.safetensors" },
      runtime: { ...runtime, vaeFormat: "flux" },
    });
    expect(pid.missing).toContain("外部 Tokenizer（--tokenizer，tokenizer.json）");
    expect(pid.args.tokenizer).toBeUndefined();

    for (const family of ["lens", "lens-turbo"]) {
      const result = buildLaunchConfig({
        family,
        modelPath: "/models/lens_bf16.safetensors",
        components: {
          vae: "/models/flux2_ae.safetensors",
          llm: "/models/gpt-oss-20b.gguf",
        },
        runtime,
      });
      expect(result.missing).toContain("外部 Tokenizer（--tokenizer，tokenizer.json）");
    }

    // 其他家族不强制，也不受空值影响。
    const flux = buildLaunchConfig({
      family: "flux",
      modelPath: "/models/flux1-dev.safetensors",
      components: {
        vae: "/models/ae.sft",
        clip_l: "/models/clip_l.safetensors",
        t5xxl: "/models/t5xxl.safetensors",
      },
      runtime,
    });
    expect(flux.missing).toEqual([]);
    expect(flux.args.tokenizer).toBeUndefined();
  });

  it("passes SageAttention and conditioning cache only when configured", () => {
    const off = buildLaunchConfig({
      family: "flux",
      modelPath: "/models/flux1-dev.safetensors",
      components: {
        vae: "/models/ae.sft",
        clip_l: "/models/clip_l.safetensors",
        t5xxl: "/models/t5xxl.safetensors",
      },
      runtime,
    });
    expect(off.args["sage-attn"]).toBeUndefined();
    expect(off.args["conditioning-cache-size"]).toBeUndefined();

    const on = buildLaunchConfig({
      family: "flux",
      modelPath: "/models/flux1-dev.safetensors",
      components: {
        vae: "/models/ae.sft",
        clip_l: "/models/clip_l.safetensors",
        t5xxl: "/models/t5xxl.safetensors",
      },
      runtime: { ...runtime, sageAttn: true, conditioningCacheSize: "8" },
    });
    expect(on.args["sage-attn"]).toBe(true);
    // 上游按整数解析，Number 化后再传避免传成带引号的字符串。
    expect(on.args["conditioning-cache-size"]).toBe(8);
    expect(on.missing).toEqual([]);

    const bad = buildLaunchConfig({
      family: "flux",
      modelPath: "/models/flux1-dev.safetensors",
      components: {
        vae: "/models/ae.sft",
        clip_l: "/models/clip_l.safetensors",
        t5xxl: "/models/t5xxl.safetensors",
      },
      runtime: { ...runtime, conditioningCacheSize: "-1" },
    });
    expect(bad.args["conditioning-cache-size"]).toBeUndefined();
    expect(bad.missing).toContain(
      "条件缓存大小（--conditioning-cache-size，非负整数）"
    );
  });

  it("requires an explicit PiD VAE format even when the filename has a hint", () => {
    const missing = buildLaunchConfig({
      family: "pid",
      modelPath: "/models/pid_flux2_512_to_2048.safetensors",
      components: { vae: "/models/ae.sft", llm: "/models/gemma.safetensors" },
      runtime,
    });
    expect(missing.missing).toContain("VAE 格式（--vae-format）");
    expect(missing.args["vae-format"]).toBeUndefined();
  });

  // 上游对除 FakeVAE 家族外的所有版本都会构建 TAE（stable-diffusion.cpp
  // create_tae），MiniMax-H3 自 #1874（taeh3）起也支持。
  // Z-Image L2P（上游 #2075）同样走 FakeVAE：它的 latent 就是 RGB 像素，
  // TAE 分支被 FakeVAE 抢先，给 TAE 只会白读权重。
  it("offers an optional TAE component for every non-FakeVAE family", () => {
    const fakeVae = [
      "chroma-radiance",
      "hidream",
      "minit2i",
      "sensenova-u1",
      "zimage-l2p",
    ];
    for (const [family, config] of Object.entries(FAMILY_CONFIG)) {
      const tae = config.fields.filter((field) => field.arg === "taesd");
      if (fakeVae.includes(family)) {
        expect(tae, `${family} 走 FakeVAE，不应暴露 TAE`).toHaveLength(0);
        continue;
      }
      expect(tae, `${family} 缺少 TAE 组件`).toHaveLength(1);
      expect(tae[0].required, `${family} 的 TAE 必须是可选项`).toBe(false);
      expect(tae[0].cat).toBe("taesd");
      expect(tae[0].description, `${family} 的 TAE 缺少权重说明`).toBeTruthy();
    }
  });

  // TAE 权重说明按家族分组硬编码，家族名写错会静默退回通用文案——这里钉住。
  it("keeps the TAE weight hints distinct per latent space", () => {
    const hints = new Map<string, string>();
    for (const [family, config] of Object.entries(FAMILY_CONFIG)) {
      const tae = config.fields.find((field) => field.arg === "taesd");
      if (tae?.description) hints.set(family, tae.description);
    }
    expect(hints.get("sd")).toMatch(/taesd（SD 1\.x/);
    expect(hints.get("sdxl")).toMatch(/taesdxl/);
    expect(hints.get("sd3")).toMatch(/taesd3/);
    expect(hints.get("flux")).toMatch(/taef1/);
    expect(hints.get("kontext")).toMatch(/taef1/);
    expect(hints.get("flux2")).toMatch(/Flux\.2/);
    expect(hints.get("wan-t2v")).toMatch(/taew2_1/);
    expect(hints.get("qwen-image")).toMatch(/taew2_1/);
    // Wan2.2-TI2V-5B 用的是 taew2_2，与其余 Wan 不同（上游 docs/taesd.md）。
    expect(hints.get("wan-ti2v")).toMatch(/taew2_2/);
    expect(hints.get("hunyuan-video")).toMatch(/HunyuanVideo/);
    expect(hints.get("ltx")).toMatch(/LTX-AV/);
    expect(hints.get("ltx25")).toMatch(/LTX-AV/);
    expect(hints.get("minimax-h3-fl2va")).toMatch(/taeh3/);
    expect(hints.get("minimax-h3-ref2va")).toMatch(/taeh3/);
    // PiD 的 latent 随 --vae-format 变，不能给单一权重名。
    expect(hints.get("pid")).toMatch(/--vae-format/);
    // 未分组的家族拿到通用文案，而不是某个具体权重名。
    expect(hints.get("custom")).toMatch(/按主模型 latent 空间/);
  });

  // 上游 #1893 / docs/ltx2.md：LTX-2.5 的 Gemma 4 文本编码器内置文本投影，
  // --embeddings-connectors 只服务于 LTX-2.3，故 ltx25 不把它列为必需。
  it("requires embeddings connectors for LTX-2.3 but not LTX-2.5", () => {
    const ltx25 = buildLaunchConfig({
      family: "ltx25",
      modelPath: "/models/ltx-2.5-22b-dev-transformer-Q8_0.gguf",
      components: {
        vae: "/models/ltx-2.5-video-vae-conv-bf16.safetensors",
        audio_vae: "/models/ltx-2.5-audio-vae-bf16.safetensors",
        llm: "/models/gemma4-12b-with-proj-ltx-2.5-Q8_0.gguf",
      },
      runtime,
    });
    expect(ltx25.missing).toEqual([]);
    expect(ltx25.args["embeddings-connectors"]).toBeUndefined();

    const ltx = buildLaunchConfig({
      family: "ltx",
      modelPath: "/models/ltx-2.3-22b-dev-UD-Q4_K_M.gguf",
      components: {
        vae: "/models/ltx-2.3-video_vae.safetensors",
        audio_vae: "/models/ltx-2.3-audio_vae.safetensors",
        llm: "/models/gemma-3-12b-it.gguf",
      },
      runtime,
    });
    expect(ltx.missing).toContain("嵌入连接器");
  });

  // 上游 docs/ip_adapter.md：IP-Adapter 只支持 SD 1.5 / SDXL，且需要
  // --clip_vision（ViT-H/14）+ --ip-adapter 两个权重同时给出。
  it("passes IP-Adapter and its CLIP-Vision encoder for SD / SDXL", () => {
    for (const family of ["sd", "sdxl"]) {
      const result = buildLaunchConfig({
        family,
        modelPath: "/models/base.safetensors",
        components: {
          clip_vision: "/models/clip_vision_h.safetensors",
          "ip-adapter": "/models/ip-adapter-plus_sd15.safetensors",
        },
        runtime,
      });

      expect(result.missing).toEqual([]);
      expect(result.args).toEqual(
        expect.objectContaining({
          clip_vision: "/models/clip_vision_h.safetensors",
          "ip-adapter": "/models/ip-adapter-plus_sd15.safetensors",
        })
      );
    }
  });

  it("exposes IP-Adapter only where upstream supports it", () => {
    for (const [family, config] of Object.entries(FAMILY_CONFIG)) {
      const hasIpAdapter = config.fields.some((f) => f.arg === "ip-adapter");
      // custom 家族按设计只做手动配置，其余非 SD/SDXL 家族不应出现该组件。
      expect(hasIpAdapter, `${family}`).toBe(family === "sd" || family === "sdxl");
    }
  });

  it("passes the selected TAE weights as --taesd", () => {
    const result = buildLaunchConfig({
      family: "wan-ti2v",
      modelPath: "/models/wan2.2_ti2v_5B.safetensors",
      components: {
        vae: "/models/wan2.2_vae.safetensors",
        t5xxl: "/models/umt5_xxl.safetensors",
        taesd: "/models/taew2_2.safetensors",
      },
      runtime,
    });

    expect(result.missing).toEqual([]);
    expect(result.args.taesd).toBe("/models/taew2_2.safetensors");
  });

  it("keeps startup GO/NO-GO green without a TAE file", () => {
    const result = buildLaunchConfig({
      family: "minimax-h3-fl2va",
      modelPath: "/models/minimax_h3_fl2va-Q4_K_M.gguf",
      components: {
        vae: "/models/minimax_h3_video_vae_fp16.safetensors",
        llm: "/models/qwen3vl_32b.gguf",
      },
      runtime,
    });

    expect(result.missing).toEqual([]);
    expect(result.args.taesd).toBeUndefined();
  });

  it("builds HunyuanVideo's split components and video mode", () => {
    const result = buildLaunchConfig({
      family: "hunyuan-video",
      modelPath: "/models/hunyuanvideo1.5_720p_t2v.safetensors",
      components: {
        vae: "/models/hunyuanvideo15_vae.safetensors",
        llm: "/models/qwen_2.5_vl_7b.safetensors",
        t5xxl: "/models/byt5_small_glyphxl.safetensors",
      },
      runtime,
    });

    expect(result.missing).toEqual([]);
    expect(result.mode).toBe("vid_gen");
    expect(result.args).toEqual(
      expect.objectContaining({
        "diffusion-model": "/models/hunyuanvideo1.5_720p_t2v.safetensors",
        vae: "/models/hunyuanvideo15_vae.safetensors",
        llm: "/models/qwen_2.5_vl_7b.safetensors",
        t5xxl: "/models/byt5_small_glyphxl.safetensors",
        "diffusion-fa": true,
      })
    );
  });

  it("builds MiniMax-H3 FL2VA component arguments in video mode", () => {
    const result = buildLaunchConfig({
      family: "minimax-h3-fl2va",
      modelPath: "/models/minimax_h3_fl2va-Q4_K_M.gguf",
      components: {
        vae: "/models/minimax_h3_video_vae_fp16.safetensors",
        audio_vae: "/models/minimax_h3_audio_vae_fp32.safetensors",
        llm: "/models/qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
      },
      runtime,
    });

    expect(result.missing).toEqual([]);
    expect(result.mode).toBe("vid_gen");
    expect(result.args).toEqual(
      expect.objectContaining({
        "diffusion-model": "/models/minimax_h3_fl2va-Q4_K_M.gguf",
        vae: "/models/minimax_h3_video_vae_fp16.safetensors",
        "audio-vae": "/models/minimax_h3_audio_vae_fp32.safetensors",
        llm: "/models/qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
        "diffusion-fa": true,
      })
    );
  });

  it("treats the MiniMax-H3 audio VAE as optional but requires the rest", () => {
    const withoutAudio = buildLaunchConfig({
      family: "minimax-h3-fl2va",
      modelPath: "/models/minimax_h3_fl2va-Q4_K_M.gguf",
      components: {
        vae: "/models/minimax_h3_video_vae_fp16.safetensors",
        llm: "/models/qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
      },
      runtime,
    });
    expect(withoutAudio.missing).toEqual([]);
    expect(withoutAudio.args["audio-vae"]).toBeUndefined();

    const withoutVae = buildLaunchConfig({
      family: "minimax-h3-fl2va",
      modelPath: "/models/minimax_h3_fl2va-Q4_K_M.gguf",
      components: { llm: "/models/qwen3vl_32b_minimax_h3-Q4_K_M.gguf" },
      runtime,
    });
    expect(withoutVae.missing).toContain("视频 VAE");
  });

  it("treats MiniMax-H3 Ref2VA as half-supported with ref_images required", () => {
    const ref2va = FAMILY_CONFIG["minimax-h3-ref2va"];
    // 半支持：不再整族封锁，参考图像为 vid_gen 必需输入。
    expect(ref2va.unsupported).toBeUndefined();
    expect(ref2va.requiredInputsByMode).toEqual({ vid_gen: ["ref_images"] });
    expect(ref2va.mode).toBe("vid");
    // FL2VA 无需参考输入。
    expect(FAMILY_CONFIG["minimax-h3-fl2va"].requiredInputsByMode).toBeUndefined();
    // 官方推荐参数（docs/minimax_h3.md）：864×480、56 帧、24 fps、cfg 1.0。
    expect(FAMILY_CONFIG["minimax-h3-fl2va"].genDefaults).toEqual(
      expect.objectContaining({
        width: 864,
        height: 480,
        video_frames: 56,
        fps: 24,
      })
    );
  });

  it("accepts every --max-vram spelling std::stof accepts", () => {
    for (const spec of [
      "6",
      "6.5",
      "-2",
      "+2",
      ".5",
      "1e3",
      "0x10",
      "cuda0=6e0,vulkan0=.5",
      // 上游 MaxVramAssignment::parse：混合全局预算 + 设备段、空段、通配键。
      "6,cuda0=4",
      "6,",
      "cuda0=6,,vulkan0=4",
      "*=6",
      "all=6",
      "default=6",
      // C99 十六进制浮点的完整形状:无整数部分 / 尾点（审查 L6）。
      "0x.8p1",
      "0x1.",
    ]) {
      expect(validateMaxVramSpec(spec)).toBeNull();
    }
    for (const spec of [
      "inf",
      "nan",
      "cuda0=",
      "=6",
      "cuda0=abc",
      // 形状合法但溢出为 inf,上游 isfinite 会拒绝——预校验同步拦（审查 L6）。
      "1e999",
      "0x1p9999",
      "cuda0=1e999",
    ]) {
      expect(validateMaxVramSpec(spec)).not.toBeNull();
    }
  });

  it("passes --max-vram through for every supported spec shape", () => {
    for (const maxVram of ["6", "6.5", "0", "-2", "cuda0=6,vulkan0=4"]) {
      const result = buildLaunchConfig({
        family: "hidream",
        modelPath: "/models/hidream.safetensors",
        components: {},
        runtime: { ...runtime, maxVram },
      });
      expect(result.args["max-vram"]).toBe(maxVram);
    }
  });

  it("omits --max-vram when unset or blank", () => {
    for (const maxVram of ["", "   ", undefined]) {
      const result = buildLaunchConfig({
        family: "hidream",
        modelPath: "/models/hidream.safetensors",
        components: {},
        runtime: { ...runtime, maxVram },
      });
      expect(result.args).not.toHaveProperty("max-vram");
    }
  });

  it("infers every PiD VAE layout variant", () => {
    expect(inferPidVaeFormat("pid_flux1_512_to_2048.safetensors")).toBe("flux");
    expect(inferPidVaeFormat("pid_sd3_512_to_2048.safetensors")).toBe("sd3");
    expect(inferPidVaeFormat("pid_flux2_512_to_2048.safetensors")).toBe("flux2");
    expect(inferPidVaeFormat("pid_qwen_image_512_to_2048.safetensors")).toBe("wan");
    expect(inferPidVaeFormat("/models/qwen/pid_flux1_512_to_2048.safetensors")).toBe(
      "flux"
    );
    expect(inferPidVaeFormat("pid_unknown.safetensors")).toBe("");
  });

  it("uses AnimateDiff defaults for video without changing image defaults", () => {
    const image = familyDefaults(FAMILY_CONFIG.sd, "img_gen");
    const video = familyDefaults(FAMILY_CONFIG.sd, "vid_gen");

    expect(image).toEqual(expect.objectContaining({ width: 512, height: 512 }));
    expect(video).toEqual(
      expect.objectContaining({
        width: 512,
        height: 512,
        video_frames: 16,
        fps: 8,
        strength: 0.75,
      })
    );
    expect((video?.sample_params as Record<string, unknown>).guidance).toEqual(
      expect.objectContaining({ txt_cfg: 8 })
    );
  });

  it("persists mode presets while retaining prompts and recovering malformed storage", () => {
    localStorage.setItem(
      "sdcpp:params:vid_gen",
      JSON.stringify({ prompt: "keep this", negative_prompt: "avoid that", width: 1 })
    );
    localStorage.setItem("sdcpp:params:img_gen", "{malformed");

    persistFamilyDefaults(FAMILY_CONFIG.sd);

    const video = JSON.parse(localStorage.getItem("sdcpp:params:vid_gen") || "{}");
    const image = JSON.parse(localStorage.getItem("sdcpp:params:img_gen") || "{}");
    expect(video).toEqual(
      expect.objectContaining({ prompt: "keep this", negative_prompt: "avoid that", video_frames: 16 })
    );
    expect(image).toEqual(expect.objectContaining({ width: 512, height: 512 }));
  });

  it("reports PiD's required reference image only for image generation", () => {
    const empty = {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: [],
      controlFrames: [],
    };
    expect(missingRequiredInputs(FAMILY_CONFIG.pid, "img_gen", empty)).toEqual(["参考图片"]);
    expect(missingRequiredInputs(FAMILY_CONFIG.pid, "vid_gen", empty)).toEqual([]);
    expect(
      missingRequiredInputs(FAMILY_CONFIG.pid, "img_gen", {
        ...empty,
        refImages: ["data:image/png;base64,abc"],
      })
    ).toEqual([]);
  });
});

// PixArt-α/Σ（上游 #2047）与 Ming-Image（上游 #2063）：家族 id 必须与 Rust 侧
// detect_family 的返回值一致，否则模型会静默掉进"自定义"、丢组件检查。
describe("newly supported families", () => {
  it("registers PixArt and Ming-Image under the ids family.rs returns", () => {
    for (const family of ["pixart-sigma", "pixart-alpha", "ming-image"]) {
      expect(FAMILY_CONFIG[family], `${family} 缺少家族配置`).toBeTruthy();
    }
  });

  it("aligns PixArt and Ming-Image dimensions up to a multiple of 16", () => {
    for (const family of ["pixart-sigma", "pixart-alpha", "ming-image"]) {
      expect(alignSizeUp(family, 1024)).toBe(1024);
      // 通用预设里的 1080 会被上游真实改成 1088，界面必须显示同一结果。
      expect(alignSizeUp(family, 1080)).toBe(1088);
    }
  });

  it("keeps the TAE hint on each model's own latent space", () => {
    const hint = (family: string) =>
      FAMILY_CONFIG[family].fields.find((field) => field.arg === "taesd")
        ?.description || "";
    expect(hint("pixart-sigma")).toMatch(/taesdxl/);
    expect(hint("pixart-alpha")).toMatch(/taesd（/);
    expect(hint("ming-image")).toMatch(/自己的 VAE/);
  });

  // T5 词表内嵌在 PixArt 里；错误地要求外部 tokenizer 会挡住本该能启动的模型。
  it("does not ask PixArt for an external tokenizer", () => {
    expect(familyNeedsExternalTokenizer("pixart-sigma")).toBe(false);
    expect(familyNeedsExternalTokenizer("pixart-alpha")).toBe(false);
    const config = buildLaunchConfig({
      family: "pixart-sigma",
      modelPath: "/models/pixart_sigma_xl2_1024_ms.safetensors",
      components: {
        t5xxl: "/models/t5xxl.safetensors",
        vae: "/models/pixart_vae.safetensors",
      },
      runtime,
    });
    expect(config.missing).toEqual([]);
    expect(config.args.t5xxl).toBe("/models/t5xxl.safetensors");
  });

  // Ming-Image 缺少 Ling tokenizer 时上游在建文本编码器阶段直接抛错，
  // 检查单必须提前拦下。
  it("requires the external Ling tokenizer for Ming-Image", () => {
    expect(familyNeedsExternalTokenizer("ming-image")).toBe(true);
    const components = {
      llm: "/models/ming_image_0.1_ling_mini_2.0_bf16.safetensors",
      vae: "/models/ming_image_vae_bf16.safetensors",
    };
    const without = buildLaunchConfig({
      family: "ming-image",
      modelPath: "/models/ming_image_0.1_design_bf16.safetensors",
      components,
      runtime,
    });
    expect(without.missing).toContain(
      "外部 Tokenizer（--tokenizer，tokenizer.json）"
    );
    const withTokenizer = buildLaunchConfig({
      family: "ming-image",
      modelPath: "/models/ming_image_0.1_design_bf16.safetensors",
      components,
      runtime: { ...runtime, tokenizer: "/models/tokenizer.json" },
    });
    expect(withTokenizer.missing).toEqual([]);
    expect(withTokenizer.args.tokenizer).toBe("/models/tokenizer.json");
    expect(withTokenizer.args["diffusion-fa"]).toBe(true);
  });

  // --tokenizer 的槽位写法由上游 TokenizerConfig 解析：Ming 的文本编码器只从
  // MAIN 槽取词表，只填 clip-l= 会一路显示"就绪"，直到启动建编码器才抛错。
  it("rejects a tokenizer spec without the main slot", () => {
    const components = {
      llm: "/models/ming_image_0.1_ling_mini_2.0_bf16.safetensors",
      vae: "/models/ming_image_vae_bf16.safetensors",
    };
    const clipOnly = buildLaunchConfig({
      family: "ming-image",
      modelPath: "/models/ming_image_0.1_design_bf16.safetensors",
      components,
      runtime: { ...runtime, tokenizer: "clip-l=/models/tokenizer.json" },
    });
    expect(clipOnly.missing).toContain(
      "外部 Tokenizer 的 main 槽（如 main=tokenizer.json）"
    );

    // 显式 main= 与多槽写法都算配置了主槽。
    for (const spec of [
      "main=/models/tokenizer.json",
      "main=/models/tokenizer.json,clip-l=/models/t5.json",
    ]) {
      const ok = buildLaunchConfig({
        family: "ming-image",
        modelPath: "/models/ming_image_0.1_design_bf16.safetensors",
        components,
        runtime: { ...runtime, tokenizer: spec },
      });
      expect(ok.missing).toEqual([]);
    }
  });

  it("rejects malformed tokenizer slot specs for every family", () => {
    expect(validateTokenizerSpec("/models/tokenizer.json")).toBeNull();
    expect(validateTokenizerSpec("main=/a.json,clip-l=/b.json")).toBeNull();
    expect(validateTokenizerSpec("bogus=/a.json")).toMatch(/未知槽位/);
    expect(validateTokenizerSpec("main=")).toMatch(/缺少路径/);
    expect(validateTokenizerSpec("main=/a.json,main=/b.json")).toMatch(/重复指定/);
    // 有 = 却缺 = 的段会被上游直接抛错。
    expect(validateTokenizerSpec("main=/a.json,/b.json")).toMatch(/缺少 =/);
    expect(hasMainTokenizerSlot("/a.json")).toBe(true);
    expect(hasMainTokenizerSlot("clip-l=/a.json")).toBe(false);
    expect(hasMainTokenizerSlot("")).toBe(false);
  });

  // 上游 capabilities 对图片模式通用地报 ref_images=true，而 Ming 的实现
  // 明确拒绝参考图——必须按家族关掉并过滤旧图。
  it("disables and filters reference images for Ming-Image", () => {
    const features = applyFamilyFeatureLimits(
      { ref_images: true, init_image: true } as Features,
      FAMILY_CONFIG["ming-image"]
    );
    expect(features.ref_images).toBe(false);
    expect(features.init_image).toBe(true);

    const images: GenImages = {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: ["data:image/png;base64,abc"],
      controlFrames: [],
    };
    expect(
      filterFamilyInputs(images, FAMILY_CONFIG["ming-image"]).refImages
    ).toEqual([]);
  });

  // 上游 #2075：Z-Image L2P 用 16×16 patch + 小型卷积解码器取代 VAE，
  // 家族 id 必须与 family.rs 的返回值一致，且不能出现 VAE / TAE 槽位
  // （给了也只会白读文件，FakeVAE 分支优先）。
  it("registers Z-Image L2P without VAE or TAE components", () => {
    const config = FAMILY_CONFIG["zimage-l2p"];
    expect(config).toBeTruthy();
    const args = config.fields.map((field) => field.arg);
    expect(args).toContain("diffusion-model");
    expect(args).toContain("llm");
    expect(args).not.toContain("vae");
    expect(args).not.toContain("taesd");

    const built = buildLaunchConfig({
      family: "zimage-l2p",
      modelPath: "/models/z_image_l2p_f16.safetensors",
      components: {
        llm: "/models/qwen_3_4b.safetensors",
        vae: "/models/stale-vae.safetensors",
        taesd: "/models/stale-tae.safetensors",
      },
      runtime,
    });
    expect(built.missing).toEqual([]);
    expect(built.args.vae).toBeUndefined();
    expect(built.args.taesd).toBeUndefined();
    expect(built.args["diffusion-fa"]).toBe(true);
  });

  it("aligns Z-Image L2P to 16 and keeps the upstream reference defaults", () => {
    // FakeVAE 缩放 1 × DiT 下采样 16：1080 会被引擎改成 1088，720 无需变化。
    expect(alignSizeUp("zimage-l2p", 1080)).toBe(1088);
    expect(alignSizeUp("zimage-l2p", 720)).toBe(720);

    const defaults = familyDefaults(FAMILY_CONFIG["zimage-l2p"], "img_gen");
    expect(defaults?.sample_params).toMatchObject({
      sample_steps: 30,
      sample_method: "euler",
      guidance: { txt_cfg: 2.0 },
    });
  });

  // 上游 runner 对非空参考潜变量直接报错，capabilities 却是协议级通用值，
  // 必须按家族关掉，避免别的模型残留的参考图被提交。
  it("disables and filters reference images for Z-Image L2P", () => {
    const features = applyFamilyFeatureLimits(
      { ref_images: true, init_image: true } as Features,
      FAMILY_CONFIG["zimage-l2p"]
    );
    expect(features.ref_images).toBe(false);
    // img2img 静态可达（FakeVAE 的 encode 是恒等映射），不要一起禁掉。
    expect(features.init_image).toBe(true);

    const images: GenImages = {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: ["data:image/png;base64,abc"],
      controlFrames: [],
    };
    expect(
      filterFamilyInputs(images, FAMILY_CONFIG["zimage-l2p"]).refImages
    ).toEqual([]);
  });
});

// 上游 video.cpp：MiniMax-H3 一旦给了参考条件（参考图/视频/音频），就不能
// 再给首帧或尾帧，生成阶段直接判失败。能力广告看不出这条，靠家族声明拦截。
describe("exclusive family inputs", () => {
  const empty: GenImages = {
    initImage: null,
    maskImage: null,
    controlImage: null,
    ipAdapterImage: null,
    endImage: null,
    refImages: [],
    controlFrames: [],
  };

  it("flags MiniMax-H3 references combined with keyframes", () => {
    const conflict: GenImages = {
      ...empty,
      refImages: ["data:image/png;base64,ref"],
      initImage: "data:image/png;base64,init",
    };
    expect(
      exclusiveInputConflicts(FAMILY_CONFIG["minimax-h3-ref2va"], conflict)
    ).toEqual(["MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用"]);
    expect(
      exclusiveInputConflicts(FAMILY_CONFIG["minimax-h3-fl2va"], conflict)
    ).toEqual(["MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用"]);

    // 参考图 + 结束帧同样是上游拒绝的组合；两条二元规则同时命中只报一次。
    expect(
      exclusiveInputConflicts(FAMILY_CONFIG["minimax-h3-ref2va"], {
        ...empty,
        refImages: ["data:image/png;base64,ref"],
        endImage: "data:image/png;base64,end",
      })
    ).toEqual(["MiniMax-H3 的参考图不能与初始图片 / 结束帧同时使用"]);

    // 只给参考图（Ref2VA 的正常用法）与只给首尾帧（FL2VA 的正常用法）都不算冲突。
    expect(
      exclusiveInputConflicts(FAMILY_CONFIG["minimax-h3-ref2va"], {
        ...empty,
        refImages: ["data:image/png;base64,ref"],
      })
    ).toEqual([]);
    expect(
      exclusiveInputConflicts(FAMILY_CONFIG["minimax-h3-fl2va"], {
        ...empty,
        initImage: "data:image/png;base64,init",
        endImage: "data:image/png;base64,end",
      })
    ).toEqual([]);
  });

  it("stays silent for families without an exclusive declaration", () => {
    const both: GenImages = {
      ...empty,
      refImages: ["data:image/png;base64,ref"],
      initImage: "data:image/png;base64,init",
    };
    expect(exclusiveInputConflicts(FAMILY_CONFIG.flux, both)).toEqual([]);
    expect(exclusiveInputConflicts(FAMILY_CONFIG.sd, both)).toEqual([]);
    expect(exclusiveInputConflicts(undefined, both)).toEqual([]);
  });
});
