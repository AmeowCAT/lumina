import { memo, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ResultEntry } from "../../store";
import type { JobConfig } from "../../types";
import { cn } from "../ui/cn";
import { IC } from "../ui/Icons";
import { TwoTapButton } from "../ui/TwoTapButton";

interface Props {
  results: ResultEntry[];
  onLightbox: (src: string, type: "image" | "video") => void;
  onApplyConfig: (config?: JobConfig, seedOffset?: number) => void;
  onDownload: (b64: string, fmt?: string, mime?: string, seed?: number) => void;
  onRemove: (jobId: string, imageIndex?: number) => void;
  onRetrySave?: (jobId: string) => void;
  /** 传入原始 b64_json + 输出格式，由调用方转成 dataURL（blob: URL 无法被
   * sd-server 解码，且切回控制台即被 revoke——对抗性审查 B2）。 */
  onUseAsInit: (b64: string, fmt: string) => void;
  getVideoUrl: (jobId: string, b64: string, mime: string) => string;
  getImageUrl: (b64: string, fmt: string) => string;
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

function saveLabel(entry: ResultEntry): { text: string; className: string; title?: string } | null {
  switch (entry.saveStatus) {
    case "not_configured":
      return {
        text: "未自动保存",
        className: "not-configured",
        title: "未配置输出目录；关闭应用前请手动下载或另存为",
      };
    case "saving":
      return { text: "保存中", className: "saving" };
    case "saved":
      return {
        text: "已保存",
        className: "saved",
        title: entry.savePaths?.join("\n"),
      };
    case "partial":
      return {
        text: "部分保存",
        className: "partial",
        title: entry.saveError || entry.savePaths?.join("\n"),
      };
    case "failed":
      return { text: "保存失败", className: "failed", title: entry.saveError };
    default:
      return null;
  }
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

interface FeaturedProps {
  entry: ResultEntry;
  onLightbox: Props["onLightbox"];
  onApplyConfig: Props["onApplyConfig"];
  onDownload: Props["onDownload"];
  onRemove: Props["onRemove"];
  onRetrySave?: Props["onRetrySave"];
  onUseAsInit: Props["onUseAsInit"];
  getVideoUrl: Props["getVideoUrl"];
  getImageUrl: Props["getImageUrl"];
}

// 本次生成聚焦区：最新结果铺满可视区，瀑布流里只保留更早的内容。
function FeaturedResult({
  entry,
  onLightbox,
  onApplyConfig,
  onDownload,
  onRemove,
  onRetrySave,
  onUseAsInit,
  getVideoUrl,
  getImageUrl,
}: FeaturedProps) {
  const dimInfo = dimensionLabel(entry.config);
  const timeInfo = elapsedLabel(entry.created, entry.completedAt);
  const savedInfo = saveLabel(entry);

  const meta = (
    <div className="featured-meta">
      {dimInfo && <span className="meta-dim">{dimInfo}</span>}
      {timeInfo && <span className="meta-time">{timeInfo}</span>}
      {savedInfo && (
        <span
          className={`meta-save ${savedInfo.className}`}
          title={savedInfo.title}
          role={entry.saveStatus === "failed" ? "alert" : "status"}
        >
          {savedInfo.text}
        </span>
      )}
      {(entry.saveStatus === "failed" || entry.saveStatus === "partial") &&
        onRetrySave && (
          <button
            type="button"
            className="result-save-retry"
            onClick={() => onRetrySave(entry.jobId)}
          >
            重试保存
          </button>
        )}
    </div>
  );

  const images = entry.result?.images || [];
  if (images.length > 0) {
    const fmt = entry.result?.output_format || "png";
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
            return (
              <figure
                key={`${entry.jobId}-${img.index ?? ii}`}
                className="featured-item"
              >
                <button
                  type="button"
                  className="featured-preview-button"
                  aria-label={`查看本次生成${seedInfo ? `，${seedInfo}` : ""}`}
                  onClick={() => onLightbox(src, "image")}
                >
                  <img src={src} alt="" />
                </button>
                <div className="featured-item-actions">
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
                    needsConfirm={entry.saveStatus !== "saved"}
                    onConfirm={() => onRemove(entry.jobId, img.index ?? ii)}
                    idle={IC.x}
                    armed={"确认?"}
                  />
                </div>
                {seedInfo && <span className="featured-seed">{seedInfo}</span>}
              </figure>
            );
          })}
        </div>
        {meta}
      </motion.section>
    );
  }

  if (entry.result?.b64_json) {
    const b64 = entry.result.b64_json;
    const mime = entry.result.mime_type || "video/webm";
    const url = getVideoUrl(entry.jobId, b64, mime);
    return (
      <motion.section
        key={`featured-${entry.jobId}`}
        className="featured-result single"
        {...cardMotion}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <figure className="featured-item">
          <video src={url} controls autoPlay loop muted />
          <div className="featured-item-actions">
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
              needsConfirm={entry.saveStatus !== "saved"}
              onConfirm={() => onRemove(entry.jobId)}
              idle={IC.x}
              armed={"确认?"}
            />
          </div>
        </figure>
        {meta}
      </motion.section>
    );
  }

  return null;
}

