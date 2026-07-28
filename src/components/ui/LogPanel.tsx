import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import { DEFAULT_SD_PORT, formatError } from "../../lib/utils";

/**
 * 底部可折叠的服务器日志面板。sd-server 的 stdout/stderr 由后端逐行捕获、
 * 通过 `server-log` 事件推送到 store.logs，这里负责展示。
 * 折叠时只显示标题 + 最新一行；展开时显示完整滚动日志并自动滚到底。
 */
export function LogPanel() {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const toast = useStore((s) => s.toast);
  const serverStatus = useStore((s) => s.serverStatus);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const external = serverStatus?.external ?? false;

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  const last = logs[logs.length - 1] || "（暂无日志）";

  // 停止 sd-server 进程（=卸载模型/释放显存），并立即切回首页重新选模型。
  const onStop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const result = await api.stopServer();
      if (!result.stopped) throw new Error("服务器未确认停止");
      useStore.setState({
        caps: null,
        serverStatus: {
          running: false,
          reachable: false,
          external: false,
          pid: null,
          model: "",
          sdPort: serverStatus?.sdPort ?? DEFAULT_SD_PORT,
        },
      });
      toast(result.alreadyStopped ? "服务器已经停止" : "服务器已停止");
    } catch (error) {
      toast(`停止服务器失败: ${formatError(error)}`, true);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className={`log-panel${open ? " open" : ""}`}>
      <div className="log-head">
        <button
          type="button"
          className="log-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="log-title">服务器日志</span>
          {!open && <span className="log-last">{last}</span>}
        </button>
        {open && (
          <>
            <button
              className="log-clear"
              aria-label="清空服务器日志"
              onClick={clearLogs}
            >
              清空
            </button>
            {!external && (
              <button
                className="log-stop"
                aria-label="停止服务器"
                onClick={onStop}
                disabled={stopping}
              >
                {stopping ? "停止中…" : "停止服务"}
              </button>
            )}
          </>
        )}
        <span className="log-count" aria-label={`${logs.length} 条日志`}>
          {logs.length}
        </span>
        <span className="log-chevron" aria-hidden="true">
          {open ? "▼" : "▲"}
        </span>
      </div>
      {open && (
        <div
          id={bodyId}
          className="log-body"
          ref={bodyRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          tabIndex={0}
        >
          {logs.length === 0 ? (
            <div className="log-empty">等待日志…</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="log-line">
                {l}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
