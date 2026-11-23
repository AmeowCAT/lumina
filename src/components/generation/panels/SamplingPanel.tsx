import { memo } from "react";
import { PREVIEW_MODE_NAMES, SAMPLER_NAMES, SCHEDULER_NAMES } from "../../../config/families";
import { LMS_DEFAULTS, resolvePreviewMode } from "../../../lib/utils";
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
  /** capabilities.preview_modes；空数组 = 旧内核，不显示预览控件。 */
  previewModes: string[];
  previewMode: string | undefined;
  previewInterval: number | undefined;
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
  previewModes,
  previewMode,
  previewInterval,
}: Props) {
  // capabilities 对"未设置"返回 "default"（routes_sdcpp.cpp
  // capability_*_name），固定放一个"默认（自动）"选项；
  // 当前值不在 caps 列表时再补一项，避免触发器空态。
  // 陈旧值（持久化里是别的内核的枚举）保留可选项，但必须**标出来**：上游对未知
  // 枚举是静默忽略，于是界面显示 A、实际跑默认，用户完全看不出原因
  // （审查 30-api §2.7）。
  const samplerOptions = [
    { value: "default", label: "默认（自动）" },
    ...samplers
      .filter((s) => s !== "default")
      .map((s) => ({ value: s, label: SAMPLER_NAMES[s] || s })),
  ];
  const staleSampler =
    !!sampleMethod && sampleMethod !== "default" && !samplers.includes(sampleMethod);
  if (staleSampler) {
    samplerOptions.push({
      value: sampleMethod,
      label: `${SAMPLER_NAMES[sampleMethod] || sampleMethod}（当前内核不支持）`,
    });
  }
  const schedulerOptions = [
    { value: "default", label: "默认（自动）" },
    ...schedulers
      .filter((s) => s !== "default")
      .map((s) => ({ value: s, label: SCHEDULER_NAMES[s] || s })),
  ];
  const staleScheduler = !!scheduler && scheduler !== "default" && !schedulers.includes(scheduler);
  if (staleScheduler) {
    schedulerOptions.push({
      value: scheduler,
      label: `${SCHEDULER_NAMES[scheduler] || scheduler}（当前内核不支持）`,
    });
  }
  const previewChoices = [...new Set(previewModes.filter((m) => m !== "none"))];
  const activePreviewMode = resolvePreviewMode(previewMode, previewModes);
  const previewOptions = [
    { value: "none", label: PREVIEW_MODE_NAMES.none },
    ...previewChoices.map((m) => ({
      value: m,
      label: PREVIEW_MODE_NAMES[m] || m,
    })),
  ];
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
      {(staleSampler || staleScheduler) && (
        <div
          className="mb-3.5 rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn"
          role="alert"
        >
          当前内核不支持已选采样器或调度器，将自动回落默认，建议改选「默认（自动）」。
        </div>
      )}
      {sampleMethod === "lms" && (
        <>
          <Slider
            label="LMS 阶数"
            value={lmsMaxOrder ?? LMS_DEFAULTS.maxOrder}
            onChange={(v) => onUpdate("sample_params.lms_max_order", v)}
            min={1}
            max={12}
            step={1}
            hint="默认 4，越高细节越锐利"
          />
          <Slider
            label="LMS 历史偏移"
            value={lmsShift ?? LMS_DEFAULTS.shift}
            onChange={(v) => onUpdate("sample_params.lms_shift", v)}
            min={0}
            max={4}
            step={1}
          />
          <div className="form-row">
            <label className="form-label" htmlFor="lms-divisions">
              LMS 积分分段
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
          />
          <Slider
            label="Beta β"
            value={betaBeta ?? 0.6}
            onChange={(v) => onUpdate("sample_params.beta_beta", v)}
            min={0.05}
            max={2}
            step={0.05}
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
        />
      )}
      {previewChoices.length > 0 && (
        <div className="form-section">
          <div className="form-row">
            <label className="form-label" htmlFor="preview-mode">
              生成预览
            </label>
            <Select
              id="preview-mode"
              value={activePreviewMode}
              onChange={(v) => onUpdate("preview", v)}
              options={previewOptions}
            />
          </div>
          {activePreviewMode !== "none" && (
            <div className="form-row">
              <div className="form-label-row">
                <label className="form-label" htmlFor="preview-interval">
                  预览间隔
                </label>
                <span className="field-anchor">每 N 步</span>
              </div>
              <NumberInput
                id="preview-interval"
                value={previewInterval ?? 1}
                onChange={(v) => onUpdate("preview_interval", v)}
                min={1}
                max={200}
                step={1}
              />
            </div>
          )}
        </div>
      )}
      <button type="button" className="btn btn-sm mt-3.5 w-full" onClick={onReset}>
        {IC.refresh}
        <span>恢复当前模型推荐值</span>
      </button>
    </Panel>
  );
});
