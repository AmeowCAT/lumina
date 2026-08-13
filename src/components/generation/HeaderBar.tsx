import { memo } from "react";
import type { GenMode } from "../../types";
import { Logo } from "../ui/Logo";
import { cn } from "../ui/cn";

interface Props {
  modelLabel: string;
  modelTitle: string;
  mode: GenMode;
  supportedModes: GenMode[];
  dreamText: string;
  onSwitchMode: (m: GenMode) => void;
  onOpenDashboard: () => void;
}

export const HeaderBar = memo(function HeaderBar({
  modelLabel,
  modelTitle,
  mode,
  supportedModes,
  dreamText,
  onSwitchMode,
  onOpenDashboard,
}: Props) {
  return (
    <header className="header">
      <div className="header-logo">
        <Logo size={22} />
        <span className="brand-zh">流光</span>
        <span className="brand-en">Lumina</span>
      </div>
      <div className="header-model">
        <span title={modelTitle}>{modelLabel}</span>
      </div>
      {dreamText && (
        <span className="header-dream" role="status">
          ◐ {dreamText}
        </span>
      )}
      <div className="header-spacer" />
      <button
        className="btn btn-sm"
        onClick={onOpenDashboard}
        aria-label="前往控制台更换模型或修改设置"
      >
        更换模型 / 设置
      </button>
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
        }}
      >
        {supportedModes.map((m) => (
          <button
            key={m}
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
    </header>
  );
});
