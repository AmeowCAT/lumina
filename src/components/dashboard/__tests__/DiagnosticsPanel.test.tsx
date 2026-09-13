import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../../store";
import { diagnosticsFor } from "../../../lib/diagnostics";
import { DiagnosticsPanel } from "../DiagnosticsPanel";

beforeEach(() => useStore.setState({ settings: { ...useStore.getState().settings, ...diagnosticsFor() } }));

describe("startup diagnostics controls", () => {
  it("starts empty and lets the user explicitly apply and clear a diagnostic preset", () => {
    render(<DiagnosticsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /诊断与数值稳定性/ }));
    const linear = screen.getByLabelText("Linear 输入缩放（--linear-scale）");
    const attention = screen.getByLabelText("Attention K/V 缩放（--attn-scale）");
    expect(linear).toHaveValue("");
    expect(attention).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "填入黑白图 / NaN 排查值" }));
    expect(linear).toHaveValue("0.0078125");
    expect(attention).toHaveValue("0.0078125");
    expect(screen.getByText(/修改后需重启服务器/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复诊断默认" }));
    expect(linear).toHaveValue("");
    expect(attention).toHaveValue("");
  });

  it("shows a validation error rather than clamping invalid input into another value", () => {
    render(<DiagnosticsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /诊断与数值稳定性/ }));
    const linear = screen.getByLabelText("Linear 输入缩放（--linear-scale）");
    fireEvent.change(linear, { target: { value: "1e-999" } });
    expect(linear).toHaveValue("1e-999");
    expect(screen.getByRole("alert")).toHaveTextContent("过小值");
    expect(useStore.getState().settings.linearScale).toBe("1e-999");
  });
});
