import { memo } from "react";
import type { HighNoiseSampleParams } from "../../../types";
import { SAMPLER_NAMES, SCHEDULER_NAMES } from "../../../config/families";
import { LMS_DEFAULTS } from "../../../lib/utils";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";

interface Props {
  samplers: string[];
  schedulers: string[];
  hsp: HighNoiseSampleParams | undefined;
  fallbackSampleMethod: string;
  fallbackScheduler: string;
  moeBoundary: number | undefined;
  showDistilled: boolean;
  betaAlpha: number | undefined;
  betaBeta: number | undefined;
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
  betaAlpha,
  betaBeta,
  onUpdate,
}: Props) {
  const sampler = hsp?.sample_method || fallbackSampleMethod;
  const scheduler = hsp?.scheduler || fallbackScheduler;
  // capabilities 对"未设置"返回 "default"（routes_sdcpp.cpp
  // capability_*_name），固定放一个"默认（自动）"选项；
  // 当前值不在 caps 列表时再补一项，避免触发器空态。
  const samplerOptions = [
    { value: "default", label: "默认（自动）" },
    ...samplers
      .filter((s) => s !== "default")
      .map((s) => ({ value: s, label: SAMPLER_NAMES[s] || s })),
  ];
  if (sampler && sampler !== "default" && !samplers.includes(sampler)) {
    samplerOptions.push({
      value: sampler,
      label: SAMPLER_NAMES[sampler] || sampler,
    });
  }
  const schedulerOptions = [
    { value: "default", label: "默认（自动）" },
    ...schedulers
      .filter((s) => s !== "default")
      .map((s) => ({ value: s, label: SCHEDULER_NAMES[s] || s })),
  ];
  if (scheduler && scheduler !== "default" && !schedulers.includes(scheduler)) {
    schedulerOptions.push({
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
      {sampler === "lms" && (
        <>
          <Slider
            label="LMS 阶数 (高噪)"
            value={hsp?.lms_max_order ?? LMS_DEFAULTS.maxOrder}
            onChange={(v) => onUpdate("high_noise_sample_params.lms_max_order", v)}
            min={1}
            max={12}
            step={1}
            hint="线性多步的历史点数，上游默认 4"
          />
          <Slider
            label="LMS 历史偏移 (高噪)"
            value={hsp?.lms_shift ?? LMS_DEFAULTS.shift}
            onChange={(v) => onUpdate("high_noise_sample_params.lms_shift", v)}
            min={0}
            max={4}
            step={1}
            hint="上游默认 1；0 为原始 k-diffusion 历史顺序"
          />
          <div className="form-row">
            <label className="form-label" htmlFor="high-noise-lms-divisions">
              LMS 积分分段 (高噪)
            </label>
            <NumberInput
              id="high-noise-lms-divisions"
              value={hsp?.lms_divisions ?? LMS_DEFAULTS.divisions}
              onChange={(v) => onUpdate("high_noise_sample_params.lms_divisions", v)}
              min={1}
              max={30000000}
              step={100}
            />
          </div>
        </>
      )}
      {scheduler === "beta" && (
        <>
          <Slider
            label="Beta α (高噪)"
            value={betaAlpha ?? 0.6}
            onChange={(v) => onUpdate("high_noise_sample_params.beta_alpha", v)}
            min={0.05}
            max={2}
            step={0.05}
            hint="调度器曲线形状参数（>0），上游默认 0.6"
          />
          <Slider
            label="Beta β (高噪)"
            value={betaBeta ?? 0.6}
            onChange={(v) => onUpdate("high_noise_sample_params.beta_beta", v)}
            min={0.05}
            max={2}
            step={0.05}
            hint="调度器曲线形状参数（>0），上游默认 0.6"
          />
        </>
      )}
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
      <div className="form-row mt-2">
        <label className="form-label" htmlFor="high-noise-extra-sample-args">
          额外采样参数 (高噪)
        </label>
        <input
          id="high-noise-extra-sample-args"
          className="input"
          type="text"
          value={hsp?.extra_sample_args ?? ""}
          onChange={(e) =>
            onUpdate("high_noise_sample_params.extra_sample_args", e.target.value)
          }
          placeholder="例如 gamma=3,apg_eta=0.8"
        />
        <div className="field-hint field-hint-flush mt-0.5">
          仅作用于高噪段（上游 high_noise_sample_params.extra_sample_args）
        </div>
      </div>
    </Panel>
  );
});
