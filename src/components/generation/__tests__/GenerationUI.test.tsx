import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";

// Tauri IPC 在 jsdom 不存在；所有 api 方法统一返回空对象，
// 本文件只验证 UI 结构渲染，不触发真实调用。
vi.mock("../../../api", () => ({
  api: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
}));

import { GenerationUI } from "../GenerationUI";

const CAPS = {
  model: { name: "test-model.safetensors", path: "D:/models/test-model.safetensors" },
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
  samplers: ["euler"],
  schedulers: ["discrete"],
  limits: { max_queue_size: 4 },
};

const VIDEO_CAPS = {
  ...CAPS,
  model: { name: "sd15.safetensors", path: "D:/models/sd15.safetensors" },
  supported_modes: ["img_gen", "vid_gen"],
  current_mode: "vid_gen",
  defaults_by_mode: {
    img_gen: CAPS.defaults_by_mode.img_gen,
    vid_gen: {
      prompt: "",
      negative_prompt: "",
      width: 512,
      height: 512,
      seed: -1,
      strength: 0.75,
      video_frames: 16,
      fps: 8,
      sample_params: {
        sample_method: "euler",
        scheduler: "discrete",
        sample_steps: 20,
        guidance: { txt_cfg: 8 },
      },
    },
  },
  features_by_mode: {
    img_gen: {},
    vid_gen: { init_image: true, end_image: true },
  },
  samplers: ["euler"],
  schedulers: ["discrete"],
};

const PID_CAPS = {
  ...CAPS,
  model: { name: "pid_custom.safetensors", path: "D:/models/pid_custom.safetensors" },
  features_by_mode: {
    img_gen: { init_image: true, ref_images: true },
  },
};

describe("GenerationUI 结构（暗房重构版）", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      caps: CAPS as never,
      mode: "img_gen",
      params: null,
      jobs: [],
      results: [],
      mainModel: "",
      familyOverride: "",
      refImages: [],
      toasts: [],
      seedRandom: true,
    });
  });

  it("渲染底部指令坞、画布工具栏与空状态", async () => {
    render(<GenerationUI />);
    await waitFor(() => expect(screen.getByLabelText("正向提示词")).toBeTruthy());
    // 提示词已从侧栏移入底部指令坞
    expect(document.querySelector(".prompt-dock")).toBeTruthy();
    expect(screen.getByLabelText("切换反向提示词输入")).toBeTruthy();
    // 任务队列默认收起为浮层开关
    expect(screen.getByLabelText("切换任务队列面板")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "当前结果" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "历史画廊" })).toBeTruthy();
    // 侧栏不再包含提示词面板，首个面板带仪表编号样式
    expect(document.querySelector(".sidebar-scroll .panel")).toBeTruthy();
    expect(screen.getByText("准备就绪")).toBeTruthy();
  });

  it("任务队列浮层可开合", async () => {
    render(<GenerationUI />);
    await waitFor(() => expect(screen.getByLabelText("正向提示词")).toBeTruthy());
    expect(document.querySelector(".queue-overlay")).toBeNull();
    screen.getByLabelText("切换任务队列面板").click();
    await waitFor(() => expect(document.querySelector(".queue-overlay")).toBeTruthy());
    screen.getByLabelText("切换任务队列面板").click();
    await waitFor(() => expect(document.querySelector(".queue-overlay")).toBeNull());
  });

  it("shows AnimateDiff video defaults, strength, and frame shortcuts", async () => {
    useStore.setState({
      caps: VIDEO_CAPS as never,
      mode: "vid_gen",
      params: null,
      mainModel: "D:/models/sd15.safetensors",
      familyOverride: "sd",
    });
    render(<GenerationUI />);

    expect(await screen.findByRole("slider", { name: /图生视频强度/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "8 帧" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "16 帧" })).toBeTruthy();
    expect((screen.getByLabelText("帧数") as HTMLInputElement).value).toBe("16");
  });

  it("marks PiD reference images as required and blocks an empty submission", async () => {
    useStore.setState({
      caps: PID_CAPS as never,
      mode: "img_gen",
      params: null,
      mainModel: "D:/models/pid_custom.safetensors",
      familyOverride: "pid",
      refImages: [],
      toasts: [],
    });
    render(<GenerationUI />);

    expect(await screen.findByText("参考图片（必需）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() =>
      expect(useStore.getState().toasts[useStore.getState().toasts.length - 1]?.msg).toContain(
        "参考图片"
      )
    );
  });
});
