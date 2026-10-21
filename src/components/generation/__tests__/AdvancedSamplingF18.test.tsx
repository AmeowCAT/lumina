import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdvancedSamplingPanel } from "../panels/AdvancedSamplingPanel";

// 审查 F-18 的验收用例：cache_option 结构化控件、SCM 掩码硬校验、SLG 三参数。
// 语义依据见 docs/audit/95-f18-semantics.md；这里只验证「界面把什么写回参数」，
// 拼串与请求体行为在 src/lib/__tests__/utils.test.ts 里覆盖。

const baseProps = {
  eta: undefined,
  flowShift: undefined,
  slg: undefined,
  vaeTilingParams: undefined,
  clipSkip: undefined,
  extraSampleArgs: undefined,
  cacheMode: undefined,
};

function renderPanel(props: Record<string, unknown> = {}) {
  const onUpdate = vi.fn();
  render(
    <AdvancedSamplingPanel {...baseProps} {...props} onUpdate={onUpdate} />
  );
  return onUpdate;
}

describe("F-18 缓存微调控件", () => {
  it("easycache 渲染上游该模式的 6 个键", () => {
    renderPanel({ cacheMode: "easycache" });

    for (const name of [
      /复用阈值（threshold）/,
      /开始缓存/,
      /停止缓存/,
      /误差衰减（decay）/,
    ]) {
      expect(screen.getByRole("slider", { name })).toBeTruthy();
    }
    expect(screen.getByRole("switch", { name: /按输出范数缩放阈值（relative）/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /每步计算后重置误差（reset）/ })).toBeTruthy();
  });

  it("dbcache 只渲染块级缓存的键，不渲染 easycache 专属项", () => {
    renderPanel({ cacheMode: "dbcache" });

    expect(screen.getByRole("slider", { name: /前段强制计算块数（Fn）/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /后段强制计算块数（Bn）/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /残差阈值（threshold）/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /预热步数（warmup）/ })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: /开始缓存（start）/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /relative/ })).toBeNull();
  });

  it("缓存关闭时不渲染微调控件（也不发 cache_option）", () => {
    renderPanel({ cacheMode: "disabled" });
    expect(screen.queryByText(/缓存微调（cache_option）/)).toBeNull();
    expect(screen.queryByLabelText(/SCM 步掩码/)).toBeNull();
  });

  it("拖动阈值滑杆把数值写回结构化草稿", () => {
    const onUpdate = renderPanel({ cacheMode: "easycache" });

    const thumb = screen.getByRole("slider", { name: /复用阈值（threshold）/ });
    thumb.focus();
    fireEvent.keyDown(thumb, { key: "ArrowRight" });

    expect(onUpdate).toHaveBeenCalledWith(
      "cache_options",
      expect.objectContaining({ threshold: 0.05 })
    );
  });

  it("开关改动写成布尔值（拼串时才会变成 0/1）", async () => {
    const onUpdate = renderPanel({
      cacheMode: "easycache",
      cacheOptions: { relative: true },
    });

    await userEvent.click(
      screen.getByRole("switch", { name: /按输出范数缩放阈值（relative）/ })
    );

    expect(onUpdate).toHaveBeenCalledWith("cache_options", {
      relative: false,
    });
  });

  // 切模式：新模式不认的键必须一起丢掉，否则界面会显示「设置了但内核不读」，
  // 且 threshold 在 easycache/dbcache 下写的是不同上游字段。
  it("切换缓存模式时同时提交裁剪后的草稿", async () => {
    const onUpdate = renderPanel({
      cacheMode: "easycache",
      cacheOptions: { threshold: 0.2, Fn: 8, start: 0.15 },
    });

    fireEvent.keyDown(screen.getByRole("combobox", { name: /缓存/ }), {
      key: "ArrowDown",
    });
    const option = await screen.findByRole("option", { name: /DBCache/ });
    fireEvent.click(option);

    expect(onUpdate).toHaveBeenCalledWith("cache_mode", "dbcache");
    expect(onUpdate).toHaveBeenCalledWith("cache_options", { Fn: 8 });
  });

  it("从元数据恢复的未知键原样保留并提示", () => {
    renderPanel({
      cacheMode: "easycache",
      cacheOption: "threshold=0.1,gamma=3",
    });
    expect(screen.getByText(/gamma=3/)).toBeTruthy();
  });

  it("还原按钮清空结构化草稿（回到内核默认）", async () => {
    const onUpdate = renderPanel({
      cacheMode: "easycache",
      cacheOptions: { threshold: 0.2 },
    });

    await userEvent.click(screen.getByRole("button", { name: "还原缓存默认" }));
    expect(onUpdate).toHaveBeenCalledWith("cache_options", {});
  });
});

