import { memo } from "react";
import type { SlgGuidance, VaeTilingParams } from "../../../types";
import { CACHE_MODES } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { Select } from "../../ui/Select";

interface Props {
  eta: number | undefined;
  flowShift: number | undefined;
  slg: SlgGuidance | undefined;
  vaeTilingParams: VaeTilingParams | undefined;
  cacheMode: string | undefined;
  clipSkip: number | undefined;
  extraSampleArgs: string | undefined;
  onUpdate: (path: string, v: unknown) => void;
}

export const AdvancedSamplingPanel = memo(function AdvancedSamplingPanel({
  eta,
  flowShift,
  slg,
  vaeTilingParams,
  cacheMode,
  clipSkip,
  extraSampleArgs,
  onUpdate,
}: Props) {
  return (
    <Panel title="高级采样" collapsed>
      <Slider
        label="Eta"
        value={eta ?? 1}
        onChange={(v) => onUpdate("sample_params.eta", v)}
        min={0}
        max={1}
        step={0.05}
        hint="随机噪声强度，通常保持推荐值"
      />
      <Slider
        label="Flow Shift"
        value={flowShift ?? 0}
        onChange={(v) => onUpdate("sample_params.flow_shift", v)}
        min={0}
        max={20}
        step={0.1}
        hint="Flow 类模型的时间步偏移"
      />
      <Slider
        label="SLG Scale"
        value={slg?.scale ?? 0}
        onChange={(v) =>
          onUpdate("sample_params.guidance.slg", {
            ...(slg || { layers: [7, 8, 9] }),
            scale: v,
          })
        }
        min={0}
        max={10}
        step={0.1}
        hint="跳层引导，0 表示关闭"
      />
      <Toggle
        label="VAE 分块"
        checked={!!vaeTilingParams?.enabled}
        onChange={(v) =>
          // 展开保留 caps 默认带下来的 tile_size 等字段，只翻转开关
          onUpdate("vae_tiling_params", { ...vaeTilingParams, enabled: v })
        }
      />
      <div className="form-row mt-2">
        <label className="form-label" htmlFor="cache-mode">
          缓存
        </label>
        <Select
          id="cache-mode"
          value={cacheMode || "disabled"}
          onChange={(v) => onUpdate("cache_mode", v)}
          options={CACHE_MODES.map((c) => ({ value: c.v, label: c.l }))}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="clip-skip">
          CLIP Skip
        </label>
        <Select
          id="clip-skip"
          value={String(clipSkip ?? -1)}
          onChange={(v) => onUpdate("clip_skip", parseInt(v))}
          options={[
            { value: "-1", label: "自动（随版本）" },
            { value: "1", label: "1 · 最后一层" },
            { value: "2", label: "2 · 倒数第二层" },
            { value: "3", label: "3" },
          ]}
        />
      </div>
      <div className="form-row mt-2">
        <label className="form-label" htmlFor="extra-sample-args">
          额外采样参数
        </label>
        <input
          id="extra-sample-args"
          className="input"
          type="text"
          value={extraSampleArgs ?? ""}
          onChange={(e) => onUpdate("sample_params.extra_sample_args", e.target.value)}
          placeholder="例如 gamma=3,apg_eta=0.8,slg_uncond=true"
        />
        <div className="field-hint field-hint-flush mt-0.5">
          上游 extra_sample_args 的 key=value 列表（逗号分隔），兜底界面未暴露的
          采样器 / 调度器 / 引导参数：flux 的 base_shift·max_shift、lcm 的
          noise_clip_std、euler_ge 的 gamma、APG 的 apg_*、slg_uncond、
          guidance_schedule 等；同名键会覆盖上面的滑杆值
        </div>
      </div>
    </Panel>
  );
});
