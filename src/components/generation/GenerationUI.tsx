import { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { api } from "../../api";
import { useStore } from "../../store";
import {
  DISTILL_FAMILIES,
  FAMILY_CONFIG,
  VIDEO_FRAME_PRESETS,
  SIZE_PRESETS,
  scaleSize,
} from "../../config/families";
import {
  buildRequestBody,
  deepClone,
  deepMerge,
  extractApiError,
  formatError,
  LINGBOT_PROMPT_TEMPLATE,
  sdcppMetadataToGenParams,
  validateLingbotPrompt,
} from "../../lib/utils";
import { familyDefaults, missingRequiredInputs } from "../../lib/launchConfig";
import type { GenImages, GenMode, GenParams, Job, JobConfig } from "../../types";
import { Lightbox } from "../ui/Lightbox";
import { ProgressBar } from "../ui/ProgressBar";
import { cn } from "../ui/cn";
import { ResultsGrid } from "./ResultsGrid";
import { JobQueue } from "./JobQueue";
import { HistoryGallery } from "./HistoryGallery";
import { HeaderBar } from "./HeaderBar";
import { PromptDock } from "./PromptDock";
import { QueueDrawer } from "./QueueDrawer";
import { ParamsSheet } from "./ParamsSheet";
import { ImageInputsPanel } from "./panels/ImageInputsPanel";
import { SizeSeedPanel } from "./panels/SizeSeedPanel";
import { SamplingPanel } from "./panels/SamplingPanel";
import { AdvancedSamplingPanel } from "./panels/AdvancedSamplingPanel";
import { HighNoisePanel } from "./panels/HighNoisePanel";
import { LoraPanel } from "./panels/LoraPanel";
import { HiresPanel } from "./panels/HiresPanel";
import { OutputPanel } from "./panels/OutputPanel";
import { useBlobUrlCache } from "../../hooks/useBlobUrlCache";
import { useJobPolling } from "../../hooks/useJobPolling";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";

// 引擎 seed 是 int64；取 JS 安全整数上限 2^53-1，覆盖完整的 64 位种子空间。
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const randSeed = () => Math.floor(Math.random() * MAX_SEED);
const normalizeModelPath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

function isVaceModel(model?: { name?: string; path?: string }): boolean {
  const source = model?.name || model?.path || "";
  const fileName = source.replace(/\\/g, "/").split("/").pop() || "";
  const lower = fileName.toLowerCase();
  // 上游只在模型内嵌 desc 精确等于 "Wan2.1-VACE-1.3B" / "Wan2.x-VACE-14B"
  // 时消费条件帧（src/stable-diffusion.cpp），capabilities 不暴露 desc，
  // 只能以文件名逼近：必须同时含 "wan" 与 "vace"，避免把其他含 "vace"
  // 子串的文件误判。重命名模型会保守地隐藏入口（功能不可达但不报错）。
  return lower.includes("wan") && lower.includes("vace");
}

function modelSelectionMatches(reportedPath: string, selectedPath: string): boolean {
  if (!reportedPath || !selectedPath) return false;
  const reported = normalizeModelPath(reportedPath);
  const selected = normalizeModelPath(selectedPath);
  const selectedName = selected.split("/").pop() || selected;
  return reported === selected || reported.endsWith("/" + selectedName);
}

interface LightboxItem {
  type: "image" | "video";
  src: string;
}

export function GenerationUI() {
  const caps = useStore((s) => s.caps);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const params = useStore((s) => s.params);
  const setParams = useStore((s) => s.setParams);
  const update = useStore((s) => s.updateParam);
  const jobs = useStore((s) => s.jobs);
  const setJobs = useStore((s) => s.setJobs);
  const results = useStore((s) => s.results);
  const setResults = useStore((s) => s.setResults);
  const initImage = useStore((s) => s.initImage);
  const maskImage = useStore((s) => s.maskImage);
  const controlImage = useStore((s) => s.controlImage);
  const ipAdapterImage = useStore((s) => s.ipAdapterImage);
  const endImage = useStore((s) => s.endImage);
  const refImages = useStore((s) => s.refImages);
  const controlFrames = useStore((s) => s.controlFrames);
  const setImage = useStore((s) => s.setImage);
  const setRefImages = useStore((s) => s.setRefImages);
  const setControlFrames = useStore((s) => s.setControlFrames);
  const seedRandom = useStore((s) => s.seedRandom);
  const setSeedRandom = useStore((s) => s.setSeedRandom);
  const clearProgress = useStore((s) => s.clearProgress);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const mainModel = useStore((s) => s.mainModel);
  const familyOverride = useStore((s) => s.familyOverride);
  const setDashboardOpen = useStore((s) => s.setDashboardOpen);

  const [submitting, setSubmitting] = useState(false);
  const [lightboxItem, setLightboxItem] = useState<LightboxItem | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<"results" | "history">("results");
  const [queueOpen, setQueueOpen] = useState(false);
  const [showNegative, setShowNegative] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<"size" | "sampling" | null>(null);
  const progressStep = useStore((s) => s.progressStep);
  const progressTotal = useStore((s) => s.progressTotal);

  const openLightbox = useCallback(
    (src: string, type: "image" | "video") => setLightboxItem({ type, src }),
    []
  );
  const closeLightbox = useCallback(() => setLightboxItem(null), []);

  const blobCache = useBlobUrlCache();
  const polling = useJobPolling();
  // hooks 返回的函数身份随每次渲染变化，直接传给 memo 子组件会让 memo 失效
  // （这是旧版整树重渲染的根源之一）。用 ref 转发包出身份稳定的回调,
  // 调用时仍指向最新闭包,行为完全等价。
  const blobRef = useRef(blobCache);
  blobRef.current = blobCache;
  const pollingRef = useRef(polling);
  pollingRef.current = polling;
  const getVideoUrl = useCallback(
    (jobId: string, b64: string, mime: string) =>
      blobRef.current.getVideoUrl(jobId, b64, mime),
    []
  );
  const getImageUrl = useCallback(
    (b64: string, fmt: string) => blobRef.current.getImageUrl(b64, fmt),
    []
  );
  const retrySave = useCallback(
    (jobId: string) => pollingRef.current.retrySave(jobId),
    []
  );
  const processedJobs = polling.processedJobs;
  const imageSnapshots = useRef<Record<GenMode, GenImages>>({
    img_gen: {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: [],
      controlFrames: [],
    },
    vid_gen: {
      initImage: null,
      maskImage: null,
      controlImage: null,
      ipAdapterImage: null,
      endImage: null,
      refImages: [],
      controlFrames: [],
    },
  });

  // Keep all hooks (the useEffect blocks below) ABOVE this region. React
  // requires hooks to run unconditionally on every render; an early return
  // placed before them skips the params-init effect, leaving `params` null
  // forever → blank screen. The null guard lives just before the JSX return.
  const features = caps?.features_by_mode?.[mode] || {};
  // 上游目前把 control_frames 作为 vid_gen 的通用协议能力返回，但实际仅
  // VACE 模型消费；LTX-AV 会明确拒绝非空条件帧。
  const controlFramesSupported =
    mode === "vid_gen" && !!features.control_frames && isVaceModel(caps?.model);
  // 家族检测走 Rust detect_family（唯一实现）；异步就位前先按 custom 渲染。
  const activeFamilyOverride =
    familyOverride &&
    FAMILY_CONFIG[familyOverride] &&
    modelSelectionMatches(caps?.model?.path || "", mainModel)
      ? familyOverride
      : "";
  const [detectedFamily, setDetectedFamily] = useState("custom");
  const family = activeFamilyOverride || detectedFamily;
  useEffect(() => {
    if (activeFamilyOverride) return;
    const p = caps?.model?.path || caps?.model?.name || "";
    if (!p) {
      setDetectedFamily("custom");
      return;
    }
    let alive = true;
    api
      .detectFamily(p)
      .then((f) => {
        if (alive) setDetectedFamily(f);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [caps?.model?.path, caps?.model?.name, activeFamilyOverride]);
  const activeJobs = jobs.filter(
    (j) =>
      j.status === "queued" || j.status === "generating" || j.status === "unknown"
  ).length;
  const currentGen = jobs.find((j) => j.status === "generating");
  // 无生成中任务时清空进度条。
  useEffect(() => {
    clearProgress();
  }, [currentGen?.id, clearProgress]);
  const maxQueue = caps?.limits?.max_queue_size || settings.maxQueueSize || 4;
  const sizePresets = SIZE_PRESETS[mode];

  // 尺寸缩放滑块的基准尺寸：由初始图片检测、预设/手动修改设定；缩放时
  // width/height = scaleSize(base)。null 表示尚未锚定（滑块显示 1×，
  // 首次拖动时以当前尺寸为基准）。家族/模式切换后基准失效，避免跨
  // 家族的旧尺寸污染比例。
  const [sizeBase, setSizeBase] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setSizeBase(null), [family, mode]);

  // Initialize / switch params from caps defaults + persisted family defaults.
  // MUST depend on `caps` too: caps load asynchronously, and without it this
  // effect never re-runs → params stays null → component returns null (black).
  useEffect(() => {
    if (!caps) return;
    let d = caps.defaults_by_mode?.[mode];
    if (!d) {
      const fallback = caps.current_mode || caps.supported_modes?.[0];
      if (!fallback) return;
      setMode(fallback);
      return;
    }
    try {
      const s = localStorage.getItem("sdcpp:params:" + mode);
      setParams(s ? deepMerge(deepClone(d), JSON.parse(s)) : deepClone(d));
    } catch {
      setParams(deepClone(d));
    }
  }, [mode, caps]);

  useEffect(() => {
    if (!params) return;
    // Debounce：拖动滑块会高频更新 params，避免每次都 JSON.stringify 落盘。
    const t = setTimeout(() => {
      try {
        localStorage.setItem("sdcpp:params:" + mode, JSON.stringify(params));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [params, mode]);

  const switchMode = useCallback(
    (m: GenMode) => {
      if (m === mode) return;
      imageSnapshots.current[mode] = {
        initImage,
        maskImage,
        controlImage,
        ipAdapterImage,
        endImage,
        refImages: [...refImages],
        controlFrames: [...controlFrames],
      };
      const next = imageSnapshots.current[m];
      setImage("initImage", next.initImage);
      setImage("maskImage", next.maskImage);
      setImage("controlImage", next.controlImage);
      setImage("ipAdapterImage", next.ipAdapterImage);
      setImage("endImage", next.endImage);
      setRefImages(() => [...next.refImages]);
      setControlFrames(() => [...next.controlFrames]);
      setMode(m);
    },
    [
      mode,
      initImage,
      maskImage,
      controlImage,
      ipAdapterImage,
      endImage,
      refImages,
      controlFrames,
      setImage,
      setRefImages,
      setControlFrames,
      setMode,
    ]
  );

  const handleGenerate = useCallback(async () => {
    if (!caps || !params) return;
    if (submitting) return;
    if (family === "lingbot-video") {
      const promptError = validateLingbotPrompt(params.prompt || "");
      if (promptError) {
        toast(promptError, true);
        return;
      }
    }
    if (activeJobs >= maxQueue) {
      toast("队列已满", true);
      return;
    }
    const submittedControlFrames = controlFramesSupported ? controlFrames : [];
    const missingInputs = missingRequiredInputs(FAMILY_CONFIG[family], mode, {
      initImage,
      maskImage,
      controlImage,
      ipAdapterImage,
      endImage,
      refImages,
      controlFrames: submittedControlFrames,
    });
    if (missingInputs.length > 0) {
      toast("请先提供: " + missingInputs.join("、"), true);
      return;
    }
    setSubmitting(true);
    try {
      let activeParams = params;
      if (seedRandom || params.seed < 0) {
        const rs = randSeed();
        activeParams = { ...params, seed: rs };
        update("seed", rs);
      }
      const images: GenImages = {
        initImage,
        maskImage,
        controlImage,
        ipAdapterImage,
        endImage,
        refImages,
        controlFrames: submittedControlFrames,
      };
      const body = buildRequestBody(mode, activeParams, images);
      const { status, body: respBody } = await api.sdcppSubmit(mode, body);
      if (status === 202) {
        setJobs((j) => [
          {
            ...(respBody as Job),
            config: {
              mode,
              params: deepClone(activeParams),
              // 图片输入一并快照（字符串引用共享，无额外内存拷贝），
              // "应用此配置"才能完整复现 img2img/inpaint 任务。
              // 两个数组必须拷贝，否则后续增删会改写已提交任务的快照。
              images: {
                ...images,
                refImages: [...images.refImages],
                controlFrames: [...images.controlFrames],
              },
            },
          },
          ...j,
        ]);
        // 提交成功即收起参数 Sheet,把画布让给显影过程。
        setSheetOpen(false);
      } else if (status === 429) {
        toast("队列已满", true);
      } else {
        toast(extractApiError(respBody, status), true);
      }
    } catch (e) {
      toast("网络错误: " + formatError(e), true);
    } finally {
      setSubmitting(false);
    }
  }, [
    caps,
    params,
    submitting,
    family,
    activeJobs,
    maxQueue,
    mode,
    initImage,
    maskImage,
    controlImage,
    ipAdapterImage,
    endImage,
    refImages,
    controlFrames,
    controlFramesSupported,
    seedRandom,
    update,
    setJobs,
    toast,
  ]);

  const randomSeed = useCallback(() => {
    if (!params) return;
    const next = !seedRandom;
    setSeedRandom(next);
    if (!next && params.seed < 0) update("seed", randSeed());
  }, [params, seedRandom, setSeedRandom, update]);

  const resetToDefaults = useCallback(() => {
    if (!caps || !params) return;
    const base = deepClone(caps.defaults_by_mode[mode]);
    const cfg = FAMILY_CONFIG[family];
    const recommended = cfg ? familyDefaults(cfg, mode) : undefined;
    const merged = recommended
      ? deepMerge(base, deepClone(recommended))
      : base;
    merged.prompt = params.prompt || "";
    merged.negative_prompt = params.negative_prompt || "";
    setParams(merged);
    const gd = recommended as { seed?: number } | undefined;
    if (gd?.seed != null && gd.seed < 0) setSeedRandom(true);
    toast("已重置为推荐值");
  }, [caps, params, family, mode, setParams, setSeedRandom, toast]);

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        const { status, body } = await api.sdcppCancel(id);
        if (status === 200) {
          setJobs((j) =>
            j.map((x) => (x.id === id ? { ...x, status: "cancelled" } : x))
          );
        } else if (status === 409) {
          // sd-server 不支持中断生成中的任务（capabilities.cancel_generating=false）
          toast("任务正在生成，暂不支持中断", true);
        } else {
          toast("取消失败：" + extractApiError(body, status), true);
        }
      } catch (e) {
        toast("取消失败：" + formatError(e), true);
      }
    },
    [setJobs, toast]
  );

  // 从列表移除单个任务（排队中的先取消，释放服务器队列槽位）。
  const removeJob = useCallback(
    async (id: string) => {
      const job = useStore.getState().jobs.find((j) => j.id === id);
      if (job?.status === "queued") {
        try {
          const cancelled = await api.sdcppCancel(id);
          if (cancelled.status !== 200) {
            toast(
              "取消排队任务失败，已保留任务记录：" +
                extractApiError(cancelled.body, cancelled.status),
              true
            );
            return;
          }
        } catch (e) {
          toast("取消排队任务失败: " + formatError(e), true);
          return;
        }
      }
      if (job?.status === "generating") {
        toast("已从列表移除；该任务正在生成，无法中断，将在后台跑完");
      }
      blobRef.current.revokeVideoUrl(id);
      processedJobs.current.delete(id);
      setJobs((j) => j.filter((x) => x.id !== id));
      setResults((r) => {
        const removed = r.find((x) => x.jobId === id);
        removed?.result?.images?.forEach((img) => {
          if (img.b64_json) blobRef.current.revokeImageUrl(img.b64_json);
        });
        return r.filter((x) => x.jobId !== id);
      });
    },
    [processedJobs, setJobs, setResults, toast]
  );

  // 清空整个队列（取消所有可取消的任务）。
  const clearJobs = useCallback(async () => {
    const terminal = useStore
      .getState()
      .jobs.filter(
        (job) =>
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled"
      );
    if (terminal.length === 0) {
      toast("没有可清理的已结束任务");
      return;
    }
    const ids = new Set(terminal.map((job) => job.id));
    setJobs((current) => current.filter((job) => !ids.has(job.id)));
    toast(`已清理 ${terminal.length} 条任务记录；生成结果仍保留`);
  }, [setJobs, toast]);

  // 删除单个结果，联动删除对应任务。未保存结果的确认由 DeleteButton 两段式承担。
  const removeResult = useCallback(
    async (jobId: string, imageIndex?: number) => {
      const job = useStore.getState().jobs.find((j) => j.id === jobId);
      if (job && (job.status === "queued" || job.status === "generating")) {
        await api.sdcppCancel(jobId).catch(() => {});
      }
      let removedWholeEntry = imageIndex == null;
      setResults((entries) =>
        entries.flatMap((entry) => {
          if (entry.jobId !== jobId) return [entry];
          if (imageIndex == null || !entry.result.images) {
            entry.result.images?.forEach((image) =>
              blobRef.current.revokeImageUrl(image.b64_json)
            );
            removedWholeEntry = true;
            return [];
          }
          const remaining = entry.result.images.filter(
            (image, index) => (image.index ?? index) !== imageIndex
          );
          const removed = entry.result.images.find(
            (image, index) => (image.index ?? index) === imageIndex
          );
          if (removed) blobRef.current.revokeImageUrl(removed.b64_json);
          if (remaining.length === 0) {
            removedWholeEntry = true;
            return [];
          }
          return [{ ...entry, result: { ...entry.result, images: remaining } }];
        })
      );
      if (removedWholeEntry) {
        blobRef.current.revokeVideoUrl(jobId);
        processedJobs.current.delete(jobId);
        setJobs((current) => current.filter((entry) => entry.id !== jobId));
      }
    },
    [processedJobs, setJobs, setResults]
  );

  // 从某任务/结果记录恢复生成配置：写入 localStorage 后切 mode，
  // 由 params init effect 读取并应用。
  // seedOffset：批量生成时第 k 张的实际种子是 seed+k（引擎按 seed+b 递增），
  // 从单张结果恢复时传入其 index 以复现该张。
  const applyConfig = useCallback(
    (config?: JobConfig, seedOffset = 0) => {
      if (!config) return;
      const p = deepClone(config.params);
      if (seedOffset > 0 && p.seed >= 0) p.seed = p.seed + seedOffset;
      // 直接写入 params（同 mode 时 mode 不变，init effect 不会重跑，必须手动 set）。
      setParams(p);
      // 恢复提交时的图片输入；无快照的旧记录清空，保证界面状态与该任务一致。
      const img = config.images;
      setImage("initImage", img?.initImage ?? null);
      setImage("maskImage", img?.maskImage ?? null);
      setImage("controlImage", img?.controlImage ?? null);
      setImage("ipAdapterImage", img?.ipAdapterImage ?? null);
      setImage("endImage", img?.endImage ?? null);
      setRefImages(() => img?.refImages ?? []);
      setControlFrames(() => img?.controlFrames ?? []);
      // 恢复配置的意图是复现：种子已是提交时的具体值，关闭随机开关。
      if (p.seed >= 0) setSeedRandom(false);
      // 跨 mode 时还要写入 localStorage，供 mode 切换后的 init effect 读取。
      try {
        localStorage.setItem("sdcpp:params:" + config.mode, JSON.stringify(p));
      } catch {
        /* ignore */
      }
      setMode(config.mode);
      toast(seedOffset > 0 ? `已恢复该张的配置（种子 ${p.seed}）` : "已恢复该任务的配置");
    },
    [
      setParams,
      setImage,
      setRefImages,
      setControlFrames,
      setSeedRandom,
      setMode,
      toast,
    ]
  );

  const download = useCallback(
    async (b64: string, fmt?: string, _mime?: string, seed?: number) => {
      if (!b64) return;
      try {
        const dt = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
        const name = seed != null && seed >= 0 ? `seed_${seed}_${dt}` : `lumina_${dt}`;
        const r = await api.saveAs(b64, fmt || "png", name);
        if (r.saved) toast("已保存：" + r.path);
      } catch (e) {
        toast("保存失败: " + formatError(e), true);
      }
    },
    [toast]
  );

  // 结果图用作 img2img 初始图片。
  const useAsInit = useCallback(
    (src: string) => {
      setImage("initImage", src);
      if (mode !== "img_gen") setMode("img_gen");
      toast("已设为初始图片，可在「图片输入」面板中调整");
    },
    [mode, setImage, setMode, toast]
  );

  // 从 PNG Info 恢复参数（历史画廊）。
  const restoreFromMetadata = useCallback(
    (metadata: Record<string, unknown>, _imageSrc: string) => {
      try {
        if (!params) return;
        // sd-server 元数据是 sdcpp.image.params/v1 schema，
        // 由 sdcppMetadataToGenParams 映射为 GenParams（含 Beta 参数回填）。
        const merged = {
          ...deepClone(params),
          ...sdcppMetadataToGenParams(metadata, caps?.loras),
        } as Partial<GenParams>;
        setParams({
          width: (merged.width as number) || params.width,
          height: (merged.height as number) || params.height,
          seed: merged.seed as number,
          prompt: (merged.prompt as string) || params.prompt,
          negative_prompt: (merged.negative_prompt as string) || params.negative_prompt,
          sample_params: (merged.sample_params as GenParams["sample_params"]) || params.sample_params,
          batch_count: merged.batch_count as number,
          video_frames: merged.video_frames as number,
          ...merged,
        });
        if ((merged.seed as number) >= 0) setSeedRandom(false);
        // 历史图尺寸取代当前尺寸，缩放基准随之失效（滑块回到 1×）。
        setSizeBase(null);
        toast("已从历史图片恢复参数");
      } catch {
        toast("参数恢复失败", true);
      }
    },
    [caps?.loras, params, setParams, setSeedRandom, toast]
  );

  // 初始图片尺寸自动填充：对齐到 64 并 clamp 到 limits。
  const handleInitSize = useCallback(
    (w: number, h: number) => {
      const minW = caps?.limits?.min_width || 64;
      const maxW = caps?.limits?.max_width || 4096;
      const minH = caps?.limits?.min_height || 64;
      const maxH = caps?.limits?.max_height || 4096;
      const align = (n: number, min: number, max: number) => {
        const v = Math.round(n / 64) * 64;
        return Math.min(max, Math.max(min, v));
      };
      const aw = align(w, minW, maxW);
      const ah = align(h, minH, maxH);
      update("width", aw);
      update("height", ah);
      // 锚定缩放基准：之后拖动尺寸缩放滑块以图片尺寸为 1×。
      setSizeBase({ w: aw, h: ah });
      toast(`已应用图片尺寸 ${aw}×${ah}`);
    },
    [caps?.limits, update, toast]
  );

  // 尺寸缩放滑块：相对基准尺寸（通常为初始图片尺寸）等比缩放宽高，
  // 结果就近对齐到家族空间基数并 clamp 到 limits。
  const handleSizeScale = useCallback(
    (scale: number) => {
      if (!params) return;
      const base = sizeBase ?? { w: params.width, h: params.height };
      if (!sizeBase) setSizeBase(base);
      const { w, h } = scaleSize(family, base.w, base.h, scale, caps?.limits);
      update("width", w);
      update("height", h);
    },
    [params, sizeBase, family, caps?.limits, update]
  );

  // 预设/手动修改尺寸后，缩放基准随之重置（滑块回到 1×）。
  const handleSizeBaseReset = useCallback(
    (w: number, h: number) => setSizeBase({ w, h }),
    []
  );

  const handleSeedEdit = useCallback(
    (raw: string) => {
      setSeedRandom(false);
      update("seed", raw === "" ? 0 : parseInt(raw) || 0);
    },
    [setSeedRandom, update]
  );

  const handleInsertLingbot = useCallback(() => {
    update("prompt", LINGBOT_PROMPT_TEMPLATE);
  }, [update]);

  const openDashboard = useCallback(
    () => setDashboardOpen(true),
    [setDashboardOpen]
  );
  const toggleNegative = useCallback(() => setShowNegative((v) => !v), []);
  const toggleQueue = useCallback(() => setQueueOpen((v) => !v), []);
  const closeQueue = useCallback(() => setQueueOpen(false), []);
  const openSheet = useCallback((target?: "size" | "sampling") => {
    setSheetTarget(target ?? null);
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const toggleSheet = useCallback(() => {
    setSheetTarget(null);
    setSheetOpen((v) => !v);
  }, []);

  // ⌘, 呼唤参数 Sheet（独立于 useKeyboardShortcuts,仅监听这一个组合键）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        toggleSheet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSheet]);

  const handleEscape = useCallback(() => {
    if (lightboxItem) closeLightbox();
    else if (sheetOpen) closeSheet();
    else if (queueOpen) closeQueue();
  }, [lightboxItem, sheetOpen, queueOpen, closeLightbox, closeSheet, closeQueue]);

  useKeyboardShortcuts({
    onGenerate: handleGenerate,
    onRandomSeed: randomSeed,
    onEscape: handleEscape,
    escapeActive: !!(lightboxItem || sheetOpen || queueOpen),
  });

  if (!caps || !params) return null;
  const sp = params.sample_params;
  const hsp = params.high_noise_sample_params;
  // 滑块显示值：当前尺寸相对基准的几何平均倍率（宽高可能单独被改过），
  // 无基准时恒为 1×；超出滑块量程时钉在端点。
  const sizeScale =
    sizeBase && sizeBase.w > 0 && sizeBase.h > 0
      ? Math.min(
          2,
          Math.max(
            0,
            Math.sqrt((params.width / sizeBase.w) * (params.height / sizeBase.h))
          )
        )
      : 1;
  const negativeVisible =
    showNegative || !!(params.negative_prompt && params.negative_prompt.trim());
  const showDistilled = DISTILL_FAMILIES.includes(family);
  const dreamText = currentGen
    ? progressTotal > 0
      ? `显影中 ${progressStep}/${progressTotal}`
      : "显影中…"
    : "";

  return (
    <>
      <HeaderBar
        modelLabel={
          caps.model?.name || caps.model?.path?.split(/[\\/]/).pop() || "当前模型"
        }
        modelTitle={caps.model?.path || caps.model?.name || "当前模型"}
        mode={mode}
        supportedModes={caps.supported_modes || []}
        dreamText={dreamText}
        onSwitchMode={switchMode}
        onOpenDashboard={openDashboard}
      />
      <div className="main">
        <div className="output-area">
          <ProgressBar />
          <div className="canvas-float left">
            <div className="mode-tabs" role="tablist" aria-label="工作区视图">
              <button
                role="tab"
                aria-selected={workspaceTab === "results"}
                className={cn("mode-tab", workspaceTab === "results" && "active")}
                onClick={() => setWorkspaceTab("results")}
              >
                当前结果
              </button>
              <button
                role="tab"
                aria-selected={workspaceTab === "history"}
                className={cn("mode-tab", workspaceTab === "history" && "active")}
                onClick={() => setWorkspaceTab("history")}
              >
                历史画廊
              </button>
            </div>
          </div>
          <div className="canvas-float right">
            <button
              className={cn("btn btn-sm", sheetOpen && "queue-toggle active")}
              onClick={toggleSheet}
              aria-expanded={sheetOpen}
              aria-label="打开参数面板"
              title="生成参数（⌘,）"
            >
              <SlidersHorizontal size={13} aria-hidden="true" /> 参数
            </button>
            <button
              className={cn("btn btn-sm queue-toggle", queueOpen && "active")}
              onClick={toggleQueue}
              aria-expanded={queueOpen}
              aria-label="切换任务队列面板"
            >
              任务队列
              {activeJobs > 0 && <span className="queue-badge">{activeJobs}</span>}
            </button>
          </div>
          <div className="output-main">
            {workspaceTab === "results" ? (
              <ResultsGrid
                results={results}
                onLightbox={openLightbox}
                onApplyConfig={applyConfig}
                onDownload={download}
                onRemove={removeResult}
                onRetrySave={retrySave}
                onUseAsInit={useAsInit}
                getVideoUrl={getVideoUrl}
                getImageUrl={getImageUrl}
              />
            ) : (
              <div className="history-workspace">
                <HistoryGallery
                  onRestoreParams={restoreFromMetadata}
                  onLightbox={openLightbox}
                  onUseAsInit={useAsInit}
                />
              </div>
            )}
          </div>
          <PromptDock
            prompt={params.prompt || ""}
            negative={params.negative_prompt || ""}
            negativeVisible={negativeVisible}
            seedRandom={seedRandom}
            submitting={submitting}
            generating={!!currentGen}
            disabled={submitting || activeJobs >= maxQueue}
            showLingbotTools={family === "lingbot-video"}
            width={params.width}
            height={params.height}
            steps={sp?.sample_steps ?? 20}
            txtCfg={sp?.guidance?.txt_cfg ?? 7}
            limits={caps?.limits}
            onUpdate={update}
            onToggleNegative={toggleNegative}
            onRandomSeed={randomSeed}
            onGenerate={handleGenerate}
            onInsertLingbot={handleInsertLingbot}
            onOpenSheet={openSheet}
          />
          <QueueDrawer open={queueOpen} onClose={closeQueue}>
            <JobQueue
              jobs={jobs}
              activeJobs={activeJobs}
              maxQueue={maxQueue}
              mode={mode}
              caps={caps}
              onApplyConfig={applyConfig}
              onCancel={cancelJob}
              onRemove={removeJob}
              onClear={clearJobs}
              onDownload={download}
            />
          </QueueDrawer>
          <ParamsSheet open={sheetOpen} onClose={closeSheet}>
            {(features.init_image ||
              features.mask_image ||
              features.control_image ||
              features.ip_adapter_image ||
              features.end_image ||
              features.ref_images ||
              controlFramesSupported) && (
              <ImageInputsPanel
                features={features}
                mode={mode}
                family={family}
                initImage={initImage}
                maskImage={maskImage}
                controlImage={controlImage}
                ipAdapterImage={ipAdapterImage}
                endImage={endImage}
                refImages={refImages}
                controlFrames={controlFrames}
                controlFramesSupported={controlFramesSupported}
                strength={params.strength}
                controlStrength={params.control_strength}
                ipAdapterStrength={params.ip_adapter_strength}
                imgCfg={sp?.guidance?.img_cfg}
                txtCfg={sp?.guidance?.txt_cfg}
                onUpdate={update}
                onSetImage={setImage}
                onSetRefImages={setRefImages}
                onSetControlFrames={setControlFrames}
                onInitSize={handleInitSize}
              />
            )}
            <SizeSeedPanel
              mode={mode}
              family={family}
              width={params.width}
              height={params.height}
              seed={params.seed}
              seedRandom={seedRandom}
              batchCount={params.batch_count}
              videoFrames={params.video_frames}
              fps={params.fps}
              qwenLayers={params.qwen_image_layers}
              limits={caps.limits}
              sizePresets={sizePresets}
              sizeScale={sizeScale}
              framePresets={VIDEO_FRAME_PRESETS[family]}
              framePresetsLabel={`${FAMILY_CONFIG[family]?.name || "视频"} 帧数快捷项`}
              onUpdate={update}
              onSizeScale={handleSizeScale}
              onSizeBaseReset={handleSizeBaseReset}
              onSeedEdit={handleSeedEdit}
              onRandomSeed={randomSeed}
              forceOpen={sheetTarget === "size"}
            />
            <SamplingPanel
              samplers={caps.samplers || []}
              schedulers={caps.schedulers || []}
              sampleMethod={sp?.sample_method || "default"}
              scheduler={sp?.scheduler || "default"}
              steps={sp?.sample_steps}
              txtCfg={sp?.guidance?.txt_cfg}
              distilled={sp?.guidance?.distilled_guidance}
              showDistilled={showDistilled}
              betaAlpha={sp?.beta_alpha}
              betaBeta={sp?.beta_beta}
              onUpdate={update}
              onReset={resetToDefaults}
              forceOpen={sheetTarget === "sampling"}
            />
            <AdvancedSamplingPanel
              eta={sp?.eta}
              flowShift={sp?.flow_shift}
              slg={sp?.guidance?.slg}
              vaeTilingParams={params.vae_tiling_params}
              cacheMode={params.cache_mode}
              clipSkip={params.clip_skip}
              onUpdate={update}
            />
            {mode === "vid_gen" && family === "wan-a14b" && (
              <HighNoisePanel
                samplers={caps.samplers || []}
                schedulers={caps.schedulers || []}
                hsp={hsp}
                fallbackSampleMethod={sp?.sample_method || "default"}
                fallbackScheduler={sp?.scheduler || "default"}
                moeBoundary={params.moe_boundary}
                showDistilled={showDistilled}
                betaAlpha={hsp?.beta_alpha}
                betaBeta={hsp?.beta_beta}
                onUpdate={update}
              />
            )}
            {features.lora && (
              <LoraPanel
                loras={params.lora || []}
                available={caps.loras || []}
                onUpdate={update}
              />
            )}
            {features.hires && (
              <HiresPanel
                hires={params.hires}
                upscalers={(caps.upscalers || []).map((u) => u.name)}
                onUpdate={update}
              />
            )}
            <OutputPanel
              mode={mode}
              outputFormat={params.output_format}
              formats={caps.output_formats_by_mode?.[mode] || ["png"]}
              compression={params.output_compression}
              onUpdate={update}
            />
          </ParamsSheet>
        </div>
      </div>
      <Lightbox item={lightboxItem} onClose={closeLightbox} />
    </>
  );
}
