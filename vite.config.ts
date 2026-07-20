import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port (1420) and host during dev.
export default defineConfig({
  plugins: [react()],
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
  },
});
