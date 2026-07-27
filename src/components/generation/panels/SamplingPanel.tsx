import { memo } from "react";
import { SAMPLER_NAMES, SCHEDULER_NAMES } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";
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
  onUpdate,
  onReset,
  forceOpen,
}: Props) {
  // caps 列表不含当前值时补一项,否则触发器会显示成"未选中"的空态
  const samplerOptions = samplers.map((s) => ({
    value: s,
    label: SAMPLER_NAMES[s] || s,
  }));
  if (sampleMethod && !samplers.includes(sampleMethod)) {
    samplerOptions.unshift({
      value: sampleMethod,
      label: SAMPLER_NAMES[sampleMethod] || sampleMethod,
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
