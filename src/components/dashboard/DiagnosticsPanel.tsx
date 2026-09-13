import type { RuntimeDiagnostics } from "../../types";
import { useStore } from "../../store";
import { buildDiagnosticArgs, diagnosticsFor, LOG_LEVELS } from "../../lib/diagnostics";
import { Panel } from "../ui/Panel";
import { Select } from "../ui/Select";

export function DiagnosticsPanel() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const values = diagnosticsFor(settings);
  const { errors } = buildDiagnosticArgs(values);
  const setValue = (key: keyof RuntimeDiagnostics, value: string) =>
    setSettings((current) => ({ ...current, [key]: value }));

  return (
    <Panel title="诊断与数值稳定性" collapsed>
      <p className="field-hint mb-3">
        以下是 sd-server 启动配置，修改后需重启服务器，不会立即影响当前任务；
        留空沿用内核默认。启动预检会拦截旧内核不支持的选项。
      </p>
      <div className="form-row">
        <label className="form-label" htmlFor="dashboard-log-level">日志等级（--log-level）</label>
        <Select
          id="dashboard-log-level"
          value={values.logLevel}
          onChange={(value) => setValue("logLevel", value)}
          options={[
            { value: "", label: "内核默认（不传）" },
            ...LOG_LEVELS.map((value) => ({ value, label: value === "debug" ? "debug · 最详细" : value })),
            ...((values.logLevel && !(LOG_LEVELS as readonly string[]).includes(values.logLevel))
              ? [{ value: values.logLevel, label: `无效值（${values.logLevel}）` }] : []),
          ]}
        />
        <div className="field-hint field-hint-flush">新版 -v / --verbose 等价于 verbose，不包含完整 debug 日志。</div>
      </div>
      {([
        ["linearScale", "Linear 输入缩放（--linear-scale）"],
        ["attnScale", "Attention K/V 缩放（--attn-scale）"],
      ] as const).map(([key, label]) => (
        <div className="form-row mt-2" key={key}>
          <label className="form-label" htmlFor={`dashboard-${key}`}>{label}</label>
          <input
            id={`dashboard-${key}`} className="input" type="text" inputMode="decimal"
            value={values[key]} onChange={(event) => setValue(key, event.target.value)}
            placeholder="留空 / 0：模型默认；例如 0.0078125"
          />
        </div>
      ))}
      <div className="field-hint field-hint-flush mt-1">
        0 保留模型内置缩放，1 关闭相应缩放；override 须为有限正数。
        attn-scale 仅在启用 --fa / --diffusion-fa 且后端支持 Flash Attention 时生效。
        这些值不是 CFG，也不能填写到“额外采样参数”。
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className="btn btn-sm" onClick={() => setSettings((current) => ({
          ...current, linearScale: "0.0078125", attnScale: "0.0078125",
        }))}>填入黑白图 / NaN 排查值</button>
        <button type="button" className="btn btn-sm" onClick={() => setSettings((current) => ({
          ...current, ...diagnosticsFor(),
        }))}>恢复诊断默认</button>
      </div>
      <div className="field-hint field-hint-flush mt-2">
        仅在出现数值异常时尝试排查值，不保证修复所有黑图。禁用预取或分段可在附加启动参数中填写
        --disable-prefetch / --disable-segmented-compute；禁用分段可能更容易显存不足。
      </div>
      {errors.length > 0 && <div role="alert" className="field-hint field-hint-flush mt-2">{errors.join("；")}</div>}
    </Panel>
  );
}
