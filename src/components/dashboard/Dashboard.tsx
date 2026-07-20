import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import { FAMILY_CONFIG } from "../../config/families";
import { formatError, modelFileOptionLabel } from "../../lib/utils";
import type { ServerArgs } from "../../types";
import { Panel } from "../ui/Panel";
import { IC } from "../ui/Icons";
import { Logo } from "../ui/Logo";
import { NumberInput } from "../ui/NumberInput";
import { useModelSwitch } from "../../hooks/useModelSwitch";

export function Dashboard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const serverStatus = useStore((s) => s.serverStatus);
  const caps = useStore((s) => s.caps);
  const jobs = useStore((s) => s.jobs);
  const results = useStore((s) => s.results);
  const scanResult = useStore((s) => s.scanResult);
  const setScanResult = useStore((s) => s.setScanResult);
  const mainModel = useStore((s) => s.mainModel);
  const setMainModel = useStore((s) => s.setMainModel);
  const familyOverride = useStore((s) => s.familyOverride);
  const setFamilyOverride = useStore((s) => s.setFamilyOverride);
  const components = useStore((s) => s.components);
  const setComponents = useStore((s) => s.setComponents);
  const toast = useStore((s) => s.toast);
  const setDashboardOpen = useStore((s) => s.setDashboardOpen);
  const [starting, setStarting] = useState(false);
  const { switchModel, switching: switchingModel, phase: switchPhase } = useModelSwitch();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [settingsState, setSettingsState] = useState<
    "loading" | "saved" | "saving" | "error"
  >("loading");
  const scanRequest = useRef(0);
  // 磁盘设置是否已加载完成：加载完成前禁止自动保存，否则挂载瞬间会把
  // 初始空 settings 写盘，与 loadSettings 竞争，可能覆盖掉用户的配置文件。
  const settingsLoaded = useRef(false);

  useEffect(() => {
    api
      .loadSettings()
      .then((s) => {
        const { loadWarning, ...persisted } = s;
        useStore.setState({ settings: persisted });
        settingsLoaded.current = true;
        if (loadWarning) {
          setSettingsState("error");
          toast(
            `${loadWarning.message}${
              loadWarning.backupPath ? `；原文件已备份到 ${loadWarning.backupPath}` : ""
            }`,
            true
          );
        } else {
          setSettingsState("saved");
        }
      })
      .catch((e) => {
        settingsLoaded.current = true;
        setSettingsState("error");
        toast("设置加载失败: " + formatError(e), true);
      });
  }, [toast]);

  useEffect(() => {
    if (!settingsLoaded.current) return;
    // 防抖：路径输入框每敲一个字符都会触发本 effect，不能每次都写盘。
    const t = setTimeout(() => {
      setSettingsState("saving");
      api
        .saveSettings(settings)
        .then(() => setSettingsState("saved"))
        .catch((e) => {
          setSettingsState("error");
          toast("设置保存失败: " + formatError(e), true);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    const requestId = ++scanRequest.current;
    setMainModel("");
    setFamilyOverride("");
    setComponents(() => ({}));
    setScanResult(null);
    setScanError("");
    if (!settings.modelDir.trim()) {
      setScanning(false);
      return;
    }
    const dir = settings.modelDir.trim();
    const timer = setTimeout(() => {
      setScanning(true);
      api
        .scanModels(dir)
        .then((result) => {
          if (scanRequest.current !== requestId) return;
          setScanResult(result);
          setScanning(false);
        })
        .catch((e) => {
          if (scanRequest.current !== requestId) return;
          const message = formatError(e);
          setScanError(message);
          setScanning(false);
          toast("扫描失败: " + message, true);
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      if (scanRequest.current === requestId) setScanning(false);
    };
  }, [
    settings.modelDir,
    setComponents,
    setFamilyOverride,
    setMainModel,
    setScanResult,
    toast,
  ]);

  const files = scanResult?.files ?? [];
  const scanFamilies = scanResult?.families ?? {};
  // 主模型只能从扫描结果（category=model）中选出，scanFamilies（Rust 端
  // detect_family 的结果）必有对应条目；不再保留前端正则回退。
  const detectedFamily = mainModel
    ? familyOverride || scanFamilies[mainModel] || "custom"
    : "";
  const familyConfig = detectedFamily ? FAMILY_CONFIG[detectedFamily] : null;
  // The "主模型" picker already selects the primary model file, so it doubles
  // as the family's main model arg (--diffusion-model for split families, -m
  // for single-file). The matching field is hidden from the component panel so
  // users don't have to pick the same file twice.
  const modelField = familyConfig
    ? familyConfig.fields.find((f) => f.arg === "diffusion-model") ||
      familyConfig.fields.find((f) => f.arg === "model") ||
      familyConfig.fields.find((f) => f.cat === "model") ||
      null
    : null;
  const modelCandidates = files.filter((f) => f.category === "model");
  const mainModelDir = mainModel
    ? files.find((f) => f.path === mainModel)?.dir
    : undefined;

  const getOptions = (cat: string) => files.filter((f) => f.category === cat);

  useEffect(() => {
    if (!mainModel || !familyConfig) return;
    setComponents((current) => {
      const next: Record<string, string> = {};
      for (const field of familyConfig.fields) {
        if (field.key === modelField?.key) continue;
        const candidates = files.filter((f) => f.category === field.cat);
        const currentValid = candidates.some((f) => f.path === current[field.key]);
        if (currentValid) {
          next[field.key] = current[field.key];
          continue;
        }
        const sameDir = candidates.filter((f) => f.dir === mainModelDir);
        if (sameDir.length === 1) next[field.key] = sameDir[0].path;
        else if (candidates.length === 1) next[field.key] = candidates[0].path;
      }
      return next;
    });
  }, [
    detectedFamily,
    familyConfig,
    files,
    mainModel,
    mainModelDir,
    modelField?.key,
    setComponents,
  ]);

  const missingFields =
    familyConfig && detectedFamily !== "custom"
      ? familyConfig.fields.filter(
          (field) =>
            field.key !== modelField?.key && field.required && !components[field.key]
        )
      : [];

  const browse = async (key: "exeDir" | "modelDir" | "outputDir") => {
    const p = key === "exeDir" ? await api.pickFile() : await api.pickFolder();
    if (p) setSettings((s) => ({ ...s, [key]: p }));
  };

  const selectMainModel = (path: string) => {
    setMainModel(path);
    const snapshot = path ? settings.modelSnapshots?.[path] : undefined;
    if (!snapshot) {
      setFamilyOverride("");
      setComponents(() => ({}));
      return;
    }
    setFamilyOverride(snapshot.familyOverride);
    setComponents(() => ({ ...snapshot.components }));
    setSettings((current) => ({
      ...current,
      backend: snapshot.backend,
      refImagePreset: snapshot.refImagePreset,
      extraArgs: snapshot.extraArgs,
      offloadCpu: snapshot.offloadCpu,
      quantType: snapshot.quantType,
      maxQueueSize: snapshot.maxQueueSize,
    }));
    toast("已恢复该模型上次启动配置");
  };

  const saveModelSnapshot = () => {
    if (!mainModel) return;
    setSettings((current) => ({
      ...current,
      modelSnapshots: {
        ...(current.modelSnapshots || {}),
        [mainModel]: {
          familyOverride,
          components: { ...components },
          backend: current.backend,
          refImagePreset: current.refImagePreset,
          extraArgs: current.extraArgs,
          offloadCpu: current.offloadCpu,
          quantType: current.quantType,
          maxQueueSize: current.maxQueueSize,
        },
      },
    }));
  };

  const startServer = async () => {
    if (!mainModel) {
      toast("请先选择模型", true);
      return;
    }
    if (!familyConfig) {
      toast("无法识别模型类型", true);
      return;
    }
    if (missingFields.length > 0) {
      toast(
        "缺少必需组件: " + missingFields.map((field) => field.label).join("、"),
        true
      );
      return;
    }
    if (serverStatus?.reachable) {
      if (serverStatus.external) {
        toast("当前连接的是外部 sd-server，请先在外部停止服务后再更换模型", true);
        return;
      }
      if (caps?.model?.path === mainModel) {
        setDashboardOpen(false);
        return;
      }
      const activeJobs = jobs.filter(
        (job) =>
          job.status === "queued" ||
          job.status === "generating" ||
          job.status === "unknown"
      ).length;
      const unsavedResults = results.filter(
        (result) => result.saveStatus !== "saved"
      ).length;
      const impacts = [
        activeJobs > 0 ? `${activeJobs} 个活动任务` : "",
        unsavedResults > 0 ? `${unsavedResults} 个尚未安全保存的结果` : "",
      ].filter(Boolean);
      if (
        impacts.length > 0 &&
        !window.confirm(
          `切换模型会停止当前服务，并影响${impacts.join("、")}。是否继续？`
        )
      ) {
        return;
      }
      setStarting(true);
      try {
        const switched = await switchModel(mainModel);
        if (switched) {
          saveModelSnapshot();
          setDashboardOpen(false);
        }
      } finally {
        setStarting(false);
      }
      return;
    }
    setStarting(true);
    try {
      const args: ServerArgs = { ...familyConfig.fixedArgs };
      // The main model picked above is the family's primary model arg.
      if (modelField && mainModel) args[modelField.arg] = mainModel;
      familyConfig.fields.forEach((f) => {
        if (f.key === modelField?.key) return;
        if (components[f.key]) args[f.arg] = components[f.key];
      });
      if (settings.modelDir) args["lora-model-dir"] = settings.modelDir;
      if (settings.modelDir) args["embd-dir"] = settings.modelDir;
      if (settings.modelDir) args["hires-upscalers-dir"] = settings.modelDir;
      if (settings.backend) args["backend"] = settings.backend;
      if (settings.refImagePreset)
        args["ref-image-args"] = `preset=${settings.refImagePreset}`;
      if (settings.offloadCpu) args["offload-to-cpu"] = true;
      if (settings.quantType) args["type"] = settings.quantType;
      if (settings.extraArgs) args["extra_args"] = settings.extraArgs;
      // 目录还是完整可执行文件路径都原样交给 Rust 端解析（is_file 探测），
      // 这里不做平台相关的拼接（"\\sd-server.exe" 会破坏 Linux/macOS）。
      const exePath = settings.exeDir || "sd-server";
      const mode = familyConfig.mode === "vid" ? "vid_gen" : null;
      await api.startServer(exePath, familyConfig.name, mode, args);
      saveModelSnapshot();
      // Persist recommended defaults so GenerationUI picks them up.
      // 保留用户上次的提示词：家族推荐值只应重置采样参数，
      // 不应把正/负向提示词也清空（重启服务器丢提示词非常恼人）。
      if (familyConfig.genDefaults) {
        const modeKey = familyConfig.mode === "vid" ? "vid_gen" : "img_gen";
        const storageKey = "sdcpp:params:" + modeKey;
        try {
          let prevPrompt = "";
          let prevNegative = "";
          try {
            const prev = JSON.parse(localStorage.getItem(storageKey) || "{}");
            prevPrompt = typeof prev.prompt === "string" ? prev.prompt : "";
            prevNegative =
              typeof prev.negative_prompt === "string" ? prev.negative_prompt : "";
          } catch {
            /* ignore malformed previous params */
          }
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              ...familyConfig.genDefaults,
              prompt: prevPrompt,
              negative_prompt: prevNegative,
            })
          );
        } catch {
          /* ignore */
        }
      }
      toast("服务器启动中...");
    } catch (e) {
      toast("启动失败: " + formatError(e), true);
    } finally {
      setStarting(false);
    }
  };

  const stopServer = async () => {
    try {
      const result = await api.stopServer();
      if (!result.stopped && !result.alreadyStopped) {
        throw new Error("未能确认服务器已经停止");
      }
      toast("已停止");
    } catch (e) {
      toast("停止失败: " + formatError(e), true);
    }
  };

  const running = serverStatus?.running ?? false;
  const external = serverStatus?.external ?? false;

  return (
    <div className="dashboard">
      <div className="dashboard-card">
        <h2 className="brand-title">
          <Logo size={34} />
          <span>流光 Lumina</span>
        </h2>
        <div className="subtitle">
          配置 sd-server 与模型，启动后进入生成界面
        </div>
        <div className={`settings-state ${settingsState}`} role="status">
          {settingsState === "loading"
            ? "正在读取设置…"
            : settingsState === "saving"
              ? "正在保存设置…"
              : settingsState === "error"
                ? "设置未保存，请检查配置目录权限"
                : "设置已保存"}
        </div>

        <div className="server-bar">
          <span
            className={`status-dot ${running || external ? "online" : "offline"}`}
            style={{ marginRight: 8 }}
          />
          <div className="status-info">
            <div className="model-name">
              {running
                ? serverStatus?.model || "sd-server"
                : serverStatus?.external
                  ? "外部 sd-server"
                  : "未运行"}
            </div>
            <div className="status-text">
              {running
                ? serverStatus?.phase === "failed"
                  ? `启动失败：${serverStatus.lastError || "请查看日志"}`
                  : serverStatus?.reachable
                  ? "就绪"
                  : serverStatus?.phase === "starting"
                    ? "正在加载模型…"
                    : "正在启动…"
                : serverStatus?.external
                  ? "就绪（外部进程）"
                  : "等待启动"}
            </div>
          </div>
          {running && !external && (
            <button
              className="btn btn-danger btn-sm"
              onClick={stopServer}
              disabled={starting}
            >
              {IC.power} 停止
            </button>
          )}
          {external && (
            <span className="tag" style={{ fontSize: 11, opacity: 0.7 }}>
              外部进程
            </span>
          )}
          {serverStatus?.reachable && (
            <button
              className="btn btn-sm"
              onClick={() => setDashboardOpen(false)}
            >
              进入生成界面
            </button>
          )}
        </div>

        <Panel title="程序与路径">
          <div className="field-row">
            <label className="form-label" htmlFor="dashboard-server-exe">{IC.box} sd-server</label>
            <input
              id="dashboard-server-exe"
              type="text"
              value={settings.exeDir}
              onChange={(e) =>
                setSettings((s) => ({ ...s, exeDir: e.target.value }))
              }
              placeholder="可留空从 PATH 查找，或选择 sd-server 可执行文件"
            />
            <button
              className="icon-btn"
              title="浏览..."
              onClick={() => browse("exeDir")}
            >
              {IC.folder}
            </button>
          </div>
          <div className="field-hint">sd-server 可执行文件；留空时从 PATH 查找</div>
          <div className="field-row">
            <label className="form-label" htmlFor="dashboard-model-dir">{IC.folder} 模型目录</label>
            <input
              id="dashboard-model-dir"
              type="text"
              value={settings.modelDir}
              onChange={(e) =>
                setSettings((s) => ({ ...s, modelDir: e.target.value }))
              }
              placeholder="例如 D:\models"
            />
            <button
              className="icon-btn"
              title="浏览..."
              onClick={() => browse("modelDir")}
            >
              {IC.folder}
            </button>
          </div>
          <div className="field-hint">
            {scanning
              ? `正在扫描：${settings.modelDir}`
              : scanError
                ? `扫描失败：${scanError}`
                : files.length
                  ? `已发现 ${files.length} 个文件${scanResult?.truncated ? "（结果已截断）" : ""}`
                  : settings.modelDir
                    ? "扫描完成，未发现支持的模型文件"
                    : "扫描模型文件的根目录"}
          </div>
          {!!scanResult?.warnings?.length && (
            <div className="scan-warning" role="alert">
              扫描部分完成：
              {scanResult.warnings
                .slice(0, 3)
                .map((warning) => warning.message)
                .join("；")}
              {scanResult.warnings.length > 3
                ? `；另有 ${scanResult.warnings.length - 3} 项警告`
                : ""}
            </div>
          )}
          <div className="field-row">
            <label className="form-label" htmlFor="dashboard-output-dir">{IC.folder} 输出目录</label>
            <input
              id="dashboard-output-dir"
              type="text"
              value={settings.outputDir}
              onChange={(e) =>
                setSettings((s) => ({ ...s, outputDir: e.target.value }))
              }
              placeholder="例如 D:\output（留空则不自动保存）"
            />
            <button
              className="icon-btn"
              title="浏览..."
              onClick={() => browse("outputDir")}
            >
              {IC.folder}
            </button>
          </div>
          <div className="field-hint">生成图片/视频的保存路径</div>
        </Panel>

        <Panel title="运行后端" collapsed>
          <div className="form-row">
            <label className="form-label" htmlFor="dashboard-backend-preset">后端预设</label>
            <select
              id="dashboard-backend-preset"
              value={settings.backend || "auto"}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  backend: e.target.value === "auto" ? "" : e.target.value,
                }))
              }
            >
              <option value="auto">自动（默认）</option>
              <option value="gpu">首个可用 GPU</option>
              <option value="cuda0">CUDA</option>
              <option value="rocm">AMD ROCm / HIP</option>
              <option value="vulkan0">Vulkan</option>
              <option value="cpu">仅 CPU</option>
            </select>
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="form-label" htmlFor="dashboard-backend-custom">自定义 --backend</label>
            <input
              id="dashboard-backend-custom"
              type="text"
              value={settings.backend}
              onChange={(e) =>
                setSettings((s) => ({ ...s, backend: e.target.value }))
              }
              placeholder="例如 cuda0 或 clip=cpu,vae=cuda0,diffusion=vulkan0"
            />
            <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
              支持组件级分配，如 clip=cpu,diffusion=cuda0
            </div>
          </div>
          </Panel>

          <Panel title="参考图处理" collapsed>
            <div className="form-row">
              <label className="form-label" htmlFor="dashboard-ref-image-preset">
                处理预设
              </label>
              <select
                id="dashboard-ref-image-preset"
                value={settings.refImagePreset}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, refImagePreset: e.target.value }))
                }
              >
                <option value="">自动检测（推荐）</option>
                <option value="flux_kontext">Flux Kontext</option>
                <option value="longcat">LongCat Edit</option>
                <option value="qwen">Qwen Image Edit</option>
                <option value="qwen_layered">Qwen Image Layered</option>
                <option value="flux2">Flux 2</option>
                <option value="z_image_omni">Boogu / Z-Image Omni</option>
                <option value="krea2_ostris_edit">Krea2 Ostris Edit</option>
                <option value="krea2_edit">Krea2 Edit 768</option>
                <option value="cosmos_reference">Anima / Cosmos Reference</option>
              </select>
              <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
                作为 --ref-image-args preset=… 在模型启动时传给 sd-server；通常保持自动即可
              </div>
              {(detectedFamily === "krea2" || detectedFamily === "krea2-turbo") && (
                <div className="field-hint" style={{ margin: "4px 0 0 0" }}>
                  Krea2 自动模式使用 Ostris Edit；仅 lbouaraba/krea2edit 一类模型选择
                  “Krea2 Edit 768”
                </div>
              )}
            </div>
          </Panel>

          <Panel title="性能与显存" collapsed>
            <div className="form-row">
              <label className="form-label">
                <input
                  type="checkbox"
                  checked={settings.offloadCpu}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, offloadCpu: e.target.checked }))
                  }
                  style={{ marginRight: 6 }}
                />
                CPU 卸载（--offload-to-cpu）
              </label>
              <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
                将部分层卸载到 CPU 以节省显存，适合低显存跑大模型
              </div>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <label className="form-label" htmlFor="dashboard-quant-type">加载时量化（--type）</label>
              <select
                id="dashboard-quant-type"
                value={settings.quantType}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, quantType: e.target.value }))
                }
              >
                <option value="">不量化（默认）</option>
                <option value="q4_0">Q4_0</option>
                <option value="q4_1">Q4_1</option>
                <option value="q5_0">Q5_0</option>
                <option value="q5_1">Q5_1</option>
                <option value="q8_0">Q8_0</option>
                <option value="f16">F16</option>
              </select>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <label className="form-label" htmlFor="dashboard-extra-args">附加启动参数</label>
              <input
                id="dashboard-extra-args"
                type="text"
                value={settings.extraArgs}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, extraArgs: e.target.value }))
                }
                placeholder="例如 --threads 8 --mmap --stream-layers"
              />
              <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
                原样拼接到 sd-server 命令行，兜底所有未在界面暴露的参数
              </div>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <label className="form-label" htmlFor="dashboard-max-queue">最大队列</label>
              <NumberInput
                id="dashboard-max-queue"
                style={{ width: 80 }}
                value={settings.maxQueueSize ?? 4}
                min={1}
                max={32}
                onChange={(value) =>
                  setSettings((s) => ({ ...s, maxQueueSize: value }))
                }
                ariaLabel="最大队列数量"
              />
              <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
                生成队列上限（服务器未提供时生效）
              </div>
            </div>
          </Panel>

          {(files.length > 0 || scanning) && (
          <Panel title="模型检测">
            {scanning ? (
              <div className="empty-state"><span className="spinner" /> 正在扫描模型…</div>
            ) : modelCandidates.length === 0 ? (
              <div className="empty-state">发现了文件，但没有可作为主模型的候选项</div>
            ) : (
              <>
            <div className="form-row">
              <label className="form-label" htmlFor="dashboard-main-model">主模型</label>
              <select
                id="dashboard-main-model"
                value={mainModel}
                onChange={(e) => selectMainModel(e.target.value)}
              >
                <option value="">-- 选择模型 --</option>
                {modelCandidates.map((f) => (
                  <option key={f.path} value={f.path}>
                    {modelFileOptionLabel(f)}
                  </option>
                ))}
              </select>
            </div>
            {mainModel && detectedFamily && (
              <div className="form-row" style={{ marginTop: 8 }}>
                <label className="form-label" htmlFor="dashboard-family">识别类型</label>
                <select
                  id="dashboard-family"
                  value={familyOverride || detectedFamily}
                  onChange={(e) => setFamilyOverride(e.target.value)}
                >
                  {Object.entries(FAMILY_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.name}
                    </option>
                  ))}
                </select>
                {familyConfig && (
                  <span className="tag" style={{ marginLeft: 4 }}>
                    {familyConfig.hint}
                  </span>
                )}
              </div>
            )}
              </>
            )}
          </Panel>
        )}

        {mainModel && familyConfig && (
          <>
            {familyConfig.fields.filter((f) => f.key !== modelField?.key).length > 0 && (
              <Panel title={`组件配置 — ${familyConfig.name}`}>
                {familyConfig.fields
                  .filter((field) => field.key !== modelField?.key)
                  .map((field) => {
                    const opts = getOptions(field.cat);
                    const val = components[field.key] || "";
                    return (
                      <div key={field.key} className="form-row">
                        <label className="form-label" htmlFor={`component-${field.key}`}>
                          {field.label}
                        </label>
                        <select
                          id={`component-${field.key}`}
                          value={val}
                          onChange={(e) =>
                            setComponents((c) => ({ ...c, [field.key]: e.target.value }))
                          }
                        >
                          <option value="">
                            {field.required && detectedFamily !== "custom"
                              ? "-- 必需，尚未设置 --"
                              : "-- 未设置（可选） --"}
                          </option>
                          {opts.map((f) => (
                            <option key={f.path} value={f.path}>
                              {modelFileOptionLabel(f)}
                              {f.dir !== mainModelDir
                                ? " — " + f.dir.split("/").pop()
                                : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
              </Panel>
            )}
            {missingFields.length > 0 && (
              <div className="validation-summary" role="alert">
                还缺 {missingFields.length} 个必需组件：
                {missingFields.map((field) => field.label).join("、")}
              </div>
            )}
            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={startServer}
                disabled={starting || switchingModel || missingFields.length > 0}
              >
                {starting || switchingModel ? (
                  <>
                    <span className="spinner" />
                    {switchPhase === "preflight"
                      ? "正在检查模型…"
                      : switchPhase === "stopping"
                        ? "正在停止当前模型…"
                        : switchPhase === "rollback"
                          ? "正在恢复上一个模型…"
                          : serverStatus?.reachable
                            ? "正在切换模型…"
                            : "启动中…"}
                  </>
                ) : (
                  <>
                    {IC.play}
                    {serverStatus?.reachable
                      ? caps?.model?.path === mainModel
                        ? "返回生成界面"
                        : "切换到此模型"
                      : "启动服务器"}
                  </>
                )}
              </button>
              {running && !external && (
                <button className="btn btn-danger" onClick={stopServer}>
                  {IC.power} 停止
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
