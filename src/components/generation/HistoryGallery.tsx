import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence } from "motion/react";
import { api } from "../../api";
import { useStore } from "../../store";
import { useTheme } from "../../lib/theme";
import { Panel } from "../ui/Panel";
import { Select } from "../ui/Select";
import { TwoTapButton } from "../ui/TwoTapButton";
import { Lightbox, type LightboxItem } from "../ui/Lightbox";
import { ByteBudgedCache } from "../../lib/byteCache";
import { b64ByteLength, b64ToBlobUrl, formatError } from "../../lib/utils";
import { cn } from "../ui/cn";
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

/** 历史画廊支持的视频扩展名（结果区淘汰后仍可回看已保存视频）。
 * sd-server 视频输出为 webm/mp4，其余常见容器一并收录（只列入、不预判解码）。 */
const VIDEO_EXTS = new Set(["webm", "mp4", "mkv", "mov", "avi", "m4v"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

function isVideoFile(f: OutputEntry): boolean {
  return VIDEO_EXTS.has(f.ext);
}

function videoMime(ext: string): string {
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "m4v":
      return "video/x-m4v";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    default:
      return "video/webm";
  }
}

/** ByteBudgedCache → 普通 Map 快照（渲染层只读；按 thumbVersion 重建）。 */
function cacheSnapshot(cache: ByteBudgedCache<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const key of cache.keys()) {
    const value = cache.get(key);
    if (value != null) m.set(key, value);
  }
  return m;
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
  src,
  videoUrl,
  retryToken,
  onOpen,
  onNeedSrc,
}: {
  file: OutputEntry;
  style?: CSSProperties;
  src: string;
  videoUrl: string;
  retryToken: number;
  onOpen: (file: OutputEntry) => void;
  onNeedSrc: () => void;
}) {
  const date = new Date(file.modified * 1000).toLocaleString();
  const isVideo = isVideoFile(file);

  // 缩略图经后端 read_thumbnail（输出目录白名单 + 降采样）按需加载；
  // 视频无法解码缩略图，瓦片直接内嵌 <video>（preload=metadata 只拉头）。
  // retryToken 仅在用户点"刷新"时变化，让首次读取失败的瓦片有机会重试；
  // 平时只随 src 变化触发一次，失败不会被父级重渲染反复重试。
  useEffect(() => {
    if (!src && !videoUrl) onNeedSrc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, videoUrl, retryToken]);

  return (
    <button
      type="button"
      className={cn("history-item", isVideo && "history-video-item")}
      style={style}
      title={`${file.name}\n${date}`}
      aria-label={`查看历史${isVideo ? "视频" : "图片"} ${file.name}${
        file.metadata ? "（含生成参数）" : ""
      }`}
      onClick={() => onOpen(file)}
    >
      {isVideo ? (
        videoUrl ? (
          <video
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            aria-hidden="true"
          />
        ) : null
      ) : (
        src && <img src={src} alt="" loading="lazy" />
      )}
      {isVideo && (
        <span className="history-play" aria-hidden="true" title="点击回放">
          ▶
        </span>
      )}
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
  // 空态文案随主题语境:暗房"历史图片" ↔ 太空"回传图像"(遥测档案)
  const vostok = useTheme() === "vostok";
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

  // 加载竞态防护：快速切换输出目录时，较慢的旧目录请求可能
  // 在新目录请求之后返回并覆盖列表。每次 load 递增请求序号，响应只在
  // 序号仍是当前值时落地（与 Dashboard 扫描逻辑同构）。
  const loadRequestId = useRef(0);

  const load = useCallback(async () => {
    if (!settings.outputDir) {
      setFiles([]);
      return;
    }
    const requestId = ++loadRequestId.current;
    setLoading(true);
    // 给此前读取失败的缩略图/视频一次重试机会（HistoryTile 的 retryToken 依赖）。
    failedThumbs.current.clear();
    failedVideos.current.clear();
    setRetryToken((t) => t + 1);
    try {
      const f = await api.listOutputFiles(settings.outputDir);
      if (requestId !== loadRequestId.current) return;
      setFiles(f);
    } catch (e) {
      if (requestId !== loadRequestId.current) return;
      toast("加载历史失败: " + formatError(e), true);
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, [settings.outputDir, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // 缩略图 dataURL 懒缓存：只为实际渲染过的文件调用后端 read_thumbnail
  // （输出目录白名单 + 降采样到 384px），小图常驻成本低；仍设字节预算
  // 兜底极端目录（按条数上限会被“几万张 10KB 小图”绕过）。
  // 失败的路径进 failedThumbs，避免重渲染风暴式重试，
  // 用户点"刷新"时清空重试（retryToken）。
  const THUMB_CACHE_BYTES = 128 * 1024 * 1024;
  /** 并发读取上限：快速滚动时避免几十个解码/IPC 同时打满后端 */
  const THUMB_CONCURRENCY = 4;
  const thumbSrcsRef = useRef(new ByteBudgedCache<string>(THUMB_CACHE_BYTES));
  const failedThumbs = useRef(new Set<string>());
  const pendingThumbs = useRef(new Set<string>());
  const thumbQueue = useRef<OutputEntry[]>([]);
  const activeThumbReads = useRef(0);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [retryToken, setRetryToken] = useState(0);
  const thumbSrcs = useMemo(
    () => cacheSnapshot(thumbSrcsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thumbVersion]
  );

  const pumpThumbQueue = useCallback(() => {
    while (
      activeThumbReads.current < THUMB_CONCURRENCY &&
      thumbQueue.current.length > 0
    ) {
      const f = thumbQueue.current.shift()!;
      if (thumbSrcsRef.current.has(f.path)) {
        pendingThumbs.current.delete(f.path);
        continue;
      }
      activeThumbReads.current += 1;
      api
        .readThumbnail(f.path)
        .then(({ b64, mime }) => {
          const cache = thumbSrcsRef.current;
          if (!cache.has(f.path)) {
            // 字节预算淘汰在 cache 内部完成（超预算即挤出最旧）。
            cache.set(f.path, `data:${mime};base64,${b64}`, b64ByteLength(b64));
            setThumbVersion((v) => v + 1);
          }
        })
        .catch(() => {
          // 失败记录在案：瓦片保持占位，"刷新"或点开瓦片时再重试，
          // 恢复参数/用作初始图路径会给出可见错误。
          failedThumbs.current.add(f.path);
        })
        .finally(() => {
          activeThumbReads.current -= 1;
          pendingThumbs.current.delete(f.path);
          pumpThumbQueue();
        });
    }
  }, []);

  const ensureThumb = useCallback(
    (f: OutputEntry, force = false) => {
      if (thumbSrcsRef.current.has(f.path)) return;
      if (pendingThumbs.current.has(f.path)) return;
      if (failedThumbs.current.has(f.path) && !force) return;
      failedThumbs.current.delete(f.path);
      pendingThumbs.current.add(f.path);
      thumbQueue.current.push(f);
      pumpThumbQueue();
    },
    [pumpThumbQueue]
  );

  // Lightbox 用原图（缩略图放大会糊）：按需读取 + 字节预算 + 并发闸——
  // 快速翻页会串起多张全量读取（单张上限 256MB），无闸时瞬时内存尖峰
  // 可达数 GB；老实现按条数上限 6 条则 6 张 256MB 原图同时驻留 1.5GB——
  // 统一改成 512MB 字节预算。
  const FULL_CACHE_BYTES = 512 * 1024 * 1024;
  /** 原图并发读取上限:与缩略图 THUMB_CONCURRENCY 同构 */
  const FULL_CONCURRENCY = 2;
  const fullSrcsRef = useRef(new ByteBudgedCache<string>(FULL_CACHE_BYTES));
  const pendingFull = useRef(new Set<string>());
  const fullQueue = useRef<OutputEntry[]>([]);
  const activeFullReads = useRef(0);
  const pumpFullQueue = useCallback(() => {
    while (
      activeFullReads.current < FULL_CONCURRENCY &&
      fullQueue.current.length > 0
    ) {
      const f = fullQueue.current.shift()!;
      if (fullSrcsRef.current.has(f.path)) {
        pendingFull.current.delete(f.path);
        continue;
      }
      activeFullReads.current += 1;
      api
        .readFileB64(f.path)
        .then((b64) => {
          const ext = f.ext === "jpg" || f.ext === "jpeg" ? "jpeg" : f.ext || "png";
          const cache = fullSrcsRef.current;
          if (!cache.has(f.path)) {
            // FIFO + 字节预算淘汰在 cache 内部完成（dataURL 无需 revoke）。
            cache.set(f.path, `data:image/${ext};base64,${b64}`, b64ByteLength(b64));
            setThumbVersion((v) => v + 1);
          }
        })
        .catch(() => {
          // 原图失败回退缩略图显示，无需报错（动作按钮各自有错误提示）。
        })
        .finally(() => {
          activeFullReads.current -= 1;
          pendingFull.current.delete(f.path);
          pumpFullQueue();
        });
    }
  }, []);
  const ensureFull = useCallback(
    (f: OutputEntry) => {
      if (fullSrcsRef.current.has(f.path) || pendingFull.current.has(f.path))
        return;
      pendingFull.current.add(f.path);
      fullQueue.current.push(f);
      pumpFullQueue();
    },
    [pumpFullQueue]
  );

  // 历史视频：整读 b64 → blob URL 供 <video> 流式播放。后端
  // read_file_b64 已有 256MB 单文件上限；缓存给 512MB 字节预算——大视频
  // 一条动辄上百 MB，条数上限会让画廊翻几页就超 GB。淘汰时
  // revoke 被挤出的 blob URL 释放解码缓冲。
  const VIDEO_CACHE_BYTES = 512 * 1024 * 1024;
  const VIDEO_CONCURRENCY = 1;
  const videoSrcsRef = useRef(new ByteBudgedCache<string>(VIDEO_CACHE_BYTES));
  const failedVideos = useRef(new Set<string>());
  const pendingVideos = useRef(new Set<string>());
  const videoQueue = useRef<OutputEntry[]>([]);
  const activeVideoReads = useRef(0);
  const pumpVideoQueue = useCallback(() => {
    while (
      activeVideoReads.current < VIDEO_CONCURRENCY &&
      videoQueue.current.length > 0
    ) {
      const f = videoQueue.current.shift()!;
      if (videoSrcsRef.current.has(f.path)) {
        pendingVideos.current.delete(f.path);
        continue;
      }
      activeVideoReads.current += 1;
      api
        .readFileB64(f.path)
        .then((b64) => {
          if (videoSrcsRef.current.has(f.path)) return;
          const url = b64ToBlobUrl(b64, videoMime(f.ext));
          const evicted = videoSrcsRef.current.set(
            f.path,
            url,
            b64ByteLength(b64)
          );
          for (const [, oldUrl] of evicted) URL.revokeObjectURL(oldUrl);
          setThumbVersion((v) => v + 1);
        })
        .catch(() => {
          // 失败记录在案：瓦片保持占位，点击/刷新再重试（读超大文件
          // 256MB 上限被拒时给用户可见的占位而非报错弹窗）。
          failedVideos.current.add(f.path);
        })
        .finally(() => {
          activeVideoReads.current -= 1;
          pendingVideos.current.delete(f.path);
          pumpVideoQueue();
        });
    }
  }, []);
  const ensureVideo = useCallback(
    (f: OutputEntry, force = false) => {
      if (videoSrcsRef.current.has(f.path)) return;
      if (pendingVideos.current.has(f.path)) return;
      if (failedVideos.current.has(f.path) && !force) return;
      failedVideos.current.delete(f.path);
      pendingVideos.current.add(f.path);
      videoQueue.current.push(f);
      pumpVideoQueue();
    },
    [pumpVideoQueue]
  );

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

  const mediaFiles = useMemo(
    () =>
      files.filter((f) => IMAGE_EXTS.has(f.ext) || VIDEO_EXTS.has(f.ext)),
    [files]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFiles = normalizedQuery
    ? mediaFiles.filter((file) => {
        const searchable =
          searchIndex.get(file.path) || file.name.toLocaleLowerCase();
        return searchable.includes(normalizedQuery);
      })
    : mediaFiles;
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
  }, [mediaFiles.length === 0, virtualize]);

  // 统一 Lightbox 的导航列表与动作条。当前项优先用原图（字节预算缓存），
  // 未就绪时回退缩略图；视频条目读整文件 blob URL。加载完成经
  // thumbVersion 触发刷新。
  const lightboxItems = useMemo<LightboxItem[]>(
    () =>
      sortedFiles.map((f) => ({
        type: isVideoFile(f) ? "video" : "image",
        src: isVideoFile(f)
          ? videoSrcsRef.current.get(f.path) || ""
          : fullSrcsRef.current.get(f.path) || thumbSrcs.get(f.path) || "",
        title: f.name,
      })),
    [sortedFiles, thumbSrcs]
  );

  // Lightbox 当前项拉原图/视频，相邻项预取缩略图/视频：虚拟滚动下导航
  // 可能落到尚未渲染过的文件,这里直接走同一缓存通道。
  useEffect(() => {
    if (lightboxIndex == null) return;
    const current = sortedFiles[lightboxIndex];
    if (current) {
      if (isVideoFile(current)) {
        ensureVideo(current, true);
      } else {
        ensureThumb(current, true);
        ensureFull(current);
      }
    }
    for (const idx of [lightboxIndex - 1, lightboxIndex + 1]) {
      const entry = sortedFiles[idx];
      if (!entry) continue;
      if (isVideoFile(entry)) ensureVideo(entry);
      else ensureThumb(entry);
    }
  }, [lightboxIndex, sortedFiles, ensureThumb, ensureFull, ensureVideo]);

  const openTile = useCallback(
    (file: OutputEntry) => {
      // force：读取失败过的瓦片点开时再试一次。
      if (isVideoFile(file)) ensureVideo(file, true);
      else ensureThumb(file, true);
      const idx = sortedFiles.findIndex((f) => f.path === file.path);
      if (idx >= 0) setLightboxIndex(idx);
    },
    [sortedFiles, ensureThumb, ensureVideo]
  );

  const onRestore = useCallback(
    async (entry: OutputEntry) => {
      if (!entry.metadata) {
        toast("该文件不含生成参数", true);
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
        thumbSrcsRef.current.delete(entry.path);
        fullSrcsRef.current.delete(entry.path);
        failedThumbs.current.delete(entry.path);
        // 视频缓存：blob URL 必须 revoke，否则删除后解码缓冲仍驻留。
        const videoUrl = videoSrcsRef.current.get(entry.path);
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        videoSrcsRef.current.delete(entry.path);
        failedVideos.current.delete(entry.path);
        setThumbVersion((v) => v + 1);
        setLightboxIndex(null);
        toast(`已删除：${entry.name}`);
      } catch (e) {
        toast("删除失败: " + formatError(e), true);
      }
    },
    [toast]
  );

  return (
    <Panel title={vostok ? "回传档案" : "历史画廊"} badge={mediaFiles.length || null}>
      {!settings.outputDir ? (
        <p className="text-muted text-xs py-1">请在控制台设置输出目录</p>
      ) : loading ? (
        <span className="spinner block mx-auto my-2" />
      ) : mediaFiles.length === 0 ? (
        <p className="text-muted text-xs py-1">
          {vostok ? "暂无回传记录" : "暂无历史记录"}
        </p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            {/* 横向工具行里 form-row 的 margin-bottom 无意义(gap 管间距),且
                :last-child 清零规则会让两侧 margin 不一致,items-end 按 margin
                box 对齐后下拉反比输入框低 9px——统一清掉才能精确底对齐 */}
            <div className="form-row flex-1 mb-0">
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
            {/* 宽度由选中项文字撑开:根字体 13px 下 w-24 仅 78px,
                "最新优先" 48px 会被截断成"最新...";
                py 对齐 input 的 7px,与搜索框等高(默认 6px 会矮 2.75px) */}
            <div className="form-row shrink-0">
              <Select
                id="history-sort"
                className="py-[7px]"
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
            <div className="empty-state">
              {vostok ? "没有匹配的回传记录" : "没有匹配的历史记录"}
            </div>
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
                    src={thumbSrcs.get(file.path) || ""}
                    videoUrl={videoSrcsRef.current.get(file.path) || ""}
                    retryToken={retryToken}
                    onOpen={openTile}
                    onNeedSrc={() =>
                      isVideoFile(file) ? ensureVideo(file) : ensureThumb(file)
                    }
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
                  src={thumbSrcs.get(f.path) || ""}
                  videoUrl={videoSrcsRef.current.get(f.path) || ""}
                  retryToken={retryToken}
                  onOpen={openTile}
                  onNeedSrc={() =>
                    isVideoFile(f) ? ensureVideo(f) : ensureThumb(f)
                  }
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
                  {onUseAsInit && !isVideoFile(entry) && (
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
                    label="删除此文件"
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
