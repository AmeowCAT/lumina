import { memo } from "react";
import type { GenMode } from "../../types";
import { useTheme } from "../../lib/theme";
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

/** VOSTOK 工作台徽记:海报母题微缩——纸白圆月、青蓝轨道、朱砂楔形。
 *  品牌已由自绘标题栏承载,第二栏不再重复 logo,改挂"当前所在"的场所标识。 */
function WedgeOrbitMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="16.5" cy="7" r="3.4" style={{ fill: "var(--color-fg, #eeead8)" }} />
      <ellipse
        cx="12" cy="13" rx="10" ry="3.2" fill="none" strokeWidth="1.1" opacity="0.8"
        transform="rotate(-18 12 13)"
        style={{ stroke: "var(--color-steel, #50afb9)" }}
      />
      <polygon
        points="2,22 2,14 22,19 22,22"
        style={{ fill: "var(--color-accent, #cf3616)" }}
      />
    </svg>
  );
}

/** 暗房主题的场所徽记:安全灯——暗房里那盏长明的琥珀灯(与 Dashboard orb 同源)。 */
function SafelightMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle
        cx="12" cy="12" r="8.5" strokeWidth="1" opacity="0.4"
        style={{ stroke: "var(--color-accent-hi, #f0c26b)" }}
      />
      <circle cx="12" cy="12" r="4.5" style={{ fill: "var(--color-accent, #d9a441)" }} />
      <circle cx="10.3" cy="10.3" r="1.5" style={{ fill: "var(--color-flow-start, #f5d78e)" }} />
    </svg>
  );
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
  const theme = useTheme();
  return (
    <header className="header">
      <div className="header-logo">
        {theme === "vostok" ? (
          <>
            <WedgeOrbitMark />
            <span className="brand-zh">工作室</span>
            <span className="brand-en">STUDIO</span>
          </>
        ) : (
          <>
            <SafelightMark />
            <span className="brand-zh">暗房</span>
            <span className="brand-en">DARKROOM</span>
          </>
        )}
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
