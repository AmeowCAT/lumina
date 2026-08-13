import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AnimatePresence } from "motion/react";
import { api } from "../../api";
import { useStore } from "../../store";
import { Panel } from "../ui/Panel";
import { Select } from "../ui/Select";
import { TwoTapButton } from "../ui/TwoTapButton";
import { Lightbox, type LightboxItem } from "../ui/Lightbox";
import { formatError } from "../../lib/utils";
import {
  computeGridLayout,
  computeVisibleRange,
  tilePosition,
} from "../../lib/virtualGrid";

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
  onUseAsInit?: (imageB64: string) => void;
}

/** 超过该数量启用虚拟滚动(小列表直接全量渲染,保持简单路径) */
const VIRTUALIZE_AT = 200;

/** 向上找最近的可滚动祖先(.output-main 等);grid 挂载前返回 null */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

function HistoryTile({
  file,
  style,
  getSrc,
  onOpen,
}: {
  file: OutputEntry;
  style?: CSSProperties;
  getSrc: (f: OutputEntry) => string;
  onOpen: (file: OutputEntry) => void;
}) {
  const date = new Date(file.modified * 1000).toLocaleString();
  return (
    <button
      type="button"
      className="history-item"
      style={style}
      title={`${file.name}\n${date}`}
      aria-label={`查看历史图片 ${file.name}${
        file.metadata ? "（含生成参数）" : ""
      }`}
      onClick={() => onOpen(file)}
    >
      <img src={getSrc(file)} alt="" loading="lazy" />
      {file.metadata && (
        <span className="history-badge" aria-hidden="true" title="含参数">
          参
        </span>
      )}
    </button>
  );
}

