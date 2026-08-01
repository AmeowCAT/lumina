import { describe, it, expect } from "vitest";
import {
  deepClone,
  deepMerge,
  extractApiError,
  fmtSize,
  b64ToBlobUrl,
  buildRequestBody,
  formatError,
  LINGBOT_PROMPT_TEMPLATE,
  modelFileOptionLabel,
  sdcppMetadataToGenParams,
  validateLingbotPrompt,
} from "../utils";
import type { GenImages, GenParams } from "../../types";

describe("extractApiError", () => {
  // sd-server 的 HTTP 错误响应里 `error` 是字符串（routes_sdcpp.cpp），
  // 早期按 `.error.message` 读会把所有失败原因吞成 "错误 400"。
  it("reads the string-shaped HTTP error body", () => {
    expect(
      extractApiError({ error: "invalid generation parameters" }, 400)
    ).toBe("invalid generation parameters");
    expect(extractApiError({ error: "job queue is full" }, 429)).toBe(
      "job queue is full"
    );
  });

  it("appends the detail message for invalid json", () => {
    expect(
      extractApiError(
        { error: "invalid json", message: "unexpected token" },
        400
      )
    ).toBe("invalid json：unexpected token");
  });

  // Job 对象内的 error 是 {code,message} 对象（async_jobs.cpp）——形状不同。
  it("reads the object-shaped job error", () => {
    expect(
      extractApiError({
        error: { code: "generation_failed", message: "generate_image returned empty results" },
      })
    ).toBe("generate_image returned empty results（generation_failed）");
  });

  it("falls back to the status code when nothing is parseable", () => {
    expect(extractApiError(null, 500)).toBe("错误 500");
    expect(extractApiError({}, 400)).toBe("错误 400");
    expect(extractApiError({ error: "" }, 400)).toBe("错误 400");
    expect(extractApiError(undefined)).toBe("未知错误");
  });
});

describe("deepClone", () => {
  it("clones a flat object", () => {
    const o = { a: 1, b: "x" };
    const c = deepClone(o);
    expect(c).toEqual(o);
    expect(c).not.toBe(o);
  });

  it("clones nested objects", () => {
    const o = { a: { b: [1, 2] } };
    const c = deepClone(o);
    expect(c).toEqual(o);
    expect(c.a).not.toBe(o.a);
    expect(c.a.b).not.toBe(o.a.b);
  });

  it("handles null returns null", () => {
    expect(deepClone(null)).toBeNull();
  });

  it("handles undefined by throwing", () => {
    expect(() => deepClone(undefined)).toThrow();
  });
});

describe("formatError", () => {
  it("renders structured Tauri errors without [object Object]", () => {
    expect(formatError({ code: "save_failed", message: "磁盘空间不足" })).toBe(
      "磁盘空间不足（save_failed）"
    );
  });
});

