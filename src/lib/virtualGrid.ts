/**
 * 历史画廊虚拟滚动的纯函数布局计算。
 * 网格规则与 CSS `repeat(auto-fill, minmax(minTile, 1fr))` + gap 一致:
 * 列数 = 容器宽度内最多能放下的 minTile 数,瓷砖宽度均分剩余空间。
 * 独立于 DOM,便于单元测试。
 */

export interface GridLayoutOpts {
  /** 瓷砖最小边长(px),与 CSS minmax 一致 */
  minTile?: number;
  /** 网格间距(px) */
  gap?: number;
}

export interface GridLayout {
  cols: number;
  /** 正方形瓷砖边长(px) */
  tile: number;
  rows: number;
  /** 完整网格的虚拟总高度(px) */
  totalHeight: number;
  /** 单行高度(瓷砖 + 间距) */
  rowH: number;
  gap: number;
}

export function computeGridLayout(
  width: number,
  count: number,
  opts: GridLayoutOpts = {}
): GridLayout {
  const minTile = opts.minTile ?? 88;
  const gap = opts.gap ?? 6;
  if (width <= 0 || count <= 0) {
    return { cols: 0, tile: minTile, rows: 0, totalHeight: 0, rowH: minTile + gap, gap };
  }
  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (minTile + gap))));
  const tile = Math.max(24, (width - (cols - 1) * gap) / cols);
  const rows = Math.ceil(count / cols);
  const rowH = tile + gap;
  return { cols, tile, rows, totalHeight: Math.max(0, rows * rowH - gap), rowH, gap };
}

export interface VisibleRange {
  start: number;
  end: number;
}

/** 视口覆盖的行区间(含 overscan 行缓冲),端点为闭区间行号 */
export function computeVisibleRange(
  layout: GridLayout,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = 2
): VisibleRange {
  if (layout.rows === 0 || layout.rowH <= 0) return { start: 0, end: 0 };
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / layout.rowH) - overscanRows
  );
  const lastRow = Math.min(
    layout.rows - 1,
    Math.ceil((scrollTop + viewportHeight) / layout.rowH) + overscanRows
  );
  // 滚过内容底部时把 start 也钉在末行,保持 start <= end 不变量
  const start = Math.min(firstRow, lastRow);
  return { start, end: Math.max(start, lastRow) };
}

export interface TilePosition {
  left: number;
  top: number;
}

/** 第 index 个瓷砖在虚拟网格内的绝对坐标(px) */
export function tilePosition(layout: GridLayout, index: number): TilePosition {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { left: col * layout.rowH, top: row * layout.rowH };
}
