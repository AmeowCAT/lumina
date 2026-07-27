import { memo } from "react";
import type { Features, GenMode } from "../../../types";
import { FAMILY_CONFIG } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { ImageUpload } from "../../ui/ImageUpload";
import { IC } from "../../ui/Icons";
import { readFileAsDataUrl } from "../../../lib/utils";

interface Props {
  features: Features;
  mode: GenMode;
  family: string;
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  endImage: string | null;
  refImages: string[];
  strength: number | undefined;
  controlStrength: number | undefined;
  imgCfg: number | undefined;
  txtCfg: number | undefined;
  onUpdate: (path: string, v: unknown) => void;
  onSetImage: (
    which: "initImage" | "maskImage" | "controlImage" | "endImage",
    v: string | null
  ) => void;
  onSetRefImages: (updater: (r: string[]) => string[]) => void;
  onInitSize: (w: number, h: number) => void;
}

export const ImageInputsPanel = memo(function ImageInputsPanel({
  features,
  mode,
  family,
  initImage,
  maskImage,
  controlImage,
  endImage,
  refImages,
  strength,
  controlStrength,
  imgCfg,
  txtCfg,
  onUpdate,
  onSetImage,
  onSetRefImages,
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
        <div className="form-row">
          <div className="form-label">
            参考图片
            {FAMILY_CONFIG[family]?.requiredInputsByMode?.[mode]?.includes(
              "ref_images"
            )
              ? "（必需）"
              : ""}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {refImages.map((img, i) => (
              <div
                key={i}
                className="relative h-14 w-14 overflow-hidden rounded-md border border-line bg-well"
              >
                <img src={img} alt="" className="h-full w-full object-cover" />
                <button
                  className="upload-remove"
                  style={{ top: 2, right: 2, width: 16, height: 16 }}
                  onClick={() => onSetRefImages((r) => r.filter((_, j) => j !== i))}
                >
                  {IC.x}
                </button>
              </div>
            ))}
            <button
              type="button"
              aria-label="添加参考图片"
              className="grid h-14 w-14 cursor-pointer place-items-center rounded-md border border-dashed border-line2 bg-transparent text-muted transition-colors hover:border-accent hover:text-accent-hi"
              onClick={() => {
                const inp = document.createElement("input");
                inp.type = "file";
                inp.accept = "image/*";
                inp.onchange = (e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) {
                    readFileAsDataUrl(f).then((url) =>
                      onSetRefImages((p) => [...p, url])
                    );
                  }
                };
                inp.click();
              }}
            >
              {IC.plus}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
});
