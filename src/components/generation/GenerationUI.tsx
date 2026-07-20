import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import {
  BUILTIN_UPSCALERS,
  CACHE_MODES,
  DISTILL_FAMILIES,
  FAMILY_CONFIG,
  SAMPLER_NAMES,
  SCHEDULER_NAMES,
  SIZE_PRESETS,
} from "../../config/families";
import {
  buildRequestBody,
  deepClone,
  deepMerge,
  formatError,
  LINGBOT_PROMPT_TEMPLATE,
  validateLingbotPrompt,
} from "../../lib/utils";
import type { GenImages, GenMode, GenParams, Job, JobConfig } from "../../types";
import { Panel } from "../ui/Panel";
import { Slider } from "../ui/Slider";
import { Toggle } from "../ui/Toggle";
import { ImageUpload } from "../ui/ImageUpload";
import { IC } from "../ui/Icons";
import { Logo } from "../ui/Logo";
import { Lightbox } from "../ui/Lightbox";
import { ProgressBar } from "../ui/ProgressBar";
import { NumberInput } from "../ui/NumberInput";
import { ResultsGrid } from "./ResultsGrid";
import { JobQueue } from "./JobQueue";
import { HistoryGallery } from "./HistoryGallery";
import { useBlobUrlCache } from "../../hooks/useBlobUrlCache";
import { useJobPolling } from "../../hooks/useJobPolling";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";

