import { memo } from "react";
import type { Features, GenMode } from "../../../types";
import { FAMILY_CONFIG } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { ImageUpload } from "../../ui/ImageUpload";
import { IC } from "../../ui/Icons";
import { readFileAsDataUrl } from "../../../lib/utils";

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
              className="upload-remove"
              style={{ top: 2, right: 2, width: 16, height: 16 }}
              onClick={() => onChange((r) => r.filter((_, j) => j !== i))}
            >
              {IC.x}
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label={addLabel}
          className="grid h-14 w-14 cursor-pointer place-items-center rounded-md border border-dashed border-line2 bg-transparent text-muted transition-colors hover:border-accent hover:text-accent-hi"
          onClick={() => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*";
            // 条件帧常常需要一次选入整段序列，允许多选后按文件名顺序追加。
            inp.multiple = true;
            inp.onchange = (e) => {
              const files = Array.from((e.target as HTMLInputElement).files || []);
              if (!files.length) return;
              Promise.all(files.map(readFileAsDataUrl)).then((urls) =>
                onChange((p) => [...p, ...urls])
              );
            };
            inp.click();
          }}
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
      {features.ref_images && mode === "img_gen" && (
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
      {features.control_frames && mode === "vid_gen" && (
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
