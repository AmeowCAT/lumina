/**
 * 东方号 VOSTOK 主题装饰素材:生成画布空态/推进中的海报样张。
 * 图样复刻东方号主题预览稿的「红楔入轨」
 * 占位海报(构成主义太空海报:纸白圆月、-18° 青蓝轨道、朱砂主楔 + 锈红副楔)。
 * 颜色全部读 CSS 变量并带 v3 色板兜底值,主题换板自动跟随;
 * 纯装饰(aria-hidden),不承载交互。
 */
export function VostokPoster() {
  return (
    <svg viewBox="0 0 480 600" aria-hidden="true">
      <rect width="480" height="600" style={{ fill: "var(--color-bg, #110e0b)" }} />
      <circle cx="356" cy="128" r="98" style={{ fill: "var(--color-fg, #eeead8)" }} />
      <circle
        cx="356" cy="128" r="98" fill="none" strokeWidth="3" opacity="0.15"
        style={{ stroke: "var(--color-bg, #110e0b)" }}
      />
      <ellipse
        cx="240" cy="330" rx="300" ry="66" fill="none" strokeWidth="2" opacity="0.55"
        transform="rotate(-18 240 330)"
        style={{ stroke: "var(--color-steel, #50afb9)" }}
      />
      <polygon
        points="0,600 0,352 480,470 480,600"
        style={{ fill: "var(--color-accent, #cf3616)" }}
      />
      <polygon
        points="0,600 0,540 480,600"
        style={{ fill: "var(--color-flow-end, #9b2014)" }}
      />
      <rect
        x="88" y="120" width="34" height="34" transform="rotate(18 105 137)"
        style={{ fill: "var(--color-accent, #cf3616)" }}
      />
      <circle cx="118" cy="212" r="9" style={{ fill: "var(--color-fg, #eeead8)" }} />
      <circle cx="60" cy="90" r="2.5" style={{ fill: "var(--color-steel, #50afb9)" }} />
      <circle cx="420" cy="330" r="2.5" style={{ fill: "var(--color-steel, #50afb9)" }} />
      <circle cx="200" cy="70" r="2" opacity="0.7" style={{ fill: "var(--color-fg, #eeead8)" }} />
      <circle cx="392" cy="412" r="2" opacity="0.7" style={{ fill: "var(--color-fg, #eeead8)" }} />
      <circle cx="150" cy="420" r="2" opacity="0.8" style={{ fill: "var(--color-steel, #50afb9)" }} />
      <rect
        x="330" y="500" width="110" height="10" transform="skewX(-24)" opacity="0.9"
        style={{ fill: "var(--color-fg, #eeead8)" }}
      />
      <text
        x="36" y="76" fontSize="30" fontWeight={700}
        style={{
          fontFamily: "var(--font-display)",
          fill: "var(--color-fg, #eeead8)",
          letterSpacing: 6,
        }}
      >
        红楔入轨
      </text>
      <text
        x="38" y="100" fontSize="11"
        style={{
          fontFamily: "var(--font-mono)",
          fill: "var(--color-accent-hi, #fb6c2b)",
          letterSpacing: 4,
        }}
      >
        RED WEDGE · ORBIT-1
      </text>
    </svg>
  );
}
