import { memo } from "react";
import type { GenMode } from "../../../types";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";

interface Props {
  mode: GenMode;
  outputFormat: string | undefined;
  formats: string[];
  compression: number | undefined;
  onUpdate: (path: string, v: unknown) => void;
}

export const OutputPanel = memo(function OutputPanel({
  mode,
  outputFormat,
  formats,
  compression,
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
        <Slider
          label="压缩"
          value={compression ?? 100}
          onChange={(v) => onUpdate("output_compression", v)}
          min={1}
          max={100}
        />
      )}
    </Panel>
  );
});
