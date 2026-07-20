import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { FAMILY_CONFIG, type FamilyConfig } from "../config/families";
import type {
  Capabilities,
  GenMode,
  ModelConfigSnapshot,
  ServerArgs,
} from "../types";
import { formatError } from "../lib/utils";

type SwitchPhase = "idle" | "preflight" | "stopping" | "starting" | "loading" | "rollback";

interface LaunchConfig {
  family: string;
  familyConfig: FamilyConfig;
  args: ServerArgs;
  mode: GenMode | null;
  modelPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizedPath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export function capabilitiesMatchModel(
  capabilities: Capabilities,
  expectedPath: string
): boolean {
  const reportedPath = capabilities.model?.path?.trim();
  if (!reportedPath) return true;
  const actual = normalizedPath(reportedPath);
  const expected = normalizedPath(expectedPath);
  const expectedName = expected.split("/").pop() || expected;
  return actual === expected || actual.endsWith("/" + expectedName);
}

export function useModelSwitch() {
  const [phase, setPhase] = useState<SwitchPhase>("idle");
  const [targetModel, setTargetModel] = useState("");
  const settings = useStore((s) => s.settings);
  const components = useStore((s) => s.components);
  const familyOverride = useStore((s) => s.familyOverride);
  const caps = useStore((s) => s.caps);
  const setCaps = useStore((s) => s.setCaps);
  const setMode = useStore((s) => s.setMode);
  const toast = useStore((s) => s.toast);
  const switching = phase !== "idle";

  const buildLaunchConfig = async (
    modelPath: string,
    snapshot?: ModelConfigSnapshot
  ): Promise<LaunchConfig> => {
    const family = snapshot?.familyOverride || (await api.detectFamily(modelPath));
    const familyConfig = FAMILY_CONFIG[family];
    if (!familyConfig) throw new Error("无法识别模型类型");

    const args: ServerArgs = { ...familyConfig.fixedArgs };
    const modelField = familyConfig.fields.find(
      (field) =>
        field.arg === "diffusion-model" || field.arg === "model" || field.cat === "model"
    );
    if (!modelField) throw new Error("模型家族没有定义主模型参数");
    args[modelField.arg] = modelPath;

    const configuredComponents = snapshot?.components || components;
    const missing: string[] = [];
    familyConfig.fields.forEach((field) => {
      if (field.key === modelField.key) return;
      const value = configuredComponents[field.key];
      if (value) args[field.arg] = value;
      else if (family !== "custom" && field.required) missing.push(field.label);
    });
    if (missing.length > 0) {
      throw new Error("缺少必需组件：" + missing.join("、"));
    }

    if (settings.modelDir) {
      args["lora-model-dir"] = settings.modelDir;
      args["embd-dir"] = settings.modelDir;
      args["hires-upscalers-dir"] = settings.modelDir;
    }
    const runtime = snapshot || settings;
    if (runtime.backend) args.backend = runtime.backend;
    if (runtime.refImagePreset)
      args["ref-image-args"] = `preset=${runtime.refImagePreset}`;
    if (runtime.offloadCpu) args["offload-to-cpu"] = true;
    if (runtime.quantType) args.type = runtime.quantType;
    if (runtime.extraArgs) args.extra_args = runtime.extraArgs;

    return {
      family,
      familyConfig,
      args,
      mode: familyConfig.mode === "vid" ? "vid_gen" : null,
      modelPath,
    };
  };

  const waitUntilReady = async (expectedPath: string): Promise<Capabilities> => {
    const deadline = Date.now() + 180_000;
    let lastError = "服务器尚未就绪";
    while (Date.now() < deadline) {
      try {
        const status = await api.serverStatus();
        if (status.reachable) {
          const nextCaps = await api.sdcppCapabilities();
          if (capabilitiesMatchModel(nextCaps, expectedPath)) {
            return nextCaps;
          }
          lastError = `服务器报告了不同模型：${nextCaps.model?.path}`;
        }
      } catch (e) {
        lastError = formatError(e);
      }
      await sleep(1000);
    }
    throw new Error(`等待模型就绪超时：${lastError}`);
  };

  const startAndWait = async (config: LaunchConfig) => {
    const exePath = settings.exeDir || "sd-server";
    await api.startServer(
      exePath,
      config.familyConfig.name,
      config.mode,
      config.args
    );
    setPhase("loading");
    return waitUntilReady(config.modelPath);
  };

  const persistDefaults = (config: LaunchConfig) => {
    const defaults = config.familyConfig.genDefaults;
    if (!defaults) return;
    const modeKey = config.familyConfig.mode === "vid" ? "vid_gen" : "img_gen";
    try {
      const previous = JSON.parse(
        localStorage.getItem("sdcpp:params:" + modeKey) || "{}"
      );
      localStorage.setItem(
        "sdcpp:params:" + modeKey,
        JSON.stringify({
          ...defaults,
          prompt: typeof previous.prompt === "string" ? previous.prompt : "",
          negative_prompt:
            typeof previous.negative_prompt === "string" ? previous.negative_prompt : "",
        })
      );
    } catch {
      // Parameter persistence is best-effort; the server switch itself succeeded.
    }
  };

  const switchModel = async (modelPath: string) => {
    if (!modelPath || switching) return undefined;
    const previousPath = caps?.model?.path || "";
    let previousConfig: LaunchConfig | null = null;
    try {
      setTargetModel(modelPath);
      setPhase("preflight");
      const snapshots = settings.modelSnapshots || {};
      const nextConfig = await buildLaunchConfig(modelPath, {
        familyOverride,
        components,
        backend: settings.backend,
        refImagePreset: settings.refImagePreset,
        extraArgs: settings.extraArgs,
        offloadCpu: settings.offloadCpu,
        quantType: settings.quantType,
        maxQueueSize: settings.maxQueueSize,
      });
      if (previousPath && previousPath !== modelPath) {
        try {
          previousConfig = await buildLaunchConfig(
            previousPath,
            snapshots[previousPath]
          );
        } catch {
          previousConfig = null;
        }
      }

      setPhase("stopping");
      await api.stopServer();
      setPhase("starting");
      const nextCaps = await startAndWait(nextConfig);
      setCaps(nextCaps);
      if (nextCaps.current_mode) setMode(nextCaps.current_mode);
      persistDefaults(nextConfig);
      toast("已切换到 " + nextConfig.familyConfig.name);
      return nextConfig.family;
    } catch (error) {
      const switchError = formatError(error);
      if (previousConfig) {
        try {
          setPhase("rollback");
          await api.stopServer().catch(() => undefined);
          const restoredCaps = await startAndWait(previousConfig);
          setCaps(restoredCaps);
          if (restoredCaps.current_mode) setMode(restoredCaps.current_mode);
          toast(`切换失败，已恢复上一个模型：${switchError}`, true);
          return undefined;
        } catch (rollbackError) {
          toast(
            `切换失败且无法恢复上一个模型：${switchError}；恢复错误：${formatError(rollbackError)}`,
            true
          );
          return undefined;
        }
      }
      toast("切换失败: " + switchError, true);
      return undefined;
    } finally {
      setPhase("idle");
      setTargetModel("");
    }
  };

  return { switchModel, switching, phase, targetModel };
}
