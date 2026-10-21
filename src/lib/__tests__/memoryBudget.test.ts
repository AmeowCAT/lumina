import { describe, expect, it } from "vitest";
import { MEMORY_BUDGET, MEMORY_BUDGET_TOTAL } from "../memoryBudget";

const MB = 1024 * 1024;

/**
 * 审查 20-frontend-arch §2.2：内存预算必须是**一本账**。
 * 这些断言的价值不在于数字本身，而在于：任何一层被悄悄调大、或新增一层忘记
 * 计入总和时，测试会失败。
 */
describe("memory budget ledger", () => {
  it("sums every tier into a single documented total", () => {
    const sum = Object.values(MEMORY_BUDGET).reduce((a, b) => a + b, 0);
    expect(MEMORY_BUDGET_TOTAL).toBe(sum);
    expect(sum).toBe(1664 * MB);
  });

  it("stays under the 1.75 GiB ceiling for the renderer", () => {
    expect(MEMORY_BUDGET_TOTAL).toBeLessThanOrEqual(1792 * MB);
  });

  it("keeps every tier positive and the results tier the largest", () => {
    for (const [, bytes] of Object.entries(MEMORY_BUDGET)) {
      expect(bytes).toBeGreaterThan(0);
    }
    expect(MEMORY_BUDGET.results).toBeGreaterThan(MEMORY_BUDGET.galleryFull);
    expect(MEMORY_BUDGET.results).toBeGreaterThan(MEMORY_BUDGET.galleryVideos);
  });
});
