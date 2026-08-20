import { memo, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ImageSaveState, ResultEntry } from "../../store";
import type { JobConfig } from "../../types";
import type { LightboxItem } from "../ui/Lightbox";
import { useVideoPoster } from "../../hooks/useVideoPoster";
import { useTheme } from "../../lib/theme";
import { cn } from "../ui/cn";
import { IC } from "../ui/Icons";
import { TwoTapButton } from "../ui/TwoTapButton";
import { VostokPoster } from "../ui/VostokArt";

/** 视频瓦片:首帧 poster(加载前不再黑屏),展示属性按场景传入 */
function VideoTile({
  url,
  autoplay,
}: {
  url: string;
  autoplay?: boolean;
}) {
  const poster = useVideoPoster(url);
  return autoplay ? (
    <video src={url} controls autoPlay loop muted poster={poster ?? undefined} />
  ) : (
    <video src={url} controls preload="metadata" poster={poster ?? undefined} />
  );
}

interface Props {
  results: ResultEntry[];
  generating: boolean;
  onLightbox: (items: LightboxItem[], index: number) => void;
  onApplyConfig: (config?: JobConfig, seedOffset?: number) => void;
  onDownload: (b64: string, fmt?: string, mime?: string, seed?: number) => void;
  onRemove: (jobId: string, imageIndex?: number) => void;
  /** 一键保存到输出目录(key = 图片索引字符串,视频为 "v") */
  onSaveImage: (jobId: string, key: string) => void;
  /** 传入原始 b64_json + 输出格式，由调用方转成 dataURL（blob: URL 无法被
   * sd-server 解码，且切回控制台即被 revoke——对抗性审查 B2）。 */
  onUseAsInit: (b64: string, fmt: string) => void;
  getVideoUrl: (jobId: string, b64: string, mime: string) => string;
  getImageUrl: (b64: string, fmt: string) => string;
}

/** 单张图片/视频的保存状态展示文案 */
function partSaveLabel(state?: ImageSaveState): {
  text: string;
  className: string;
  title?: string;
} | null {
  switch (state?.status) {
    case "saving":
      return { text: "保存中", className: "saving" };
    case "saved":
      return { text: "已保存", className: "saved", title: state.path };
    case "failed":
      return { text: "保存失败", className: "failed", title: state.error };
    default:
      return null;
  }
}

/** 保存按钮的提示文案(按状态) */
function saveBtnTitle(state?: ImageSaveState): string {
  switch (state?.status) {
    case "saving":
      return "正在保存…";
    case "saved":
      return `已保存到输出目录：${state.path || ""}`;
    case "failed":
      return `保存失败：${state.error || "未知原因"}（点击重试）`;
    default:
      return "保存到输出目录";
  }
}

function seedLabel(config?: JobConfig, index?: number): string {
  const base = config?.params?.seed;
  if (base == null || base < 0) return "";
  const s = base + (index ?? 0);
  return `种子 ${s}`;
}

function dimensionLabel(config?: JobConfig): string {
  const w = config?.params?.width;
  const h = config?.params?.height;
  if (w == null || h == null) return "";
  return `${w}×${h}`;
}

function elapsedLabel(created?: number, completedAt?: number): string {
  if (created == null || created <= 0 || completedAt == null) return "";
  const secs = Math.max(0, Math.round(completedAt / 1000 - created));
  if (secs < 60) return `${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m} 分 ${s} 秒`;
}

