import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";

// 放大相关的交互回归：模态期间的快捷键让位、焦点不逃逸、重复提交防护。
// api 整体被 mock，未列出的方法为 undefined，因此只声明用到的三个。
const apiMocks = vi.hoisted(() => ({
  detectFamily: vi.fn(),
  sdcppSubmit: vi.fn(),
  sdcppUpscale: vi.fn(),
}));
vi.mock("../../../api", () => ({ api: apiMocks }));

import { GenerationUI } from "../GenerationUI";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=";

const CAPS = {
  model: { name: "test.safetensors", path: "D:/models/test.safetensors" },
  supported_modes: ["img_gen"],
  current_mode: "img_gen",
  defaults_by_mode: {
    img_gen: {
      prompt: "",
      negative_prompt: "",
      width: 512,
      height: 512,
      seed: -1,
      batch_count: 1,
      sample_params: {
        sample_method: "euler",
        scheduler: "discrete",
        sample_steps: 20,
        guidance: { txt_cfg: 7 },
      },
    },
  },
  features_by_mode: { img_gen: {} },
  output_formats_by_mode: { img_gen: ["png", "jpeg"] },
  samplers: ["euler"],
  schedulers: ["discrete"],
  loras: [],
  limits: { max_queue_size: 4 },
  upscale: true,
  upscalers: [{ name: "RealESRGAN_x4plus", model: true, image_upscale: true }],
};

function resetStore() {
  useStore.setState({
    caps: CAPS as never,
    mode: "img_gen",
    params: null,
    jobs: [],
    results: [
      {
        jobId: "source",
        mode: "img_gen",
        result: { output_format: "png", images: [{ index: 0, b64_json: PNG }] },
      },
    ],
    mainModel: "",
    familyOverride: "",
    initImage: null,
    maskImage: null,
    controlImage: null,
    ipAdapterImage: null,
    endImage: null,
    refImages: [],
    controlFrames: [],
    toasts: [],
    seedRandom: true,
    dashboardOpen: false,
    upscaleBusy: false,
  });
}

async function openUpscaleDialog() {
  render(
    <div className="app-view">
      <GenerationUI />
    </div>
  );
  await screen.findByLabelText("正向提示词");
  fireEvent.click(screen.getByLabelText("放大此图片"));
  return screen.findByRole("dialog", { name: "图像放大" });
}

describe("独立放大的模态隔离", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.detectFamily.mockReset().mockResolvedValue("custom");
    apiMocks.sdcppSubmit.mockReset().mockResolvedValue({
      status: 202,
      body: { id: "job_test", kind: "img_gen", status: "queued" },
    });
    apiMocks.sdcppUpscale.mockReset().mockImplementation(() => new Promise(() => {}));
    resetStore();
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
  });

  it("Ctrl+Enter 不再提交后台生成", async () => {
    await openUpscaleDialog();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiMocks.sdcppSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().jobs).toHaveLength(0);
  });

  it("Ctrl+, 不再召唤后台参数面板", async () => {
    await openUpscaleDialog();

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.params-sheet[aria-hidden="false"]')).toBeNull();
  });

  it("Ctrl+R 不再改动后台种子", async () => {
    await openUpscaleDialog();
    const before = useStore.getState().params;

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useStore.getState().params).toBe(before);
  });

  it("后台界面在模态期间被设为 inert", async () => {
    const { container } = render(
      <div className="app-view">
        <GenerationUI />
      </div>
    );
    await screen.findByLabelText("正向提示词");
    const view = container.querySelector(".app-view")!;
    expect(view.hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByLabelText("放大此图片"));
    await screen.findByRole("dialog", { name: "图像放大" });
    await waitFor(() => expect(view.hasAttribute("inert")).toBe(true));
  });

  it("进行中的放大记在 store 里，组件重挂也不会重复提交", async () => {
    const first = render(
      <div className="app-view">
        <GenerationUI />
      </div>
    );
    await screen.findByLabelText("正向提示词");
    fireEvent.click(screen.getByLabelText("放大此图片"));
    await screen.findByRole("dialog", { name: "图像放大" });
    fireEvent.click(screen.getByRole("button", { name: "开始放大" }));

    expect(apiMocks.sdcppUpscale).toHaveBeenCalledTimes(1);
    expect(useStore.getState().upscaleBusy).toBe(true);
    first.unmount();

    // 模拟"切到控制台再返回"：局部 state 会重置，但 store 的忙态还在。
    render(
      <div className="app-view">
        <GenerationUI />
      </div>
    );
    await screen.findByLabelText("正向提示词");
    fireEvent.click(screen.getByLabelText("放大此图片"));
    const submit = await screen.findByRole("button", { name: "放大中…" });
    expect(submit).toBeDisabled();
    expect(apiMocks.sdcppUpscale).toHaveBeenCalledTimes(1);
  });

  it("busy 时 Tab 不会把焦点留在对话框之外", async () => {
    await openUpscaleDialog();
    const dialog = screen.getByRole("dialog", { name: "图像放大" });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true)
    );

    const submit = screen.getByRole("button", { name: "开始放大" });
    submit.focus();
    fireEvent.click(submit);
    // 提交后按钮被禁用，焦点必须被收回对话框容器。
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("对话框内的下拉菜单带提升层级类名", async () => {
    await openUpscaleDialog();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "重复次数" }), {
      key: "ArrowDown",
    });

    const list = await screen.findByRole("listbox");
    // 菜单 portal 到 body，必须抬到模态之上才看得见。
    expect(list.className).toContain("select-content-elevated");
  });
});
