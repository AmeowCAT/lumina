import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { CliCapabilities, ServerArgs } from "../../types";
import { formatError } from "../../lib/utils";

/** Explicit, model-safe inspection. No automatic execution while typing a path. */
export function CliCompatibility({
  exePath,
  args,
  port,
}: {
  exePath: string;
  args?: ServerArgs;
  port: number;
}) {
  const [result, setResult] = useState<CliCapabilities | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    ++request.current;
    setResult(null);
    setError("");
    setBusy(false);
    return () => { ++request.current; };
  }, [exePath, argsKey, port]);

  const inspect = async () => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const next = args
        ? await api.preflightServer(exePath || "sd-server", args, port)
        : await api.inspectServer(exePath || "sd-server");
      if (id === request.current) setResult(next);
    } catch (e) {
      if (id === request.current) setError(formatError(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };

  return (
    <div className="form-row mt-2">
      <button type="button" className="btn btn-sm" onClick={() => void inspect()} disabled={busy}>
        {busy ? "检测中…" : "检测内核兼容性"}
      </button>
      <div className="field-hint field-hint-flush mt-1">
        只读取 --help / --version，不加载或停止模型。启动时还会自动校验；不会改写已保存参数。
      </div>
      {error && <div role="alert" className="field-hint field-hint-flush mt-1">{error}</div>}
      {result && (
        <div role="status" className="field-hint field-hint-flush mt-1">
          <div>{result.verified ? "已确认 CLI 能力" : "CLI 能力未确认"} · {result.version || "内核未报告版本"}</div>
          {result.memoryMode === "automatic" && <div>自动分段内核：max-vram 0 不禁用分段。</div>}
          {result.memoryMode === "legacy" && <div>旧版内核：保留 stream-layers 与旧版显存预算语义。</div>}
          {result.autoFit === "on-off" && <div>auto-fit 使用 on/off；无手动设备/权重放置时默认开启。</div>}
          {result.autoFit === "flag" && <div>auto-fit 是旧版裸开关，不能附加 on/off。</div>}
          {result.warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      )}
    </div>
  );
}
