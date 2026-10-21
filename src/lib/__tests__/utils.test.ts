import { describe, it, expect } from "vitest";
import {
  b64ToBlobUrl,
  buildCacheOption,
  buildRequestBody,
  cacheOptionFields,
  clearLegacyLatentTiling,
  deepClone,
  deepMerge,
  extractApiError,
  fmtSize,
  formatError,
  formatLayerList,
  hasLegacyLatentTiling,
  hasPixelTiling,
  jobElapsed,
  legacyLatentTilingAxes,
  legacyTilingDroppedOnPixels,
  LINGBOT_PROMPT_TEMPLATE,
  matchAvailableLora,
  modelFileOptionLabel,  normalizeSizeStep,
  normalizeScmMask,
  parseCacheOption,
  parseLayerList,
  pixelTilingDroppedOnLatent,
  previewModesFromCapabilities,
  resolveCacheOption,
  resolvePreviewMode,
  resolveVaeTilingForProtocol,
  sanitizeCacheOptionsForMode,
  sdcppMetadataToGenParams,
  setTilingArgValue,
  tilingArgValue,
  trimJobsToBudget,
  vaeTilingProtocolFromCapabilities,
  validateLingbotPrompt,
  validateScmMask,
  validateSlgWindow,
} from "../utils";
import type {
  Capabilities,
  GenImages,
  GenParams,
  Job,
  SlgGuidance,
} from "../../types";

describe("normalizeSizeStep", () => {
  it("defaults to 1 and keeps positive integers", () => {
    expect(normalizeSizeStep(1)).toBe(1);
    expect(normalizeSizeStep(32)).toBe(32);
    // localStorage 里存的是字符串，恢复路径必须同样可用。
    expect(normalizeSizeStep("32")).toBe(32);
    expect(normalizeSizeStep(16.9)).toBe(16);
  });

  it("falls back to 1 for missing or unusable values", () => {
    for (const value of [undefined, null, "", "abc", 0, -8, NaN, Infinity]) {
      expect(normalizeSizeStep(value)).toBe(1);
    }
  });

  it("clamps oversized steps instead of passing them through", () => {
    expect(normalizeSizeStep(4096)).toBe(1024);
    expect(normalizeSizeStep("1e9")).toBe(1024);
  });
});

