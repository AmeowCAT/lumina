/**
 * 东方号 VOSTOK 主题典藏版海报样张：生成画布空态/推进中的精密构成主义版画。
 *
 * 设计语言：利西茨基（El Lissitzky）《以红楔攻打白军》的几何张力 ×
 * 拜科努尔/酒泉航天测控星历图。采用石版油墨黑底、奶油档案纸白球体、
 * 65.0° 倾角遥测青蓝轨道环、朱砂红主楔与氧化铁副楔，辅以精密经纬刻度与套准十字。
 * 纯装饰（aria-hidden），颜色全部绑定 CSS 变量。
 */
export function VostokPoster() {
  return (
    <svg viewBox="0 0 480 600" aria-hidden="true">
      {/* 石版印刷基底与内框发丝线 */}
      <rect width="480" height="600" style={{ fill: "var(--color-bg, #110e0b)" }} />
      <rect
        x="14"
        y="14"
        width="452"
        height="572"
        fill="none"
        strokeWidth="1"
        opacity="0.22"
        style={{ stroke: "var(--color-fg, #efeadd)" }}
      />

      {/* 顶部星历坐标网格线与十字准星 */}
      <line
        x1="14"
        y1="128"
        x2="466"
        y2="128"
        strokeWidth="0.75"
        strokeDasharray="3 5"
        opacity="0.2"
        style={{ stroke: "var(--color-fg, #efeadd)" }}
      />
      <line
        x1="352"
        y1="14"
        x2="352"
        y2="586"
        strokeWidth="0.75"
        strokeDasharray="3 5"
        opacity="0.2"
        style={{ stroke: "var(--color-fg, #efeadd)" }}
      />
      <g opacity="0.45" strokeWidth="1" style={{ stroke: "var(--color-steel, #50afb9)" }}>
        <line x1="72" y1="124" x2="72" y2="132" />
        <line x1="68" y1="128" x2="76" y2="128" />
        <line x1="210" y1="264" x2="210" y2="272" />
        <line x1="206" y1="268" x2="214" y2="268" />
      </g>

      {/* 奶油纸白天体与精密内环刻度 */}
      <circle cx="352" cy="128" r="88" style={{ fill: "var(--color-fg, #efeadd)" }} />
      <circle
        cx="352"
        cy="128"
        r="74"
        fill="none"
        strokeWidth="1"
        opacity="0.22"
        style={{ stroke: "var(--color-bg, #110e0b)" }}
      />
      <circle
        cx="352"
        cy="128"
        r="104"
        fill="none"
        strokeWidth="1"
        strokeDasharray="2 4"
        opacity="0.35"
        style={{ stroke: "var(--color-fg, #efeadd)" }}
      />

      {/* 双层遥测青蓝椭圆轨道环（-18° 倾角） */}
      <ellipse
        cx="244"
        cy="318"
        rx="288"
        ry="62"
        fill="none"
        strokeWidth="1.75"
        opacity="0.72"
        transform="rotate(-18 244 318)"
        style={{ stroke: "var(--color-steel, #50afb9)" }}
      />
      <ellipse
        cx="244"
        cy="318"
        rx="246"
        ry="44"
        fill="none"
        strokeWidth="0.9"
        strokeDasharray="6 6"
        opacity="0.45"
        transform="rotate(-18 244 318)"
        style={{ stroke: "var(--color-fg, #efeadd)" }}
      />

      {/* 构成主义几何卫星节点 */}
      <rect
        x="92"
        y="156"
        width="28"
        height="28"
        transform="rotate(18 106 170)"
        style={{ fill: "var(--color-accent, #cf3616)" }}
      />
      <circle cx="122" cy="236" r="7.5" style={{ fill: "var(--color-fg, #efeadd)" }} />
      <circle cx="404" cy="272" r="4" style={{ fill: "var(--color-go, #30c8cf)" }} />
      <circle cx="152" cy="378" r="2.5" style={{ fill: "var(--color-steel, #50afb9)" }} />

      {/* 主视觉：利西茨基朱砂红大楔形 + 铁锈红暗部副楔 */}
      <polygon
        points="14,586 14,356 466,468 466,586"
        style={{ fill: "var(--color-accent, #cf3616)" }}
      />
      <polygon points="14,586 14,518 466,586" style={{ fill: "var(--color-flow-end, #8c1d12)" }} />
      {/* 楔形前缘精密纸白平行翼条 */}
      <rect
        x="318"
        y="496"
        width="108"
        height="8"
        transform="skewX(-22)"
        style={{ fill: "var(--color-fg, #efeadd)" }}
      />
      <rect
        x="318"
        y="510"
        width="64"
        height="3"
        transform="skewX(-22)"
        opacity="0.7"
        style={{ fill: "var(--color-flow-start, #f9d280)" }}
      />

      {/* 左上工业版画标题栏 */}
      <text
        x="34"
        y="50"
        fontSize="9.5"
        style={{
          fontFamily: "var(--font-mono)",
          fill: "var(--color-muted, #9a9384)",
          letterSpacing: 3.5,
        }}
      >
        ВОСТОК-01 · 65.0° INC
      </text>
      <text
        x="34"
        y="84"
        fontSize="28"
        fontWeight={700}
        style={{
          fontFamily: "var(--font-display)",
          fill: "var(--color-fg, #efeadd)",
          letterSpacing: 5,
        }}
      >
        红楔入轨
      </text>
      <text
        x="36"
        y="106"
        fontSize="10.5"
        fontWeight={600}
        style={{
          fontFamily: "var(--font-mono)",
          fill: "var(--color-accent-hi, #ff7340)",
          letterSpacing: 3.6,
        }}
      >
        RED WEDGE · ORBIT-1
      </text>

      {/* 左下版画编号落款 */}
      <text
        x="34"
        y="566"
        fontSize="9.5"
        style={{
          fontFamily: "var(--font-mono)",
          fill: "var(--color-fg, #efeadd)",
          letterSpacing: 2.8,
        }}
      >
        LUMINA AEROSPACE ARCHIVE · PLATE NO. 01
      </text>
    </svg>
  );
}
