import { memo } from "react";
import type { HighNoiseSampleParams } from "../../../types";
import { SAMPLER_NAMES, SCHEDULER_NAMES } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";

interface Props {
  samplers: string[];
  schedulers: string[];
  hsp: HighNoiseSampleParams | undefined;
  fallbackSampleMethod: string;
  fallbackScheduler: string;
  moeBoundary: number | undefined;
  showDistilled: boolean;
  onUpdate: (path: string, v: unknown) => void;
}

export const HighNoisePanel = memo(function HighNoisePanel({
  samplers,
  schedulers,
  hsp,
  fallbackSampleMethod,
  fallbackScheduler,
  moeBoundary,
  showDistilled,
  onUpdate,
}: Props) {
  const sampler = hsp?.sample_method || fallbackSampleMethod;
  const scheduler = hsp?.scheduler || fallbackScheduler;
  // caps 列表不含当前值时补一项,否则触发器会显示成"未选中"的空态
  const samplerOptions = samplers.map((s) => ({
    value: s,
    label: SAMPLER_NAMES[s] || s,
  }));
  if (sampler && !samplers.includes(sampler)) {
    samplerOptions.unshift({
      value: sampler,
      label: SAMPLER_NAMES[sampler] || sampler,
    });
  }
  const schedulerOptions = schedulers.map((s) => ({
    value: s,
    label: SCHEDULER_NAMES[s] || s,
  }));
  if (scheduler && !schedulers.includes(scheduler)) {
    schedulerOptions.unshift({
      value: scheduler,
      label: SCHEDULER_NAMES[scheduler] || scheduler,
    });
  }
  return (
    <Panel title="高噪段采样">
      <div className="form-row">
        <label className="form-label" htmlFor="high-noise-sampler">
          采样器
        </label>
        <Select
          id="high-noise-sampler"
          value={sampler}
          onChange={(v) => onUpdate("high_noise_sample_params.sample_method", v)}
          options={samplerOptions}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="high-noise-scheduler">
          调度器
        </label>
        <Select
          id="high-noise-scheduler"
          value={scheduler}
          onChange={(v) => onUpdate("high_noise_sample_params.scheduler", v)}
          options={schedulerOptions}
        />
      </div>
      <Slider
        label="步数"
        value={hsp?.sample_steps ?? 8}
        onChange={(v) => onUpdate("high_noise_sample_params.sample_steps", v)}
        min={1}
        max={100}
      />
      <Slider
        label="CFG (文本)"
        value={hsp?.guidance?.txt_cfg ?? 3.5}
        onChange={(v) => onUpdate("high_noise_sample_params.guidance.txt_cfg", v)}
        min={0}
        max={30}
        step={0.5}
      />
      {showDistilled && (
        <Slider
          label="蒸馏 CFG (高噪)"
          value={hsp?.guidance?.distilled_guidance ?? 0}
          onChange={(v) =>
            onUpdate("high_noise_sample_params.guidance.distilled_guidance", v)
          }
          min={0}
          max={30}
          step={0.5}
        />
      )}
      <Slider
        label="Eta (高噪)"
        value={hsp?.eta ?? 1}
        onChange={(v) => onUpdate("high_noise_sample_params.eta", v)}
        min={0}
        max={1}
        step={0.05}
      />
      <Slider
        label="Flow Shift (高噪)"
        value={hsp?.flow_shift ?? 0}
        onChange={(v) => onUpdate("high_noise_sample_params.flow_shift", v)}
        min={0}
        max={20}
        step={0.1}
      />
      <Slider
        label="MoE Boundary"
        value={moeBoundary ?? 0.8}
        onChange={(v) => onUpdate("moe_boundary", v)}
        min={0}
        max={1}
        step={0.05}
        hint="低噪段/高噪段分界比例"
      />
    </Panel>
  );
});
