import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { UpscalerInfo } from "../../types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
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

  return createPortal(
    <div className="fixed inset-0 z-[520] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/55"
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
        className="panel relative w-full max-w-md outline-none"
      >
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <h3 className="text-[12px] font-semibold text-fg">图像放大</h3>
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
        <div className="px-3 pb-3">
          <div className="field-hint field-hint-flush mb-2">
            直接调用内核的独立放大接口（RGB ESRGAN），不进入扩散采样，因此不会生成任务；
            运行期间与生成互斥，结果不保留 alpha。
            {source?.fmt ? `源图格式：${source.fmt.toUpperCase()}。` : ""}
          </div>
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
                { value: "", label: "自动（第一个兼容模型）" },
                ...upscalers.map((u) => ({ value: u.name, label: u.name })),
              ]}
            />
          </div>
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
          <div className="form-row">
            <label className="form-label" htmlFor="upscale-tile">
              分块尺寸
              <span className="form-sublabel">
                0 = 用内核 --upscale-tile-size；小于 32 的值会被内核抬到 32
              </span>
            </label>
            <NumberInput
              id="upscale-tile"
              value={tileSize}
              onChange={setTileSize}
              min={0}
              max={2048}
              step={32}
            />
          </div>
          <div className="field-hint field-hint-flush mt-1">
            结果每轴不超过 {maxWidth || 8192}×{maxHeight || 8192} 像素（含重复次数），
            超出会被内核在放大前拒绝。
          </div>
          {busy && (
            <div className="field-hint field-hint-flush mt-1" role="status">
              放大进行中：该接口同步执行且不可取消，请等待内核返回后再关闭窗口。
            </div>
          )}
          {error && (
            <div className="field-hint field-hint-flush mt-2" role="alert">
              {error}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <div className="header-spacer flex-1" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !source}
              onClick={() =>
                onSubmit({
                  upscaler,
                  repeats,
                  tileSize,
                  outputFormat: resolvedFormat,
                })
              }
            >
              {busy ? "放大中…" : "开始放大"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
