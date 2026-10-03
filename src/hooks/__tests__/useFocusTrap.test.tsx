import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "../useFocusTrap";

/**
 * 焦点圈的三种边界：正常循环、容器内焦点落在不可 Tab 的元素上、以及焦点在
 * 容器外的 portal 浮层里（Radix 下拉菜单）。最后一类必须放手，否则菜单的
 * 键盘处理会被抢掉。
 */
function Harness({ withOutside }: { withOutside?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return (
    <div>
      {withOutside && (
        <button type="button" aria-label="容器外按钮">
          outside
        </button>
      )}
      <div
        ref={(node) => {
          ref.current = node;
        }}
        role="dialog"
        aria-label="测试对话框"
      >
        <button type="button">第一个</button>
        {/* tabIndex=-1：可获得焦点但不参与 Tab 序列 */}
        <span tabIndex={-1} data-testid="anchor">
          锚点
        </span>
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("把焦点移入容器，并在首尾之间循环", async () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "第一个" });
    // 容器内只有一个可 Tab 的元素，Tab 应回到它自身。
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("容器内的焦点不可 Tab 时，把 Tab 拉回圈内而不是让它跑到后台", async () => {
    render(<Harness withOutside />);
    const first = screen.getByRole("button", { name: "第一个" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    // 焦点在容器内、却不在可 Tab 集合里：浏览器会顺势走到容器外。
    const anchor = screen.getByTestId("anchor");
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    expect(anchor.contains(document.activeElement)).toBe(false);
  });

  it("焦点在容器外的 portal 浮层里时不干预 Tab", async () => {
    render(<Harness withOutside />);
    const first = screen.getByRole("button", { name: "第一个" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    const outside = screen.getByRole("button", { name: "容器外按钮" });
    outside.focus();

    fireEvent.keyDown(document, { key: "Tab" });
    // 交给浮层自己处理：焦点圈不能把它抢回对话框。
    expect(document.activeElement).toBe(outside);
  });

  it("焦点丢失到 body 时把 Tab 拉回圈内", async () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "第一个" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});
