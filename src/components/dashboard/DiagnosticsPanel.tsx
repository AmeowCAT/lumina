import type { RuntimeDiagnostics } from "../../types";
import { useStore } from "../../store";
import {
  buildDiagnosticArgs,
  diagnosticsFor,
  LOG_LEVELS,
  scaleValidationError,
} from "../../lib/diagnostics";
import { InfoTip } from "../ui/InfoTip";
import { Panel } from "../ui/Panel";
import { Select } from "../ui/Select";
import { cn } from "../ui/cn";

export function DiagnosticsPanel() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const values = diagnosticsFor(settings);
  const { errors } = buildDiagnosticArgs(values);
  const setValue = (key: keyof RuntimeDiagnostics, value: string) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const hasCustom = Boolean(values.logLevel || values.linearScale || values.attnScale);
  const badge = errors.length > 0 ? "参数有误" : hasCustom ? "已自定义" : undefined;

  return (
    <Panel title="诊断与数值稳定性" collapsed badge={badge}>
      <p className="text-[11px] text-muted mb-3">修改后需重启服务器生效</p>
      <div className="form-row">
        <label className="form-label" htmlFor="dashboard-log-level">
          日志等级（--log-level）
        </label>
        <Select
          id="dashboard-log-level"
          value={values.logLevel}
          onChange={(value) => setValue("logLevel", value)}
          options={[
            { value: "", label: "内核默认（不传）" },
            ...LOG_LEVELS.map((value) => ({
              value,
              label: value === "debug" ? "debug · 最详细" : value,
            })),
            ...(values.logLevel && !(LOG_LEVELS as readonly string[]).includes(values.logLevel)
              ? [{ value: values.logLevel, label: `无效值（${values.logLevel}）` }]
              : []),
          ]}
        />
      </div>

      <div className="form-section">
        <div className="form-grid-sm">
          {(
            [
              ["linearScale", "Linear 输入缩放（--linear-scale）"],
              ["attnScale", "Attention K/V 缩放（--attn-scale）"],
            ] as const
          ).map(([key, label]) => (
            <div className="form-row" key={key}>
              <div className="form-label-row">
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  <label className="form-label" htmlFor={`dashboard-${key}`}>
                    {label}
                  </label>
                  {key === "linearScale" && (
                    <InfoTip>
                      留空或填 0 使用模型默认，填 1 关闭缩放；Attention 缩放仅在启用 Flash Attention
                      时生效
                    </InfoTip>
                  )}
                </span>
              </div>
              <input
                id={`dashboard-${key}`}
                className={cn(
                  "input font-mono text-[12px]",
                  scaleValidationError(values[key]) && "invalid",
                )}
                type="text"
                inputMode="decimal"
                value={values[key]}
                onChange={(event) => setValue(key, event.target.value)}
                placeholder="默认（如 0.0078125）"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="form-section flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            setSettings((current) => ({
              ...current,
              linearScale: "0.0078125",
              attnScale: "0.0078125",
            }))
          }
        >
          填入黑白图 / NaN 排查值
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() =>
            setSettings((current) => ({
              ...current,
              ...diagnosticsFor(),
            }))
          }
        >
          恢复诊断默认
        </button>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-danger/35 bg-danger-dim px-3 py-2 text-[11.5px] leading-relaxed text-danger"
        >
          {errors.join("；")}
        </div>
      )}
    </Panel>
  );
}