export const HistoryGallery = memo(function HistoryGallery({
  onRestoreParams,
  onUseAsInit,
}: Props) {
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const [files, setFiles] = useState<OutputEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "name">("newest");
  /** 当前在统一 Lightbox 中预览的条目索引(按 sortedFiles 顺序) */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // 虚拟滚动:网格宽度(列数由宽度决定) + 滚动容器视口
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  const scrollRef = useRef({ top: 0, height: 0 });
  const rafRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!settings.outputDir) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const f = await api.listOutputFiles(settings.outputDir);
      setFiles(f);
    } catch (e) {
      toast("加载历史失败: " + formatError(e), true);
    } finally {
      setLoading(false);
    }
  }, [settings.outputDir, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // src URL 懒缓存:只为实际渲染过的文件生成 asset:// URL,
  // 上千文件时避免一次性构造全部 URL(虚拟滚动配套)。
  const srcCache = useRef(new Map<string, string>());
  const getSrc = useCallback((f: OutputEntry) => {
    let url = srcCache.current.get(f.path);
    if (!url) {
      url = convertFileSrc(f.path);
      srcCache.current.set(f.path, url);
    }
    return url;
  }, []);

  // 搜索文本一次性预计算：旧实现每次键击对每个文件 JSON.stringify(metadata)
  // 过滤，上千文件时明显卡顿（对抗性审查）。这里只随 files 变化重建。
  const searchIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
      m.set(
        f.path,
        [
          f.name,
          new Date(f.modified * 1000).toLocaleString(),
          f.metadata ? JSON.stringify(f.metadata) : "",
        ]
          .join(" ")
          .toLocaleLowerCase()
      );
    }
    return m;
  }, [files]);

  const imgFiles = useMemo(
    () => files.filter((f) => ["png", "jpg", "jpeg", "webp"].includes(f.ext)),
    [files]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFiles = normalizedQuery
    ? imgFiles.filter((file) => {
        const searchable =
          searchIndex.get(file.path) || file.name.toLocaleLowerCase();
        return searchable.includes(normalizedQuery);
      })
    : imgFiles;
  const sortedFiles = useMemo(() => {
    const arr = [...filteredFiles];
    if (sort === "newest") arr.sort((a, b) => b.modified - a.modified);
    else if (sort === "oldest") arr.sort((a, b) => a.modified - b.modified);
    else arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [filteredFiles, sort]);

  // 虚拟布局
  const layout = useMemo(
    () => computeGridLayout(gridWidth, sortedFiles.length),
    [gridWidth, sortedFiles.length]
  );
  const virtualize =
    sortedFiles.length > VIRTUALIZE_AT && gridWidth > 0 && layout.cols > 0;
  const range = computeVisibleRange(layout, scroll.top, scroll.height);
  const startIdx = virtualize ? range.start * layout.cols : 0;
  const endIdx = virtualize
    ? Math.min(sortedFiles.length, (range.end + 1) * layout.cols)
    : sortedFiles.length;

  // 网格挂载后:量宽(ResizeObserver) + 挂滚动监听(rAF 节流)
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const ro = new ResizeObserver(() => setGridWidth(grid.clientWidth));
    ro.observe(grid);
    const scroller = findScrollParent(grid);
    const read = () => {
      if (!scroller) return;
      scrollRef.current = {
        top: scroller.scrollTop,
        height: scroller.clientHeight,
      };
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setScroll(scrollRef.current);
        });
      }
    };
    read();
    scroller?.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      ro.disconnect();
      scroller?.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [imgFiles.length === 0, virtualize]);

  // 统一 Lightbox 的导航列表与动作条
  const lightboxItems = useMemo<LightboxItem[]>(
    () =>
      sortedFiles.map((f) => ({
        type: "image",
        src: getSrc(f),
        title: f.name,
      })),
    [sortedFiles, getSrc]
  );

  const openTile = useCallback(
    (file: OutputEntry) => {
      const idx = sortedFiles.findIndex((f) => f.path === file.path);
      if (idx >= 0) setLightboxIndex(idx);
    },
    [sortedFiles]
  );

  const onRestore = useCallback(
    async (entry: OutputEntry) => {
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
    },
    [onRestoreParams, toast]
  );

  const useAsInitialImage = useCallback(
    async (entry: OutputEntry) => {
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
    },
    [onUseAsInit, toast]
  );

  // 删除磁盘文件(不可逆,由两段式按钮确认)。成功后从列表移除、
  // 清掉 src 缓存并关闭预览。
  const deleteFile = useCallback(
    async (entry: OutputEntry) => {
      try {
        await api.deleteOutputFile(entry.path);
        setFiles((fs) => fs.filter((f) => f.path !== entry.path));
        srcCache.current.delete(entry.path);
        setLightboxIndex(null);
        toast(`已删除：${entry.name}`);
      } catch (e) {
        toast("删除失败: " + formatError(e), true);
      }
    },
    [toast]
  );

  return (
    <Panel title="历史画廊" badge={imgFiles.length || null}>
      {!settings.outputDir ? (
        <p className="text-muted text-xs py-1">请在控制台设置输出目录</p>
      ) : loading ? (
        <span className="spinner block mx-auto my-2" />
      ) : imgFiles.length === 0 ? (
        <p className="text-muted text-xs py-1">暂无历史图片</p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <div className="form-row flex-1">
              <label className="form-label" htmlFor="history-search">
                搜索历史
              </label>
              <input
                id="history-search"
                className="input"
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="文件名、日期、模型或提示词"
              />
            </div>
            <div className="form-row w-24">
              <Select
                id="history-sort"
                value={sort}
                onChange={(v) => setSort(v as "newest" | "oldest" | "name")}
                ariaLabel="排序方式"
                options={[
                  { value: "newest", label: "最新优先" },
                  { value: "oldest", label: "最旧优先" },
                  { value: "name", label: "按文件名" },
                ]}
              />
            </div>
          </div>
          {sortedFiles.length === 0 ? (
            <div className="empty-state">没有匹配的历史图片</div>
          ) : virtualize ? (
            <div
              className="history-grid history-grid-virtual"
              ref={gridRef}
              style={{ height: layout.totalHeight }}
            >
              {Array.from({ length: endIdx - startIdx }, (_, k) => {
                const idx = startIdx + k;
                const file = sortedFiles[idx];
                const pos = tilePosition(layout, idx);
                return (
                  <HistoryTile
                    key={file.path}
                    file={file}
                    getSrc={getSrc}
                    onOpen={openTile}
                    style={{
                      position: "absolute",
                      left: pos.left,
                      top: pos.top,
                      width: layout.tile,
                      height: layout.tile,
                    }}
                  />
                );
              })}
            </div>
          ) : (
            <div className="history-grid" ref={gridRef}>
              {sortedFiles.map((f) => (
                <HistoryTile
                  key={f.path}
                  file={f}
                  getSrc={getSrc}
                  onOpen={openTile}
                />
              ))}
            </div>
          )}
          <button className="btn btn-sm mt-2" onClick={load}>
            刷新
          </button>
        </>
      )}

      {/* 预览与结果区共用同一个 Lightbox(滚动/捏合/键盘缩放统一);
          动作条经 renderFooter 按当前索引渲染 */}
      <AnimatePresence>
        {lightboxIndex != null && (
          <Lightbox
            items={lightboxItems}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onNavigate={setLightboxIndex}
            renderFooter={(index) => {
              const entry = sortedFiles[index];
              if (!entry) return null;
              return (
                <>
                  {onUseAsInit && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        if (await useAsInitialImage(entry)) {
                          setLightboxIndex(null);
                        }
                      }}
                    >
                      用作初始图片
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={async () => {
                      if (await onRestore(entry)) setLightboxIndex(null);
                    }}
                    disabled={!entry.metadata}
                  >
                    {entry.metadata ? "恢复此配置" : "无参数可恢复"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setLightboxIndex(null)}
                  >
                    关闭
                  </button>
                  <TwoTapButton
                    className="btn btn-sm btn-danger"
                    label="删除此图片"
                    armedLabel="确认删除该文件"
                    armedTitle="文件将从磁盘永久删除，再次点击确认"
                    needsConfirm
                    onConfirm={() => void deleteFile(entry)}
                    idle="删除"
                    armed="确认?"
                  />
                </>
              );
            }}
          />
        )}
      </AnimatePresence>
    </Panel>
  );
});
