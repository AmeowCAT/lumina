import { memo, useRef } from "react";
import type { Features, GenMode } from "../../../types";
import { FAMILY_CONFIG } from "../../../config/families";
import { useStore } from "../../../store";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { ImageUpload } from "../../ui/ImageUpload";
import { IC } from "../../ui/Icons";
import { readFileAsDataUrl } from "../../../lib/utils";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 多图输入行：缩略图 + 逐个删除 + 追加。参考图片与 VACE 条件帧共用。 */
function MultiImageRow({
  label,
  images,
  onChange,
  addLabel,
}: {
  label: string;
  images: string[];
  onChange: (updater: (r: string[]) => string[]) => void;
  addLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const toast = useStore((s) => s.toast);
  return (
    <div className="form-row">
      <div className="form-label">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {images.map((img, i) => (
          <div
            key={i}
            className="relative h-14 w-14 overflow-hidden rounded-md border border-line bg-well"
          >
            <img src={img} alt="" className="h-full w-full object-cover" />
            <button
              className="upload-remove upload-remove-sm"
              aria-label={`移除第 ${i + 1} 张`}
              onClick={() => onChange((r) => r.filter((_, j) => j !== i))}
            >
              {IC.x}
            </button>
          </div>
        ))}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (!files.length) return;
            const invalid = files
              .map((f) =>
                !f.type.startsWith("image/")
                  ? `${f.name}（非图片格式）`
                  : f.size > MAX_UPLOAD_BYTES
                    ? `${f.name}（超过 100MB）`
                    : null
              )
              .filter((x): x is string => !!x);
            if (invalid.length) {
              toast(`已跳过 ${invalid.length} 个无效文件：${invalid.join("、")}`, true);
            }
            const valid = files.filter(
              (f) => f.type.startsWith("image/") && f.size <= MAX_UPLOAD_BYTES
            );
            if (!valid.length) return;
            // 条件帧顺序即上游条件帧顺序：显式按文件名排序，
            // 不依赖浏览器的 FileList 顺序。
            valid.sort((a, b) => a.name.localeCompare(b.name));
            Promise.all(valid.map(readFileAsDataUrl)).then((urls) =>
              onChange((p) => [...p, ...urls])
            );
            // 文件对话框是原生模态：关闭后把焦点还给追加按钮
            requestAnimationFrame(() => addBtnRef.current?.focus());
          }}
        />
        <button
          ref={addBtnRef}
          type="button"
          aria-label={addLabel}
          className="grid h-14 w-14 cursor-pointer place-items-center rounded-md border border-dashed border-line2 bg-transparent text-muted transition-colors hover:border-accent hover:text-accent-hi"
          onClick={() => inputRef.current?.click()}
        >
          {IC.plus}
        </button>
      </div>
    </div>
  );
}

interface Props {
  features: Features;
  mode: GenMode;
  family: string;
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  ipAdapterImage: string | null;
  endImage: string | null;
  refImages: string[];
  controlFrames: string[];
  controlFramesSupported: boolean;
  refImagesSupported: boolean;
  strength: number | undefined;
  controlStrength: number | undefined;
  ipAdapterStrength: number | undefined;
  imgCfg: number | undefined;
  txtCfg: number | undefined;
  onUpdate: (path: string, v: unknown) => void;
  onSetImage: (
    which:
      | "initImage"
      | "maskImage"
      | "controlImage"
      | "ipAdapterImage"
      | "endImage",
    v: string | null
  ) => void;
  onSetRefImages: (updater: (r: string[]) => string[]) => void;
  onSetControlFrames: (updater: (r: string[]) => string[]) => void;
  onInitSize: (w: number, h: number) => void;
}

export const ImageInputsPanel = memo(function ImageInputsPanel({
  features,
  mode,
  family,
  initImage,
  maskImage,
  controlImage,
  ipAdapterImage,
  endImage,
  refImages,
  controlFrames,
  controlFramesSupported,
  refImagesSupported,
  strength,
  controlStrength,
  ipAdapterStrength,
  imgCfg,
  txtCfg,
  onUpdate,
  onSetImage,
  onSetRefImages,
  onSetControlFrames,
  onInitSize,
}: Props) {
  return (
    <Panel title="图片输入" collapsed={!features.init_image}>
      {features.init_image && (
        <ImageUpload
          label="初始图片"
          value={initImage}
          onChange={(v) => onSetImage("initImage", v)}
          onSizeDetected={onInitSize}
        />
      )}
      {features.mask_image && mode === "img_gen" && (
        <ImageUpload
          label="蒙版"
          value={maskImage}
          onChange={(v) => onSetImage("maskImage", v)}
        />
      )}
      {features.control_image && mode === "img_gen" && (
        <ImageUpload
          label="Control 图片"
          value={controlImage}
          onChange={(v) => onSetImage("controlImage", v)}
        />
      )}
      {features.ip_adapter_image && mode === "img_gen" && (
        <ImageUpload
          label="IP-Adapter 图片"
          value={ipAdapterImage}
          onChange={(v) => onSetImage("ipAdapterImage", v)}
        />
      )}
      {features.end_image && mode === "vid_gen" && (
        <ImageUpload
          label="结束帧"
          value={endImage}
          onChange={(v) => onSetImage("endImage", v)}
        />
      )}
      {(features.init_image || features.control_image) && mode === "img_gen" && (
        <>
          <Slider
            label="重绘强度"
            value={strength ?? 0.75}
            onChange={(v) => onUpdate("strength", v)}
            min={0}
            max={1}
            step={0.05}
          />
          <Slider
            label="Control 强度"
            value={controlStrength ?? 0.9}
            onChange={(v) => onUpdate("control_strength", v)}
            min={0}
            max={1}
            step={0.05}
          />
          <Slider
            label="CFG (图像)"
            value={imgCfg}
            onChange={(v) => onUpdate("sample_params.guidance.img_cfg", v)}
            min={0}
            max={30}
            step={0.5}
            hint={
              imgCfg != null ? undefined : `未设置，跟随文本 CFG (${txtCfg ?? 0})`
            }
          />
        </>
      )}
      {features.ip_adapter_image && mode === "img_gen" && (
        <Slider
          label="IP-Adapter 强度"
          value={ipAdapterStrength ?? 1.0}
          onChange={(v) => onUpdate("ip_adapter_strength", v)}
          min={0}
          max={2}
          step={0.05}
        />
      )}
      {features.init_image && mode === "vid_gen" && (
        <Slider
          label="图生视频强度"
          value={strength ?? 0.75}
          onChange={(v) => onUpdate("strength", v)}
          min={0}
          max={1}
          step={0.05}
          hint="数值越高，偏离初始图的幅度越大；越低则越稳定"
        />
      )}
      {refImagesSupported && (
        <MultiImageRow
          label={
            "参考图片" +
            (FAMILY_CONFIG[family]?.requiredInputsByMode?.[mode]?.includes(
              "ref_images"
            )
              ? "（必需）"
              : "")
          }
          images={refImages}
          onChange={onSetRefImages}
          addLabel="添加参考图片"
        />
      )}
      {controlFramesSupported && mode === "vid_gen" && (
        <MultiImageRow
          label="条件帧（VACE）"
          images={controlFrames}
          onChange={onSetControlFrames}
          addLabel="添加条件帧"
        />
      )}
    </Panel>
  );
});
