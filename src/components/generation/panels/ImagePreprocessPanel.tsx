import { memo } from "react";
import { Panel } from "../../ui/Panel";
import { imagePreprocessDraftLines } from "../../../lib/utils";

interface Props {
  /** 编辑草稿按行存储，保留空行与空白；构建请求时才清理为 image_preprocess。 */
  rules: string[] | undefined;
  /** 家族是否暴露参考图输入（决定提示里是否提 target=ref 等）。 */
  hasRefImages: boolean;
  onUpdate: (path: string, v: unknown) => void;
}

const PLACEHOLDER = [
  "target=init,mode=crop-resize,filter=lanczos",
  "target=ref,index=0,mode=none",
].join("\n");

/**
 * 上游 #2028 的 `--image-preprocess` / 请求体 `image_preprocess`：在进入原有
 * 生成管线之前，对每个图像输入做**一次性**几何变换。
 *
 * 这里只做规则串的原文透传（每行一条），合法性由内核在生成开始时校验并报错；
 * GUI 不复制上游的规则语法，避免与内核漂移。空 = 用输入预设默认。
 */
export const ImagePreprocessPanel = memo(function ImagePreprocessPanel({
  rules,
  hasRefImages,
  onUpdate,
}: Props) {
  const text = imagePreprocessDraftLines(rules).join("\n");

  return (
    <Panel title="图像输入几何（image_preprocess）" collapsed>
      <div className="form-row">
        <label className="form-label" htmlFor="image-preprocess">
          预处理规则
        </label>
        <textarea
          id="image-preprocess"
          className="input"
          rows={3}
          value={text}
          spellCheck={false}
          onChange={(e) =>
            onUpdate(
              "image_preprocess",
              // Preserve draft whitespace/newlines; normalize only on submission.
              e.target.value.split("\n")
            )
          }
          placeholder={PLACEHOLDER}
        />
        <div className="field-hint field-hint-flush mt-0.5">
          每行一条 key=value 规则，作用于生成前的输入图像几何（不影响
          VAE / CLIP / ControlNet 的内部预处理）。必需键 target：
          init · end · mask · control ·{hasRefImages ? " ref ·" : ""} ip-adapter ·
          id · control-frame；可用 mode=auto|none|stretch|crop|crop-resize|fit-pad、
          filter=auto|nearest|nearest-exact|bilinear|bicubic|lanczos、
          antialias、width/height、anchor、pad_color、canny=true。
          ref / id / control-frame 支持 index=N（0 起）单条覆盖。
          留空表示沿用各输入的默认几何。参考图是否在 VAE 编码前缩放由
          --ref-image-args 单独控制。
        </div>
      </div>
    </Panel>
  );
});
