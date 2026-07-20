import { describe, it, expect } from "vitest";
import {
  deepClone,
  deepMerge,
  fmtSize,
  b64ToBlobUrl,
  buildRequestBody,
  formatError,
  LINGBOT_PROMPT_TEMPLATE,
  modelFileOptionLabel,
  validateLingbotPrompt,
} from "../utils";
import type { GenImages, GenParams } from "../../types";

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
});
