import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { UpscalerInfo } from "../../types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { InfoTip } from "../ui/InfoTip";
import { Select } from "../ui/Select";
import { NumberInput } from "../ui/NumberInput";

/** 上游 `POST /sdcpp/v1/upscale` 的可用选项（无扩散模型参与）。 */
export interface UpscaleOptions {
  /** 空串 = 用第一个兼容模型（内核行为）。 */
  upscaler: string;
  /** 1–4，服务端会夹取。 */
  repeats: number;
  /** 0 = 用内核 `--upscale-tile-size`。 */
  tileSize: number;
  outputFormat: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 仅 `image_upscale` 的模型；内置滤镜与 latent 放大器不能用于该接口。 */
  upscalers: UpscalerInfo[];
  /** capabilities 声明的输出格式，webp 未必编译进来。 */
  outputFormats: string[];
  /** 源图（base64 / dataURL 原样回传服务端）与其格式。 */
  source: { b64: string; fmt: string } | null;
  busy: boolean;
  error?: string;
  maxWidth?: number;
  maxHeight?: number;
  onSubmit: (options: UpscaleOptions) => void;
}

const REPEAT_OPTIONS = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: n === 1 ? "1 次" : `${n} 次`,
}));

const FALLBACK_FORMATS = ["png", "jpeg"];

/**
 * 独立放大的参数对话框。
 *
 * 该接口是**同步**的（服务端不建任务、不能用任务队列看进度），所以这里用
 * 模态框承载"运行中 / 失败"两个状态，而不是把它塞进任务队列。
 */
export function UpscaleDialog({
  open,
  onClose,
  upscalers,
  outputFormats,
  source,
  busy,
  error,
  maxWidth,
  maxHeight,
  onSubmit,
}: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const [upscaler, setUpscaler] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [tileSize, setTileSize] = useState(0);
  const [format, setFormat] = useState("png");
  /** 同步放大的已耗时（秒）：该接口没有进度事件，至少给一个活着的时间参照。 */
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [busy]);

  // 可选模型变化（换服务器/换目录）时清掉已失效的选择，避免提交一个内核
  // 不认识的名字。
  useEffect(() => {
    if (upscaler && !upscalers.some((u) => u.name === upscaler)) setUpscaler("");
  }, [upscaler, upscalers]);

  // Esc 由调用方（GenerationUI 的统一浮层链）处理：这里再挂一个监听会让一次
  // Esc 同时关掉本对话框和它背后的参数面板。

  // busy 会把提交与关闭按钮一起禁用，浏览器随即把焦点丢给 body。这里把焦点
  // 收回对话框容器，配合 useFocusTrap 的兜底，避免 Tab 跑到后台界面上。
  useEffect(() => {
    if (open && busy) trapRef.current?.focus();
  }, [open, busy, trapRef]);

  if (!open) return null;

  const formats = (outputFormats.length ? outputFormats : FALLBACK_FORMATS).filter(
    (f) => f === "png" || f === "jpeg" || f === "webp",
  );
  const formatOptions = (formats.length ? formats : FALLBACK_FORMATS).map((f) => ({
    value: f,
    label: f.toUpperCase(),
  }));
  const resolvedFormat = formatOptions.some((o) => o.value === format)
    ? format
    : formatOptions[0].value;
  // 上游 #2396（routes_sdcpp.cpp:527）：tile_size 在 1–31 之间改为直接返回 HTTP 400
  // （"tile_size must be at least 32"），不再静默抬到 32；0 表示省略键、用内核默认。
  const tileSizeError =
    tileSize > 0 && tileSize < 32 ? "手动指定分块尺寸须 ≥ 32，填 0 使用默认" : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[520] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-[var(--color-scrim)]"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />
      <div
        ref={(node) => {
          trapRef.current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-label="图像放大"
        tabIndex={-1}
        className="panel relative mb-0 w-full max-w-md shadow-[var(--shadow-overlay)] outline-none"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h3 className="text-[13px] font-semibold tracking-[0.01em] text-fg">图像放大</h3>
          {source?.fmt && <span className="field-anchor">{source.fmt.toUpperCase()}</span>}
          <InfoTip>
            直接放大图像，不保留透明通道；单边上限 {maxWidth || 8192}×{maxHeight || 8192}
          </InfoTip>
          <div className="header-spacer flex-1" />
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭放大对话框"
            disabled={busy}
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="px-4 py-4">
          <div className="form-stack">
            <div className="form-row">
              <label className="form-label" htmlFor="upscale-model">
                放大器
              </label>
              <Select
                id="upscale-model"
                value={upscaler}
                onChange={setUpscaler}
                disabled={busy}
                contentClassName="select-content-elevated"
                options={[
                  { value: "", label: "自动" },
                  ...upscalers.map((u) => ({ value: u.name, label: u.name })),
                ]}
              />
            </div>
            <div className="form-grid">
              <div className="form-row">
                <label className="form-label" htmlFor="upscale-repeats">
                  重复次数
                </label>
                <Select
                  id="upscale-repeats"
                  value={String(repeats)}
                  onChange={(v) => setRepeats(Number(v))}
                  disabled={busy}
                  contentClassName="select-content-elevated"
                  options={REPEAT_OPTIONS}
                />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="upscale-format">
                  输出格式
                </label>
                <Select
                  id="upscale-format"
                  value={resolvedFormat}
                  onChange={setFormat}
                  disabled={busy}
                  contentClassName="select-content-elevated"
                  options={formatOptions}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-label-row">
                <label className="form-label" htmlFor="upscale-tile">
                  分块尺寸
                </label>
                <span className="field-anchor">0 = 自动</span>
              </div>
              <NumberInput
                id="upscale-tile"
                value={tileSize}
                onChange={setTileSize}
                min={0}
                max={2048}
                step={32}
              />
            </div>
            {tileSizeError && (
              <div
                className="rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn"
                role="alert"
              >
                {tileSizeError}
              </div>
            )}
            {busy && (
              <div
                className="flex items-center gap-2 rounded-md border border-accent-border bg-accent-dim px-2.5 py-2 text-[11px] leading-relaxed text-fg"
                role="status"
              >
                <span
                  className="spinner shrink-0"
                  style={{ width: 12, height: 12, borderWidth: 1.5 }}
                  aria-hidden="true"
                />
                <span>正在放大，过程不可取消，请稍候</span>
              </div>
            )}
            {error && (
              <div
                className="rounded-md border border-danger/30 bg-danger-dim px-2.5 py-2 text-[11px] leading-relaxed text-danger"
                role="alert"
              >
                {error}
              </div>
            )}
          </div>
          <div className="form-section flex items-center justify-end gap-2">
            <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !source || !!tileSizeError}
              onClick={() =>
                onSubmit({
                  upscaler,
                  repeats,
                  tileSize,
                  outputFormat: resolvedFormat,
                })
              }
            >
              {busy ? (elapsed > 0 ? `放大中… ${elapsed}s` : "放大中…") : "开始放大"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
