import { describe, expect, it } from "vitest";
import {
  computeGridLayout,
  computeVisibleRange,
  tilePosition,
} from "../virtualGrid";

describe("computeGridLayout", () => {
  it("fits as many min-tiles as width allows", () => {
    // width 500, min 88, gap 6 → floor(506/94)=5 列
    const layout = computeGridLayout(500, 100);
    expect(layout.cols).toBe(5);
    // 瓷砖均分剩余: (500 - 4*6) / 5
    expect(layout.tile).toBeCloseTo(95.2, 5);
    expect(layout.rows).toBe(20);
    expect(layout.totalHeight).toBeCloseTo(20 * (95.2 + 6) - 6, 5);
  });

  it("never exceeds item count and keeps at least one column", () => {
    const narrow = computeGridLayout(40, 100);
    expect(narrow.cols).toBe(1);
    const few = computeGridLayout(2000, 3);
    expect(few.cols).toBe(3);
    expect(few.rows).toBe(1);
  });

  it("clamps tile size so a single column always fits", () => {
    const tiny = computeGridLayout(30, 10);
    expect(tiny.tile).toBe(30);
    expect(tiny.rows).toBe(10);
  });

  it("handles empty inputs without division by zero", () => {
    expect(computeGridLayout(0, 10).rows).toBe(0);
    expect(computeGridLayout(500, 0).rows).toBe(0);
  });
});

describe("computeVisibleRange", () => {
  const layout = computeGridLayout(500, 100); // 5 列,20 行,rowH≈101.2

  it("covers the viewport with overscan", () => {
    const range = computeVisibleRange(layout, 500, 300, 2);
    // first 可见行 = floor(500/101.2)=4 → 减 2 → 2
    expect(range.start).toBe(2);
    const lastVisible = Math.ceil(800 / layout.rowH) + 2;
    expect(range.end).toBe(Math.min(19, lastVisible));
  });

  it("clamps to the first/last row", () => {
    expect(computeVisibleRange(layout, 0, 300).start).toBe(0);
    const bottom = computeVisibleRange(layout, 10_000_000, 300);
    expect(bottom.end).toBe(19);
  });

  it("returns empty range for empty layout", () => {
    const empty = computeGridLayout(0, 10);
    expect(computeVisibleRange(empty, 0, 300)).toEqual({ start: 0, end: 0 });
  });
});

describe("tilePosition", () => {
  it("lays tiles out row-major with gap spacing", () => {
    const layout = computeGridLayout(500, 100); // 5 列
    const first = tilePosition(layout, 0);
    expect(first).toEqual({ left: 0, top: 0 });
    const secondRowFirst = tilePosition(layout, 5);
    expect(secondRowFirst).toEqual({ left: 0, top: layout.rowH });
    const third = tilePosition(layout, 2);
    expect(third).toEqual({ left: 2 * layout.rowH, top: 0 });
  });
});
