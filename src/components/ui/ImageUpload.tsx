import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IC } from "./Icons";
import { getImageSize, readFileAsDataUrl } from "../../lib/utils";

function processFile(
  file: File,
  onChange: (v: string | null) => void,
  onSizeDetected?: (w: number, h: number) => void
) {
  readFileAsDataUrl(file).then((url) => {
    onChange(url);
    if (onSizeDetected) {
      getImageSize(url)
        .then(({ width, height }) => onSizeDetected(width, height))
        .catch(() => {});
    }
  });
}

// 同屏可能同时挂载多个 ImageUpload（初始图/蒙版/Control/IP-Adapter/结束帧）。
// 若每个实例各自注册 document 级 paste 监听，一次 Ctrl+V 会命中全部监听器，
// 同一张图被无感写入所有槽位（对抗性审查 B1）。这里改为"最后交互的实例"
// 独占粘贴：模块级记录最后指针进入/聚焦的实例；未交互过则回落到第一个
// 挂载的实例（初始图），保持单槽位时的旧行为。
let lastActiveUploadId: string | null = null;
let firstUploadId: string | null = null;

function pasteTarget(): string | null {
  return lastActiveUploadId ?? firstUploadId;
}

export function ImageUpload({
  label,
  value,
  onChange,
  onSizeDetected,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  onSizeDetected?: (width: number, height: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputId = useId();
  const labelId = useId();
  const hintId = useId();
  // 稳定回调引用，避免 useEffect 反复注销/注册 paste 监听。
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const sizeRef = useRef(onSizeDetected);
  sizeRef.current = onSizeDetected;

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f?.type?.startsWith("image/")) processFile(f, onChange, onSizeDetected);
    },
    [onChange, onSizeDetected]
  );

  // 挂载顺序即注册顺序：第一个挂载的实例成为粘贴兜底目标（初始图槽位）。
  useEffect(() => {
    if (!firstUploadId) firstUploadId = inputId;
    return () => {
      if (firstUploadId === inputId) firstUploadId = null;
      if (lastActiveUploadId === inputId) lastActiveUploadId = null;
    };
  }, [inputId]);

  // 全局 Ctrl+V 粘贴图片（仅在焦点不在文本输入时触发）。多实例同屏时只有
  // "最后交互的实例"（见 pasteTarget）处理本次粘贴，避免一图写入全部槽位。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (pasteTarget() !== inputId) return;
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (el as HTMLElement)?.isContentEditable) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const f = items[i].getAsFile();
          if (f) {
            e.preventDefault();
            processFile(f, cbRef.current, sizeRef.current);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [inputId]);

  return (
    <div
      className="form-row"
      onPointerEnter={() => {
        lastActiveUploadId = inputId;
      }}
      onFocusCapture={() => {
        lastActiveUploadId = inputId;
      }}
    >
      <div id={labelId} className="form-label">
        {label}
      </div>
      {value ? (
        <div className="upload-preview">
          <img src={value} alt={`${label}预览`} />
          <button
            type="button"
            className="upload-remove"
            aria-label={`移除${label}`}
            title={`移除${label}`}
            onClick={() => onChange(null)}
          >
            {IC.x}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`upload-zone${dragOver ? " drag-over" : ""}`}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <p>{dragOver ? "松开以上传" : "点击或拖放图片"}</p>
          <p id={hintId} className="upload-hint">
            PNG / JPG / WEBP · 也支持 Ctrl+V
          </p>
        </button>
      )}
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-labelledby={labelId}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) processFile(f, onChange, onSizeDetected);
          e.target.value = "";
        }}
      />
    </div>
  );
}
