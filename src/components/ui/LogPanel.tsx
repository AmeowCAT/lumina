import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import { logSeverity } from "../../lib/logFormat";
import { DEFAULT_SD_PORT, formatError } from "../../lib/utils";
import { IC } from "./Icons";
import { TwoTapButton } from "./TwoTapButton";

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
  // 标量 selector：订阅整个 jobs 数组会让日志面板在生成期间每 2 秒重渲染。
  const activeCount = useStore(
    (s) =>
      s.jobs.filter(
        (j) => j.status === "queued" || j.status === "generating" || j.status === "unknown",
      ).length,
  );
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

  const last = logs[logs.length - 1]?.text || "（暂无日志）";

  /** 一键复制全部日志：README 让用户「先看日志面板」，但此前只能截图（审查 99 §5.4）。 */
  const copyAll = async () => {
    const text = useStore
      .getState()
      .logs.map((l) => l.text)
      .join("\n");
    if (!text) {
      toast("暂无日志可复制");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${logs.length} 行日志`);
    } catch {
      toast("复制失败：当前环境不允许访问剪贴板", true);
    }
  };

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
            <button className="log-clear" aria-label="清空服务器日志" onClick={clearLogs}>
              清空
            </button>
            <button
              className="log-clear"
              aria-label="复制全部服务器日志到剪贴板"
              title="复制全部日志（报 issue 时贴这个，比截图有用）"
              onClick={() => void copyAll()}
            >
              复制
            </button>
            {!external && (
              <TwoTapButton
                className="log-stop"
                label="停止服务器"
                armedLabel={`确认停止（${activeCount} 个任务将丢失）`}
                armedTitle="停止服务器会卸载模型并丢失进行中的任务，再次点击确认"
                needsConfirm={activeCount > 0}
                onConfirm={() => {
                  if (!stopping) void onStop();
                }}
                disabled={stopping}
                idle={stopping ? "停止中…" : "停止服务"}
                armed="确认?"
              />
            )}
          </>
        )}
        <span className="log-count" aria-label={`${logs.length} 条日志`}>
          {logs.length}
        </span>
        <span className="log-chevron" aria-hidden="true">
          {IC.chev}
        </span>
      </div>
      {open && (
        <div
          id={bodyId}
          className="log-body"
          ref={bodyRef}
          role="log"
          aria-live="off"
          aria-relevant="additions text"
          tabIndex={0}
        >
          {logs.length === 0 ? (
            <div className="log-empty">等待日志…</div>
          ) : (
            logs.map((l) => {
              const severity = logSeverity(l.text);
              return (
                <div
                  key={l.id}
                  className={
                    "log-line" +
                    (severity === "error" ? " log-err" : severity === "warn" ? " log-warn" : "")
                  }
                >
                  {l.text}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
