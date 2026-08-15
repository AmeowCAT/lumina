import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { api } from "./api";
import { useStore, type LogEvent } from "./store";
import { Dashboard } from "./components/dashboard/Dashboard";
import { GenerationUI } from "./components/generation/GenerationUI";
import { LogPanel } from "./components/ui/LogPanel";
import { Logo } from "./components/ui/Logo";
import { ToastContainer } from "./components/ui/Toast";
import { useJobPolling } from "./hooks/useJobPolling";
import { useSystemIntegration } from "./hooks/useSystemIntegration";

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
  const lastCapsErrorToast = useRef(0);

  // 任务轮询挂在整个 App 生命周期（而非 GenerationUI）：切到控制台改设置
  // 期间任务仍在服务器上跑，停止轮询会让完成的结果无人收货、随服务器
  // 停止永久丢失（对抗性审查 B3）。
  useJobPolling();
  // 任务栏进度等系统级集成（进度订阅内部自行收敛，不触发额外渲染）。
  useSystemIntegration();

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
              // current_mode 是服务器启动时的静态默认值（上游 routes_sdcpp.cpp），
              // 只在首次接入/服务器切换时同步到 UI。周期性 30s 刷新若照搬会把
              // 用户手动切到的 vid_gen 静默拉回 img_gen。
              if (c.current_mode && (!hadCaps || identityChanged)) setMode(c.current_mode);
              if (!hadCaps || identityChanged) {
                const label = s.external
                  ? "检测到外部 sd-server — " + (c.model?.name || "")
                  : "服务器就绪 — " + (c.model?.name || "");
                toast(label);
              }
            } catch {
              // 服务器可达但能力信息反复失败：给用户可见的提示（30s 节流），
              // 而不是静默卡在控制台（对抗性审查 B6）。
              const now = Date.now();
              if (now - lastCapsErrorToast.current > 30_000) {
                lastCapsErrorToast.current = now;
                toast("无法获取服务器能力信息，服务器可能仍在加载", true);
              }
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
  // `\r` 分隔（进度条）→ 进度行原地刷新最后一行；`\n` 分隔（普通日志）→ 追加。
  // 生成期间每步都会触发事件：按 requestAnimationFrame 聚合成一次 store
  // 写入（flushLogs），避免每个事件都触发一次与日志行数成正比的重渲染。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // 单队列保序：旧实现把 line/progress 分容器收集，flush 时先 line 后
    // progress，同帧内到达顺序相反时合并结果与逐条处理不一致（审查 P4e）。
    const pendingEvents: LogEvent[] = [];
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      const events = pendingEvents.splice(0);
      useStore.getState().flushLogs(events);
    };
    listen<{ type: string; text: string }>("server-log", (e) => {
      const p = e.payload;
      pendingEvents.push(
        p.type === "progress"
          ? { type: "progress", text: p.text }
          : { type: "line", text: p.text }
      );
      if (rafId == null) rafId = requestAnimationFrame(flush);
    }).then((f) => {
      if (disposed) {
        f();
        if (rafId != null) cancelAnimationFrame(rafId);
      } else {
        unlisten = f;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        flush();
      }
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
        <div className="splash">
          <motion.div
            className="splash-card"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <Logo size={44} />
            <h1 className="wordmark">流光</h1>
            <div className="hero-en">LUMINA STUDIO</div>
            <span className="orb ready splash-orb" aria-hidden="true" />
            <div className="splash-status" role="status">
              <span className="spinner" />
              <span>正在检查启动器和服务器状态</span>
            </div>
          </motion.div>
        </div>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="app">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={phase}
          className="app-view"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {phase === "running" ? <GenerationUI /> : <Dashboard />}
        </motion.div>
      </AnimatePresence>
      <LogPanel />
      <ToastContainer />
    </div>
  );
}
