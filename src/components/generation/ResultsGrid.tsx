import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ResultEntry } from "../../store";
import type { JobConfig } from "../../types";
import { IC } from "../ui/Icons";
import { TwoTapButton } from "../ui/TwoTapButton";

interface Props {
  results: ResultEntry[];
  onLightbox: (src: string, type: "image" | "video") => void;
  onApplyConfig: (config?: JobConfig, seedOffset?: number) => void;
  onDownload: (b64: string, fmt?: string, mime?: string, seed?: number) => void;
  onRemove: (jobId: string, imageIndex?: number) => void;
  onRetrySave?: (jobId: string) => void;
  onUseAsInit: (b64: string) => void;
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

// 显影(The Develop):结果落画布时从模糊灰度显影为清晰全彩,
// 一张一次,像拍立得在暗房灯下成形。这是本设计的签名时刻。
const cardMotion = {
  layout: true,
  initial: { opacity: 0, scale: 1.05, filter: "blur(20px) saturate(0.55)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px) saturate(1)" },
  exit: {
    opacity: 0,
    scale: 0.96,
    filter: "blur(8px)",
    transition: { duration: 0.16 },
  },
} as const;

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
  if (results.length === 0) {
    return (
      <div className="empty-state">
        <p className="mb-1 text-[13px] text-fg2">
          准备就绪
        </p>
        <p>
          输入提示词后点击 生成，或按 <span className="kbd">Ctrl</span>+
          <span className="kbd">Enter</span>
        </p>
      </div>
    );
  }

  return (
    <div className="result-grid">
      <AnimatePresence initial={false}>
        {results.map((r, ri) => {
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
                      onClick={() => onUseAsInit(src)}
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
                          r.config?.params?.seed != null && r.config.params.seed >= 0
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
                  <span>{(r.result.output_format || "webm").toUpperCase()}</span>
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
                    onClick={() => onDownload(b64, r.result!.output_format, mime)}
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
  );
});
