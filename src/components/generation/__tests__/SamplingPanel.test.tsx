import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SamplingPanel } from "../panels/SamplingPanel";

const baseProps = {
  samplers: ["euler"],
  schedulers: ["karras"],
  sampleMethod: "euler",
  scheduler: "karras",
  steps: 20,
  txtCfg: 7,
  distilled: undefined,
  showDistilled: false,
  betaAlpha: undefined,
  betaBeta: undefined,
  lmsMaxOrder: undefined,
  lmsShift: undefined,
  lmsDivisions: undefined,
  onUpdate: vi.fn(),
  onReset: vi.fn(),
  previewModes: [] as string[],
  previewMode: undefined,
  previewInterval: undefined,
};

describe("SamplingPanel option fallbacks", () => {
  it("echoes the current sampler/scheduler even when caps omit them", () => {
    render(<SamplingPanel {...baseProps} scheduler="discrete" />);

    expect(screen.getByLabelText("调度器")).toHaveTextContent("Discrete");
    expect(screen.getByLabelText("采样器")).toHaveTextContent("Euler");
  });
});

describe("SamplingPanel beta scheduler args", () => {
  it("shows alpha/beta sliders only for the beta scheduler", () => {
    const base = {
      ...baseProps,
      schedulers: ["beta", "karras"],
      betaAlpha: 0.8,
      betaBeta: 0.5,
    };
    const { rerender } = render(<SamplingPanel {...base} scheduler="beta" />);

    expect(screen.getByRole("slider", { name: /Beta α/ })).toHaveAttribute(
      "aria-valuetext",
      "0.80"
    );
    expect(screen.getByRole("slider", { name: /Beta β/ })).toHaveAttribute(
      "aria-valuetext",
      "0.50"
    );

    rerender(<SamplingPanel {...base} scheduler="karras" />);

    expect(screen.queryByRole("slider", { name: /Beta α/ })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Beta β/ })).toBeNull();
  });
});

// 上游 #1885 让 lms 的 max_order / shift / divisions 可配（denoiser.hpp sample_lms）。
describe("SamplingPanel lms sampler args", () => {
  it("shows the lms controls only for the lms sampler, defaulting to upstream values", () => {
    const base = { ...baseProps, samplers: ["euler", "lms"] };
    const { rerender } = render(<SamplingPanel {...base} sampleMethod="lms" />);

    expect(screen.getByRole("slider", { name: /LMS 阶数/ })).toHaveAttribute(
      "aria-valuetext",
      "4"
    );
    expect(screen.getByRole("slider", { name: /LMS 历史偏移/ })).toHaveAttribute(
      "aria-valuetext",
      "1"
    );
    expect(screen.getByLabelText(/LMS 积分分段/)).toHaveValue(1000);

    rerender(<SamplingPanel {...base} sampleMethod="euler" />);

    expect(screen.queryByRole("slider", { name: /LMS 阶数/ })).toBeNull();
    expect(screen.queryByRole("slider", { name: /LMS 历史偏移/ })).toBeNull();
    expect(screen.queryByLabelText(/LMS 积分分段/)).toBeNull();
  });

  it("reports lms edits on the sample_params path", () => {
    const onUpdate = vi.fn();
    render(
      <SamplingPanel
        {...baseProps}
        samplers={["lms"]}
        sampleMethod="lms"
        lmsDivisions={2000}
        onUpdate={onUpdate}
      />
    );

    const divisions = screen.getByLabelText(/LMS 积分分段/);
    expect(divisions).toHaveValue(2000);
    fireEvent.focus(divisions);
    fireEvent.change(divisions, { target: { value: "1500" } });
    fireEvent.blur(divisions);

    expect(onUpdate).toHaveBeenCalledWith("sample_params.lms_divisions", 1500);
  });
});

describe("SamplingPanel 默认（自动）选项", () => {
  it("切换调度器后默认选项仍保留", async () => {
    render(<SamplingPanel {...baseProps} />);

    fireEvent.click(screen.getByLabelText("调度器"));
    expect(await screen.findByRole("option", { name: "默认（自动）" })).toBeTruthy();
  });

  it("当前值为 default 哨兵时显示 默认（自动）", () => {
    render(
      <SamplingPanel {...baseProps} sampleMethod="default" scheduler="default" />
    );

    expect(screen.getByLabelText("调度器")).toHaveTextContent("默认（自动）");
    expect(screen.getByLabelText("采样器")).toHaveTextContent("默认（自动）");
  });
});

describe("SamplingPanel 生成预览（上游 #2093）", () => {
  it("旧内核没有 preview_modes 时不显示预览控件", () => {
    render(<SamplingPanel {...baseProps} />);
    expect(screen.queryByLabelText(/生成预览/)).toBeNull();
  });

  it("有预览能力时列出模式，并只在开启后显示间隔", () => {
    const { rerender } = render(
      <SamplingPanel
        {...baseProps}
        previewModes={["none", "proj", "tae", "vae"]}
        previewMode="none"
      />
    );

    expect(screen.getByLabelText(/生成预览/)).toHaveTextContent("关闭");
    // 关闭状态不显示间隔输入。
    expect(screen.queryByLabelText(/预览间隔/)).toBeNull();

    rerender(
      <SamplingPanel
        {...baseProps}
        previewModes={["none", "proj", "tae", "vae"]}
        previewMode="tae"
        previewInterval={5}
      />
    );
    expect(screen.getByLabelText(/生成预览/)).toHaveTextContent("TAE 解码");
    expect(screen.getByLabelText(/预览间隔/)).toHaveValue(5);
  });

  it("把预览模式写到请求体顶层键 preview", async () => {
    const onUpdate = vi.fn();
    render(
      <SamplingPanel
        {...baseProps}
        previewModes={["none", "proj"]}
        previewMode="none"
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByLabelText(/生成预览/));
    fireEvent.click(await screen.findByRole("option", { name: "潜空间投影" }));

    expect(onUpdate).toHaveBeenCalledWith("preview", "proj");
  });

  it("当前模式不受支持时显示关闭，不把旧值补为可选项", async () => {
    render(
      <SamplingPanel
        {...baseProps}
        previewModes={["none", "proj"]}
        previewMode="vae"
      />
    );

    expect(screen.getByLabelText(/生成预览/)).toHaveTextContent("关闭");
    expect(screen.queryByLabelText(/预览间隔/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/生成预览/));
    expect(await screen.findByRole("option", { name: "潜空间投影" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "VAE 解码" })).toBeNull();
  });
});