describe("F-18 SCM 步掩码", () => {
  it("只在块级缓存模式下显示输入框", () => {
    renderPanel({ cacheMode: "dbcache" });
    expect(screen.getByLabelText(/SCM 步掩码/)).toBeTruthy();
  });

  it("easycache/spectrum 下不显示（上游只在该路径消费）", () => {
    renderPanel({ cacheMode: "easycache" });
    expect(screen.queryByLabelText(/SCM 步掩码/)).toBeNull();
  });

  // 这条是安全边界：parse_scm_mask 对每段直接 std::stoi 且无 try/catch，
  // 异常逸出会让 sd-server 的 worker 线程 terminate。
  it("非法掩码给出 alert 并标记 aria-invalid", () => {
    renderPanel({ cacheMode: "dbcache", scmMask: "1,,0" });

    const input = screen.getByLabelText(/SCM 步掩码/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert")).toHaveTextContent(/0\/1/);
  });

  it("合法掩码没有提示", () => {
    renderPanel({ cacheMode: "dbcache", scmMask: "1,1,0,0" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("输入会写回 scm_mask 原文（合法性由请求体再拦一次）", () => {
    const onUpdate = renderPanel({ cacheMode: "dbcache", scmMask: "1,0" });
    const input = screen.getByLabelText(/SCM 步掩码/) as HTMLInputElement;
    // 受控组件：显示的是参数里的原文，非法值也照样保留（用户才能改回来）。
    expect(input.value).toBe("1,0");

    fireEvent.change(input, { target: { value: "1,,0" } });
    expect(onUpdate).toHaveBeenCalledWith("scm_mask", "1,,0");
  });
});

describe("F-18 SLG 三参数", () => {
  it("缺省时显示上游默认值，改动写回 slg 对象", async () => {
    const onUpdate = renderPanel({ slg: { scale: 2 } });

    const start = screen.getByLabelText(/SLG 起始比例/);
    await userEvent.clear(start);
    await userEvent.type(start, "0.05{Enter}");

    expect(onUpdate).toHaveBeenCalledWith(
      "sample_params.guidance.slg",
      expect.objectContaining({ scale: 2, layer_start: 0.05 })
    );
  });

  it("起止比例倒置时给出可读提示（上游会静默不生效）", () => {
    renderPanel({ slg: { scale: 2, layer_start: 0.3, layer_end: 0.2 } });
    expect(screen.getByRole("alert")).toHaveTextContent(/必须小于/);
  });

  it("跳层索引留空 = 不下发该键（不写空数组）", async () => {
    const onUpdate = renderPanel({
      slg: { scale: 2, layers: [7, 8, 9] },
    });

    const input = screen.getByLabelText(/跳层索引/);
    await userEvent.clear(input);

    expect(onUpdate).toHaveBeenCalledWith(
      "sample_params.guidance.slg",
      expect.objectContaining({ layers: undefined })
    );
  });

  it("跳层索引非法时只提示，不写参数", () => {
    const onUpdate = renderPanel({ slg: { scale: 2, layers: [7] } });

    const input = screen.getByLabelText(/跳层索引/);
    onUpdate.mockClear();
    // 一次 change 覆盖「粘贴一段非法文本」的场景：逐字符键入时中途可能合法，
    // 只有整段非法才应该只提示、不写参数。
    fireEvent.change(input, { target: { value: "7,x" } });

    expect(screen.getByRole("alert")).toHaveTextContent(/不是非负整数/);
    for (const call of onUpdate.mock.calls) {
      expect(call[0]).not.toBe("sample_params.guidance.slg");
    }
  });

  it("合法索引去重后写回数组", async () => {
    const onUpdate = renderPanel({ slg: { scale: 2, layers: [7] } });

    const input = screen.getByLabelText(/跳层索引/);
    await userEvent.clear(input);
    await userEvent.type(input, "7, 8, 8");

    expect(onUpdate).toHaveBeenLastCalledWith(
      "sample_params.guidance.slg",
      expect.objectContaining({ layers: [7, 8] })
    );
  });
});
