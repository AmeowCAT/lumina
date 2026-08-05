import { beforeEach, describe, expect, it } from "vitest";
import {
  alignSizeUp,
  alignVideoFrames,
  FAMILY_CONFIG,
  VIDEO_FRAME_MAX,
  VIDEO_FRAME_PRESETS,
} from "../../config/families";
import type { LaunchRuntime } from "../launchConfig";
import {
  buildLaunchConfig,
  familyDefaults,
  inferPidVaeFormat,
  missingRequiredInputs,
  persistFamilyDefaults,
} from "../launchConfig";

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
    expect(alignVideoFrames("ltx", 33)).toBe(33);
    expect(alignVideoFrames("ltx", 34)).toBe(33);
    // 4n+1 会得到 37；8n+1 必须回落到 33。
    expect(alignVideoFrames("ltx", 40)).toBe(33);
    expect(alignVideoFrames("ltx", 41)).toBe(41);
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

const runtime: LaunchRuntime = {
  backend: "cuda0",
  refImagePreset: "",
  vaeFormat: "",
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
      runtime: { ...runtime, vaeFormat: "flux" },
    });

    expect(result.missing).toEqual([]);
    expect(result.args).toEqual(
      expect.objectContaining({
        "diffusion-model": "/models/pid_flux1_512_to_2048.safetensors",
        vae: "/models/ae.sft",
        llm: "/models/gemma_2_2b.safetensors",
        "diffusion-fa": true,
        "vae-format": "flux",
      })
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

  it("marks MiniMax-H3 Ref2VA unsupported while FL2VA stays launchable", () => {
    expect(FAMILY_CONFIG["minimax-h3-fl2va"].unsupported).toBeUndefined();
    expect(FAMILY_CONFIG["minimax-h3-ref2va"].unsupported).toBeTruthy();
    expect(FAMILY_CONFIG["minimax-h3-fl2va"].mode).toBe("vid");
    expect(FAMILY_CONFIG["minimax-h3-ref2va"].mode).toBe("vid");
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