describe("preview capability gating", () => {
  it("requires support from the current generation mode", () => {
    const caps = {
      preview_modes: ["none", "proj", "proj", "vae"],
      features_by_mode: { img_gen: { preview: true }, vid_gen: { preview: false } },
    } as unknown as Capabilities;
    expect(previewModesFromCapabilities(caps, "img_gen")).toEqual(["none", "proj", "vae"]);
    expect(previewModesFromCapabilities(caps, "vid_gen")).toEqual([]);
    expect(previewModesFromCapabilities({ ...caps, features_by_mode: {} }, "img_gen")).toEqual([]);
    expect(previewModesFromCapabilities({ ...caps, preview_modes: undefined }, "img_gen")).toEqual([]);
  });

  it("falls back to none for unsupported or malformed saved values", () => {
    expect(resolvePreviewMode("vae", ["none", "proj"])).toBe("none");
    expect(resolvePreviewMode("proj", [])).toBe("none");
    expect(resolvePreviewMode(undefined, ["proj"])).toBe("none");
    expect(resolvePreviewMode(1 as unknown as string)).toBe("none");
    expect(resolvePreviewMode("future-mode", ["none", "future-mode"])).toBe("future-mode");
  });
});

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

  // 上游 #2028 把请求字段 auto_resize_ref_image 换成了 ref_image_args，
  // 旧内核只认前者、新内核只认后者，且两边都会忽略未知键，所以双发才能同时
  // 覆盖新旧 sd-server（不能只删旧键——旧内核上开关会失效）。
  describe("reference image resize (upstream #2028)", () => {
    it("always sends the legacy boolean and never needs ref_image_args by default", () => {
      const body = buildRequestBody("img_gen", baseParams, {} as GenImages);
      expect(body.auto_resize_ref_image).toBe(true);
      expect(body.ref_image_args).toBeUndefined();
    });

    it("dual-sends the resize opt-out and keeps the launch preset", () => {
      const p: GenParams = { ...baseParams, auto_resize_ref_image: false };
      const body = buildRequestBody("img_gen", p, {} as GenImages, {
        refImagePreset: "flux_kontext",
      });
      // 旧内核读这个。
      expect(body.auto_resize_ref_image).toBe(false);
      // 新内核读这个；请求端是整体赋值，漏掉 preset 会把启动参数顶掉。
      expect(body.ref_image_args).toBe(
        "preset=flux_kontext,resize_before_vae=false"
      );
    });

    it("honors an explicit ref_image_args without duplicating preset or resize", () => {
      const p: GenParams = {
        ...baseParams,
        auto_resize_ref_image: false,
        ref_image_args: "preset=longcat,resize_before_vae=off",
      };
      const body = buildRequestBody("img_gen", p, {} as GenImages, {
        refImagePreset: "flux_kontext",
      });
      expect(body.ref_image_args).toBe("preset=longcat,resize_before_vae=off");
    });

    // 审查 30-api §2.10：embed_image_metadata 此前只在 img_gen 分支发送，
    // 视频永远带元数据、用户关不掉；fps 缺省也要跟上游一致（16，不是 24）。
    it.each(["img_gen", "vid_gen"] as const)(
      "sends embed_image_metadata=false in %s when the user disables it",
      (mode) => {
        expect(
          buildRequestBody(mode, { ...baseParams, embed_image_metadata: false }, {} as GenImages)
            .embed_image_metadata
        ).toBe(false);
        expect(
          buildRequestBody(mode, { ...baseParams, embed_image_metadata: undefined }, {} as GenImages)
            .embed_image_metadata
        ).toBe(true);
      }
    );

    it("defaults vid_gen fps to the upstream value, not 24", () => {
      expect(
        buildRequestBody("vid_gen", { ...baseParams, fps: undefined }, {} as GenImages).fps
      ).toBe(16);
      expect(
        buildRequestBody("vid_gen", { ...baseParams, fps: 30 }, {} as GenImages).fps
      ).toBe(30);
    });

    it.each(["img_gen", "vid_gen"] as const)("normalizes draft rules only when building %s requests", (mode) => {
      const rules = ["  target=init,mode=fit-pad  ", "", "   ", "target=ref,mode=none", ""];
      const p = { ...baseParams, image_preprocess: rules };
      expect(buildRequestBody(mode, p, {} as GenImages).image_preprocess).toEqual([
        "target=init,mode=fit-pad", "target=ref,mode=none",
      ]);
      expect(p.image_preprocess).toEqual(["  target=init,mode=fit-pad  ", "", "   ", "target=ref,mode=none", ""]);
      expect(buildRequestBody(mode, { ...baseParams, image_preprocess: ["", "  "] }, {} as GenImages))
        .not.toHaveProperty("image_preprocess");
    });

    it.each(["img_gen", "vid_gen"] as const)("handles malformed persisted rules for %s", (mode) => {
      for (const value of [null, 42, {}, "not-an-array", [1, null, {}]]) {
        const p = { ...baseParams, image_preprocess: value as unknown as string[] };
        expect(buildRequestBody(mode, p, {} as GenImages)).not.toHaveProperty("image_preprocess");
      }
      const mixed = [null, 42, {}, "  target=ref,mode=none ", ""];
      const p = { ...baseParams, image_preprocess: mixed as unknown as string[] };
      expect(buildRequestBody(mode, p, {} as GenImages).image_preprocess).toEqual(["target=ref,mode=none"]);
      expect(mixed).toEqual([null, 42, {}, "  target=ref,mode=none ", ""]);
    });

    it("sends image_preprocess for both generation modes", () => {
      const p: GenParams = {
        ...baseParams,
        image_preprocess: ["target=init,mode=fit-pad", "target=ref,mode=none"],
      };
      expect(buildRequestBody("img_gen", p, {} as GenImages).image_preprocess).toEqual([
        "target=init,mode=fit-pad",
        "target=ref,mode=none",
      ]);
      expect(buildRequestBody("vid_gen", p, {} as GenImages).image_preprocess).toEqual([
        "target=init,mode=fit-pad",
        "target=ref,mode=none",
      ]);
    });
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

  it("omits high-noise SLG entirely when it is not enabled", () => {
    // 审查 F-18：此前恒发 {scale:0}，会把服务端启动参数
    // --high-noise-slg-scale 每条请求都打回关闭（docs/audit/95-f18-semantics.md §5.3）。
    // 「要关掉服务端默认」只能靠启动参数表达，不能靠恒发 0 去猜。
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
    const hn = body.high_noise_sample_params as {
      guidance: Record<string, unknown>;
    };
    expect("slg" in hn.guidance).toBe(false);
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

  // MiniMax-H3 Ref2VA 半支持：调用方按家族能力裁剪后传入，vid_gen 请求体
  // 不再按 mode 丢弃参考图。
  it("includes ref_images in vid_gen requests", () => {
    const body = buildRequestBody("vid_gen", baseParams, {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: ["data:image/png;base64,ref"],
      controlFrames: [],
    });
    expect(body.ref_images).toEqual(["data:image/png;base64,ref"]);
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

  // 上游 #2059：新版内核只认 tile_size_w/h（图像像素），旧内核只认 x/y
  // （latent 单位）。同一份设置不能同时发给两边，否则"设置了却没生效"。
  it("preserves complete pixel-unit VAE tiling parameters when enabled", () => {
    const p: GenParams = {
      ...baseParams,
      vae_tiling_params: {
        enabled: true,
        temporal_tiling: true,
        tile_size_w: 512,
        tile_size_h: 512,
        target_overlap: 0.5,
        rel_size_w: 0,
        rel_size_h: 0,
        extra_tiling_args: "",
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    expect(body.vae_tiling_params).toEqual(p.vae_tiling_params);
  });

  it("drops legacy latent tiling keys on a pixel-unit kernel", () => {
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
    // 旧值保留在设置里（界面会提示重设），但不发送给新内核。
    expect(body.vae_tiling_params).toEqual({
      enabled: true,
      temporal_tiling: true,
      target_overlap: 0.5,
      extra_tiling_args: "",
    });
    expect(legacyTilingDroppedOnPixels(p.vae_tiling_params)).toBe(true);
  });

  it("keeps legacy keys for a kernel that still speaks latent units", () => {
    const p: GenParams = {
      ...baseParams,
      vae_tiling_params: {
        enabled: true,
        tile_size_x: 64,
        tile_size_y: 64,
        tile_size_w: 512,
        tile_size_h: 512,
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages, {
      vaeTilingProtocol: "latent",
    });
    expect(body.vae_tiling_params).toEqual({
      enabled: true,
      tile_size_x: 64,
      tile_size_y: 64,
    });
  });

  it("detects the tiling protocol from capabilities, not from Lumina's version", () => {
    expect(
      vaeTilingProtocolFromCapabilities({
        defaults_by_mode: {
          img_gen: { vae_tiling_params: { tile_size_w: 0, tile_size_h: 0 } },
        },
      })
    ).toBe("pixels");
    expect(
      vaeTilingProtocolFromCapabilities({
        defaults_by_mode: {
          vid_gen: { vae_tiling_params: { tile_size_x: 0, tile_size_y: 0 } },
        },
      })
    ).toBe("latent");
    // 旧内核/裁剪响应里两套键都没有时按最新内核处理。
    expect(vaeTilingProtocolFromCapabilities({ defaults_by_mode: {} })).toBe(
      "pixels"
    );
    expect(vaeTilingProtocolFromCapabilities(null)).toBe("pixels");
  });

  it("resolves tiling payloads per protocol and keeps the disabled override", () => {
    const legacy = { enabled: true, tile_size_x: 32, tile_size_y: 32 };
    expect(resolveVaeTilingForProtocol(legacy, "pixels")).toEqual({
      enabled: true,
    });
    expect(resolveVaeTilingForProtocol(legacy, "latent")).toEqual(legacy);
    expect(resolveVaeTilingForProtocol({ enabled: false }, "pixels")).toEqual({
      enabled: false,
    });
    expect(hasLegacyLatentTiling(legacy)).toBe(true);
    expect(hasLegacyLatentTiling({ enabled: true, tile_size_w: 256 })).toBe(
      false
    );
  });

  // 两个方向都要提示：用新内核出图、回填元数据后又切回旧内核时，像素值
  // 同样会被丢弃，不能静默。
  it("flags dropped tiling values in both protocol directions", () => {
    const pixelOnly = { enabled: true, tile_size_w: 512, tile_size_h: 512 };
    expect(hasPixelTiling(pixelOnly)).toBe(true);
    expect(legacyTilingDroppedOnPixels(pixelOnly)).toBe(false);
    expect(pixelTilingDroppedOnLatent(pixelOnly)).toBe(true);

    const latentOnly = { enabled: true, tile_size_x: 32, tile_size_y: 32 };
    expect(pixelTilingDroppedOnLatent(latentOnly)).toBe(false);
    expect(legacyTilingDroppedOnPixels(latentOnly)).toBe(true);

    // 关闭状态与两套键齐全时都不提示。
    expect(pixelTilingDroppedOnLatent({ enabled: false, tile_size_w: 512 })).toBe(
      false
    );
    expect(
      pixelTilingDroppedOnLatent({
        enabled: true,
        tile_size_w: 512,
        tile_size_x: 32,
      })
    ).toBe(false);
  });

  // 已经存在像素值（很可能来自 capabilities 的启动默认值）时仍然要提示：
  // 否则旧设置会静默失效，用户以为迁移已经完成。
  it("keeps warning about legacy axes even when pixel values exist", () => {
    const mixed = {
      enabled: true,
      tile_size_w: 512,
      tile_size_h: 512,
      tile_size_x: 16,
      tile_size_y: 16,
    };
    expect(legacyTilingDroppedOnPixels(mixed)).toBe(true);
    // 逐轴信息用于界面提示，未设置的轴不出现。
    const mixedAxes = legacyLatentTilingAxes(mixed);
    expect(mixedAxes.tileX).toBe(16);
    expect(mixedAxes.tileY).toBe(16);
    expect(mixedAxes.relX).toBeUndefined();
    expect(mixedAxes.relY).toBeUndefined();
    expect(legacyLatentTilingAxes({ enabled: true })).toEqual({});

    // 清除旧值后提示消失，像素值原样保留。
    const cleared = clearLegacyLatentTiling(mixed);
    expect(legacyTilingDroppedOnPixels(cleared)).toBe(false);
    expect(cleared.tile_size_w).toBe(512);
    expect(cleared.tile_size_x).toBeUndefined();
    // 清除只影响旧协议字段，不能改写用户设置的对象本身。
    expect(mixed.tile_size_x).toBe(16);
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

  // 上游 #1885：lms 采样器的 max_order / shift / divisions 可配。
  it("sends lms args via extra_sample_args when lms is selected", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "lms",
        lms_max_order: 3,
        lms_shift: 0,
        lms_divisions: 2000,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "lms_max_order=3,lms_shift=0,lms_divisions=2000"
    );
  });

  it("does not send lms args for other samplers", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "euler",
        lms_max_order: 3,
        lms_shift: 2,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(
      (body.sample_params as Record<string, unknown>).extra_sample_args
    ).toBeUndefined();
  });

  // 上游 parse_strict_int 会整条忽略小数；越界值按上游 max(1,·)/max(0,·) 语义丢弃。
  it("truncates lms args to integers and drops out-of-range ones", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "lms",
        lms_max_order: 4.7,
        lms_shift: -1,
        lms_divisions: 0,
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "lms_max_order=4"
    );
  });

  it("appends free-form extra_sample_args after the structured ones", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "lms",
        scheduler: "beta",
        beta_alpha: 0.8,
        lms_max_order: 2,
        // 上游 parse_key_value_args 后写覆盖先写，自由文本因此可以覆盖滑杆值。
        extra_sample_args: " gamma=3 ; lms_max_order=6 , broken , empty= ",
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "alpha=0.8,lms_max_order=2,gamma=3,lms_max_order=6"
    );
  });

  it("sends free-form extra args even when no structured arg applies", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        sample_method: "euler_ge",
        scheduler: "karras",
        extra_sample_args: "gamma=2.5",
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect((body.sample_params as Record<string, unknown>).extra_sample_args).toBe(
      "gamma=2.5"
    );
  });

  it("omits extra_sample_args when the free-form text has no valid pair", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: {
        ...baseParams.sample_params,
        extra_sample_args: "  , broken ; =3 ",
      },
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(
      (body.sample_params as Record<string, unknown>).extra_sample_args
    ).toBeUndefined();
  });

  it("carries lms + free-form args on the high-noise stage independently", () => {
    const p: GenParams = {
      ...baseParams,
      sample_params: { ...baseParams.sample_params, sample_method: "euler" },
      high_noise_sample_params: {
        sample_method: "lms",
        sample_steps: 8,
        lms_shift: 1,
        shifted_timestep: 250,
        extra_sample_args: "gamma=4",
        guidance: { txt_cfg: 3.5 },
      },
    };
    const body = buildRequestBody("vid_gen", p, {} as GenImages);
    const hn = body.high_noise_sample_params as Record<string, unknown>;
    expect(hn.extra_sample_args).toBe("lms_shift=1,gamma=4");
    // 上游 parse_sample_params_json 对高噪段同样解析 shifted_timestep。
    expect(hn.shifted_timestep).toBe(250);
    expect(
      (body.sample_params as Record<string, unknown>).extra_sample_args
    ).toBeUndefined();
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

  // 上游 #2093：preview / preview_interval 是 img_gen 与 vid_gen 通用的顶层字段。
  describe("generation previews (upstream #2093)", () => {
    it.each(["img_gen", "vid_gen"] as const)("disables unsupported saved previews in %s requests", (mode) => {
      const params: GenParams = { ...baseParams, preview: "vae", preview_interval: 4 };
      for (const previewModes of [[], ["none", "proj"]]) {
        const body = buildRequestBody(mode, params, {} as GenImages, { previewModes });
        expect(body.preview).toBe("none");
        expect(body).not.toHaveProperty("preview_interval");
      }
      expect(buildRequestBody(mode, params, {} as GenImages, { previewModes: ["none", "vae"] }))
        .toMatchObject({ preview: "vae", preview_interval: 4 });
    });

    it("explicitly disables previews by default in both modes", () => {
      for (const mode of ["img_gen", "vid_gen"] as const) {
        const body = buildRequestBody(mode, baseParams, {} as GenImages);
        // 预览默认关闭，不发送间隔。
        expect(body.preview).toBe("none");
        expect("preview_interval" in body).toBe(false);
      }
    });

    it("sends the mode and interval once previews are on", () => {
      const p: GenParams = { ...baseParams, preview: "tae", preview_interval: 4 };
      const body = buildRequestBody("img_gen", p, {} as GenImages);

      expect(body.preview).toBe("tae");
      expect(body.preview_interval).toBe(4);
    });

    it("clamps non-positive intervals the way upstream does", () => {
      const zero: GenParams = {
        ...baseParams,
        preview: "proj",
        preview_interval: 0,
      };
      expect(buildRequestBody("img_gen", zero, {} as GenImages).preview_interval).toBe(1);

      const negative: GenParams = {
        ...baseParams,
        preview: "proj",
        preview_interval: -3,
      };
      expect(
        buildRequestBody("vid_gen", negative, {} as GenImages).preview_interval
      ).toBe(1);
    });
  });
});

// 审查 F-18 / docs/audit/95-f18-semantics.md：cache_option 是 key=value 串，
// 同名键跨模式含义不同；scm_mask 非法会让内核 terminate。这里守住
// 「拼串确定」「按模式裁剪」「非法不下发」三条。
describe("F-18 缓存微调与 SCM 掩码", () => {
  const baseParams: GenParams = {
    width: 512,
    height: 512,
    seed: 42,
    sample_params: { sample_steps: 20, guidance: { txt_cfg: 7 } },
  };

  it("按 spec 固定键序拼 cache_option", () => {
    expect(
      buildCacheOption("easycache", { threshold: 0.3, start: 0.1, reset: false })
    ).toBe("threshold=0.3,start=0.1,reset=0");
  });

  it("拼串与草稿的对象键序无关", () => {
    const a = buildCacheOption("spectrum", { stop: 0.8, w: 0.5, m: 4 });
    const b = buildCacheOption("spectrum", { m: 4, w: 0.5, stop: 0.8 });
    expect(a).toBe(b);
    expect(a).toBe("w=0.5,m=4,stop=0.8");
  });

  it("只拼当前模式合法的键", () => {
    // Fn 只在 dbcache 系生效：easycache 下留着会「设置了但内核不读」。
    expect(buildCacheOption("easycache", { Fn: 8, threshold: 0.2 })).toBe(
      "threshold=0.2"
    );
    expect(buildCacheOption("dbcache", { Fn: 8, threshold: 0.2 })).toBe(
      "Fn=8,threshold=0.2"
    );
  });

  it("关闭/未知模式不产生 cache_option", () => {
    expect(buildCacheOption("disabled", { threshold: 0.2 })).toBeUndefined();
    expect(buildCacheOption(undefined, { threshold: 0.2 })).toBeUndefined();
    expect(buildCacheOption("easycache", {})).toBeUndefined();
  });

  it("数值按 spec 夹取、整数截断、浮点尾数收窄", () => {
    expect(buildCacheOption("dbcache", { Fn: 4.7 })).toBe("Fn=4");
    expect(buildCacheOption("easycache", { threshold: 0.1 + 0.2 })).toBe(
      "threshold=0.3"
    );
    expect(buildCacheOption("easycache", { threshold: -5 })).toBe("threshold=0");
  });

  it("保留原始串里界面不认识的键（元数据往返不丢参数）", () => {
    expect(
      buildCacheOption("easycache", { threshold: 0.2 }, "threshold=0.1,gamma=3")
    ).toBe("threshold=0.2,gamma=3");
  });

  it("原始串可解析回草稿，未知键单独列出", () => {
    const { draft, unknownPairs } = parseCacheOption(
      "threshold=1.5,reset=0,gamma=3"
    );
    expect(draft).toEqual({ threshold: 1.5, reset: false });
    expect(unknownPairs).toEqual([{ key: "gamma", value: "3" }]);
  });

  it("切换缓存模式时丢弃新模式不认的键与跨模式语义漂移的键", () => {
    const draft = { threshold: 0.2, Fn: 8, start: 0.15 };
    // easycache → dbcache：Fn 合法、start 不合法、threshold 跨分组必须丢。
    expect(sanitizeCacheOptionsForMode("dbcache", draft, "easycache")).toEqual({
      Fn: 8,
    });
    // easycache → ucache：同分组，threshold 保留。
    expect(sanitizeCacheOptionsForMode("ucache", draft, "easycache")).toEqual({
      threshold: 0.2,
      start: 0.15,
    });
  });

  it("三种模式的控件集合与上游键集合一致", () => {
    const keys = (mode: string) => cacheOptionFields(mode).map((f) => f.key);
    expect(keys("easycache")).toEqual([
      "threshold",
      "start",
      "end",
      "decay",
      "relative",
      "reset",
    ]);
    expect(keys("dbcache")).toEqual(["Fn", "Bn", "threshold", "warmup"]);
    expect(keys("spectrum")).toEqual([
      "w",
      "m",
      "lam",
      "window",
      "flex",
      "warmup",
      "stop",
    ]);
    expect(keys("disabled")).toEqual([]);
  });

  it("resolveCacheOption 优先草稿，否则沿用原始串", () => {
    expect(
      resolveCacheOption({ cache_mode: "easycache", cache_option: "threshold=0.1" })
    ).toBe("threshold=0.1");
    expect(
      resolveCacheOption({
        cache_mode: "easycache",
        cache_option: "threshold=0.1",
        cache_options: { threshold: 0.3 },
      })
    ).toBe("threshold=0.3");
    expect(resolveCacheOption({ cache_mode: "easycache" })).toBeUndefined();
  });

  it("请求体只带合法 scm_mask", () => {
    const ok: GenParams = {
      ...baseParams,
      cache_mode: "dbcache",
      scm_mask: "1,1,0,0",
    };
    expect(buildRequestBody("img_gen", ok, {} as GenImages).scm_mask).toBe(
      "1,1,0,0"
    );
    // 非法掩码绝不下发：上游 parse_scm_mask 无 try/catch 且在 worker 线程，
    // 坏值会让 sd-server terminate（宁可少一个键）。
    for (const bad of ["1,x,0", "1,,0", "01", "1 1", "abc", "1,2"]) {
      const p: GenParams = {
        ...baseParams,
        cache_mode: "dbcache",
        scm_mask: bad,
      };
      expect(buildRequestBody("img_gen", p, {} as GenImages).scm_mask).toBeUndefined();
    }
  });

  it("cache_mode 关闭时既不发 cache_option 也不发 scm_mask", () => {
    const p: GenParams = {
      ...baseParams,
      cache_mode: "disabled",
      cache_option: "threshold=0.2",
      scm_mask: "1,0",
    };
    const body = buildRequestBody("img_gen", p, {} as GenImages);
    expect(body.cache_mode).toBe("disabled");
    expect(body.cache_option).toBeUndefined();
    expect(body.scm_mask).toBeUndefined();
  });

  it("validateScmMask / normalizeScmMask 给出可读原因并拦截", () => {
    expect(validateScmMask("")).toBeNull();
    expect(validateScmMask("1,0,1")).toBeNull();
    expect(validateScmMask("1,,0")).toContain("0/1");
    expect(normalizeScmMask("1,,0")).toBeUndefined();
    expect(normalizeScmMask(" 1,0 ")).toBe("1,0");
    expect(normalizeScmMask("")).toBeUndefined();
  });
});

// 审查 F-18：SLG 的 layers / layer_start / layer_end 此前没有入口，
// 请求体还会把 [7,8,9]/0.01/0.2 硬塞进去覆盖服务端 --skip-layers。
describe("F-18 SLG 三参数", () => {
  const baseParams: GenParams = {
    width: 512,
    height: 512,
    seed: 42,
    sample_params: { sample_steps: 20, guidance: { txt_cfg: 7 } },
  };
  const withSlg = (slg: SlgGuidance): GenParams => ({
    ...baseParams,
    sample_params: {
      ...baseParams.sample_params,
      guidance: { txt_cfg: 7, slg },
    },
  });
  const slgOf = (body: Record<string, unknown>) =>
    (
      body.sample_params as {
        guidance: { slg?: Record<string, unknown> };
      }
    ).guidance.slg;

  it("开启时只发设置过的子项", () => {
    expect(slgOf(buildRequestBody("img_gen", withSlg({ scale: 2.5 }), {} as GenImages))).toEqual(
      { scale: 2.5 }
    );
  });

  it("layers 缺省时省略该键（不覆盖内核 --skip-layers）", () => {
    const slg = slgOf(
      buildRequestBody(
        "img_gen",
        withSlg({ scale: 2.5, layer_start: 0.05 }),
        {} as GenImages
      )
    );
    expect(slg).toBeDefined();
    expect("layers" in (slg as object)).toBe(false);
    expect(slg?.layer_start).toBe(0.05);
    expect("layer_end" in (slg as object)).toBe(false);
  });

  it("空数组的 layers 视为未设置（空数组在上游等于关闭 SLG）", () => {
    expect(
      slgOf(buildRequestBody("img_gen", withSlg({ scale: 1, layers: [] }), {} as GenImages))
    ).toEqual({ scale: 1 });
  });

  it("关闭时仍显式发 scale:0（服务端可能默认开启）", () => {
    expect(
      slgOf(
        buildRequestBody("img_gen", withSlg({ scale: 0, layers: [4] }), {} as GenImages)
      )
    ).toEqual({ scale: 0 });
  });

  it("跳层索引解析：空串是未设置，非法输入不产生数组", () => {
    expect(parseLayerList("")).toEqual({ ok: true });
    expect(parseLayerList("7,8,9")).toEqual({ ok: true, layers: [7, 8, 9] });
    expect(parseLayerList("7, 7, 8")).toEqual({ ok: true, layers: [7, 8] });
    expect(parseLayerList("7,,9").ok).toBe(false);
    expect(parseLayerList("7,a").ok).toBe(false);
    expect(parseLayerList("-1").ok).toBe(false);
    expect(parseLayerList("256").ok).toBe(false);
    expect(formatLayerList([7, 8, 9])).toBe("7,8,9");
    expect(formatLayerList([])).toBe("");
    expect(formatLayerList(undefined)).toBe("");
  });

  it("SLG 生效窗口校验（start >= end 会静默不生效）", () => {
    expect(validateSlgWindow(0.01, 0.2)).toBeNull();
    expect(validateSlgWindow(0.2, 0.2)).toContain("小于");
    expect(validateSlgWindow(0.3, 0.2)).toContain("小于");
    expect(validateSlgWindow(-0.1, 0.2)).toContain("0–1");
    expect(validateSlgWindow(undefined, 0.2)).toBeNull();
  });

  it("高噪 SLG 只在开启时发送，且同样省略缺省子项", () => {
    const off: GenParams = {
      ...baseParams,
      high_noise_sample_params: {
        sample_steps: 8,
        guidance: { txt_cfg: 3.5 },
      },
    };
    const hnOff = buildRequestBody("vid_gen", off, {} as GenImages)
      .high_noise_sample_params as { guidance: Record<string, unknown> };
    expect("slg" in hnOff.guidance).toBe(false);

    const on: GenParams = {
      ...baseParams,
      high_noise_sample_params: {
        sample_steps: 8,
        guidance: { txt_cfg: 3.5, slg: { scale: 2, layer_start: 0.1 } },
      },
    };
    const hnOn = buildRequestBody("vid_gen", on, {} as GenImages)
      .high_noise_sample_params as {
      guidance: { slg?: Record<string, unknown> };
    };
    expect(hnOn.guidance.slg).toEqual({ scale: 2, layer_start: 0.1 });
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

  // 上游 #2028 起元数据只写 ref_image_args / image_preprocess，
  // auto_resize_ref_image 不再出现；旧图仍要能回填。
  it("recovers reference resize and image preprocessing from new metadata", () => {
    const off = sdcppMetadataToGenParams({
      width: 1024,
      height: 1024,
      ref_image_args: "preset=qwen,resize_before_vae=false",
      image_preprocess: "target=ref,mode=none;target=init,mode=fit-pad",
    });
    expect(off.auto_resize_ref_image).toBe(false);
    expect(off.ref_image_args).toBe("preset=qwen,resize_before_vae=false");
    expect(off.image_preprocess).toEqual([
      "target=ref,mode=none",
      "target=init,mode=fit-pad",
    ]);

    // 数组形式的 image_preprocess（native 请求允许 string | array）。
    const arr = sdcppMetadataToGenParams({
      width: 512,
      height: 512,
      image_preprocess: ["target=mask,filter=nearest-exact"],
    });
    expect(arr.image_preprocess).toEqual(["target=mask,filter=nearest-exact"]);

    // 旧图：布尔键优先，且不会因为缺少新键而误判。
    const legacy = sdcppMetadataToGenParams({
      width: 512,
      height: 512,
      auto_resize_ref_image: false,
    });
    expect(legacy.auto_resize_ref_image).toBe(false);
    expect(legacy.ref_image_args).toBeUndefined();

    // 新版默认（只写 preset、没有 resize_before_vae）不应把开关翻成关闭。
    const presetOnly = sdcppMetadataToGenParams({
      width: 512,
      height: 512,
      ref_image_args: "preset=qwen",
    });
    expect(presetOnly.auto_resize_ref_image).toBeUndefined();
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

  // 回归（审查 S-10）：元数据的 name 是**含扩展名的文件名**（上游
  // common.cpp:3146 的 sd_basename），capabilities 的 name 是 **stem**
  // （runtime.cpp:286）。夹具必须按真实形状构造，两侧都写 "style.safetensors"
  // 会让这个缺陷一直是绿灯。
  it("matches loras by name and skips unmatched ones", () => {
    const meta = {
      seed: 1,
      loras: [
        { name: "style.safetensors", multiplier: 0.8, is_high_noise: false },
        { name: "missing.safetensors", multiplier: 1 },
      ],
    };
    const p = sdcppMetadataToGenParams(meta, [
      { name: "style", path: "D:/loras/style.safetensors" },
    ]);
    expect(p.lora).toEqual([
      {
        path: "D:/loras/style.safetensors",
        multiplier: 0.8,
        is_high_noise: false,
      },
    ]);
  });

  it("matches loras through path basename and bare stems", () => {
    // 三种真实存在的写法：caps 只给文件名、元数据不带扩展名、路径尾部匹配。
    expect(
      matchAvailableLora(
        [{ name: "style", path: "loras/style.safetensors" }],
        "style.safetensors"
      )?.path
    ).toBe("loras/style.safetensors");
    expect(
      matchAvailableLora([{ name: "style.safetensors", path: "a/b.pt" }], "style")
        ?.path
    ).toBe("a/b.pt");
    expect(
      matchAvailableLora(
        [{ name: "unrelated", path: "D:/loras/style.safetensors" }],
        "style.safetensors"
      )?.path
    ).toBe("D:/loras/style.safetensors");
    expect(
      matchAvailableLora([{ name: "style", path: "loras/style.safetensors" }], "other")
    ).toBeUndefined();
  });

  it("leaves beta fields unset for unrelated extra_sample_args", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      sampling: { steps: 4, extra_sample_args: "noise_clip_std=0.5" },
    });
    expect(p.sample_params?.beta_alpha).toBeUndefined();
    expect(p.sample_params?.beta_beta).toBeUndefined();
  });

  // 上游 #1885：lms 采样器的 lms_max_order / lms_shift / lms_divisions。
  it("restores lms args and keeps unknown extra args verbatim", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      sampling: {
        steps: 20,
        method: "lms",
        extra_sample_args:
          "lms_max_order=3; lms_shift=0 ,lms_divisions=2000, gamma=3,slg_uncond=true",
      },
    });
    expect(p.sample_params).toMatchObject({
      sample_method: "lms",
      lms_max_order: 3,
      lms_shift: 0,
      lms_divisions: 2000,
      // 结构化字段吃不下的键原样保留，"应用此配置" 才不会静默丢参数。
      extra_sample_args: "gamma=3,slg_uncond=true",
    });
  });

  it("drops lms args that upstream parse_strict_int would reject", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      sampling: {
        method: "lms",
        extra_sample_args: "lms_max_order=2.5,lms_shift=-1,lms_divisions=0",
      },
    });
    expect(p.sample_params?.lms_max_order).toBeUndefined();
    expect(p.sample_params?.lms_shift).toBeUndefined();
    expect(p.sample_params?.lms_divisions).toBeUndefined();
    expect(p.sample_params?.extra_sample_args).toBeUndefined();
  });

  // 上游 common.cpp 只在启用时写 vae_tiling 段；#2059 起键名改为 w/h，
  // 因此新旧图片要分别回填，且不能把 latent 数值当成像素。
  it("restores a legacy latent-unit vae_tiling section unchanged", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      vae_tiling: {
        enabled: true,
        temporal_tiling: true,
        tile_size_x: 256,
        tile_size_y: 192,
        target_overlap: 0.25,
        rel_size_x: 0.5,
        rel_size_y: 0.5,
        extra_tiling_args: "foo=1",
      },
    });
    expect(p.vae_tiling_params).toEqual({
      enabled: true,
      temporal_tiling: true,
      tile_size_x: 256,
      tile_size_y: 192,
      target_overlap: 0.25,
      rel_size_x: 0.5,
      rel_size_y: 0.5,
      extra_tiling_args: "foo=1",
    });
  });

  it("restores a pixel-unit vae_tiling section from new metadata", () => {
    const p = sdcppMetadataToGenParams({
      seed: 1,
      vae_tiling: {
        enabled: true,
        temporal_tiling: false,
        tile_size_w: 512,
        tile_size_h: 384,
        target_overlap: 0.3,
        rel_size_w: 0.5,
        rel_size_h: 0.25,
        extra_tiling_args: "temporal_tile_frames=4",
      },
    });
    expect(p.vae_tiling_params).toEqual({
      enabled: true,
      temporal_tiling: false,
      tile_size_w: 512,
      tile_size_h: 384,
      target_overlap: 0.3,
      rel_size_w: 0.5,
      rel_size_h: 0.25,
      extra_tiling_args: "temporal_tile_frames=4",
    });
  });

  it("leaves vae_tiling_params unset when the metadata omits the section", () => {
    const p = sdcppMetadataToGenParams({ seed: 1 });
    expect(p.vae_tiling_params).toBeUndefined();
  });
});