/** 全量结果拍平成 lightbox 导航列表(聚焦区在前,瀑布流在后) */
function buildLightboxItems(
  results: ResultEntry[],
  getImageUrl: (b64: string, fmt: string) => string,
  getVideoUrl: (jobId: string, b64: string, mime: string) => string
): { items: LightboxItem[]; indexOf: Map<string, number> } {
  const items: LightboxItem[] = [];
  const indexOf = new Map<string, number>();
  for (const r of results) {
    if (r.result?.images) {
      const fmt = r.result.output_format || "png";
      r.result.images.forEach((img) => {
        const key = `${r.jobId}:${img.index ?? -1}`;
        indexOf.set(key, items.length);
        items.push({
          type: "image",
          src: getImageUrl(img.b64_json, fmt),
          title: [seedLabel(r.config, img.index), dimensionLabel(r.config)]
            .filter(Boolean)
            .join(" · "),
        });
      });
    } else if (r.result?.b64_json) {
      const key = `${r.jobId}:v`;
      indexOf.set(key, items.length);
      items.push({
        type: "video",
        src: getVideoUrl(
          r.jobId,
          r.result.b64_json,
          r.result.mime_type || "video/webm"
        ),
        title: `${r.result.fps} FPS · ${r.result.frame_count} 帧`,
      });
    }
  }
  return { items, indexOf };
}

// 显影(The Develop):小图放大成型——暗房里照片从一小张渐渐放大显影,
// 只用缩放/透明度/饱和度渐变,不用模糊,避免大图模糊导致的闪烁。
const cardMotion = {
  layout: true,
  initial: {
    opacity: 0,
    scale: 0.86,
    filter: "saturate(0.55) brightness(0.9)",
  },
  animate: { opacity: 1, scale: 1, filter: "saturate(1) brightness(1)" },
  exit: {
    opacity: 0,
    scale: 0.94,
    transition: { duration: 0.16 },
  },
} as const;

/** 图片的保存键:与 ingest 时相同,index 缺省按渲染顺序 */
const imageKey = (imgIndex: number | undefined, ii: number) =>
  String(imgIndex ?? ii);

/** 保存到输出目录的图标按钮(与"下载"弹窗选路径区分) */
function SaveToDirButton({
  state,
  onSave,
  ariaLabel,
}: {
  state?: ImageSaveState;
  onSave: () => void;
  ariaLabel: string;
}) {
  const saved = state?.status === "saved";
  const saving = state?.status === "saving";
  return (
    <button
      className={cn("btn btn-sm", saved && "save-done")}
      title={saveBtnTitle(state)}
      aria-label={ariaLabel}
      disabled={saving}
      onClick={onSave}
    >
      {IC.save}
    </button>
  );
}

interface FeaturedProps {
  entry: ResultEntry;
  items: LightboxItem[];
  indexOf: Map<string, number>;
  onLightbox: Props["onLightbox"];
  onApplyConfig: Props["onApplyConfig"];
  onDownload: Props["onDownload"];
  onRemove: Props["onRemove"];
  onSaveImage: Props["onSaveImage"];
  onUseAsInit: Props["onUseAsInit"];
  getVideoUrl: Props["getVideoUrl"];
  getImageUrl: Props["getImageUrl"];
}

