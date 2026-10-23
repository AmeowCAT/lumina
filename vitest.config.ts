import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // 单例默认 5s 对重组件偏紧：渲染整个 Dashboard 的用例本地约 1–2s，
    // CI 的 Windows runner 约慢 45%（实测同一文件 12.3s → 17.9s），再叠加
    // 首次动态导入就可能越过 5s。放宽到 20s 只影响"慢"，不影响"错"。
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      // 覆盖率只统计产品代码：测试自身、测试环境垫片与纯类型文件不参与
      // （审查 60-build-test §2.12：此前没有任何覆盖率口径）。
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/__tests__/**", "src/test/**", "src/types.ts"],
      // 门禁取"略低于当前实测值"（实测 语句 65.8 / 分支 62.4 / 函数 59.4 / 行 67.3）：
      // 目的是拦住大幅回退，而不是要求一次补齐到 70%（那需要补的是生命周期层测试，
      // 已在 docs/audit/98-fixes-status.md 列为后续项）。
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 55,
        lines: 62,
      },
    },
  },
});
