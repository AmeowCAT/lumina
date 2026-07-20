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

  // 全局 Ctrl+V 粘贴图片（仅在焦点不在文本输入时触发）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
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
  }, []);

  return (
    <div className="form-row">
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
