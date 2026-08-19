import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import "./styles.css";
// 主题层必须在基础样式之后导入:同 layer 内以更高优先级选择器接管
import "./theme-vostok.css";
import { initTheme } from "./lib/theme";

// 渲染前把持久化主题落到 <html data-theme> 与 meta theme-color;
// index.html 的引导脚本已做过一次,这里幂等重复,同时初始化模块内快照。
initTheme();

// reducedMotion="user":framer-motion 的 JS 动画(spring/位移/缩放)跟随
// 系统"减少动态效果"偏好,与 styles.css 的 CSS 媒体查询行为对齐。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>
);
