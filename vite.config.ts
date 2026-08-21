import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port (1420) and host during dev.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: "oxc",
    sourcemap: false,
    // 手动 vendor 拆分：低频模块已动态 import()（控制台/历史
    // 画廊/参数面板），再把 react/motion/radix 等常驻依赖拆成独立 chunk，
    // 让首屏入口 chunk 低于 500KB 警告线，也便于浏览器并行加载。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules\/(react|react-dom|scheduler)\//,
            },
            {
              name: "motion-vendor",
              test: /node_modules\/(motion|framer-motion)\//,
            },
            {
              name: "ui-vendor",
              test: /node_modules\/(radix-ui|@radix-ui|lucide-react|zustand|clsx|tailwind-merge)\//,
            },
          ],
        },
      },
    },
  },
});
