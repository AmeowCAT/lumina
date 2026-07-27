import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { useStore } from "./store";
import { Dashboard } from "./components/dashboard/Dashboard";
import { GenerationUI } from "./components/generation/GenerationUI";
import { LogPanel } from "./components/ui/LogPanel";
import { ToastContainer } from "./components/ui/Toast";

type Phase = "checking" | "dashboard" | "running";

export default function App() {
  const [phase, setPhase] = useState<Phase>("checking");
  const serverStatus = useStore((s) => s.serverStatus);
  const dashboardOpen = useStore((s) => s.dashboardOpen);
  const setServerStatus = useStore((s) => s.setServerStatus);
  const setCaps = useStore((s) => s.setCaps);
  const setMode = useStore((s) => s.setMode);
  const toast = useStore((s) => s.toast);
  const lastCapsSync = useRef(0);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const s = await api.serverStatus();
        if (!alive) return;
        // De-dupe: skip setState when nothing actually changed. The poll passes
        // a fresh object every 3s; without this guard zustand treats it as a
        // change and forces a Dashboard re-render → layout reflow, which closes
        // any open <select> dropdown in WebView2/Chromium (the "flicker & close"
        // bug). Only re-render when a meaningful field differs.
        const prev = useStore.getState().serverStatus;
        if (
          !prev ||
          prev.running !== s.running ||
          prev.reachable !== s.reachable ||
          prev.external !== s.external ||
           prev.pid !== s.pid ||
           prev.model !== s.model ||
           prev.phase !== s.phase ||
           prev.lastError !== s.lastError ||
           prev.startedAt !== s.startedAt
        ) {
          setServerStatus(s);
        }
        // Accept both managed and externally-launched servers
        if (s.reachable) {
          let c = useStore.getState().caps;
          const identityChanged =
            !!prev &&
            (prev.startedAt !== s.startedAt ||
              (!!prev.model && !!s.model && prev.model !== s.model));
          const shouldRefreshCaps =
            !c || identityChanged || Date.now() - lastCapsSync.current > 30_000;
          if (identityChanged) {
            setCaps(null);
            c = null;
          }
          if (shouldRefreshCaps) {
            try {
              const hadCaps = !!c;
              c = await api.sdcppCapabilities();
              if (!alive) return;
              setCaps(c);
              lastCapsSync.current = Date.now();
              if (c.current_mode) setMode(c.current_mode);
              if (!hadCaps || identityChanged) {
                const label = s.external
                  ? "检测到外部 sd-server — " + (c.model?.name || "")
                  : "服务器就绪 — " + (c.model?.name || "");
                toast(label);
              }
            } catch {
              /* server still loading */
            }
          }
          // Only enter running once caps are available — otherwise GenerationUI
          // returns null (no params) and the screen is blank.
          if (c && !useStore.getState().dashboardOpen) setPhase("running");
        } else {
          if (useStore.getState().caps) {
            setCaps(null);
            toast("与服务器的连接已断开", true);
          }
          setPhase("dashboard");
        }
      } catch {
        if (alive) setPhase((p) => (p === "checking" ? "dashboard" : p));
      }
    };
    check();
    const iv = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [setServerStatus, setCaps, setMode, toast]);

  useEffect(() => {
    if (dashboardOpen) setPhase("dashboard");
    else if (serverStatus?.reachable && useStore.getState().caps) setPhase("running");
  }, [dashboardOpen, serverStatus?.reachable]);

  // 订阅 sd-server 的 stdout/stderr 日志流，推入 store 供内置日志面板展示。
  // `\r` 分隔（进度条）→ updateProgress 原地刷新最后一行；
  // `\n` 分隔（普通日志）→ appendLog 追加新行。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<{ type: string; text: string }>("server-log", (e) => {
      const p = e.payload;
      if (p.type === "progress") useStore.getState().updateProgress(p.text);
      else useStore.getState().appendLog(p.text);
    }).then((f) => {
      if (disposed) f();
      else unlisten = f;
    });
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);

  // 服务器停掉后立即切回首页（不必等 3 秒轮询）。
  // external 的 running 恒为 false（它不是我们 spawn 的子进程），
  // 不能据此切回首页——否则接管外部 sd-server 时会和 check() 的
  // setPhase("running") 每 3 秒来回震荡。
  useEffect(() => {
    if (
      serverStatus &&
      !serverStatus.running &&
      !serverStatus.external &&
      phase === "running"
    ) {
      setPhase("dashboard");
    }
  }, [serverStatus, phase]);

  if (phase === "checking") {
    return (
      <div className="app">
        <div className="dashboard dashboard-single">
          <div className="dashboard-card" style={{ textAlign: "center" }}>
            <span
              className="spinner"
              style={{ width: 32, height: 32, borderWidth: 3 }}
            />
            <h2 style={{ marginTop: 16 }}>连接中...</h2>
            <p style={{ color: "var(--color-muted)", fontSize: 13 }}>
              正在检查启动器和服务器状态
            </p>
          </div>
        </div>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="app">
      {phase === "running" ? <GenerationUI /> : <Dashboard />}
      <LogPanel />
      <ToastContainer />
    </div>
  );
}
