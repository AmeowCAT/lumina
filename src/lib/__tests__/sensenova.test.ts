import { describe, expect, it } from "vitest";
import { alignSizeUp, FAMILY_CONFIG, scaleSize } from "../../config/families";
import { applyFamilyFeatureLimits, buildLaunchConfig, familyDefaults, filterFamilyInputs } from "../launchConfig";
import type { GenImages } from "../../types";

const family = FAMILY_CONFIG["sensenova-u1"];
const images: GenImages = {
  initImage: "initial", maskImage: "mask", controlImage: "control", ipAdapterImage: "adapter",
  endImage: "last", refImages: ["reference"], controlFrames: ["frame"],
};

describe("SenseNova U1.5 integration", () => {
  it("loads the complete index with --model and no TE/VAE/TAE", () => {
    const result = buildLaunchConfig({
      family: "sensenova-u1",
      modelPath: "/models/SenseNova-U1.5-8B-MoT/model.safetensors.index.json",
      components: { vae: "stale-vae", llm: "stale-llm", taesd: "stale-tae" },
      runtime: { backend: "", refImagePreset: "", extraArgs: "", offloadCpu: false, quantType: "" },
    });
    expect(result.missing).toEqual([]);
    expect(result.modelField).toBe("model");
    expect(result.args.model).toContain("model.safetensors.index.json");
    for (const key of ["diffusion-model", "vae", "llm", "taesd"]) expect(result.args).not.toHaveProperty(key);
    expect(result.args).toMatchObject({ fa: true, rng: "cuda" });
  });

  it("offers official defaults and 32-pixel spatial alignment", () => {
    expect(familyDefaults(family, "img_gen")).toMatchObject({
      width: 2048, height: 2048,
      sample_params: { sample_steps: 50, sample_method: "euler", flow_shift: 3, guidance: { txt_cfg: 4 } },
    });
    expect(alignSizeUp("sensenova-u1", 2049)).toBe(2080);
    expect(scaleSize("sensenova-u1", 2048, 2048, 0.99)).toEqual({ w: 2016, h: 2016 });
    expect(family.sizePresetsByMode?.img_gen?.[0].sizes).toContainEqual(["2048", 2048, 2048]);
  });

  it("restricts generic HTTP features without mutating the server response", () => {
    const protocol = { init_image: true, ref_images: true, mask_image: true, vae_tiling: true, hires: true, lora: true };
    const limited = applyFamilyFeatureLimits(protocol, family);
    expect(limited).toMatchObject({ init_image: false, ref_images: false, mask_image: false, vae_tiling: false, hires: false, lora: true });
    expect(protocol.init_image).toBe(true);
  });

  it("never submits stale images from another family", () => {
    expect(filterFamilyInputs(images, family)).toEqual({
      initImage: null, maskImage: null, controlImage: null, ipAdapterImage: null,
      endImage: null, refImages: [], controlFrames: [],
    });
    expect(images.refImages).toEqual(["reference"]);
    expect(filterFamilyInputs(images, FAMILY_CONFIG.flux)).toEqual(images);
  });
});
