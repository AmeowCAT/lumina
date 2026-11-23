import { memo } from "react";
import { InfoTip, Panel } from "../../ui/Panel";
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
    <Panel title="图像预处理" collapsed>
      <div className="form-row">
        <div className="form-label-row">
          <div className="flex items-center gap-1.5">
            <label className="form-label" htmlFor="image-preprocess">
              预处理规则
            </label>
            <span className="field-anchor">每行一条</span>
          </div>
          <InfoTip label="语法">
            每行一条 key=value，须含 target（init / end / mask / control
            {hasRefImages ? " / ref" : ""} / ip-adapter），可用
            mode、filter、width、height、index。留空使用默认。
          </InfoTip>
        </div>
        <textarea
          id="image-preprocess"
          className="input font-mono text-[11.5px]"
          rows={3}
          value={text}
          spellCheck={false}
          onChange={(e) =>
            onUpdate(
              "image_preprocess",
              // Preserve draft whitespace/newlines; normalize only on submission.
              e.target.value.split("\n"),
            )
          }
          placeholder={PLACEHOLDER}
        />
      </div>
    </Panel>
  );
});
