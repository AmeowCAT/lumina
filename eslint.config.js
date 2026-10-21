// ESLint 扁平配置（审查 60-build-test §2.7）。
//
// 目标不是"风格统一"（那是 Prettier 的事，见 docs/UPSTREAM-SYNC.md 的待办）：
// 这里只开**能抓到真实缺陷**的规则——`react-hooks` 的依赖数组/调用顺序、
// 未使用变量、`no-floating-promises`、`eqeqeq` 等。格式类规则一律不开，
// 以免产生一个覆盖全库、无法审阅的 diff。
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "src-tauri/**",
      "scripts/**",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React 19 / Compiler 的建议规则：本仓库大量既有写法会命中（如"在 effect 里
      // 直接 setState"、"把 ref 值用在渲染里"），逐条改造的收益低于噪音成本。
      // 保留可见性但不阻塞 CI；真正的缺陷规则（hooks 调用顺序、未使用变量）仍是 error。
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/rules-of-hooks": "error",
      // 这些在现有代码里大量出现（`catch {}`、动态 import 的类型断言），
      // 关掉以免把真正的缺陷淹没在噪音里。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // 测试里 mock 的存根函数返回 `any` 是常态。
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
