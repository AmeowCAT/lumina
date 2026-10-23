import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// `findBy*` / `waitFor` 的默认等待只有 1000ms。界面里若干重组件是
// `React.lazy` 动态导入的（`GenerationParamsSheet`、`HistoryGallery`，见
// `GenerationUI.tsx`），测试首次打开它们要等 Vite 现场转换那一大串模块——
// 本地一两百毫秒，GitHub 的 Windows runner 上会超过 1 秒，于是出现
// 「本地绿、CI 红」的假失败（实测：`keeps the L2P hint free of development
// metadata` 在 CI 上恰好在 1035ms 超时）。放宽到 5 秒是基于动态导入的 I/O 特性，
// 不是掩盖断言问题：真正缺失的元素依然会在 5 秒后失败。
configure({ asyncUtilTimeout: 5000 });

// jsdom 未实现 Radix 组件依赖的若干 DOM API，统一在此打桩：
// Pointer Capture（Radix Slider/Select 拖拽）、scrollIntoView（Select 列表
// 滚动定位）、ResizeObserver（Popper 定位自动更新）、matchMedia（动效库探测）。
const elementProto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
elementProto.hasPointerCapture = () => false;
elementProto.setPointerCapture = () => {};
elementProto.releasePointerCapture = () => {};
elementProto.scrollIntoView = () => {};

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
