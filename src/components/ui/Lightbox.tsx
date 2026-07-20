import { useEffect, useId, useRef, useState } from "react";

interface LightboxItem {
  type: "image" | "video";
  src: string;
}

export function Lightbox({
  item,
  onClose,
}: {
  item: LightboxItem | null;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!item) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), video[controls], [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
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
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
  }, [item]);

  if (!item) return null;

  const close = () => {
    onClose();
    setDragging(false);
  };

  const changeZoom = (delta: number) => {
    setZoom((current) => Math.max(0.25, Math.min(10, current + delta)));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const onWheel = (event: React.WheelEvent) => {
    if (item.type !== "image") return;
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? -0.15 : 0.15);
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

  return (
    <div
      ref={dialogRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onWheel={onWheel}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <h2 id={titleId} className="sr-only">
        {item.type === "image" ? "图片预览" : "视频预览"}
      </h2>
      {item.type === "image" ? (
        <img
          src={item.src}
          alt="生成结果预览"
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
            transition: dragging ? "none" : "transform 0.15s ease-out",
          }}
          onMouseDown={onMouseDown}
        />
      ) : (
        <video src={item.src} controls />
      )}
      {item.type === "image" && (
        <div className="lightbox-toolbar" aria-label="图片缩放控件">
          <button
            type="button"
            className="lightbox-tool"
            aria-label="缩小图片"
            onClick={() => changeZoom(-0.25)}
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
            onClick={() => changeZoom(0.25)}
          >
            +
          </button>
        </div>
      )}
      <button
        ref={closeButtonRef}
        type="button"
        className="lightbox-close"
        onClick={close}
        title="关闭 (Esc)"
        aria-label="关闭预览"
      >
        ✕
      </button>
    </div>
  );
}
