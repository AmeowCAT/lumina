import { memo } from "react";
import type { GenMode } from "../../../types";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";
import { Toggle } from "../../ui/Toggle";

interface Props {
  mode: GenMode;
  outputFormat: string | undefined;
  formats: string[];
  compression: number | undefined;
  /** 是否把生成参数写进 PNG/WebP 元数据（上游 `embed_image_metadata`，默认开）。 */
  embedMetadata: boolean | undefined;
  onUpdate: (path: string, v: unknown) => void;
}

export const OutputPanel = memo(function OutputPanel({
  mode,
  outputFormat,
  formats,
  compression,
  embedMetadata,
  onUpdate,
}: Props) {
  return (
    <Panel title="输出" collapsed>
      <div className="form-row">
        <label className="form-label" htmlFor="output-format">
          格式
        </label>
        <Select
          id="output-format"
          value={outputFormat || "png"}
          onChange={(v) => onUpdate("output_format", v)}
          options={formats.map((f) => ({ value: f, label: f.toUpperCase() }))}
        />
      </div>
      {mode === "img_gen" && (
        <>
          <Slider
            label="压缩"
            value={compression ?? 100}
            onChange={(v) => onUpdate("output_compression", v)}
            min={1}
            max={100}
          />
          {/* 审查 30-api §2.10：img_gen 恒发 embed_image_metadata=true，用户无法
              关闭——分享图片时提示词与全部参数都会跟着走。 */}
          <Toggle
            label="写入生成参数元数据"
            checked={embedMetadata !== false}
            onChange={(v) => onUpdate("embed_image_metadata", v)}
          />
          <div className="field-hint field-hint-flush">
            关闭后图片里不再嵌入提示词/种子/参数，「从历史图恢复参数」会不可用；
            分享原图前建议关闭。
          </div>
        </>
      )}
    </Panel>
  );
});
