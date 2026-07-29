import { beforeEach, describe, expect, it } from "vitest";
import { alignVideoFrames, FAMILY_CONFIG } from "../../config/families";
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

const runtime: LaunchRuntime = {
  backend: "cuda0",
  refImagePreset: "",
  vaeFormat: "",
  extraArgs: "",
  offloadCpu: false,
  quantType: "",
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