describe("deepMerge", () => {
  it("overwrites primitive values", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("recursively merges nested objects", () => {
    const t = { a: { b: 1, c: 2 } };
    const s = { a: { b: 3 } };
    expect(deepMerge(t, s)).toEqual({ a: { b: 3, c: 2 } });
  });

  it("replaces arrays instead of concatenating", () => {
    const t = { arr: [1, 2] };
    const s = { arr: [3] };
    expect(deepMerge(t, s)).toEqual({ arr: [3] });
  });

  it("adds new keys", () => {
    expect(deepMerge({ a: 1 } as object, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe("fmtSize", () => {
  it("formats GB", () => {
    expect(fmtSize(2048)).toBe("2.0 GB");
  });

  it("formats MB", () => {
    expect(fmtSize(512)).toBe("512 MB");
    expect(fmtSize(1)).toBe("1 MB");
  });

  it("formats KB", () => {
    expect(fmtSize(0.5)).toBe("512 KB");
    expect(fmtSize(0.001)).toBe("1 KB");
  });
});

describe("LingBot prompt helpers", () => {
  it("accepts the built-in JSON template", () => {
    expect(validateLingbotPrompt(LINGBOT_PROMPT_TEMPLATE)).toBeNull();
  });

  it("keeps plain text prompts compatible", () => {
    expect(validateLingbotPrompt("a cat walking through a garden")).toBeNull();
  });

  it("reports malformed JSON prompts", () => {
    expect(validateLingbotPrompt('{"caption":')).toMatch(/JSON 格式无效/);
  });
});

describe("modelFileOptionLabel", () => {
  it("marks safetensors indexes without marking ordinary files", () => {
    const base = {
      stem: "model",
      path: "/models/model",
      relPath: "model",
      sizeMb: 2048,
      dir: "/models",
      category: "model",
    };
    expect(
      modelFileOptionLabel({
        ...base,
        name: "model.safetensors.index.json",
        ext: "safetensors.index.json",
      })
    ).toBe("model.safetensors.index.json [分片索引] (2.0 GB)");
    expect(
      modelFileOptionLabel({
        ...base,
        name: "model.safetensors",
        ext: "safetensors",
      })
    ).toBe("model.safetensors (2.0 GB)");
  });
});

describe("b64ToBlobUrl", () => {
  it("creates a blob URL from base64", () => {
    const b64 = btoa("hello");
    const url = b64ToBlobUrl(b64, "text/plain");
    expect(url).toMatch(/^blob:/);
    URL.revokeObjectURL(url);
  });

  it("strips data URL prefix", () => {
    const b64 = btoa("world");
    const url = b64ToBlobUrl(`data:text/plain;base64,${b64}`, "text/plain");
    expect(url).toMatch(/^blob:/);
    URL.revokeObjectURL(url);
  });
});

describe("buildRequestBody", () => {
  const baseParams: GenParams = {
    width: 512,
    height: 512,
    seed: 42,
    sample_params: {
      sample_method: "euler",
      sample_steps: 20,
      scheduler: "discrete",
      guidance: { txt_cfg: 7, distilled_guidance: 0 },
    },
  };

  it("includes required fields for img_gen", () => {
    const body = buildRequestBody("img_gen", baseParams, {} as GenImages);
    expect(body.prompt).toBe("");
    expect(body.width).toBe(512);
    expect(body.height).toBe(512);
    expect(body.seed).toBe(42);
    expect(body.batch_count).toBe(1);
    expect(body.output_format).toBeUndefined();
  });

  // capabilities 把"未设置"序列化为 "default"（routes_sdcpp.cpp
  // capability_*_name），请求体应省略而不是透传，让服务端用模型默认。
  it("omits default sentinels for sample_method/scheduler", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "default",
        scheduler: "default",
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    const sp = body.sample_params as Record<string, unknown>;
    expect(sp.sample_method).toBeUndefined();
    expect(sp.scheduler).toBeUndefined();
  });

  it("omits default sentinels in high_noise_sample_params", () => {
    const p: GenParams = {
      ...baseParams,
      high_noise_sample_params: {
        sample_method: "default",
        sample_steps: 8,
        scheduler: "default",
        guidance: { txt_cfg: 3.5 },
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    const hn = body.high_noise_sample_params as Record<string, unknown>;
    expect(hn.sample_method).toBeUndefined();
    expect(hn.scheduler).toBeUndefined();
  });

  it("includes Qwen Image Layered layer count for img_gen", () => {
    const p: GenParams = { ...baseParams, qwen_image_layers: 5 };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.qwen_image_layers).toBe(5);
  });

  it("includes video fields for vid_gen", () => {
    const p: GenParams = { ...baseParams, video_frames: 24, fps: 30 };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    expect(body.video_frames).toBe(24);
    expect(body.fps).toBe(30);
    expect(body.batch_count).toBeUndefined();
  });

  it("keeps AnimateDiff strength and init image in vid_gen requests", () => {
    const body = buildRequestBody(
      "vid_gen",
      { ...baseParams, strength: 0.75, video_frames: 16 },
      {
        initImage: "data:image/png;base64,init",
        maskImage: null,
        controlImage: null,
        ipAdapterImage: null,
        endImage: null,
        refImages: [],
        controlFrames: [],
      }
    );
    expect(body.strength).toBe(0.75);
    expect(body.init_image).toBe("data:image/png;base64,init");
  });

  it("omits clip_skip when -1", () => {
    const p: GenParams = { ...baseParams, clip_skip: -1 };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.clip_skip).toBeUndefined();
  });

  it("includes clip_skip when set", () => {
    const p: GenParams = { ...baseParams, clip_skip: 2 };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.clip_skip).toBe(2);
  });

  it("includes img_cfg in guidance when set", () => {
    const p = deepClone(baseParams);
    p.sample_params.guidance.img_cfg = 5;
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    const sp = body.sample_params as { guidance?: { img_cfg?: number } };
    expect(sp.guidance?.img_cfg).toBe(5);
  });

  it("omits img_cfg when not set", () => {
    const body = buildRequestBody("img_gen", baseParams, {} as GenImages);
    const sp = body.sample_params as { guidance?: { img_cfg?: number } };
    expect(sp.guidance?.img_cfg).toBeUndefined();
  });

  it("filters empty-path loras", () => {
    const p: GenParams = { ...baseParams, lora: [{ path: "" }, { path: "/test.safetensors" }] };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    const loras = body.lora as { path: string }[];
    expect(loras).toHaveLength(1);
    expect(loras[0].path).toBe("/test.safetensors");
  });

  it("includes hires when enabled", () => {
    const p: GenParams = { ...baseParams, hires: { enabled: true, upscaler: "Latent", steps: 20 } };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.hires).toEqual({ enabled: true, upscaler: "Latent", steps: 20 });
  });

  it("preserves complete Hunyuan VAE tiling parameters when enabled", () => {
    const p: GenParams = {
      ...baseParams,
      vae_tiling_params: {
        enabled: true,
        temporal_tiling: true,
        tile_size_x: 256,
        tile_size_y: 256,
        target_overlap: 0.5,
        rel_size_x: 0,
        rel_size_y: 0,
        extra_tiling_args: "",
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    expect(body.vae_tiling_params).toEqual(p.vae_tiling_params);
  });

  it("includes high_noise_sample_params for vid_gen", () => {
    const p: GenParams = {
      ...baseParams,
      high_noise_sample_params: {
        sample_method: "euler",
        sample_steps: 8,
        guidance: { txt_cfg: 3.5 },
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    expect(body.high_noise_sample_params).toBeDefined();
  });

  // 上游 #1834：beta 调度器经 sample_params.extra_sample_args 自定义 alpha/beta。
  it("sends beta scheduler alpha/beta via extra_sample_args", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        scheduler: "beta",
        beta_alpha: 0.8,
        beta_beta: 0.5,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "alpha=0.8,beta=0.5"
    );
  });

  it("omits extra_sample_args when beta values are unset", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: { ...baseParams.sample_params, scheduler: "beta" },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(
      (body.sample_params as Record<string, unknown>).extra_sample_args
    ).toBeUndefined();
  });

  it("does not send beta args for other schedulers", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        scheduler: "karras",
        beta_alpha: 0.8,
        beta_beta: 0.5,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(
      (body.sample_params as Record<string, unknown>).extra_sample_args
    ).toBeUndefined();
  });

  it("ignores non-positive beta args and trims float noise", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        scheduler: "beta",
        beta_alpha: 0,
        beta_beta: 0.6000000000000001,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "beta=0.6"
    );
  });

  it("sends beta args in high_noise_sample_params separately", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        scheduler: "beta",
        beta_alpha: 0.7,
      },
      high_noise_sample_params: {
        sample_method: "euler",
        sample_steps: 8,
        scheduler: "beta",
        beta_beta: 0.4,
        guidance: { txt_cfg: 3.5 },
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "alpha=0.7"
    );
    expect(
      (body.high_noise_sample_params as Record<string, unknown>)
        .extra_sample_args
    ).toBe("beta=0.4");
  });

  // 上游 #1824 将 IP-Adapter 纳入 img_gen schema；vid_gen 不接受这两个字段。
  it("sends ip_adapter fields only for img_gen", () => {
    const images = {
      ...({} as GenImages),
      ipAdapterImage: "data:image/png;base64,ip",
    };
    const p: GenParams = { ...baseParams, ip_adapter_strength: 0.6 };

    const img = buildRequestBody("img_gen", p, images);
    expect(img.ip_adapter_image).toBe("data:image/png;base64,ip");
    expect(img.ip_adapter_strength).toBe(0.6);

    const vid = buildRequestBody("vid_gen", p, images);
    expect(vid.ip_adapter_image).toBeUndefined();
    expect(vid.ip_adapter_strength).toBeUndefined();
  });

  it("defaults ip_adapter_strength to 1.0 for img_gen", () => {
    const body = buildRequestBody("img_gen", baseParams, {} as GenImages);
    expect(body.ip_adapter_strength).toBe(1.0);
  });

  // control_frames 是 vid_gen 的 VACE 条件帧，顺序即条件帧顺序。
  it("sends control_frames only for vid_gen and preserves order", () => {
    const frames = ["data:image/png;base64,a", "data:image/png;base64,b"];
    const images = { ...({} as GenImages), controlFrames: frames };

    const vid = buildRequestBody("vid_gen", baseParams, images);
    expect(vid.control_frames).toEqual(frames);

    const img = buildRequestBody("img_gen", baseParams, images);
    expect(img.control_frames).toBeUndefined();
  });

  it("passes through the full hires field set", () => {
    const p: GenParams = {
      ...baseParams,
      hires: {
        enabled: true,
        upscaler: "Latent",
        scale: 2,
        steps: 10,
        denoising_strength: 0.7,
        target_width: 2048,
        target_height: 1536,
        upscale_tile_size: 256,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.hires).toMatchObject({
      target_width: 2048,
      target_height: 1536,
      upscale_tile_size: 256,
    });
  });

  // 空 custom_sigmas 必须整个省略：上游只要该键存在就用它覆盖 sigma 表。
  it("omits an empty hires.custom_sigmas", () => {
    const p: GenParams = {
      ...baseParams,
      hires: { enabled: true, custom_sigmas: [] },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.hires).toBeDefined();
    expect("custom_sigmas" in (body.hires as object)).toBe(false);
  });

  it("keeps a non-empty hires.custom_sigmas", () => {
    const p: GenParams = {
      ...baseParams,
      hires: { enabled: true, custom_sigmas: [1.5, 0.8] },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.hires as { custom_sigmas?: number[] }).custom_sigmas).toEqual([
      1.5, 0.8,
    ]);
  });

  // 上游 validate 对长度 <2 的 custom_sigmas 直接拒绝（400 invalid
  // generation parameters），必须省略，不能透传。
  it("omits a single-value hires.custom_sigmas that upstream would reject", () => {
    const p: GenParams = {
      ...baseParams,
      hires: { enabled: true, custom_sigmas: [0.8] },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);

    expect("custom_sigmas" in (body.hires as object)).toBe(false);
  });

  it("omits a non-positive hires upscale tile size from persisted state", () => {
    const p: GenParams = {
      ...baseParams,
      hires: { enabled: true, upscale_tile_size: 0 },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);

    expect("upscale_tile_size" in (body.hires as object)).toBe(false);
  });
});