// 本次生成聚焦区：最新结果铺满可视区，瀑布流里只保留更早的内容。
function FeaturedResult({
  entry,
  items,
  indexOf,
  onLightbox,
  onApplyConfig,
  onDownload,
  onRemove,
  onSaveImage,
  onUseAsInit,
  getVideoUrl,
  getImageUrl,
}: FeaturedProps) {
  const dimInfo = dimensionLabel(entry.config);
  const timeInfo = elapsedLabel(entry.created, entry.completedAt);

  const meta = (
    <div className="featured-meta">
      {dimInfo && <span className="meta-dim">{dimInfo}</span>}
      {timeInfo && <span className="meta-time">{timeInfo}</span>}
    </div>
  );

  const images = entry.result?.images || [];
  if (images.length > 0) {
    const fmt = entry.result?.output_format || "png";
    const allSaved = images.every(
      (img, ii) => entry.saves?.[imageKey(img.index, ii)]?.status === "saved"
    );
    return (
      <motion.section
        key={`featured-${entry.jobId}`}
        className={cn("featured-result", images.length === 1 && "single")}
        {...cardMotion}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="featured-batch">
          {images.map((img, ii) => {
            const src = getImageUrl(img.b64_json, fmt);
            const seedInfo = seedLabel(entry.config, img.index ?? ii);
            const key = imageKey(img.index, ii);
            const lbIndex =
              indexOf.get(`${entry.jobId}:${img.index ?? ii}`) ?? 0;
            const saveState = entry.saves?.[key];
            return (
              <figure
                key={`${entry.jobId}-${img.index ?? ii}`}
                className="featured-item"
              >
                <button
                  type="button"
                  className="featured-preview-button"
                  aria-label={`查看本次生成${seedInfo ? `，${seedInfo}` : ""}`}
                  onClick={() => onLightbox(items, lbIndex)}
                >
                  <img src={src} alt="" />
                </button>
                <div className="featured-item-actions">
                  <SaveToDirButton
                    state={saveState}
                    ariaLabel="保存到输出目录"
                    onSave={() => onSaveImage(entry.jobId, key)}
                  />
                  <button
                    className="btn btn-sm"
                    title="用作初始图片（发送到 img2img）"
                    aria-label="用作初始图片"
                    onClick={() => onUseAsInit(img.b64_json, fmt)}
                  >
                    {IC.image}
                  </button>
                  <button
                    className="btn btn-sm"
                    title={
                      entry.config && entry.config.params.seed >= 0
                        ? `应用此配置（种子 ${
                            entry.config.params.seed + (img.index ?? ii)
                          }）`
                        : "应用此配置"
                    }
                    aria-label="应用此图片的生成配置"
                    onClick={() => onApplyConfig(entry.config, img.index ?? ii)}
                  >
                    {IC.refresh}
                  </button>
                  <button
                    className="btn btn-sm"
                    aria-label="下载图片"
                    onClick={() =>
                      onDownload(
                        img.b64_json,
                        fmt,
                        undefined,
                        entry.config?.params?.seed != null &&
                          entry.config.params.seed >= 0
                          ? entry.config.params.seed + (img.index ?? ii)
                          : undefined
                      )
                    }
                  >
                    {IC.dl}
                  </button>
                  <TwoTapButton
                    className="btn btn-sm btn-danger"
                    label="删除此图片"
                    armedLabel="确认删除（尚未保存）"
                    armedTitle="尚未保存，再次点击确认删除"
                    needsConfirm={saveState?.status !== "saved"}
                    onConfirm={() => onRemove(entry.jobId, img.index ?? ii)}
                    idle={IC.x}
                    armed={"确认?"}
                  />
                </div>
                {seedInfo && <span className="featured-seed">{seedInfo}</span>}
                {saveState?.status === "failed" && (
                  <div className="featured-save-failed">
                    <span role="alert">保存失败</span>
                    <button
                      type="button"
                      className="result-save-retry"
                      onClick={() => onSaveImage(entry.jobId, key)}
                    >
                      重试保存
                    </button>
                  </div>
                )}
              </figure>
            );
          })}
        </div>
        {images.length > 1 && (
          <div className="featured-batch-actions">
            <button
              type="button"
              className="btn btn-sm"
              title="恢复该批次的生成配置（种子、提示词与图片输入）"
              onClick={() => onApplyConfig(entry.config)}
            >
              {IC.refresh} 应用整批配置
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="把本批全部图片保存到输出目录"
              onClick={() =>
                images.forEach((img, ii) =>
                  onSaveImage(entry.jobId, imageKey(img.index, ii))
                )
              }
            >
              {IC.save} 保存整批
            </button>
            <TwoTapButton
              className="btn btn-sm btn-danger"
              label="删除整批"
              armedLabel="确认删除整批（尚未保存）"
              armedTitle="尚未保存，再次点击确认删除"
              needsConfirm={!allSaved}
              onConfirm={() => onRemove(entry.jobId)}
              idle="删除整批"
              armed="确认?"
            />
          </div>
        )}
        {meta}
      </motion.section>
    );
  }

  if (entry.result?.b64_json) {
    const b64 = entry.result.b64_json;
    const mime = entry.result.mime_type || "video/webm";
    const url = getVideoUrl(entry.jobId, b64, mime);
    const lbIndex = indexOf.get(`${entry.jobId}:v`) ?? 0;
    const saveState = entry.saves?.["v"];
    return (
      <motion.section
        key={`featured-${entry.jobId}`}
        className="featured-result single"
        {...cardMotion}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <figure className="featured-item">
          <VideoTile url={url} autoplay />
          <div className="featured-item-actions">
            <SaveToDirButton
              state={saveState}
              ariaLabel="保存视频到输出目录"
              onSave={() => onSaveImage(entry.jobId, "v")}
            />
            <button
              className="btn btn-sm"
              title="全屏预览"
              aria-label="全屏预览视频"
              onClick={() => onLightbox(items, lbIndex)}
            >
              {IC.zoom}
            </button>
            <button
              className="btn btn-sm"
              title="应用此配置"
              aria-label="应用此视频的生成配置"
              onClick={() => onApplyConfig(entry.config)}
            >
              {IC.refresh}
            </button>
            <button
              className="btn btn-sm"
              aria-label="下载视频"
              onClick={() =>
                onDownload(b64, entry.result!.output_format, mime)
              }
            >
              {IC.dl} 下载
            </button>
            <TwoTapButton
              className="btn btn-sm btn-danger"
              label="删除此视频"
              armedLabel="确认删除（尚未保存）"
              armedTitle="尚未保存，再次点击确认删除"
              needsConfirm={saveState?.status !== "saved"}
              onConfirm={() => onRemove(entry.jobId)}
              idle={IC.x}
              armed={"确认?"}
            />
          </div>
          {saveState?.status === "failed" && (
            <div className="featured-save-failed">
              <span role="alert">保存失败</span>
              <button
                type="button"
                className="result-save-retry"
                onClick={() => onSaveImage(entry.jobId, "v")}
              >
                重试保存
              </button>
            </div>
          )}
        </figure>
        {meta}
      </motion.section>
    );
  }

  return null;
}