// 审查 20-frontend §2.3：结果侧有字节预算，任务侧的 config.images 此前只有条数上限。
// 审查 30-api §2.9：视频时间维分块存在 extra_tiling_args 里，界面按单键读写。
describe("extra_tiling_args 单键读写", () => {
  it("reads a key without disturbing the others", () => {
    expect(
      tilingArgValue("temporal_tile_frames=8,temporal_tile_overlap=2", "temporal_tile_frames")
    ).toBe(8);
    expect(tilingArgValue("other=1", "temporal_tile_frames")).toBeNull();
    expect(tilingArgValue(undefined, "temporal_tile_frames")).toBeNull();
  });

  it("writes a key in place and removes it when cleared", () => {
    expect(
      setTilingArgValue("temporal_tile_overlap=2", "temporal_tile_frames", 4)
    ).toBe("temporal_tile_overlap=2,temporal_tile_frames=4");
    expect(setTilingArgValue("a=1,b=2", "a", 9)).toBe("b=2,a=9");
    expect(setTilingArgValue("a=1,b=2", "a", null)).toBe("b=2");
    expect(setTilingArgValue(undefined, "a", 3)).toBe("a=3");
  });
});

describe("trimJobsToBudget", () => {
  const job = (id: string, b64?: string): Job => ({
    id,
    kind: "img_gen",
    status: "completed",
    config: b64
      ? {
          mode: "img_gen",
          params: {
            width: 512,
            height: 512,
            seed: 1,
            sample_params: { guidance: {} },
          },
          images: {
            initImage: b64,
            maskImage: null,
            controlImage: null,
            ipAdapterImage: null,
            endImage: null,
            refImages: [],
            controlFrames: [],
          },
        }
      : undefined,
  });

  it("keeps the list untouched while under budget", () => {
    const jobs = [job("a", "A".repeat(1024)), job("b", "B".repeat(1024))];
    expect(trimJobsToBudget(jobs, 1024 * 1024)).toBe(jobs);
  });

  it("strips images from the oldest jobs first and never from the newest", () => {
    // 3 条任务各 1024 字符 base64 ≈ 768 B；总 2304 B 超出 2048 B 预算，
    // 只需剥离最旧的一条即可回到预算内。
    const jobs = [
      job("newest", "C".repeat(1024)),
      job("mid", "B".repeat(1024)),
      job("oldest", "A".repeat(1024)),
    ];
    const trimmed = trimJobsToBudget(jobs, 2048);
    expect(trimmed[0].config?.images?.initImage).toBeTruthy();
    expect(trimmed[1].config?.images).toBeTruthy();
    expect(trimmed[2].config?.images).toBeUndefined();
  });
});

// 审查 30-api §2.8：耗时优先用内核的 started/completed，而不是 created→轮询时刻。
describe("jobElapsed", () => {
  it("uses the kernel timestamps when both are present", () => {
    const j: Job = {
      id: "x",
      kind: "img_gen",
      status: "completed",
      created: 100,
      started: 110,
      completed: 125,
    };
    expect(jobElapsed(j, true)).toBe("15s");
  });

  it("returns nothing for queued jobs and falls back to created for legacy payloads", () => {
    expect(jobElapsed({ id: "q", kind: "img_gen", status: "queued", created: 100 }, false)).toBe("");
    const legacy: Job = {
      id: "l",
      kind: "img_gen",
      status: "completed",
      created: 100,
      // 旧内核没有 completed，用最近一次成功轮询兜底
      lastPollSuccess: 130_000,
    };
    expect(jobElapsed(legacy, true)).toBe("30s");
  });
});
