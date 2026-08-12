import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../../api";
import { useStore } from "../../store";
import { Panel } from "../ui/Panel";
import { formatError } from "../../lib/utils";

interface OutputEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
  ext: string;
  metadata?: Record<string, unknown>;
}

interface Props {
  onRestoreParams: (metadata: Record<string, unknown>, imageB64: string) => void;
  onLightbox: (src: string, type: "image") => void;
  onUseAsInit?: (imageB64: string) => void;
}

export const HistoryGallery = memo(function HistoryGallery({
  onRestoreParams,
  onLightbox,
  onUseAsInit,
}: Props) {
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const [files, setFiles] = useState<OutputEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<OutputEntry | null>(null);
  const [visibleCount, setVisibleCount] = useState(30);
  const [query, setQuery] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewTitleId = useId();

  const load = useCallback(async () => {
    if (!settings.outputDir) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const f = await api.listOutputFiles(settings.outputDir);
      setFiles(f);
      setVisibleCount(30);
    } catch (e) {
      toast("加载历史失败: " + formatError(e), true);
    } finally {
      setLoading(false);
    }
  }, [settings.outputDir, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const dateStr = (secs: number) => {
    return new Date(secs * 1000).toLocaleString();
  };

  const srcMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
      m.set(f.path, convertFileSrc(f.path));
    }
    return m;
  }, [files]);

  // 搜索文本一次性预计算：旧实现每次键击对每个文件 JSON.stringify(metadata)
  // 过滤，上千文件时明显卡顿（对抗性审查）。这里只随 files 变化重建。
  const searchIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
      m.set(
        f.path,
        [
          f.name,
          dateStr(f.modified),
          f.metadata ? JSON.stringify(f.metadata) : "",
        ]
          .join(" ")
          .toLocaleLowerCase()
      );
    }
    return m;
  }, [files]);

  const closePreview = useCallback(() => {
    setPreview(null);
    requestAnimationFrame(() => previewTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!preview) return;

    const dialog = previewRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    focusable?.[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== "Tab" || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePreview, preview]);

  const onRestore = async (entry: OutputEntry) => {
    if (!entry.metadata) {
      toast("该图片不含生成参数", true);
      return false;
    }
    try {
      const b64 = await api.readFileB64(entry.path);
      const ext = entry.ext || "png";
      const dataUrl = `data:image/${ext};base64,${b64}`;
      onRestoreParams(entry.metadata, dataUrl);
      return true;
    } catch (e) {
      toast("读取文件失败: " + formatError(e), true);
      return false;
    }
  };

  const useAsInitialImage = async (entry: OutputEntry) => {
    if (!onUseAsInit) return false;
    try {
      const b64 = await api.readFileB64(entry.path);
      const ext = entry.ext || "png";
      onUseAsInit(`data:image/${ext};base64,${b64}`);
      return true;
    } catch (e) {
      toast("读取文件失败: " + formatError(e), true);
      return false;
    }
  };

  const imgFiles = files.filter((f) =>
    ["png", "jpg", "jpeg", "webp"].includes(f.ext)
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFiles = normalizedQuery
    ? imgFiles.filter((file) => {
        const searchable =
          searchIndex.get(file.path) || file.name.toLocaleLowerCase();
        return searchable.includes(normalizedQuery);
      })
    : imgFiles;

  return (
    <Panel title="历史画廊" badge={imgFiles.length || null}>
      {!settings.outputDir ? (
        <p className="muted" style={{ fontSize: 12, padding: "4px 0" }}>
          请在控制台设置输出目录
        </p>
      ) : loading ? (
        <span className="spinner" style={{ width: 16, height: 16, margin: "8px auto", display: "block" }} />
      ) : imgFiles.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, padding: "4px 0" }}>
          暂无历史图片
        </p>
      ) : (
        <>
          <div className="form-row">
            <label className="form-label" htmlFor="history-search">
              搜索历史
            </label>
            <input
              id="history-search"
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(30);
              }}
              placeholder="文件名、日期、模型或提示词"
            />
          </div>
          {filteredFiles.length === 0 ? (
            <div className="empty-state">没有匹配的历史图片</div>
          ) : (
          <div className="history-grid">
          {filteredFiles.slice(0, visibleCount).map((f) => {
            const src = srcMap.get(f.path) || convertFileSrc(f.path);
            return (
              <button
                type="button"
                key={f.path}
                className="history-item"
                title={`${f.name}\n${dateStr(f.modified)}`}
                aria-label={`查看历史图片 ${f.name}${
                  f.metadata ? "（含生成参数）" : ""
                }`}
                onClick={(event) => {
                  previewTriggerRef.current = event.currentTarget;
                  setPreview(f);
                }}
              >
                <img src={src} alt="" loading="lazy" />
                {f.metadata && (
                  <span className="history-badge" aria-hidden="true" title="含参数">
                    参
                  </span>
                )}
              </button>
            );
          })}
          {visibleCount < filteredFiles.length && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ gridColumn: "1 / -1" }}
              onClick={() => setVisibleCount((count) => count + 30)}
            >
              加载更多（剩余 {filteredFiles.length - visibleCount}）
            </button>
          )}
          <button
            className="btn btn-sm"
            style={{ gridColumn: "1 / -1" }}
            onClick={load}
          >
            刷新
          </button>
        </div>
          )}
        </>
      )}
      {preview && (
        <div
          ref={previewRef}
          className="history-lightbox"
          role="dialog"
          aria-modal="true"
          aria-labelledby={previewTitleId}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <h2 id={previewTitleId} className="sr-only">
            历史图片：{preview.name}
          </h2>
          <div className="history-preview-content">
            <img
              src={srcMap.get(preview.path) || convertFileSrc(preview.path)}
              alt={preview.name}
            />
            <div className="history-preview-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const src =
                    srcMap.get(preview.path) || convertFileSrc(preview.path);
                  previewTriggerRef.current?.focus();
                  setPreview(null);
                  onLightbox(src, "image");
                }}
              >
                全屏查看
              </button>
              {onUseAsInit && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    if (await useAsInitialImage(preview)) closePreview();
                  }}
                >
                  用作初始图片
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={async () => {
                  if (await onRestore(preview)) closePreview();
                }}
                disabled={!preview.metadata}
              >
                {preview.metadata ? "恢复此配置" : "无参数可恢复"}
              </button>
              <button type="button" className="btn btn-sm" onClick={closePreview}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
});
