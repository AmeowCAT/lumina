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

const MAX_VRAM_DEVICE_RE = /^[A-Za-z0-9_.+*-]+$/;
// 与上游 parse_strict_float（std::stof + isfinite）对齐：十进制浮点
// （1e3、.5、+2、-1.5e-2）及 C99 十六进制浮点（0x10、0x1p3、0x.8p1）都合法，
// 仅 inf/nan 被 isfinite 拦掉。
const MAX_VRAM_NUM_RE =
  /^[+-]?((\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|0[xX]([0-9a-fA-F]+(\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)([pP][+-]?\d+)?)$/;

/** 形状合法还不够——1e999 / 0x1p9999 会溢出成 inf,被上游 isfinite 拒绝;
 *  预校验同步拦掉,免得启动时才报可读性差的错误（审查 L6）。 */
function isFiniteC99Float(s: string): boolean {
  if (!/^[+-]?0[xX]/.test(s)) return Number.isFinite(Number(s));
  // JS 不解析 C99 十六进制浮点,手算 mantissa × 2^exp 判溢出。
  const body = s.replace(/^[+-]/, "").slice(2);
  const [mant, exp] = body.split(/[pP]/);
  const [intPart, fracPart = ""] = mant.split(".");
  const mantVal =
    (intPart ? parseInt(intPart, 16) : 0) +
    (fracPart ? parseInt(fracPart, 16) / 16 ** fracPart.length : 0);
  return Number.isFinite(mantVal * 2 ** (exp ? parseInt(exp, 10) : 0));
}

/** 预校验 --max-vram 原始 spec（上游 ggml_graph_cut 解析失败会让 sd-server
 * 启动即退，GUI 提前拦截给出可读错误）。返回错误消息或 null。
 * 与上游 MaxVramAssignment::parse 对齐：逗号分段逐段解析，无 `=` 的段
 * 设置全局默认预算（后者覆盖前者），`设备=数值` 段设置单设备预算，
 * 空段跳过，`all`/`default`/`*` 是合法的默认预算键。 */
export function validateMaxVramSpec(raw: string): string | null {
  const spec = raw.trim();
  if (!spec) return null;
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue; // 上游跳过空段
    const eq = p.indexOf("=");
    if (eq < 0) {
      // 无 `=`：整段是全局默认预算数值（可与设备段混用，如 "6,cuda0=4"）。
      if (!MAX_VRAM_NUM_RE.test(p)) {
        return `应为数字（GiB）或负的保留余量，如 6 或 -2：${p}`;
      }
      if (!isFiniteC99Float(p)) {
        return `数值超出可表示范围（溢出为 inf）：${p}`;
      }
      continue;
    }
    if (eq === 0) return `设备分配项格式应为 设备=数值：${p}`;
    const device = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!MAX_VRAM_DEVICE_RE.test(device)) {
      return `设备名包含非法字符：${device}`;
    }
    if (!MAX_VRAM_NUM_RE.test(value)) {
      return `设备 ${device} 的预算应为数字（GiB），如 ${device}=6`;
    }
    if (!isFiniteC99Float(value)) {
      return `设备 ${device} 的预算数值超出可表示范围（溢出为 inf）`;
    }
  }
  return null;
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
