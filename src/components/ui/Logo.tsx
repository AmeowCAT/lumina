import { useTheme } from "../../lib/theme";
import { cn } from "./cn";

/**
 * 流光 Lumina 品牌徽章（内联 SVG，随双主题切换几何母题）：
 * - 墨曜 · 暗室（lumina）：精密光学镜头筒（右上 54° 校准缺口）+ 中心光圈环 + 光学钴蓝对齐点。
 * - 东方号 VOSTOK（vostok）：苏联构成主义「红楔击穿白环」× 东方一号轨道遥测几何徽章。
 * 零渐变、零辉光，全部读取主题 CSS 变量。
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  const theme = useTheme();
  const isVostok = theme === "vostok";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="流光 Lumina"
      role="img"
    >
      <rect
        className="logo-rect-bg"
        width="64"
        height="64"
        rx={isVostok ? "4" : "14"}
        fill="var(--color-logo-bg, #1c1e22)"
      />
      <rect
        className="logo-rect-frame"
        x="1"
        y="1"
        width="62"
        height="62"
        rx={isVostok ? "3" : "13"}
        stroke="var(--color-logo-border, rgb(255 255 255 / 0.14))"
        strokeWidth="1.5"
      />
      {isVostok ? (
        <>
          {/* 构成主义十字基准刻度线 */}
          <path
            d="M35 9V14M35 52V57M12 33H17M53 33H58"
            stroke="var(--color-logo-fg, #efeadd)"
            strokeOpacity="0.35"
            strokeWidth="1.5"
          />
          {/* 东方一号轨道环 */}
          <circle
            cx="35"
            cy="33"
            r="16.5"
            stroke="var(--color-logo-fg, #efeadd)"
            strokeWidth="3.2"
          />
          {/* 李西茨基红楔（Red Wedge in Orbit）刺入轨道中心 */}
          <polygon points="10,12 39,26 23,41" fill="var(--color-logo-accent, #cf3616)" />
          {/* 远地点轨道遥测星点 */}
          <circle cx="49.5" cy="16.5" r="3" fill="var(--color-go, #30c8cf)" />
        </>
      ) : (
        <>
          <path
            d="M49.59 26.28A18.5 18.5 0 1 1 37.72 14.41"
            stroke="var(--color-logo-fg, #f2f3f5)"
            strokeWidth="3.8"
            strokeLinecap="round"
          />
          <circle
            cx="32"
            cy="32"
            r="7.5"
            stroke="var(--color-logo-fg, #f2f3f5)"
            strokeWidth="3.4"
          />
          <circle cx="45.08" cy="18.92" r="3.6" fill="var(--color-logo-accent, #5b8def)" />
        </>
      )}
    </svg>
  );
}
