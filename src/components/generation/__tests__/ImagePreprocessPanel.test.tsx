import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ImagePreprocessPanel } from "../panels/ImagePreprocessPanel";

function Editor() {
  const [rules, setRules] = useState<string[]>([]);
  return (
    <ImagePreprocessPanel
      rules={rules}
      hasRefImages
      onUpdate={(_, value) => setRules(value as string[])}
    />
  );
}

describe("ImagePreprocessPanel", () => {
  it("preserves Enter and whitespace while typing multiple rules", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByRole("button", { name: "图像输入几何（image_preprocess）" }));
    const input = screen.getByLabelText("预处理规则");
    await user.type(input, "target=init,mode=none{Enter}");
    expect(input).toHaveValue("target=init,mode=none\n");
    await user.type(input, "{Enter}  target=ref,mode=none ");
    expect(input).toHaveValue("target=init,mode=none\n\n  target=ref,mode=none ");
    await user.clear(input);
    expect(input).toHaveValue("");
  });

  it.each([
    [null, ""],
    [42, ""],
    [{ invalid: true }, ""],
    ["not-an-array", ""],
    [[42, null, {}, "  target=ref,mode=none ", ""], "  target=ref,mode=none \n"],
  ])("handles malformed persisted rules %# without changing valid draft whitespace", (value, expected) => {
    render(<ImagePreprocessPanel rules={value as string[]} hasRefImages onUpdate={() => {}} />);
    expect(screen.getByLabelText("预处理规则")).toHaveValue(expected);
  });

  it("reflects externally restored rules", () => {
    const onUpdate = () => {};
    const { rerender } = render(<ImagePreprocessPanel rules={["target=init,mode=none"]} hasRefImages onUpdate={onUpdate} />);
    rerender(<ImagePreprocessPanel rules={["target=ref,mode=none", "target=mask,filter=nearest"]} hasRefImages onUpdate={onUpdate} />);
    expect(screen.getByLabelText("预处理规则")).toHaveValue("target=ref,mode=none\ntarget=mask,filter=nearest");
  });
});
