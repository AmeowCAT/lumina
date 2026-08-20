import { memo } from "react";
import { SAMPLER_NAMES, SCHEDULER_NAMES } from "../../../config/families";
import { LMS_DEFAULTS } from "../../../lib/utils";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";
import { IC } from "../../ui/Icons";

interface Props {
  samplers: string[];
  schedulers: string[];
  sampleMethod: string;
  scheduler: string;
  steps: number | undefined;
  txtCfg: number | undefined;
  distilled: number | undefined;
  showDistilled: boolean;
  betaAlpha: number | undefined;
  betaBeta: number | undefined;
  lmsMaxOrder: number | undefined;
  lmsShift: number | undefined;
  lmsDivisions: number | undefined;
  onUpdate: (path: string, v: unknown) => void;
  onReset: () => void;
  /** 参数 chip 深链:召唤 Sheet 时强制展开本面板 */
  forceOpen?: boolean;
}

export const SamplingPanel = memo(function SamplingPanel({
  samplers,
  schedulers,
  sampleMethod,
  scheduler,
  steps,
  txtCfg,
  distilled,
  showDistilled,
  betaAlpha,
  betaBeta,
  lmsMaxOrder,
  lmsShift,
  lmsDivisions,
  onUpdate,
  onReset,
  forceOpen,
}: Props) {
  // capabilities 对"未设置"返回 "default"（routes_sdcpp.cpp
  // capability_*_name），固定放一个"默认（自动）"选项；
  // 当前值不在 caps 列表时再补一项，避免触发器空态。
  const samplerOptions = [
    { value: "default", label: "默认（自动）" },
    ...samplers
      .filter((s) => s !== "default")
      .map((s) => ({ value: s, label: SAMPLER_NAMES[s] || s })),
  ];
  if (sampleMethod && sampleMethod !== "default" && !samplers.includes(sampleMethod)) {
    samplerOptions.push({
      value: sampleMethod,
      label: SAMPLER_NAMES[sampleMethod] || sampleMethod,
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
    <Panel title="采样设置" forceOpen={forceOpen}>
      <div className="form-row">
        <label className="form-label" htmlFor="sample-method">
          采样器
        </label>
        <Select
          id="sample-method"
          value={sampleMethod}
          onChange={(v) => onUpdate("sample_params.sample_method", v)}
          options={samplerOptions}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="scheduler">
          调度器
        </label>
        <Select
          id="scheduler"
          value={scheduler}
          onChange={(v) => onUpdate("sample_params.scheduler", v)}
          options={schedulerOptions}
        />
      </div>
      {sampleMethod === "lms" && (
        <>
          <Slider
            label="LMS 阶数"
            value={lmsMaxOrder ?? LMS_DEFAULTS.maxOrder}
            onChange={(v) => onUpdate("sample_params.lms_max_order", v)}
            min={1}
            max={12}
            step={1}
            hint="线性多步的历史点数，上游默认 4；1 等同 Euler，越高越锐利但需要更多步数（>12 可能出 NaN）"
          />
          <Slider
            label="LMS 历史偏移"
            value={lmsShift ?? LMS_DEFAULTS.shift}
            onChange={(v) => onUpdate("sample_params.lms_shift", v)}
            min={0}
            max={4}
            step={1}
            hint="上游默认 1（少步数更稳）；0 为原始 k-diffusion 历史顺序"
          />
          <div className="form-row">
            <label className="form-label" htmlFor="lms-divisions">
              LMS 积分分段
              <span className="form-sublabel">
                系数积分的分段数，上游默认 1000；越大越精确也越慢
              </span>
            </label>
            <NumberInput
              id="lms-divisions"
              value={lmsDivisions ?? LMS_DEFAULTS.divisions}
              onChange={(v) => onUpdate("sample_params.lms_divisions", v)}
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
            label="Beta α"
            value={betaAlpha ?? 0.6}
            onChange={(v) => onUpdate("sample_params.beta_alpha", v)}
            min={0.05}
            max={2}
            step={0.05}
            hint="调度器曲线形状参数（>0），上游默认 0.6"
          />
          <Slider
            label="Beta β"
            value={betaBeta ?? 0.6}
            onChange={(v) => onUpdate("sample_params.beta_beta", v)}
            min={0.05}
            max={2}
            step={0.05}
            hint="调度器曲线形状参数（>0），上游默认 0.6"
          />
        </>
      )}
      <Slider
        label="步数"
        value={steps ?? 20}
        onChange={(v) => onUpdate("sample_params.sample_steps", v)}
        min={1}
        max={100}
      />
      <Slider
        label="CFG (文本)"
        value={txtCfg ?? 7}
        onChange={(v) => onUpdate("sample_params.guidance.txt_cfg", v)}
        min={0}
        max={30}
        step={0.5}
      />
      {showDistilled && (
        <Slider
          label="蒸馏 CFG"
          value={distilled ?? 0}
          onChange={(v) => onUpdate("sample_params.guidance.distilled_guidance", v)}
          min={0}
          max={30}
          step={0.5}
          hint="蒸馏模型"
        />
      )}
      <button className="btn btn-sm w-full" onClick={onReset}>
        {IC.refresh}
        <span>恢复当前模型推荐值</span>
      </button>
    </Panel>
  );
});
