import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { useFocusTrap } from "../../hooks/useFocusTrap";

export interface LightboxItem {
  type: "image" | "video";
  src: string;
  /** 展示在底部工具栏的说明(种子/尺寸/文件名等) */
  title?: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/**
 * 全屏预览。进出动画由父级 AnimatePresence 编排(本组件须在
 * AnimatePresence 内条件渲染);导航/缩放/焦点圈统一于此。
 * 内容 Portal 到 body:免疫调用方所在层叠上下文的 z-index 陷阱
 * (如历史画廊嵌在 .output-main 内,提示词 dock 会盖住弹层)。
 */
export function Lightbox({
  items,
  index,
  onClose,
  onNavigate,
  renderFooter,
}: {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
  /** 提供即显示前后导航;未提供时隐藏导航按钮 */
  onNavigate?: (index: number) => void;
  /** 底部动作条(如历史画廊的"恢复此配置/用作初始图片");按当前索引渲染 */
  renderFooter?: (index: number) => ReactNode;
}) {
  const item = items[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** 上次渲染展示的条目 src:切换条目时在渲染期同步重置视图 */
  const [prevSrc, setPrevSrc] = useState<string | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  // 触屏手势状态(必须在所有早期 return 之前声明)
  const touch = useRef<{
    mode: "none" | "pan" | "pinch";
    panStart: { x: number; y: number };
    start: { x: number; y: number };
    dist: number;
    zoomStart: number;
  }>({
    mode: "none",
    panStart: { x: 0, y: 0 },
    start: { x: 0, y: 0 },
    dist: 0,
    zoomStart: 1,
  });
  // 滚轮等异步路径经 ref 调用最新版 zoomAt(避免闭包过期)
  const zoomAtRef = useRef<
    ((factor: number, x?: number, y?: number) => void) | null
  >(null);
  const trapRef = useFocusTrap<HTMLDivElement>(!!item);

  // 键盘等异步路径经 ref 读最新视图状态,避免闭包过期
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (onNavigate && items.length > 1) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onNavigate(
            (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) %
              items.length
          );
          return;
        }
      }
      if (item.type !== "image") return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom(clampZoom(zoomRef.current + 0.25));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom(clampZoom(zoomRef.current - 0.25));
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [item, index, items.length, onClose, onNavigate]);

  // 滚轮缩放用原生非 passive 监听:React 17+ 把 wheel 注册为 passive,
  // preventDefault 在合成事件里不生效;原生监听保证滚轮缩放稳定可用。
  useEffect(() => {
    if (!item || item.type !== "image") return;
    const el = stageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtRef.current?.(e.deltaY > 0 ? 0.85 : 1.15, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [item]);

  if (!item) return null;

  // 切换条目时在渲染期同步重置视图(React 官方"渲染期间调整状态"模式):
  // 副作用式重置要等 paint 之后才跑,新图会先以旧倍率闪一帧——
  // 快速翻页 + 双击放大的时序下甚至残留 250%。
  if (prevSrc !== item.src) {
    setPrevSrc(item.src);
    if (zoom !== 1) setZoom(1);
    if (pan.x !== 0 || pan.y !== 0) setPan({ x: 0, y: 0 });
    if (dragging) setDragging(false);
  }

  /** 以光标为锚点缩放:光标下的图像点保持不动 */
  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const cx =
      clientX != null && rect ? clientX - rect.left - rect.width / 2 : 0;
    const cy =
      clientY != null && rect ? clientY - rect.top - rect.height / 2 : 0;
    const nz = clampZoom(zoom * factor);
    if (nz === zoom) return;
    setPan({
      x: cx - (cx - pan.x) * (nz / zoom),
      y: cy - (cy - pan.y) * (nz / zoom),
    });
    setZoom(nz);
  };
  zoomAtRef.current = zoomAt;

  const zoomBy = (delta: number) => setZoom(clampZoom(zoomRef.current + delta));

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    if (item.type !== "image") return;
    // 快速连点导航/缩放/动作条按钮会冒泡成 dblclick:忽略交互控件上的
    // 双击,只把"双击图片本身"当作缩放意图(否则翻页时新图被误放大)
    const target = event.target as HTMLElement;
    if (target.closest("button, .lightbox-toolbar, .lightbox-footer")) return;
    if (zoom > 1.02) resetView();
    else zoomAt(2.5, event.clientX, event.clientY);
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (zoom <= 1) return;
    event.preventDefault();
    setDragging(true);
    dragStart.current = { x: event.clientX, y: event.clientY };
    panStart.current = pan;
  };

  const onMouseMove = (event: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: panStart.current.x + (event.clientX - dragStart.current.x),
      y: panStart.current.y + (event.clientY - dragStart.current.y),
    });
  };

  const onMouseUp = () => setDragging(false);

  const onTouchStart = (event: React.TouchEvent) => {
    const t = touch.current;
    if (item.type !== "image") return;
    if (event.touches.length === 2) {
      const a = event.touches[0];
      const b = event.touches[1];
      t.mode = "pinch";
      t.dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      t.zoomStart = zoomRef.current;
      t.panStart = panRef.current;
      t.start = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
    } else if (event.touches.length === 1 && zoomRef.current > 1) {
      const a = event.touches[0];
      t.mode = "pan";
      t.start = { x: a.clientX, y: a.clientY };
      t.panStart = panRef.current;
    }
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const t = touch.current;
    if (t.mode === "pinch" && event.touches.length === 2) {
      const a = event.touches[0];
      const b = event.touches[1];
      if (t.dist <= 0) return;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const nz = clampZoom(t.zoomStart * (dist / t.dist));
      const mid = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
      // 锚定两指中点:中点上一次与现在的位移差放大 nz/zoomStart 倍
      const rect = stageRef.current?.getBoundingClientRect();
      const cx = rect ? mid.x - rect.left - rect.width / 2 : 0;
      const cy = rect ? mid.y - rect.top - rect.height / 2 : 0;
      setPan({
        x: cx - (cx - t.panStart.x) * (nz / t.zoomStart),
        y: cy - (cy - t.panStart.y) * (nz / t.zoomStart),
      });
      setZoom(nz);
    } else if (t.mode === "pan" && event.touches.length === 1) {
      const a = event.touches[0];
      setPan({
        x: t.panStart.x + (a.clientX - t.start.x),
        y: t.panStart.y + (a.clientY - t.start.y),
      });
    }
  };

  const onTouchEnd = () => {
    touch.current.mode = "none";
  };
  const canNav = !!onNavigate && items.length > 1;
  const go = (step: number) =>
    onNavigate!((index + step + items.length) % items.length);

  return createPortal(
    <motion.div
      ref={(node) => {
        trapRef.current = node;
        stageRef.current = node;
      }}
      className={renderFooter ? "lightbox has-footer" : "lightbox"}
      role="dialog"
      aria-modal="true"
      aria-label={
        item.title || (item.type === "image" ? "图片预览" : "视频预览")
      }
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onDoubleClick={onDoubleClick}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {item.type === "image" ? (
        <img
          src={item.src}
          alt={item.title || "生成结果预览"}
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            transition: dragging ? "none" : "transform 0.15s ease-out",
          }}
          onMouseDown={onMouseDown}
        />
      ) : (
        <video src={item.src} controls autoPlay loop />
      )}

      {canNav && (
        <button
          type="button"
          className="lightbox-nav lightbox-nav-prev"
          aria-label="上一张"
          onClick={() => go(-1)}
        >
          ‹
        </button>
      )}
      {canNav && (
        <button
          type="button"
          className="lightbox-nav lightbox-nav-next"
          aria-label="下一张"
          onClick={() => go(1)}
        >
          ›
        </button>
      )}

      <div className="lightbox-toolbar">
        {canNav && (
          <>
            <button
              type="button"
              className="lightbox-tool"
              aria-label="上一张"
              onClick={() => go(-1)}
            >
              ‹
            </button>
            <span className="lightbox-counter">
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              className="lightbox-tool"
              aria-label="下一张"
              onClick={() => go(1)}
            >
              ›
            </button>
            <span className="lightbox-sep" aria-hidden="true" />
          </>
        )}
        {item.type === "image" && (
          <>
            <button
              type="button"
              className="lightbox-tool"
              aria-label="缩小图片"
              onClick={() => zoomBy(-0.25)}
            >
              −
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-zoom"
              aria-label="重置图片缩放"
              onClick={resetView}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="lightbox-tool"
              aria-label="放大图片"
              onClick={() => zoomBy(0.25)}
            >
              +
            </button>
          </>
        )}
        {item.title && <span className="lightbox-meta">{item.title}</span>}
      </div>

      {renderFooter && (
        <div className="lightbox-footer">{renderFooter(index)}</div>
      )}

      <button
        type="button"
        className="lightbox-close"
        data-autofocus
        onClick={onClose}
        title="关闭 (Esc)"
        aria-label="关闭预览"
      >
        ✕
      </button>
    </motion.div>,
    document.body
  );
}