describe("sdcppMetadataToGenParams", () => {
  it("maps img_gen v1 metadata into GenParams with beta args", () => {
    const meta = {
      schema: "sdcpp.image.params/v1",
      mode: "img_gen",
      seed: 42,
      width: 1024,
      height: 1024,
      prompt: { positive: "a fox", negative: "blurry" },
      sampling: {
        steps: 8,
        eta: 1,
        flow_shift: 1.15,
        extra_sample_args: "alpha=0.8,beta=0.5",
        method: "euler",
        scheduler: "beta",
        guidance: {
          txt_cfg: 1.0,
          img_cfg: 5,
          distilled_guidance: 0,
          slg: { scale: 2, layers: [7, 8, 9], start: 0.01, end: 0.2 },
        },
        custom_sigmas: [0.1, 0.2],
      },
      clip_skip: 2,
      strength: 0.75,
      control_strength: 0.9,
      ip_adapter_strength: 0.6,
      auto_resize_ref_image: true,
      increase_ref_index: false,
      hires: {
        enabled: true,
        upscaler: "Lanczos",
        scale: 2,
        target_width: 0,
        target_height: 0,
        steps: 12,
        denoising_strength: 0.4,
        custom_sigmas: [],
        upscale_tile_size: 512,
      },
    };

    const p = sdcppMetadataToGenParams(meta);
    expect(p.prompt).toBe("a fox");
    expect(p.negative_prompt).toBe("blurry");
    expect(p.width).toBe(1024);
    expect(p.height).toBe(1024);
    expect(p.seed).toBe(42);
    expect(p.sample_params).toMatchObject({
      sample_steps: 8,
      eta: 1,
      flow_shift: 1.15,
      sample_method: "euler",
      scheduler: "beta",
      beta_alpha: 0.8,
      beta_beta: 0.5,
      custom_sigmas: [0.1, 0.2],
      guidance: {
        txt_cfg: 1.0,
        img_cfg: 5,
        slg: { scale: 2, layers: [7, 8, 9], layer_start: 0.01, layer_end: 0.2 },
      },
    });
    expect(p.clip_skip).toBe(2);
    expect(p.strength).toBe(0.75);
    expect(p.control_strength).toBe(0.9);
    expect(p.ip_adapter_strength).toBe(0.6);
    expect(p.auto_resize_ref_image).toBe(true);
    expect(p.increase_ref_index).toBe(false);
    expect(p.hires).toMatchObject({
      enabled: true,
      upscaler: "Lanczos",
      steps: 12,
      scale: 2,
      denoising_strength: 0.4,
      upscale_tile_size: 512,
    });
  });

  it("maps vid_gen metadata including high-noise beta args", () => {
    const meta = {
      mode: "vid_gen",
      seed: 7,
      width: 832,
      height: 480,
      prompt: { positive: "panning" },
      sampling: { steps: 20, scheduler: "discrete" },
      video: { frame_count: 33, fps: 24 },
      moe_boundary: 0.8,
      vace_strength: 1.0,
      high_noise_sampling: {
        steps: 8,
        scheduler: "beta",
        extra_sample_args: "beta=0.4",
      },
    };

    const p = sdcppMetadataToGenParams(meta);
    expect(p.video_frames).toBe(33);
    expect(p.fps).toBe(24);
    expect(p.moe_boundary).toBe(0.8);
    expect(p.vace_strength).toBe(1.0);
    expect(p.high_noise_sample_params).toMatchObject({
      sample_steps: 8,
      scheduler: "beta",
      beta_beta: 0.4,
    });
  });

  it("matches loras by name and skips unmatched ones", () => {
    const meta = {
      seed: 1,
      loras: [
        { name: "style.safetensors", multiplier: 0.8, is_high_noise: false },
        { name: "missing.safetensors", multiplier: 1 },
      ],
    };
    const p = sdcppMetadataToGenParams(meta, [
      { name: "style.safetensors", path: "D:/loras/style.safetensors" },
    ]);
    expect(p.lora).toEqual([
      {
        path: "D:/loras/style.safetensors",
        multiplier: 0.8,
        is_high_noise: false,
      },
    ]);
  });

  it("leaves beta fields unset for unrelated extra_sample_args", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      sampling: { steps: 4, extra_sample_args: "noise_clip_std=0.5" },
    });
    expect(p.sample_params?.beta_alpha).toBeUndefined();
    expect(p.sample_params?.beta_beta).toBeUndefined();
  });
});