export const ResultsGrid = memo(function ResultsGrid({
  results,
  generating,
  onLightbox,
  onApplyConfig,
  onDownload,
  onRemove,
  onSaveImage,
  onUseAsInit,
  getVideoUrl,
  getImageUrl,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(results.length);
  const theme = useTheme();

  const { items, indexOf } = buildLightboxItems(
    results,
    getImageUrl,
    getVideoUrl
  );

  // 新结果落地（数组变长）时回到顶部聚焦区，保证新图一出现就在眼前。
  useEffect(() => {
    if (results.length > prevLen.current) {
      wrapRef.current?.parentElement?.scrollTo?.({ top: 0, behavior: "smooth" });
    }
    prevLen.current = results.length;
  }, [results.length]);

  if (results.length === 0) {
    // VOSTOK 空态:画布不是空白,钉着一张待替换的海报样张(原型素材回填);
    // 推进中样张退饱和 + 对角跟踪扫描,太空任务控制屏的构成主义表达。
    if (theme === "vostok") {
      return (
        <div
          className={cn(
            "empty-state",
            "empty-state-hero",
            "vostok-hero",
            generating && "generating"
          )}
        >
          <div className="vostok-hero-art">
            <VostokPoster />
            {generating && <span className="vostok-scan" aria-hidden="true" />}
          </div>
          {generating ? (
            <>
              <p className="text-[13px] text-fg2">推进中…</p>
              <p>图像正在回传，完成后会自动出现在这里</p>
            </>
          ) : (
            <>
              <p className="mb-1 text-[13px] text-fg2">发射台就绪</p>
              <p>
                输入提示词后点击 生成，或按 <span className="kbd">Ctrl</span>+
                <span className="kbd">Enter</span>
              </p>
            </>
          )}
        </div>
      );
    }
    return (
      <div className={cn("empty-state", "empty-state-hero", generating && "generating")}>
        {generating ? (
          <>
            <p className="text-[13px] text-fg2">正在显影…</p>
            <p>暗房里图像正在成形，完成后会自动出现在这里</p>
          </>
        ) : (
          <>
            <p className="mb-1 text-[13px] text-fg2">准备就绪</p>
            <p>
              输入提示词后点击 生成，或按 <span className="kbd">Ctrl</span>+
              <span className="kbd">Enter</span>
            </p>
          </>
        )}
      </div>
    );
  }

  // 结果数组最新在前（useJobPolling 在完成时前插），
  // 首条作为"本次生成"聚焦，其余进瀑布流。
  const featured = results[0];
  const older = results.slice(1);

  return (
    <div className="results-workspace" ref={wrapRef}>
      <FeaturedResult
        entry={featured}
        items={items}
        indexOf={indexOf}
        onLightbox={onLightbox}
        onApplyConfig={onApplyConfig}
        onDownload={onDownload}
        onRemove={onRemove}
        onSaveImage={onSaveImage}
        onUseAsInit={onUseAsInit}
        getVideoUrl={getVideoUrl}
        getImageUrl={getImageUrl}
      />
      {older.length > 0 && (
        <>
          <div className="result-grid">
            <AnimatePresence initial={false}>
              {older.map((r, ri) => {
                if (r.result?.images)
                  return r.result.images.map((img, ii) => {
                    const fmt = r.result.output_format || "png";
                    const src = getImageUrl(img.b64_json, fmt);
                    const seedInfo = seedLabel(r.config, img.index ?? ii);
                    const dimInfo = dimensionLabel(r.config);
                    const timeInfo = elapsedLabel(r.created, r.completedAt);
                    const key = imageKey(img.index, ii);
                    const saveState = r.saves?.[key];
                    const savedInfo = partSaveLabel(saveState);
                    const lbIndex =
                      indexOf.get(`${r.jobId}:${img.index ?? ii}`) ?? 0;
                    return (
                      <motion.div
                        key={`${r.jobId}-${img.index ?? ii}`}
                        {...cardMotion}
                        transition={{
                          duration: 1.05,
                          ease: [0.16, 1, 0.3, 1],
                          delay: Math.min(ii * 0.08, 0.32),
                        }}
                        className="result-card"
                      >
                        <button
                          type="button"
                          className="result-preview-button"
                          aria-label={`查看生成结果${seedInfo ? `，${seedInfo}` : ""}`}
                          onClick={() => onLightbox(items, lbIndex)}
                        >
                          <img src={src} alt="" />
                        </button>
                        <div className="result-meta">
                          {seedInfo && <span className="meta-seed">{seedInfo}</span>}
                          {dimInfo && <span className="meta-dim">{dimInfo}</span>}
                          {timeInfo && <span className="meta-time">{timeInfo}</span>}
                          {savedInfo && (
                            <span
                              className={`meta-save ${savedInfo.className}`}
                              title={savedInfo.title}
                              role={savedInfo.className === "failed" ? "alert" : "status"}
                            >
                              {savedInfo.text}
                            </span>
                          )}
                          {saveState?.status === "failed" && (
                            <button
                              type="button"
                              className="result-save-retry"
                              onClick={() => onSaveImage(r.jobId, key)}
                            >
                              重试保存
                            </button>
                          )}
                        </div>
                        <div className="result-card-actions">
                          <SaveToDirButton
                            state={saveState}
                            ariaLabel="保存到输出目录"
                            onSave={() => onSaveImage(r.jobId, key)}
                          />
                          <button
                            className="btn btn-sm"
                            title="用作初始图片（发送到 img2img）"
                            aria-label="用作初始图片"
                            onClick={() => onUseAsInit(img.b64_json, fmt)}
                          >
                            {IC.image}
                          </button>
                          <button
                            className="btn btn-sm"
                            title={
                              r.config && r.config.params.seed >= 0
                                ? `应用此配置（种子 ${
                                    r.config.params.seed + (img.index ?? ii)
                                  }）`
                                : "应用此配置"
                            }
                            aria-label="应用此图片的生成配置"
                            onClick={() => onApplyConfig(r.config, img.index ?? ii)}
                          >
                            {IC.refresh}
                          </button>
                          <button
                            className="btn btn-sm"
                            aria-label="下载图片"
                            onClick={() =>
                              onDownload(
                                img.b64_json,
                                fmt,
                                undefined,
                                r.config?.params?.seed != null &&
                                  r.config.params.seed >= 0
                                  ? r.config.params.seed + (img.index ?? ii)
                                  : undefined
                              )
                            }
                          >
                            {IC.dl}
                          </button>
                          <TwoTapButton
                            className="btn btn-sm btn-danger"
                            label="删除此图片"
                            armedLabel="确认删除（尚未保存）"
                            armedTitle="尚未保存，再次点击确认删除"
                            needsConfirm={saveState?.status !== "saved"}
                            onConfirm={() => onRemove(r.jobId, img.index ?? ii)}
                            idle={IC.x}
                            armed={"确认?"}
                          />
                        </div>
                      </motion.div>
                    );
                  });
                if (r.result?.b64_json) {
                  const b64 = r.result.b64_json;
                  const mime = r.result.mime_type || "video/webm";
                  const url = getVideoUrl(r.jobId, b64, mime);
                  const saveState = r.saves?.["v"];
                  const savedInfo = partSaveLabel(saveState);
                  const lbIndex = indexOf.get(`${r.jobId}:v`) ?? 0;
                  return (
                    <motion.div
                      key={r.jobId || ri}
                      {...cardMotion}
                      transition={{ duration: 1.05, ease: [0.16, 1, 0.3, 1] }}
                      className="result-card"
                    >
                      <VideoTile url={url} />
                      <div className="result-meta">
                        <span>{r.result.fps} FPS</span>
                        <span>{r.result.frame_count} 帧</span>
                        <span>
                          {(r.result.output_format || "webm").toUpperCase()}
                        </span>
                        {savedInfo && (
                          <span
                            className={`meta-save ${savedInfo.className}`}
                            title={savedInfo.title}
                            role={savedInfo.className === "failed" ? "alert" : "status"}
                          >
                            {savedInfo.text}
                          </span>
                        )}
                        {saveState?.status === "failed" && (
                          <button
                            type="button"
                            className="result-save-retry"
                            onClick={() => onSaveImage(r.jobId, "v")}
                          >
                            重试保存
                          </button>
                        )}
                      </div>
                      <div className="result-card-actions">
                        <SaveToDirButton
                          state={saveState}
                          ariaLabel="保存视频到输出目录"
                          onSave={() => onSaveImage(r.jobId, "v")}
                        />
                        <button
                          className="btn btn-sm"
                          title="全屏预览"
                          aria-label="全屏预览视频"
                          onClick={() => onLightbox(items, lbIndex)}
                        >
                          {IC.zoom}
                        </button>
                        <button
                          className="btn btn-sm"
                          title="应用此配置"
                          aria-label="应用此视频的生成配置"
                          onClick={() => onApplyConfig(r.config)}
                        >
                          {IC.refresh}
                        </button>
                        <button
                          className="btn btn-sm"
                          aria-label="下载视频"
                          onClick={() =>
                            onDownload(b64, r.result!.output_format, mime)
                          }
                        >
                          {IC.dl} 下载
                        </button>
                        <TwoTapButton
                          className="btn btn-sm btn-danger"
                          label="删除此视频"
                          armedLabel="确认删除（尚未保存）"
                          armedTitle="尚未保存，再次点击确认删除"
                          needsConfirm={saveState?.status !== "saved"}
                          onConfirm={() => onRemove(r.jobId)}
                          idle={IC.x}
                          armed={"确认?"}
                        />
                      </div>
                    </motion.div>
                  );
                }
                return null;
              })}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
});
