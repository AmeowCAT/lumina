import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
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
  b64ToDataUrl,
  buildRequestBody,
  deepClone,
  deepMerge,
  extractApiError,
  formatError,
  LINGBOT_PROMPT_TEMPLATE,
  MAX_JOBS,
  sdcppMetadataToGenParams,
  validateLingbotPrompt,
} from "../../lib/utils";
import { familyDefaults, missingRequiredInputs } from "../../lib/launchConfig";
import type { GenImages, GenMode, GenParams, Job, JobConfig } from "../../types";
import { Lightbox, type LightboxItem } from "../ui/Lightbox";
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
import { useTheme } from "../../lib/theme";
import {
  ingestCompletedJob,
  processedJobs,
  saveEntryPart,
  trackDetachedJob,
} from "../../hooks/useJobPolling";
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
  // 同步锁：setState 生效要等一次渲染，键盘连发（Ctrl+Enter 按住重复触发）
  // 与双击可能在同帧内两次进入 handleGenerate；ref 在首次 await 前同步上锁。
  const submittingRef = useRef(false);
  const [lightbox, setLightbox] = useState<{
    items: LightboxItem[];
    index: number;
  } | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<"results" | "history">("results");
  const [queueOpen, setQueueOpen] = useState(false);
  const [showNegative, setShowNegative] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<"size" | "sampling" | null>(null);
  const progressStep = useStore((s) => s.progressStep);
  const progressTotal = useStore((s) => s.progressTotal);
  const theme = useTheme();

  const openLightbox = useCallback(
    (items: LightboxItem[], index: number) => setLightbox({ items, index }),
    []
  );
  const closeLightbox = useCallback(() => setLightbox(null), []);
  // 稳定引用:内联箭头会让 Lightbox 的键盘 effect 依赖每次父级渲染
  // 都变化,反复重挂 listener(审查低危项)。
  const navigateLightbox = useCallback(
    (i: number) => setLightbox((s) => (s ? { ...s, index: i } : s)),
    []
  );

  const blobCache = useBlobUrlCache();
  // hooks 返回的函数身份随每次渲染变化，直接传给 memo 子组件会让 memo 失效
  // （这是旧版整树重渲染的根源之一）。用 ref 转发包出身份稳定的回调,
  // 调用时仍指向最新闭包,行为完全等价。
  const blobRef = useRef(blobCache);
  blobRef.current = blobCache;
  const getVideoUrl = useCallback(
    (jobId: string, b64: string, mime: string) =>
      blobRef.current.getVideoUrl(jobId, b64, mime),
    []
  );
  const getImageUrl = useCallback(
    (b64: string, fmt: string) => blobRef.current.getImageUrl(b64, fmt),
    []
  );
  // 轮询已上移至 App 级常驻（切到控制台也继续收货）；这里的
  // saveEntryPart 是模块级函数，经稳定身份转发保持 memo 子组件 props 稳定。
  const saveImageStable = useCallback(
    (jobId: string, key: string) => void saveEntryPart(jobId, key),
    []
  );
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
  // MiniMax-H3 Ref2VA 半支持：vid_gen 协议已接受 ref_images（参考图像条件），
  // 但 capabilities 的 vid_gen features 未广告 ref_images，按家族声明判定。
  const refImagesSupported =
    (mode === "img_gen" && !!features.ref_images) ||
    !!FAMILY_CONFIG[family]?.requiredInputsByMode?.[mode]?.includes("ref_images");
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
    if (submittingRef.current) return;
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
    const submittedRefImages = refImagesSupported ? refImages : [];
    const missingInputs = missingRequiredInputs(FAMILY_CONFIG[family], mode, {
      initImage,
      maskImage,
      controlImage,
      ipAdapterImage,
      endImage,
      refImages: submittedRefImages,
      controlFrames: submittedControlFrames,
    });
    if (missingInputs.length > 0) {
      toast("请先提供: " + missingInputs.join("、"), true);
      return;
    }
    // 锁必须在所有早退检查之后上：否则"缺少输入"这类 return 会让锁
    // 永久保持 true，后续生成全部静默失效（重审抓出的 bug）。
    submittingRef.current = true;
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
        refImages: submittedRefImages,
        controlFrames: submittedControlFrames,
      };
      const body = buildRequestBody(mode, activeParams, images);
      const { status, body: respBody } = await api.sdcppSubmit(mode, body);
      if (status === 202) {
        setJobs((j) =>
          [
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
          ].slice(0, MAX_JOBS)
        );
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
      submittingRef.current = false;
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
    // 防御：某 mode 在 capabilities 中无默认值时 deepClone(undefined) 会抛
    // SyntaxError（JSON.parse(undefined)），这里回落空对象（对抗性审查 B6）。
    const defaults = caps.defaults_by_mode?.[mode];
    const base = defaults ? deepClone(defaults) : ({} as Partial<GenParams>);
    const cfg = FAMILY_CONFIG[family];
    const recommended = cfg ? familyDefaults(cfg, mode) : undefined;
    const merged = (recommended
      ? deepMerge(base as GenParams, deepClone(recommended))
      : base) as GenParams;
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
          // 服务端返回取消后的最新作业对象：排队任务会被置 cancelled，但
          // 已完成/失败的任务返回 200 且状态不变——按返回体如实更新，而不是
          // 无条件把本地置为 cancelled（对抗性审查 A4）。
          const d = body as Partial<Job> | null;
          const s = d?.status;
          // 竞态修复（审查 P1）：任务在两次轮询之间已完成、用户恰好点取消，
          // 返回体是 completed——轮询不会再处理它，这里直接收割结果。
          const ingested = d ? ingestCompletedJob(d as Job) : false;
          setJobs((j) =>
            j.map((x) =>
              x.id === id && typeof s === "string"
                ? { ...x, status: s as Job["status"] }
                : x
            )
          );
          if (typeof s === "string" && s !== "cancelled") {
            toast(ingested ? "任务已完成，结果已收入画廊" : "该任务已结束，无需取消");
          }
        } else if (status === 409) {
          // sd-server 不支持中断生成中的任务（capabilities.cancel_generating=false）
          toast("任务正在生成，暂不支持中断", true);
        } else if (status === 404 || status === 410) {
          // 任务在服务器上已不存在（重启/过期）：与轮询同款处理置为失败，
          // 避免列表里残留"永远排队"的幽灵任务（审查 P1）。
          setJobs((j) =>
            j.map((x) =>
              x.id === id
                ? {
                    ...x,
                    status: "failed",
                    error: { message: "任务已失效（服务器重启或任务过期）" },
                  }
                : x
            )
          );
          toast("任务已失效（服务器重启或任务过期）", true);
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
        // 脱离队列后仍低频轮询到终态并收割进结果画廊——否则"后台跑完"
        // 的结果无人接收，永久丢失（对抗性审查 M3）。
        trackDetachedJob(id);
        toast("已从列表移除；该任务正在生成，完成后结果仍会进入结果画廊");
      }
      // 只移除任务记录，不动结果画廊：清空按钮的语义是"不删除生成结果"，
      // 单个移除若连带删结果会让未保存的图静默丢失（对抗性审查 M2）。
      // 结果侧有独立的删除入口（removeResult）。
      processedJobs.delete(id);
      setJobs((j) => j.filter((x) => x.id !== id));
    },
    [setJobs, toast]
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
        // 取消失败不能静默吞掉：服务器侧任务会继续占用队列槽位（表现为之后
        // 莫名的 429"队列已满"）。失败时如实提示，本地记录仍按用户意图删除
        // （对抗性审查 B4）。
        try {
          const cancelled = await api.sdcppCancel(jobId);
          if (cancelled.status !== 200) {
            toast(
              "服务器侧任务未能取消：" +
                extractApiError(cancelled.body, cancelled.status),
              true
            );
          }
        } catch (e) {
          toast("取消失败，任务可能仍在服务器队列中：" + formatError(e), true);
        }
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
        processedJobs.delete(jobId);
        setJobs((current) => current.filter((entry) => entry.id !== jobId));
      }
    },
    [setJobs, setResults, toast]
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

  // 结果图用作 img2img 初始图片。src 可以是完整 dataURL（历史画廊读文件后
  // 构造）或原始 base64（结果网格传入 b64_json + 输出格式）。统一转成
  // dataURL 存入 initImage：blob: URL 只在本页面生命周期内有效（切回控制台
  // 即被 revoke），且 sd-server 无法解码 blob: 协议（对抗性审查 B2）。
  const useAsInit = useCallback(
    (src: string, fmt?: string) => {
      const dataUrl = src.startsWith("data:")
        ? src
        : b64ToDataUrl(src, fmt ? `image/${fmt}` : "image/png");
      setImage("initImage", dataUrl);
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
          // 元数据缺 seed 时 merged.seed 为 undefined，直接写入会产生 NaN
          // 并渲染进输入框（对抗性审查 B6）；回落当前值。
          seed:
            typeof merged.seed === "number" && Number.isFinite(merged.seed)
              ? merged.seed
              : params.seed,
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
      const trimmed = raw.trim();
      // parseInt 会把 "1e3" 解析成 1、"123abc" 解析成 123（静默错误种子）；
      // Number 严格解析，非法输入回落 0，并钳制到安全整数范围。负数保留
      // （提交时 seed<0 会重新掷随机种子）。
      const n = Number(trimmed);
      const seed =
        trimmed === "" || !Number.isFinite(n)
          ? 0
          : Math.max(-MAX_SEED, Math.min(MAX_SEED, Math.trunc(n)));
      update("seed", seed);
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
    if (lightbox) closeLightbox();
    else if (sheetOpen) closeSheet();
    else if (queueOpen) closeQueue();
  }, [lightbox, sheetOpen, queueOpen, closeLightbox, closeSheet, closeQueue]);

  useKeyboardShortcuts({
    onGenerate: handleGenerate,
    onRandomSeed: randomSeed,
    onEscape: handleEscape,
    escapeActive: !!(lightbox || sheetOpen || queueOpen),
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
  // 进行中文案随主题语境:暗房"显影" ↔ 太空"推进"(发动机工作段)
  const developing = theme === "vostok" ? "推进中" : "显影中";
  const dreamText = currentGen
    ? progressTotal > 0
      ? `${developing} ${progressStep}/${progressTotal}`
      : `${developing}…`
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
          {/* VOSTOK 胶片边注:画布右缘竖排遥测,生成时实时帧号 */}
          {theme === "vostok" && (
            <span className="r-vertical r-canvas-vertical" aria-hidden="true">
              {currentGen && progressTotal > 0
                ? `FRAME ${String(progressStep).padStart(3, "0")}/${String(progressTotal).padStart(3, "0")} · ORBIT-1`
                : "STANDBY · ORBIT-1 · LUMINA STUDIO"}
            </span>
          )}
          <div className="canvas-float left">
            <div
              className="mode-tabs"
              role="tablist"
              aria-label="工作区视图"
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                setWorkspaceTab((t) =>
                  t === "results" ? "history" : "results"
                );
              }}
            >
              <button
                id="workspace-tab-results"
                role="tab"
                aria-selected={workspaceTab === "results"}
                aria-controls="workspace-panel-results"
                tabIndex={workspaceTab === "results" ? 0 : -1}
                className={cn("mode-tab", workspaceTab === "results" && "active")}
                onClick={() => setWorkspaceTab("results")}
              >
                当前结果
              </button>
              <button
                id="workspace-tab-history"
                role="tab"
                aria-selected={workspaceTab === "history"}
                aria-controls="workspace-panel-history"
                tabIndex={workspaceTab === "history" ? 0 : -1}
                className={cn("mode-tab", workspaceTab === "history" && "active")}
                onClick={() => setWorkspaceTab("history")}
              >
                {theme === "vostok" ? "回传档案" : "历史画廊"}
              </button>
            </div>
          </div>
          <div className="canvas-float right">
            <button
              className={cn("btn btn-sm queue-toggle", queueOpen && "active")}
              onClick={toggleQueue}
              aria-expanded={queueOpen}
              aria-label="切换任务队列面板"
            >
              任务队列
              {activeJobs > 0 && <span className="queue-badge">{activeJobs}</span>}
            </button>
            <button
              className={cn("btn btn-sm", sheetOpen && "queue-toggle active")}
              onClick={toggleSheet}
              aria-expanded={sheetOpen}
              aria-label="打开参数面板"
              title="生成参数（⌘,）"
            >
              <SlidersHorizontal size={13} aria-hidden="true" /> 参数
            </button>
          </div>
          <div className="output-main">
            <AnimatePresence mode="wait" initial={false}>
              {workspaceTab === "results" ? (
                <motion.div
                  key="workspace-results"
                  id="workspace-panel-results"
                  role="tabpanel"
                  aria-labelledby="workspace-tab-results"
                  className="workspace-panel"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  <ResultsGrid
                    results={results}
                    generating={!!currentGen}
                    onLightbox={openLightbox}
                    onApplyConfig={applyConfig}
                    onDownload={download}
                    onRemove={removeResult}
                    onSaveImage={saveImageStable}
                    onUseAsInit={useAsInit}
                    getVideoUrl={getVideoUrl}
                    getImageUrl={getImageUrl}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="workspace-history"
                  id="workspace-panel-history"
                  role="tabpanel"
                  aria-labelledby="workspace-tab-history"
                  className="workspace-panel"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="history-workspace">
                    <HistoryGallery
                      onRestoreParams={restoreFromMetadata}
                      onUseAsInit={useAsInit}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
              refImagesSupported ||
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
                refImagesSupported={refImagesSupported}
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
              lmsMaxOrder={sp?.lms_max_order}
              lmsShift={sp?.lms_shift}
              lmsDivisions={sp?.lms_divisions}
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
              extraSampleArgs={sp?.extra_sample_args}
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
      <AnimatePresence>
        {lightbox && (
          <Lightbox
            items={lightbox.items}
            index={lightbox.index}
            onClose={closeLightbox}
            onNavigate={navigateLightbox}
          />
        )}
      </AnimatePresence>
    </>
  );
}
