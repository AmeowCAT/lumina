import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { CliCapabilities, ServerArgs } from "../../types";
import { formatError } from "../../lib/utils";
import { cn } from "../ui/cn";

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
    return () => {
      ++request.current;
    };
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
    <div className="form-row">
      <div className="flex items-center justify-between gap-3">
        <span className="form-label mb-0">内核兼容性</span>
        <button
          type="button"
          className="btn btn-sm shrink-0"
          onClick={() => void inspect()}
          disabled={busy}
        >
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" />
              检测中…
            </>
          ) : (
            "检测内核兼容性"
          )}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-danger/35 bg-danger-dim px-3 py-2 text-[11.5px] leading-relaxed text-danger"
        >
          {error}
        </div>
      )}
      {result && (
        <div
          role="status"
          className="mt-3 rounded-md border border-line bg-well px-3 py-2.5 text-[11.5px] leading-relaxed text-fg2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-line">
            <span className="inline-flex items-center gap-2 font-medium text-fg">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full shrink-0",
                  result.verified ? "bg-success" : "bg-warn",
                )}
                aria-hidden="true"
              />
              {result.verified ? "内核兼容" : "版本未识别"}
            </span>
            <span className="font-mono text-[10.5px] text-muted">
              {result.version || "未知版本"}
            </span>
          </div>
          <div className="mt-2 space-y-1.5 text-[11px] text-fg2">
            {result.memoryMode === "automatic" && (
              <div className="flex items-start gap-2">
                <span className="text-muted select-none" aria-hidden="true">
                  ·
                </span>
                <span>支持自动分段与显存管理</span>
              </div>
            )}
            {result.memoryMode === "legacy" && (
              <div className="flex items-start gap-2">
                <span className="text-muted select-none" aria-hidden="true">
                  ·
                </span>
                <span>旧版内核，采用传统显存管理</span>
              </div>
            )}
            {result.autoFit === "on-off" && (
              <div className="flex items-start gap-2">
                <span className="text-muted select-none" aria-hidden="true">
                  ·
                </span>
                <span>支持自动设备分配</span>
              </div>
            )}
            {result.autoFit === "flag" && (
              <div className="flex items-start gap-2">
                <span className="text-muted select-none" aria-hidden="true">
                  ·
                </span>
                <span>旧版内核，仅支持基础自动适配</span>
              </div>
            )}
            {result.options.includes("--dgl-dir") && (
              <div className="flex items-start gap-2 text-fg">
                <span className="text-accent-hi select-none" aria-hidden="true">
                  ·
                </span>
                <span>DGL 架构内核，部分高级效果需通过 DGL 脚本配置，参考图预设建议保持自动</span>
              </div>
            )}
            {result.warnings.map((warning) => (
              <div
                key={warning}
                className="flex items-start gap-2 rounded-sm bg-warn-dim px-2 py-1 text-warn"
              >
                <span className="select-none font-mono" aria-hidden="true">
                  !
                </span>
                <span>{warning}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
