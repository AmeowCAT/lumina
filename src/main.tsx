import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import "./styles.css";

// reducedMotion="user":framer-motion 的 JS 动画(spring/位移/缩放)跟随
// 系统"减少动态效果"偏好,与 styles.css 的 CSS 媒体查询行为对齐。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>
);