// 引擎 seed 是 int64；取 JS 安全整数上限 2^53-1，覆盖完整的 64 位种子空间。
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const randSeed = () => Math.floor(Math.random() * MAX_SEED);

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
  const endImage = useStore((s) => s.endImage);
  const refImages = useStore((s) => s.refImages);
  const setImage = useStore((s) => s.setImage);
  const setRefImages = useStore((s) => s.setRefImages);
  const seedRandom = useStore((s) => s.seedRandom);
  const setSeedRandom = useStore((s) => s.setSeedRandom);
  const clearProgress = useStore((s) => s.clearProgress);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const setDashboardOpen = useStore((s) => s.setDashboardOpen);

  const [submitting, setSubmitting] = useState(false);
  const [lightboxItem, setLightboxItem] = useState<LightboxItem | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<"results" | "history">("results");
  const [queueOpen, setQueueOpen] = useState(false);
  const [showNegative, setShowNegative] = useState(false);

  const openLightbox = (src: string, type: "image" | "video") =>
    setLightboxItem({ type, src });
  const closeLightbox = () => setLightboxItem(null);

  const { getVideoUrl, revokeVideoUrl, getImageUrl, revokeImageUrl } = useBlobUrlCache();
  const { processedJobs, retrySave } = useJobPolling();
  const imageSnapshots = useRef<Record<GenMode, GenImages>>({
    img_gen: {
      initImage: null,
      maskImage: null,
      controlImage: null,
      endImage: null,
      refImages: [],
    },
    vid_gen: {
      initImage: null,
      maskImage: null,
      controlImage: null,
      endImage: null,
      refImages: [],
    },
  });

  // Keep all hooks (the useEffect blocks below) ABOVE this region. React
  // requires hooks to run unconditionally on every render; an early return
  // placed before them skips the params-init effect, leaving `params` null
  // forever → blank screen. The null guard lives just before the JSX return.
  const features = caps?.features_by_mode?.[mode] || {};
  // 家族检测走 Rust detect_family（唯一实现）；异步就位前先按 custom 渲染。
  const [family, setFamily] = useState("custom");
  useEffect(() => {
    const p = caps?.model?.path || caps?.model?.name || "";
    if (!p) {
      setFamily("custom");
      return;
    }
    let alive = true;
    api
      .detectFamily(p)
      .then((f) => {
        if (alive) setFamily(f);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [caps?.model?.path, caps?.model?.name]);
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

  const switchMode = (m: GenMode) => {
    if (m === mode) return;
    imageSnapshots.current[mode] = {
      initImage,
      maskImage,
      controlImage,
      endImage,
      refImages: [...refImages],
    };
    const next = imageSnapshots.current[m];
    setImage("initImage", next.initImage);
    setImage("maskImage", next.maskImage);
    setImage("controlImage", next.controlImage);
    setImage("endImage", next.endImage);
    setRefImages(() => [...next.refImages]);
    setMode(m);
  };

  const handleGenerate = async () => {
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
        endImage,
        refImages,
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
              images: { ...images, refImages: [...refImages] },
            },
          },
          ...j,
        ]);
      } else if (status === 429) {
        toast("队列已满", true);
      } else {
        const err =
          (respBody as { error?: { message?: string } })?.error?.message ||
          `错误 ${status}`;
        toast(err, true);
      }
    } catch (e) {
      toast("网络错误: " + formatError(e), true);
    } finally {
      setSubmitting(false);
    }
  };

  const randomSeed = () => {
    if (!params) return;
    const next = !seedRandom;
    setSeedRandom(next);
    if (!next && params.seed < 0) update("seed", randSeed());
  };

  const resetToDefaults = () => {
    if (!caps || !params) return;
    const base = deepClone(caps.defaults_by_mode[mode]);
    const cfg = FAMILY_CONFIG[family];
    const merged = cfg?.genDefaults
      ? deepMerge(base, deepClone(cfg.genDefaults))
      : base;
    merged.prompt = params.prompt || "";
    merged.negative_prompt = params.negative_prompt || "";
    setParams(merged);
    const gd = cfg?.genDefaults as { seed?: number } | undefined;
    if (gd?.seed != null && gd.seed < 0) setSeedRandom(true);
    toast("已重置为推荐值");
  };

  const cancelJob = async (id: string) => {
    try {
      const { status } = await api.sdcppCancel(id);
      if (status === 200) {
        setJobs((j) =>
          j.map((x) => (x.id === id ? { ...x, status: "cancelled" } : x))
        );
      } else if (status === 409) {
        // sd-server 不支持中断生成中的任务（capabilities.cancel_generating=false）
        toast("任务正在生成，暂不支持中断", true);
      } else {
        toast("取消失败", true);
      }
    } catch {
      toast("取消失败", true);
    }
  };

  // 从列表移除单个任务（排队中的先取消，释放服务器队列槽位）。
  const removeJob = async (id: string) => {
    const job = useStore.getState().jobs.find((j) => j.id === id);
    if (job?.status === "queued") {
      try {
        const cancelled = await api.sdcppCancel(id);
        if (cancelled.status !== 200) {
          toast("取消排队任务失败，已保留任务记录", true);
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
    revokeVideoUrl(id);
    processedJobs.current.delete(id);
    setJobs((j) => j.filter((x) => x.id !== id));
    setResults((r) => {
      const removed = r.find((x) => x.jobId === id);
      removed?.result?.images?.forEach((img) => {
        if (img.b64_json) revokeImageUrl(img.b64_json);
      });
      return r.filter((x) => x.jobId !== id);
    });
  };

  // 清空整个队列（取消所有可取消的任务）。
  const clearJobs = async () => {
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
  };

  // 删除单个结果，联动删除对应任务。
  const removeResult = async (jobId: string, imageIndex?: number) => {
    const resultEntry = useStore.getState().results.find((entry) => entry.jobId === jobId);
    if (
      resultEntry &&
      resultEntry.saveStatus !== "saved" &&
      !window.confirm(
        imageIndex == null
          ? "该结果尚未确认保存。删除后可能无法恢复，是否继续？"
          : "该图片尚未确认保存。删除后可能无法恢复，是否继续？"
      )
    ) {
      return;
    }
    const job = useStore.getState().jobs.find((j) => j.id === jobId);
    if (job && (job.status === "queued" || job.status === "generating")) {
      await api.sdcppCancel(jobId).catch(() => {});
    }
    let removedWholeEntry = imageIndex == null;
    setResults((entries) =>
      entries.flatMap((entry) => {
        if (entry.jobId !== jobId) return [entry];
        if (imageIndex == null || !entry.result.images) {
          entry.result.images?.forEach((image) => revokeImageUrl(image.b64_json));
          removedWholeEntry = true;
          return [];
        }
        const remaining = entry.result.images.filter(
          (image, index) => (image.index ?? index) !== imageIndex
        );
        const removed = entry.result.images.find(
          (image, index) => (image.index ?? index) === imageIndex
        );
        if (removed) revokeImageUrl(removed.b64_json);
        if (remaining.length === 0) {
          removedWholeEntry = true;
          return [];
        }
        return [{ ...entry, result: { ...entry.result, images: remaining } }];
      })
    );
    if (removedWholeEntry) {
      revokeVideoUrl(jobId);
      processedJobs.current.delete(jobId);
      setJobs((current) => current.filter((entry) => entry.id !== jobId));
    }
  };

  // 恢复某任务/结果记录的生成配置：写入 localStorage 后切 mode，
  // 由 GenerationUI 的 params init effect 读取并应用。
  // seedOffset：批量生成时第 k 张的实际种子是 seed+k（引擎按 seed+b 递增），
  // 从单张结果恢复时传入其 index 以复现该张。
  const applyConfig = (config?: JobConfig, seedOffset = 0) => {
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
    setImage("endImage", img?.endImage ?? null);
    setRefImages(() => img?.refImages ?? []);
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
  };

  const download = async (b64: string, fmt?: string, _mime?: string, seed?: number) => {
    if (!b64) return;
    try {
      const dt = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
      const name = seed != null && seed >= 0 ? `seed_${seed}_${dt}` : `lumina_${dt}`;
      const r = await api.saveAs(b64, fmt || "png", name);
      if (r.saved) toast("已保存：" + r.path);
    } catch (e) {
      toast("保存失败: " + formatError(e), true);
    }
  };

  // 结果图用作 img2img 初始图片。
  const useAsInit = (src: string) => {
    setImage("initImage", src);
    if (mode !== "img_gen") setMode("img_gen");
    toast("已设为初始图片，可在「图片输入」面板中调整");
  };

  // 从 PNG Info 恢复参数（历史画廊）。
  const restoreFromMetadata = (metadata: Record<string, unknown>, _imageSrc: string) => {
    try {
      if (!params) return;
      // 元数据的字段结构与 GenParams 兼容（server 写入的 JSON 即为请求体格式）。
      const merged = { ...deepClone(params), ...metadata } as Partial<GenParams>;
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
      toast("已从历史图片恢复参数");
    } catch {
      toast("参数恢复失败", true);
    }
  };

  useKeyboardShortcuts({
    onGenerate: handleGenerate,
    onRandomSeed: randomSeed,
    onEscape: () => setLightboxItem(null),
    escapeActive: !!lightboxItem,
  });

  if (!caps || !params) return null;
  const sp = params.sample_params;
  const hsp = params.high_noise_sample_params;
  const negativeVisible =
    showNegative || !!(params.negative_prompt && params.negative_prompt.trim());

  return (
    <>
      <header className="header">
        <div className="header-logo">
          <Logo size={26} />
          <span className="brand-zh">流光</span>
          <span className="brand-en">Lumina</span>
        </div>
        <div className="header-model">
          <span title={caps.model?.path || caps.model?.name || "当前模型"}>
            {caps.model?.name || caps.model?.path?.split(/[\\/]/).pop() || "当前模型"}
          </span>
        </div>
        <div className="header-spacer" />
        <button
          className="btn btn-sm"
          onClick={() => setDashboardOpen(true)}
          aria-label="前往控制台更换模型或修改设置"
        >
          更换模型 / 设置
        </button>
        <div className="mode-tabs">
          {caps.supported_modes?.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`mode-tab${mode === m ? " active" : ""}`}
              onClick={() => switchMode(m)}
            >
              {m === "img_gen" ? "图片" : "视频"}
            </button>
          ))}
        </div>
      </header>
      <ProgressBar />
      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-scroll">
            {features.init_image && (
              <Panel title="图片输入" collapsed={!features.init_image}>
                {features.init_image && (
                  <ImageUpload
                    label="初始图片"
                    value={initImage}
                    onChange={(v) => setImage("initImage", v)}
                    onSizeDetected={(w, h) => {
                      // 按初始图片尺寸自动填充宽高：对齐到 64 并 clamp 到 limits。
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
                      toast(`已应用图片尺寸 ${aw}×${ah}`);
                    }}
                  />
                )}
                {features.mask_image && mode === "img_gen" && (
                  <ImageUpload
                    label="蒙版"
                    value={maskImage}
                    onChange={(v) => setImage("maskImage", v)}
                  />
                )}
                {features.control_image && mode === "img_gen" && (
                  <ImageUpload
                    label="Control 图片"
                    value={controlImage}
                    onChange={(v) => setImage("controlImage", v)}
                  />
                )}
                {features.end_image && mode === "vid_gen" && (
                  <ImageUpload
                    label="结束帧"
                    value={endImage}
                    onChange={(v) => setImage("endImage", v)}
                  />
                )}
                {(features.init_image || features.control_image) &&
                  mode === "img_gen" && (
                    <>
                      <Slider
                        label="重绘强度"
                        value={params.strength ?? 0.75}
                        onChange={(v) => update("strength", v)}
                        min={0}
                        max={1}
                        step={0.05}
                      />
                      <Slider
                        label="Control 强度"
                        value={params.control_strength ?? 0.9}
                        onChange={(v) => update("control_strength", v)}
                        min={0}
                        max={1}
                        step={0.05}
                      />
                      <Slider
                        label="CFG (图像)"
                        value={sp?.guidance?.img_cfg}
                        onChange={(v) => update("sample_params.guidance.img_cfg", v)}
                        min={0}
                        max={30}
                        step={0.5}
                        hint={
                          sp?.guidance?.img_cfg != null
                            ? undefined
                            : `未设置，跟随文本 CFG (${sp?.guidance?.txt_cfg ?? 0})`
                        }
                      />
                    </>
                  )}
                {features.ref_images && mode === "img_gen" && (
                  <div className="form-row">
                    <div className="form-label">参考图片</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {refImages.map((img, i) => (
                        <div
                          key={i}
                          style={{
                            width: 56,
                            height: 56,
                            position: "relative",
                            borderRadius: "var(--radius-sm)",
                            overflow: "hidden",
                            border: "1px solid var(--border)",
                          }}
                        >
                          <img
                            src={img}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                          <button
                            className="upload-remove"
                            style={{ top: 2, right: 2, width: 14, height: 14, fontSize: 7 }}
                            onClick={() =>
                              setRefImages((r) => r.filter((_, j) => j !== i))
                            }
                          >
                            {IC.x}
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        aria-label="添加参考图片"
                        style={{
                          width: 56,
                          height: 56,
                          border: "1.5px dashed var(--border)",
                          borderRadius: "var(--radius-sm)",
                          display: "grid",
                          placeItems: "center",
                          cursor: "pointer",
                          color: "var(--muted)",
                          background: "transparent",
                        }}
                        onClick={() => {
                          const inp = document.createElement("input");
                          inp.type = "file";
                          inp.accept = "image/*";
                          inp.onchange = (e) => {
                            const f = (e.target as HTMLInputElement).files?.[0];
                            if (f) {
                              const r = new FileReader();
                              r.onload = (ev) =>
                                setRefImages((p) => [...p, ev.target?.result as string]);
                              r.readAsDataURL(f);
                            }
                          };
                          inp.click();
                        }}
                      >
                        {IC.plus}
                      </button>
                    </div>
                  </div>
                )}
              </Panel>
            )}

            <Panel title="尺寸与种子">
              <div className="size-presets">
                {sizePresets.map((grp) => (
                  <div key={grp.label} className="size-group">
                    <span className="size-group-label">{grp.label}</span>
                    <div className="size-group-btns">
                      {grp.sizes.map(([l, w, h]) => (
                        <button
                          key={l}
                          className={`size-preset${
                            params.width === w && params.height === h ? " active" : ""
                          }`}
                          aria-pressed={params.width === w && params.height === h}
                          onClick={() => {
                            update("width", w);
                            update("height", h);
                          }}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="inline-2">
                <div className="form-row">
                  <label className="form-label" htmlFor="generation-width">宽度</label>
                  <NumberInput
                    id="generation-width"
                    value={params.width}
                    onChange={(value) => update("width", value)}
                    min={caps.limits?.min_width || 64}
                    max={caps.limits?.max_width || 4096}
                    step={64}
                  />
                </div>
                <div className="form-row">
                  <label className="form-label" htmlFor="generation-height">高度</label>
                  <NumberInput
                    id="generation-height"
                    value={params.height}
                    onChange={(value) => update("height", value)}
                    min={caps.limits?.min_height || 64}
                    max={caps.limits?.max_height || 4096}
                    step={64}
                  />
                </div>
              </div>
              <div className="form-row" style={{ marginTop: 8 }}>
                <label className="form-label" htmlFor="generation-seed">种子</label>
                <div className="seed-row">
                  <input
                    id="generation-seed"
                    type="number"
                    value={params.seed < 0 ? "" : params.seed}
                    onChange={(e) => {
                      setSeedRandom(false);
                      update("seed", e.target.value === "" ? 0 : parseInt(e.target.value) || 0);
                    }}
                    placeholder="随机"
                  />
                  <button
                    className={`seed-btn${seedRandom ? " active" : ""}`}
                    title="随机种子"
                    aria-label="切换每次生成使用随机种子"
                    aria-pressed={seedRandom}
                    onClick={randomSeed}
                  >
                    {IC.dice}
                  </button>
                </div>
              </div>
              {mode === "img_gen" && (
                <div className="form-row" style={{ marginTop: 6 }}>
                  <label className="form-label" htmlFor="batch-count">批量</label>
                  <div className="slider-row">
                    <input
                      id="batch-count"
                      type="range"
                      value={params.batch_count || 1}
                      onChange={(e) => update("batch_count", parseInt(e.target.value))}
                      min={1}
                      max={caps.limits?.max_batch_count || 8}
                    />
                    <span className="slider-val">{params.batch_count || 1}</span>
                  </div>
                </div>
              )}
              {mode === "img_gen" && family === "qwen-image-layered" && (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <label className="form-label" htmlFor="qwen-image-layers">
                    分层数量
                  </label>
                  <NumberInput
                    id="qwen-image-layers"
                    value={params.qwen_image_layers ?? 3}
                    onChange={(value) => update("qwen_image_layers", value)}
                    min={0}
                    step={1}
                    style={{ width: 80 }}
                  />
                  <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
                    最终输出数量为分层数量 + 1
                  </div>
                </div>
              )}
              {mode === "vid_gen" && (
                <>
                  <Slider
                    label="帧数"
                    value={params.video_frames || 33}
                    onChange={(v) => update("video_frames", v)}
                    min={1}
                    max={121}
                  />
                  {family === "lingbot-video" && (
                    <div className="frame-presets" aria-label="LingBot 帧数快捷项">
                      {[33, 49, 81].map((frames) => (
                        <button
                          type="button"
                          key={frames}
                          className={`size-preset${
                            params.video_frames === frames ? " active" : ""
                          }`}
                          onClick={() => update("video_frames", frames)}
                        >
                          {frames} 帧
                        </button>
                      ))}
                    </div>
                  )}
                  <Slider
                    label="FPS"
                    value={params.fps || 24}
                    onChange={(v) => update("fps", v)}
                    min={1}
                    max={60}
                  />
                </>
              )}
            </Panel>

            <Panel title="采样设置">
              <div className="inline-2">
                <div className="form-row">
                  <label className="form-label" htmlFor="sample-method">采样器</label>
                  <select
                    id="sample-method"
                    value={sp?.sample_method || "euler"}
                    onChange={(e) => update("sample_params.sample_method", e.target.value)}
                  >
                    {(caps.samplers || []).map((s) => (
                      <option key={s} value={s}>
                        {SAMPLER_NAMES[s] || s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="form-label" htmlFor="scheduler">调度器</label>
                  <select
                    id="scheduler"
                    value={sp?.scheduler || "discrete"}
                    onChange={(e) => update("sample_params.scheduler", e.target.value)}
                  >
                    {(caps.schedulers || []).map((s) => (
                      <option key={s} value={s}>
                        {SCHEDULER_NAMES[s] || s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Slider
                label="步数"
                value={sp?.sample_steps ?? 20}
                onChange={(v) => update("sample_params.sample_steps", v)}
                min={1}
                max={100}
              />
              <Slider
                label="CFG (文本)"
                value={sp?.guidance?.txt_cfg ?? 7}
                onChange={(v) => update("sample_params.guidance.txt_cfg", v)}
                min={0}
                max={30}
                step={0.5}
              />
              {DISTILL_FAMILIES.includes(family) && (
                <Slider
                  label="蒸馏 CFG"
                  value={sp?.guidance?.distilled_guidance ?? 0}
                  onChange={(v) => update("sample_params.guidance.distilled_guidance", v)}
                  min={0}
                  max={30}
                  step={0.5}
                  hint="蒸馏模型"
                />
              )}
              <button
                className="btn btn-sm"
                style={{ width: "100%" }}
                onClick={resetToDefaults}
              >
                {IC.refresh}
                <span>恢复当前模型推荐值</span>
              </button>
            </Panel>

            <Panel title="高级采样" collapsed>
              <Slider
                label="Eta"
                value={sp?.eta ?? 1}
                onChange={(v) => update("sample_params.eta", v)}
                min={0}
                max={1}
                step={0.05}
                hint="随机噪声强度，通常保持推荐值"
              />
              <Slider
                label="Flow Shift"
                value={sp?.flow_shift ?? 0}
                onChange={(v) => update("sample_params.flow_shift", v)}
                min={0}
                max={20}
                step={0.1}
                hint="Flow 类模型的时间步偏移"
              />
              <Slider
                label="SLG Scale"
                value={sp?.guidance?.slg?.scale ?? 0}
                onChange={(v) =>
                  update("sample_params.guidance.slg", {
                    ...(sp?.guidance?.slg || { layers: [7, 8, 9] }),
                    scale: v,
                  })
                }
                min={0}
                max={10}
                step={0.1}
                hint="跳层引导，0 表示关闭"
              />
              <Toggle
                label="VAE 分块"
                checked={!!params.vae_tiling_params?.enabled}
                onChange={(v) =>
                  // 展开保留 caps 默认带下来的 tile_size 等字段，只翻转开关
                  update("vae_tiling_params", {
                    ...params.vae_tiling_params,
                    enabled: v,
                  })
                }
              />
              <div className="form-row">
                <label className="form-label" htmlFor="cache-mode">缓存</label>
                <select
                  id="cache-mode"
                  value={params.cache_mode || "disabled"}
                  onChange={(e) => update("cache_mode", e.target.value)}
                >
                  {CACHE_MODES.map((c) => (
                    <option key={c.v} value={c.v}>
                      {c.l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="clip-skip">CLIP Skip</label>
                <select
                  id="clip-skip"
                  value={params.clip_skip ?? -1}
                  onChange={(e) => update("clip_skip", parseInt(e.target.value))}
                >
                  <option value={-1}>自动（随版本）</option>
                  <option value={1}>1 · 最后一层</option>
                  <option value={2}>2 · 倒数第二层</option>
                  <option value={3}>3</option>
                </select>
              </div>
            </Panel>

            {mode === "vid_gen" && family === "wan-a14b" && (
              <Panel title="高噪段采样">
                <div className="inline-2">
                  <div className="form-row">
                    <label className="form-label" htmlFor="high-noise-sampler">采样器</label>
                    <select
                      id="high-noise-sampler"
                      value={hsp?.sample_method || sp?.sample_method || "euler"}
                      onChange={(e) =>
                        update("high_noise_sample_params.sample_method", e.target.value)
                      }
                    >
                      {(caps.samplers || []).map((s) => (
                        <option key={s} value={s}>
                          {SAMPLER_NAMES[s] || s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor="high-noise-scheduler">调度器</label>
                    <select
                      id="high-noise-scheduler"
                      value={hsp?.scheduler || sp?.scheduler || "discrete"}
                      onChange={(e) =>
                        update("high_noise_sample_params.scheduler", e.target.value)
                      }
                    >
                      {(caps.schedulers || []).map((s) => (
                        <option key={s} value={s}>
                          {SCHEDULER_NAMES[s] || s}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Slider
                  label="步数"
                  value={hsp?.sample_steps ?? 8}
                  onChange={(v) => update("high_noise_sample_params.sample_steps", v)}
                  min={1}
                  max={100}
                />
                <Slider
                  label="CFG (文本)"
                  value={hsp?.guidance?.txt_cfg ?? 3.5}
                  onChange={(v) =>
                    update("high_noise_sample_params.guidance.txt_cfg", v)
                  }
                  min={0}
                  max={30}
                  step={0.5}
                />
                {DISTILL_FAMILIES.includes(family) && (
                  <Slider
                    label="蒸馏 CFG (高噪)"
                    value={hsp?.guidance?.distilled_guidance ?? 0}
                    onChange={(v) =>
                      update("high_noise_sample_params.guidance.distilled_guidance", v)
                    }
                    min={0}
                    max={30}
                    step={0.5}
                  />
                )}
                <Slider
                  label="Eta (高噪)"
                  value={hsp?.eta ?? 1}
                  onChange={(v) => update("high_noise_sample_params.eta", v)}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <Slider
                  label="Flow Shift (高噪)"
                  value={hsp?.flow_shift ?? 0}
                  onChange={(v) =>
                    update("high_noise_sample_params.flow_shift", v)
                  }
                  min={0}
                  max={20}
                  step={0.1}
                />
                <Slider
                  label="MoE Boundary"
                  value={params.moe_boundary ?? 0.8}
                  onChange={(v) => update("moe_boundary", v)}
                  min={0}
                  max={1}
                  step={0.05}
                  hint="低噪段/高噪段分界比例"
                />
              </Panel>
            )}

            {features.lora && (
              <Panel title="LoRA" badge={(params.lora?.length || 0) || null}>
                {(params.lora || []).map((l, i) => {
                  const setMult = (v: number) => {
                    const n = [...(params.lora || [])];
                    n[i] = { ...n[i], multiplier: v };
                    update("lora", n);
                  };
                  return (
                  <div key={i} className="lora-row">
                    <div className="lora-row-main">
                      <select
                        aria-label={`第 ${i + 1} 个 LoRA 模型`}
                        value={l.path}
                        onChange={(e) => {
                          const n = [...(params.lora || [])];
                          n[i] = { ...n[i], path: e.target.value };
                          update("lora", n);
                        }}
                      >
                        <option value="">-- 选择 LoRA --</option>
                        {(caps.loras || []).map((l2) => (
                          <option key={l2.path} value={l2.path}>
                            {l2.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="lora-remove"
                        onClick={() =>
                          update(
                            "lora",
                            (params.lora || []).filter((_, j) => j !== i)
                          )
                        }
                      >
                        {IC.x}
                      </button>
                    </div>
                    <div className="lora-mult-row">
                      <span className="lora-mult-label">强度</span>
                      <input
                        type="range"
                        className="lora-mult-slider"
                        min={0}
                        max={2}
                        step={0.05}
                        value={l.multiplier ?? 1}
                        onChange={(e) => setMult(parseFloat(e.target.value))}
                      />
                      <NumberInput
                        className="lora-mult-num"
                        min={0}
                        max={2}
                        step={0.05}
                        value={l.multiplier ?? 1}
                        onChange={setMult}
                        ariaLabel={`第 ${i + 1} 个 LoRA 强度`}
                      />
                    </div>
                  </div>
                  );
                })}
                <button
                  className="add-lora"
                  onClick={() =>
                    update("lora", [
                      ...(params.lora || []),
                      { path: "", multiplier: 1 },
                    ])
                  }
                >
                  {IC.plus} 添加 LoRA
                </button>
              </Panel>
            )}

            {features.hires && (
              <Panel title="高清修复" collapsed>
                <Toggle
                  label="启用"
                  checked={!!params.hires?.enabled}
                  onChange={(v) => update("hires", { ...params.hires, enabled: v })}
                />
                {params.hires?.enabled && (
                  <>
                    <div className="form-row" style={{ marginTop: 8 }}>
                      <label className="form-label" htmlFor="hires-upscaler">放大器</label>
                      <select
                        id="hires-upscaler"
                        value={params.hires.upscaler || "Latent"}
                        onChange={(e) =>
                          update("hires", { ...params.hires, upscaler: e.target.value })
                        }
                      >
                        {/* caps.upscalers 已包含全部内置项（None/Lanczos/Latent…）
                            以及 --hires-upscalers-dir 扫描到的 ESRGAN 模型；
                            BUILTIN_UPSCALERS 仅作为 caps 缺失时的回退，两者不能
                            拼接使用（会产生重复项和重复 key）。 */}
                        {(caps.upscalers?.length
                          ? caps.upscalers.map((u) => u.name)
                          : BUILTIN_UPSCALERS
                        ).map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Slider
                      label="步数"
                      value={params.hires.steps ?? 20}
                      onChange={(v) => update("hires", { ...params.hires, steps: v })}
                      min={1}
                      max={100}
                    />
                    <Slider
                      label="缩放"
                      value={params.hires.scale ?? 2}
                      onChange={(v) => update("hires", { ...params.hires, scale: v })}
                      min={1}
                      max={4}
                      step={0.1}
                    />
                    <Slider
                      label="降噪"
                      value={params.hires.denoising_strength ?? 0.7}
                      onChange={(v) =>
                        update("hires", { ...params.hires, denoising_strength: v })
                      }
                      min={0}
                      max={1}
                      step={0.05}
                    />
                  </>
                )}
              </Panel>
            )}

            <Panel title="输出" collapsed>
              <div className="form-row">
                <label className="form-label" htmlFor="output-format">格式</label>
                <select
                  id="output-format"
                  value={params.output_format || "png"}
                  onChange={(e) => update("output_format", e.target.value)}
                >
                  {(caps.output_formats_by_mode?.[mode] || ["png"]).map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              {mode === "img_gen" && (
                <Slider
                  label="压缩"
                  value={params.output_compression ?? 100}
                  onChange={(v) => update("output_compression", v)}
                  min={1}
                  max={100}
                />
              )}
            </Panel>
          </div>
        </aside>
        <div className="output-area">
          <div className="canvas-toolbar" role="tablist" aria-label="工作区视图">
            <div className="mode-tabs">
              <button
                role="tab"
                aria-selected={workspaceTab === "results"}
                className={`mode-tab${workspaceTab === "results" ? " active" : ""}`}
                onClick={() => setWorkspaceTab("results")}
              >
                当前结果
              </button>
              <button
                role="tab"
                aria-selected={workspaceTab === "history"}
                className={`mode-tab${workspaceTab === "history" ? " active" : ""}`}
                onClick={() => setWorkspaceTab("history")}
              >
                历史画廊
              </button>
            </div>
            <div className="header-spacer" />
            <button
              className={`btn btn-sm queue-toggle${queueOpen ? " active" : ""}`}
              onClick={() => setQueueOpen((v) => !v)}
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
          <div className="prompt-dock">
            {negativeVisible && (
              <textarea
                id="negative-prompt"
                className="dock-negative"
                value={params.negative_prompt || ""}
                onChange={(e) => update("negative_prompt", e.target.value)}
                placeholder="反向提示词：描述你想排除的内容…"
                rows={2}
                aria-label="反向提示词"
              />
            )}
            <div className="prompt-dock-row">
              <textarea
                id="positive-prompt"
                className="dock-prompt"
                value={params.prompt || ""}
                onChange={(e) => update("prompt", e.target.value)}
                placeholder="描述你想生成的画面…（Ctrl + Enter 生成）"
                rows={3}
                aria-label="正向提示词"
              />
              <div className="prompt-dock-actions">
                <button
                  type="button"
                  className={`seed-btn${negativeVisible ? " active" : ""}`}
                  onClick={() => setShowNegative((v) => !v)}
                  aria-pressed={negativeVisible}
                  aria-label="切换反向提示词输入"
                  title="反向提示词"
                >
                  反
                </button>
                <button
                  className={`seed-btn${seedRandom ? " active" : ""}`}
                  onClick={randomSeed}
                  aria-label="切换每次生成使用随机种子"
                  aria-pressed={seedRandom}
                  title="随机种子"
                >
                  {IC.dice}
                </button>
                <button
                  className="btn btn-primary generate-btn"
                  onClick={handleGenerate}
                  disabled={submitting || activeJobs >= maxQueue}
                >
                  {submitting ? (
                    <>
                      <span className="spinner" /> 提交中
                    </>
                  ) : currentGen ? (
                    <>
                      <span className="spinner" /> 生成中
                    </>
                  ) : (
                    <>
                      {IC.play} 生成
                    </>
                  )}
                </button>
              </div>
            </div>
            {family === "lingbot-video" && (
              <div className="prompt-tools">
                <button
                  type="button"
                  className="size-preset"
                  onClick={() => {
                    const current = params.prompt?.trim();
                    if (
                      current &&
                      !window.confirm("当前提示词将被 LingBot JSON 模板替换，是否继续？")
                    ) {
                      return;
                    }
                    update("prompt", LINGBOT_PROMPT_TEMPLATE);
                  }}
                >
                  插入 LingBot JSON 模板
                </button>
                <span className="field-hint">
                  也可继续使用普通文本；以 JSON 开头时会在提交前校验格式
                </span>
              </div>
            )}
          </div>
          {queueOpen && (
            <>
              <div
                className="queue-backdrop"
                onClick={() => setQueueOpen(false)}
                aria-hidden="true"
              />
              <div className="queue-overlay">
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
              </div>
            </>
          )}
        </div>
      </div>
      <Lightbox item={lightboxItem} onClose={closeLightbox} />
    </>
  );
}
