import { memo, useRef } from "react";
import { ArrowLeft, Layers, SlidersHorizontal } from "lucide-react";
import type { GenMode } from "../../types";
import { useTheme } from "../../lib/theme";
import { cn } from "../ui/cn";

export type WorkspaceTab = "results" | "history";

/** VOSTOK 测控台徽记：构成主义纸白圆月、遥测青蓝轨道与朱砂红楔。 */
function WedgeOrbitMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="16.5" cy="7" r="3.2" style={{ fill: "var(--color-fg, #efeadd)" }} />
      <ellipse
        cx="12"
        cy="13"
        rx="9.5"
        ry="3"
        fill="none"
        strokeWidth="1.2"
        transform="rotate(-18 12 13)"
        style={{ stroke: "var(--color-steel, #50afb9)" }}
      />
      <polygon points="2,22 2,14.5 22,19 22,22" style={{ fill: "var(--color-accent, #cf3616)" }} />
    </svg>
  );
}

/** 墨曜暗室徽记：精密中画幅取景框与光圈十字。 */
function StudioApertureMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="15"
        height="15"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
        opacity="0.7"
      />
      <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="10" r="1.2" style={{ fill: "var(--color-accent, #4c82f7)" }} />
    </svg>
  );
}

interface Props {
  modelLabel: string;
  modelTitle: string;
  familyLabel?: string;
  mode: GenMode;
  supportedModes: GenMode[];
  workspaceTab: WorkspaceTab;
  dreamText: string;
  queueOpen: boolean;
  activeJobs: number;
  sheetOpen: boolean;
  onSwitchMode: (m: GenMode) => void;
  onSwitchWorkspaceTab: (tab: WorkspaceTab) => void;
  onToggleQueue: () => void;
  onToggleSheet: () => void;
  onOpenDashboard: () => void;
}

export const HeaderBar = memo(function HeaderBar({
  modelLabel,
  modelTitle,
  familyLabel,
  mode,
  supportedModes,
  workspaceTab,
  dreamText,
  queueOpen,
  activeJobs,
  sheetOpen,
  onSwitchMode,
  onSwitchWorkspaceTab,
  onToggleQueue,
  onToggleSheet,
  onOpenDashboard,
}: Props) {
  const theme = useTheme();
  // tab 键盘模式与 APG 对齐：方向键切换时焦点跟随移动（roving tabindex
  // 下不移焦点会让焦点停在已被 tabindex=-1 的旧 tab 上）。
  const modeTabRefs = useRef<Partial<Record<GenMode, HTMLButtonElement | null>>>({});
  const workspaceTabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>({});

  const switchWorkspaceByKey = (key: string) => {
    if (key !== "ArrowLeft" && key !== "ArrowRight") return false;
    const next: WorkspaceTab = workspaceTab === "results" ? "history" : "results";
    onSwitchWorkspaceTab(next);
    workspaceTabRefs.current[next]?.focus();
    return true;
  };

  return (
    <header className="header">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-ghost shrink-0"
          onClick={onOpenDashboard}
          aria-label="前往控制台更换模型或修改设置"
          title="前往控制台更换模型或修改设置"
        >
          <ArrowLeft size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>控制台</span>
        </button>
        <span className="header-divider" aria-hidden="true" />
        <div className="header-logo hidden sm:flex">
          {theme === "vostok" ? (
            <>
              <WedgeOrbitMark />
              <span className="brand-zh">测控台</span>
              <span className="brand-en">CONTROL</span>
            </>
          ) : (
            <>
              <StudioApertureMark />
              <span className="brand-zh">暗室</span>
              <span className="brand-en">STUDIO</span>
            </>
          )}
        </div>
        <div className="header-model min-w-0" title={modelTitle}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
          <span className="truncate text-fg">{modelLabel}</span>
          {familyLabel && (
            <span className="hidden shrink-0 border-l border-line pl-2 text-[10px] tracking-[0.04em] text-muted xl:inline">
              {familyLabel}
            </span>
          )}
        </div>
        {dreamText && (
          <span className="header-dream" role="status">
            <span
              className="spinner"
              style={{ width: 11, height: 11, borderWidth: 1.5 }}
              aria-hidden="true"
            />
            <span>{dreamText}</span>
          </span>
        )}
      </div>

      <div className="header-spacer" />

      <div
        className="mode-tabs shrink-0"
        role="tablist"
        aria-label="工作区视图"
        onKeyDown={(e) => {
          if (switchWorkspaceByKey(e.key)) e.preventDefault();
        }}
      >
        <button
          ref={(el) => {
            workspaceTabRefs.current.results = el;
          }}
          type="button"
          id="workspace-tab-results"
          role="tab"
          aria-selected={workspaceTab === "results"}
          aria-controls="workspace-panel-results"
          tabIndex={workspaceTab === "results" ? 0 : -1}
          className={cn("mode-tab", workspaceTab === "results" && "active")}
          onClick={() => onSwitchWorkspaceTab("results")}
        >
          当前结果
        </button>
        <button
          ref={(el) => {
            workspaceTabRefs.current.history = el;
          }}
          type="button"
          id="workspace-tab-history"
          role="tab"
          aria-selected={workspaceTab === "history"}
          aria-controls="workspace-panel-history"
          tabIndex={workspaceTab === "history" ? 0 : -1}
          className={cn("mode-tab", workspaceTab === "history" && "active")}
          onClick={() => onSwitchWorkspaceTab("history")}
        >
          {theme === "vostok" ? "回传档案" : "历史画廊"}
        </button>
      </div>

      <div className="header-spacer" />

      <div className="flex shrink-0 items-center gap-1.5">
        {supportedModes.length > 0 && (
          <>
            <div
              className="mode-tabs"
              role="tablist"
              aria-label="生成模式"
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                const idx = supportedModes.indexOf(mode);
                const next =
                  e.key === "ArrowRight"
                    ? (idx + 1) % supportedModes.length
                    : (idx - 1 + supportedModes.length) % supportedModes.length;
                onSwitchMode(supportedModes[next]);
                modeTabRefs.current[supportedModes[next]]?.focus();
              }}
            >
              {supportedModes.map((m) => (
                <button
                  key={m}
                  ref={(el) => {
                    modeTabRefs.current[m] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  tabIndex={mode === m ? 0 : -1}
                  className={cn("mode-tab", mode === m && "active")}
                  onClick={() => onSwitchMode(m)}
                >
                  {m === "img_gen" ? "图片" : "视频"}
                </button>
              ))}
            </div>
            <span className="header-divider" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className={cn("btn btn-sm btn-ghost queue-toggle", queueOpen && "active")}
          onClick={onToggleQueue}
          aria-expanded={queueOpen}
          aria-label="切换任务队列面板"
          title="任务队列"
        >
          <Layers size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>队列</span>
          {activeJobs > 0 && <span className="queue-badge">{activeJobs}</span>}
        </button>
        <button
          type="button"
          className={cn("btn btn-sm btn-ghost queue-toggle", sheetOpen && "active")}
          onClick={onToggleSheet}
          aria-expanded={sheetOpen}
          aria-label="打开参数面板"
          title="生成参数（Ctrl+,）"
        >
          <SlidersHorizontal size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>参数</span>
          <span className="kbd hidden lg:inline-block">Ctrl+,</span>
        </button>
      </div>
    </header>
  );
});
