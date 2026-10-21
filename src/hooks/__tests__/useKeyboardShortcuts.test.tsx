import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useKeyboardShortcuts,
  type KeyboardShortcutHandlers,
} from "../useKeyboardShortcuts";

/**
 * 快捷键的四个真实回归点（对应审查 F-01 / F-02 / F-03）：
 *  1. 用 `e.code` 而不是 `e.key` —— CapsLock 大写或非美式布局时 `e.key` 不是 "r"，
 *     旧实现拦不住，按键会落到 WebView2 的刷新上（结果只在内存里 = 整批丢失）。
 *  2. 认 `metaKey`（macOS Cmd）。
 *  3. 尊重 `defaultPrevented`（Radix Select/Popover 在 Esc 上自己关闭并
 *     preventDefault，不能同一次按键再关掉背后的参数面板）。
 *  4. `blockBackgroundShortcuts` 与 `escapeActive` 是两个独立开关：Lightbox /
 *     队列抽屉 / 放大对话框下误触提交等于白烧几分钟 GPU，而 Esc 仍要关浮层。
 */
function Harness({ handlers }: { handlers: KeyboardShortcutHandlers }) {
  useKeyboardShortcuts(handlers);
  return <input aria-label="提示词" />;
}

const makeHandlers = (
  over: Partial<KeyboardShortcutHandlers> = {}
): KeyboardShortcutHandlers => ({
  onGenerate: vi.fn(),
  onRandomSeed: vi.fn(),
  onEscape: vi.fn(),
  escapeActive: true,
  ...over,
});

function mount(over: Partial<KeyboardShortcutHandlers> = {}) {
  const handlers = makeHandlers(over);
  const view = render(<Harness handlers={handlers} />);
  return {
    handlers,
    /** 用同一批 mock 换 props（测试 ref 转发：不需要重订阅就能读到新标志位） */
    update(next: Partial<KeyboardShortcutHandlers>) {
      view.rerender(<Harness handlers={{ ...handlers, ...next }} />);
    },
    unmount: view.unmount,
  };
}

/** 在 window 上派发一次 keydown 并返回事件本体（用于断言 defaultPrevented） */
function pressOnWindow(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  cleanup();
});

describe("useKeyboardShortcuts", () => {
  it("Ctrl+Enter 提交生成并阻止默认行为", () => {
    const { handlers } = mount();

    const event = pressOnWindow({ key: "Enter", code: "Enter", ctrlKey: true });

    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("⌘+Enter（macOS metaKey）同样提交", () => {
    const { handlers } = mount();

    pressOnWindow({ key: "Enter", code: "Enter", metaKey: true });

    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);
  });

  it("只认 e.code：CapsLock 打开时 key 是 \"R\" 也照样换种子（F-01 回归）", () => {
    const { handlers } = mount();

    const event = pressOnWindow({ key: "R", code: "KeyR", ctrlKey: true });

    expect(handlers.onRandomSeed).toHaveBeenCalledTimes(1);
    expect(handlers.onGenerate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("只认 e.code：非美式布局下 key 不是 \"r\" 也能换种子", () => {
    const { handlers } = mount();

    // 俄语布局上 Ctrl+R 的 key 是 "к"，code 仍是 KeyR。
    pressOnWindow({ key: "к", code: "KeyR", ctrlKey: true });

    expect(handlers.onRandomSeed).toHaveBeenCalledTimes(1);
  });

  it("输入法组合期间（isComposing）不提交", () => {
    const { handlers } = mount();

    const event = pressOnWindow({
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
      isComposing: true,
    });

    expect(handlers.onGenerate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("按住不放产生的自动重复（repeat）不重复提交", () => {
    const { handlers } = mount();

    pressOnWindow({ key: "Enter", code: "Enter", ctrlKey: true, repeat: true });

    expect(handlers.onGenerate).not.toHaveBeenCalled();
  });

  it("已被浮层消费的 Esc（defaultPrevented）不再触发 onEscape", () => {
    const { handlers } = mount();

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    // Radix 的 Select/Popover 在 Esc 上自己关闭并 preventDefault。
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });

    expect(handlers.onEscape).not.toHaveBeenCalled();
  });

  it("抽屉/灯箱打开时后台快捷键让位，但 Esc 仍然生效（F-03 契约）", () => {
    const { handlers } = mount({ blockBackgroundShortcuts: true });

    pressOnWindow({ key: "Enter", code: "Enter", ctrlKey: true });
    pressOnWindow({ key: "r", code: "KeyR", ctrlKey: true });
    expect(handlers.onGenerate).not.toHaveBeenCalled();
    expect(handlers.onRandomSeed).not.toHaveBeenCalled();

    // 两个开关是独立的：拦后台快捷键不等于拦 Esc。
    pressOnWindow({ key: "Escape", code: "Escape" });
    expect(handlers.onEscape).toHaveBeenCalledTimes(1);
  });

  it("escapeActive=false 时 Esc 交给页面自身处理（不 preventDefault）", () => {
    const { handlers } = mount({ escapeActive: false });

    const event = pressOnWindow({ key: "Escape", code: "Escape" });

    expect(handlers.onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl+Shift+R 不换种子（避免与浏览器/WebView 的组合键冲突）", () => {
    const { handlers } = mount();

    pressOnWindow({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });

    expect(handlers.onRandomSeed).not.toHaveBeenCalled();
  });

  it("提示词输入框内 Ctrl+Enter 仍然提交（PromptDock 的既定交互，未做输入框禁用）", () => {
    const { handlers } = mount();
    const input = screen.getByLabelText("提示词");
    input.focus();

    // 冒泡到 window，与真实按键路径一致。
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });

    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);
  });

  it("标志位经 ref 读取：rerender 后无需重订阅即生效", () => {
    const { handlers, update } = mount();

    pressOnWindow({ key: "Enter", code: "Enter", ctrlKey: true });
    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);

    update({ blockBackgroundShortcuts: true });
    pressOnWindow({ key: "Enter", code: "Enter", ctrlKey: true });
    // 仍是 1 次：新标志位立刻生效，且没有因为重订阅而遗漏/重复。
    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);
  });
});
