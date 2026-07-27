import "@testing-library/jest-dom/vitest";

// jsdom 未实现 Radix 组件依赖的若干 DOM API，统一在此打桩：
// Pointer Capture（Radix Slider/Select 拖拽）、scrollIntoView（Select 列表
// 滚动定位）、ResizeObserver（Popper 定位自动更新）、matchMedia（动效库探测）。
const elementProto = window.HTMLElement.prototype as unknown as Record<
  string,
  unknown
>;
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
