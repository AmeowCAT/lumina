import { useId } from "react";

/**
 * 流光 Lumina 品牌图标（内联 SVG）。三道 teal→cyan→靛 的流光弧 + 发光节点，
 * 深色圆角底，呼应"流光"与应用的青绿（teal）强调色主题。
 *
 * 用 `useId` 给渐变分配唯一 id，避免同页多实例时 `url(#...)` 撞车。
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
          <stop stopColor="#1a1e28" />
          <stop offset="1" stopColor="#0d0f14" />
        </linearGradient>
        <linearGradient id={flow} x1="12" y1="54" x2="52" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2dd4bf" />
          <stop offset="0.5" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
        <radialGradient id={spark} cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#5eead4" />
          <stop offset="1" stopColor="#14b8a6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${bg})`} />
      <rect
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
          stroke="#14b8a6"
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
      <circle cx="49" cy="17" r="2.6" fill="#ffffff" />
    </svg>
  );
}
