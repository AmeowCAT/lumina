import {
  FAMILY_CONFIG,
  PID_VAE_FORMATS,
  type FamilyConfig,
  type RequiredInput,
} from "../config/families";
import type {
  GenImages,
  GenMode,
  ModelConfigSnapshot,
  ServerArgs,
  Settings,
} from "../types";
import { deepMerge } from "./utils";

/** Runtime settings shared by the dashboard and model-switch workflow. */
export type LaunchRuntime = Pick<
  Settings,
  | "backend"
  | "refImagePreset"
  | "vaeFormat"
  | "extraArgs"
  | "offloadCpu"
  | "quantType"
  | "maxVram"
>;

export interface BuildLaunchConfigInput {
  family: string;
  modelPath: string;
  components: Record<string, string>;
  runtime: LaunchRuntime | ModelConfigSnapshot;
  modelDir?: string;
}

export interface BuiltLaunchConfig {
  family: string;
  familyConfig: FamilyConfig;
  args: ServerArgs;
  modelField: string;
  mode: GenMode | null;
  missing: string[];
}

export function findModelField(config: FamilyConfig) {
  return (
    config.fields.find((field) => field.arg === "diffusion-model") ||
    config.fields.find((field) => field.arg === "model") ||
    config.fields.find((field) => field.cat === "model") ||
    null
  );
}

function runtimeValue<K extends keyof LaunchRuntime>(
  runtime: LaunchRuntime | ModelConfigSnapshot,
  key: K
): LaunchRuntime[K] {
  return runtime[key] as LaunchRuntime[K];
}

/** Build the exact sd-server CLI argument map used for a model launch. */
export function buildLaunchConfig({
  family,
  modelPath,
  components,
  runtime,
  modelDir,
}: BuildLaunchConfigInput): BuiltLaunchConfig {
  const familyConfig = FAMILY_CONFIG[family];
  if (!familyConfig) throw new Error("无法识别模型类型");

  const modelField = findModelField(familyConfig);
  if (!modelField) throw new Error("模型家族没有定义主模型参数");

  const args: ServerArgs = { ...familyConfig.fixedArgs };
  const missing: string[] = [];
  args[modelField.arg] = modelPath;

  for (const field of familyConfig.fields) {
    if (field.key === modelField.key) continue;
    const value = components[field.key];
    if (value) {
      args[field.arg] = value;
    } else if (family !== "custom" && field.required) {
      missing.push(field.label);
    }
  }

  const backend = runtimeValue(runtime, "backend");
  const refImagePreset = runtimeValue(runtime, "refImagePreset");
  const vaeFormat = runtimeValue(runtime, "vaeFormat");
  const extraArgs = runtimeValue(runtime, "extraArgs");
  const quantType = runtimeValue(runtime, "quantType");
  const maxVram = runtimeValue(runtime, "maxVram");

  if (modelDir) {
    args["lora-model-dir"] = modelDir;
    args["embd-dir"] = modelDir;
    args["hires-upscalers-dir"] = modelDir;
  }
  if (backend) args.backend = backend;
  if (refImagePreset) args["ref-image-args"] = `preset=${refImagePreset}`;
  if (runtimeValue(runtime, "offloadCpu")) args["offload-to-cpu"] = true;
  if (quantType) args.type = quantType;
  // --max-vram 为空/纯空白时不传该参数：引擎不设置图切分预算。
  if (maxVram && maxVram.trim()) args["max-vram"] = maxVram.trim();
  if (extraArgs) args.extra_args = extraArgs;

  if (family === "pid") {
    const validVaeFormat = PID_VAE_FORMATS.some(
      (option) => option.value === vaeFormat
    );
    if (validVaeFormat) {
      args["vae-format"] = vaeFormat as string;
    } else {
      missing.push("VAE 格式（--vae-format）");
    }
  }

  return {
    family,
    familyConfig,
    args,
    modelField: modelField.key,
    mode: familyConfig.mode === "vid" ? "vid_gen" : null,
    missing,
  };
}

export function familyPreferredMode(config: FamilyConfig): GenMode {
  return config.mode === "vid" ? "vid_gen" : "img_gen";
}

/** Return defaults for a concrete generation mode, preserving old metadata. */
export function familyDefaults(config: FamilyConfig, mode: GenMode) {
  const specific = config.genDefaultsByMode?.[mode];
  const legacy = familyPreferredMode(config) === mode ? config.genDefaults : undefined;
  if (specific && legacy) return deepMerge({ ...legacy }, specific);
  return specific || legacy;
}

/** Persist every mode-specific family preset while retaining user prompts. */
export function persistFamilyDefaults(config: FamilyConfig, storage?: Storage) {
  const target = storage || globalThis.localStorage;
  const modes = new Set<GenMode>();
  if (config.genDefaults) modes.add(familyPreferredMode(config));
  for (const mode of Object.keys(config.genDefaultsByMode || {}) as GenMode[]) {
    modes.add(mode);
  }

  for (const mode of modes) {
    const defaults = familyDefaults(config, mode);
    if (!defaults) continue;
    try {
      let previous: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(target.getItem(`sdcpp:params:${mode}`) || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          previous = parsed as Record<string, unknown>;
        }
      } catch {
        // A malformed previous preset should not prevent writing the new one.
      }
      target.setItem(
        `sdcpp:params:${mode}`,
        JSON.stringify({
          ...defaults,
          prompt: typeof previous.prompt === "string" ? previous.prompt : "",
          negative_prompt:
            typeof previous.negative_prompt === "string" ? previous.negative_prompt : "",
        })
      );
    } catch {
      // Parameter persistence is best-effort; launching the server still succeeds.
    }
  }
}

export function inferPidVaeFormat(modelPath: string): string {
  const path = modelPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  if (path.includes("qwen") || path.includes("qwen-image")) return "wan";
  if (path.includes("flux2") || path.includes("flux-2") || path.includes("flux_2")) {
    return "flux2";
  }
  if (path.includes("sd3") || path.includes("sd_3") || path.includes("sd-3")) {
    return "sd3";
  }
  if (
    path.includes("flux") ||
    path.includes("zimage") ||
    path.includes("z-image") ||
    path.includes("z_image")
  ) {
    return "flux";
  }
  return "";
}

export function requiredInputLabel(input: RequiredInput): string {
  switch (input) {
    case "ref_images":
      return "参考图片";
    case "init_image":
      return "初始图片";
    case "end_image":
      return "结束帧";
  }
}

export function missingRequiredInputs(
  config: FamilyConfig | undefined,
  mode: GenMode,
  images: GenImages
): string[] {
  const required = config?.requiredInputsByMode?.[mode] || [];
  return required
    .filter((input) => {
      if (input === "ref_images") return images.refImages.length === 0;
      if (input === "init_image") return !images.initImage;
      return !images.endImage;
    })
    .map(requiredInputLabel);
}