export const ResultsGrid = memo(function ResultsGrid({
  results,
  onLightbox,
  onApplyConfig,
  onDownload,
  onRemove,
  onRetrySave,
  onUseAsInit,
  getVideoUrl,
  getImageUrl,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(results.length);

  // 新结果落地（数组变长）时回到顶部聚焦区，保证新图一出现就在眼前。
  useEffect(() => {
    if (results.length > prevLen.current) {
      wrapRef.current?.parentElement?.scrollTo?.({ top: 0, behavior: "smooth" });
    }
    prevLen.current = results.length;
  }, [results.length]);

  if (results.length === 0) {
    return (
      <div className="empty-state">
        <p className="mb-1 text-[13px] text-fg2">准备就绪</p>
        <p>
          输入提示词后点击 生成，或按 <span className="kbd">Ctrl</span>+
          <span className="kbd">Enter</span>
        </p>
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
        onLightbox={onLightbox}
        onApplyConfig={onApplyConfig}
        onDownload={onDownload}
        onRemove={onRemove}
        onRetrySave={onRetrySave}
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
                    const savedInfo = saveLabel(r);
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
                          onClick={() => onLightbox(src, "image")}
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
                              role={r.saveStatus === "failed" ? "alert" : "status"}
                            >
                              {savedInfo.text}
                            </span>
                          )}
                          {(r.saveStatus === "failed" || r.saveStatus === "partial") &&
                            onRetrySave && (
                              <button
                                type="button"
                                className="result-save-retry"
                                onClick={() => onRetrySave(r.jobId)}
                              >
                                重试保存
                              </button>
                            )}
                        </div>
                        <div className="result-card-actions">
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
                            needsConfirm={r.saveStatus !== "saved"}
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
                  const savedInfo = saveLabel(r);
                  return (
                    <motion.div
                      key={r.jobId || ri}
                      {...cardMotion}
                      transition={{ duration: 1.05, ease: [0.16, 1, 0.3, 1] }}
                      className="result-card"
                    >
                      <video src={url} controls style={{ maxWidth: 640 }} />
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
                            role={r.saveStatus === "failed" ? "alert" : "status"}
                          >
                            {savedInfo.text}
                          </span>
                        )}
                        {(r.saveStatus === "failed" || r.saveStatus === "partial") &&
                          onRetrySave && (
                            <button
                              type="button"
                              className="result-save-retry"
                              onClick={() => onRetrySave(r.jobId)}
                            >
                              重试保存
                            </button>
                          )}
                      </div>
                      <div className="result-card-actions">
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
                          needsConfirm={r.saveStatus !== "saved"}
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
