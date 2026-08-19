import { useId } from "react";

/**
 * 流光 Lumina 品牌图标（内联 SVG)。三道淡金→金→赭的流光弧 + 发光节点,
 * 深色圆角底,呼应"暗房金光"主题的安全灯琥珀色。
 *
 * 用 `useId` 给渐变分配唯一 id,避免同页多实例时 `url(#...)` 撞车。
 * 徽章底色/圆角读 CSS 变量(--color-logo-bg-*, --logo-rx),主题可覆写;
 * 流光弧读 --color-flow-start/--color-accent/--color-flow-end,随主题换色。
 */
export function Logo({ size = 28 }: { size?: number }) {
  const uid = useId().replace(/:/g, "");
  const bg = `${uid}-bg`;
  const flow = `${uid}-flow`;
  const spark = `${uid}-spark`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="流光 Lumina"
      role="img"
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--color-logo-bg-hi, #221c12)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-logo-bg-lo, #100d09)" }} />
        </linearGradient>
        <linearGradient id={flow} x1="12" y1="54" x2="52" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-flow-start)" />
          <stop offset="0.5" stopColor="var(--color-accent)" />
          <stop offset="1" stopColor="var(--color-flow-end)" />
        </linearGradient>
        <radialGradient id={spark} cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#fff8e6" />
          <stop offset="0.45" stopColor="var(--color-flow-start)" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect className="logo-rect-bg" width="64" height="64" rx="15" fill={`url(#${bg})`} />
      <rect
        className="logo-rect-frame"
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx="14.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.08"
      />
      <g fill="none" strokeLinecap="round">
        <path
          d="M15 47 C 22 33, 31 27, 49 17"
          stroke="var(--color-accent)"
          strokeOpacity="0.22"
          strokeWidth="11"
        />
        <path d="M15 47 C 22 33, 31 27, 49 17" stroke={`url(#${flow})`} strokeWidth="6" />
        <path
          d="M17 53 C 27 43, 37 36, 51 29"
          stroke={`url(#${flow})`}
          strokeWidth="3.5"
          strokeOpacity="0.85"
        />
        <path
          d="M22 55 C 32 50, 41 45, 53 39"
          stroke={`url(#${flow})`}
          strokeWidth="2"
          strokeOpacity="0.5"
        />
      </g>
      <circle cx="49" cy="17" r="7" fill={`url(#${spark})`} />
      <circle cx="49" cy="17" r="2.6" fill="#fff8e6" />
    </svg>
  );
}
