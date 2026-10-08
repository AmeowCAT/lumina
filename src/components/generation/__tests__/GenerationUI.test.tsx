import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";

// Tauri IPC 在 jsdom 不存在；所有 api 方法统一返回空对象，
// 仅对需要断言的调用保留稳定 mock。
const apiMocks = vi.hoisted(() => ({
  detectFamily: vi.fn(),
  sdcppSubmit: vi.fn(),
}));
vi.mock("../../../api", () => ({
  api: apiMocks,
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

const CONTROL_FRAME_VIDEO_CAPS = {
  ...VIDEO_CAPS,
  features_by_mode: {
    ...VIDEO_CAPS.features_by_mode,
    vid_gen: {
      ...VIDEO_CAPS.features_by_mode.vid_gen,
      control_frames: true,
    },
  },
};

describe("GenerationUI 结构（暗房重构版）", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.detectFamily.mockReset().mockResolvedValue("custom");
    apiMocks.sdcppSubmit.mockReset().mockResolvedValue({
      status: 202,
      body: {
        id: "job_test",
        kind: "vid_gen",
        status: "queued",
      },
    });
    useStore.setState({
      caps: CAPS as never,
      mode: "img_gen",
      params: null,
      jobs: [],
      results: [],
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
    });
  });

  it.each([
    ["missing capability", undefined, undefined],
    ["disabled mode", ["none", "vae"], false],
    ["unsupported saved value", ["none", "proj"], true],
  ] as const)("does not submit an old preview setting with %s", async (_, preview_modes, preview) => {
    localStorage.setItem("sdcpp:params:img_gen", JSON.stringify({ preview: "vae", preview_interval: 2 }));
    useStore.setState({ caps: { ...CAPS, preview_modes, features_by_mode: { img_gen: { preview } } } as never });
    render(<GenerationUI />);
    fireEvent.click(await screen.findByRole("button", { name: "生成" }));
    await waitFor(() => expect(apiMocks.sdcppSubmit).toHaveBeenCalledTimes(1));
    const body = apiMocks.sdcppSubmit.mock.calls[0][1];
    expect(body.preview).toBe("none");
    expect(body).not.toHaveProperty("preview_interval");
    expect(useStore.getState().jobs[0].config?.params.preview).toBe("none");
  });

  it("blocks MiniMax references with keyframes and allows resubmission after fixing them", async () => {
    const model = { name: "minimax_h3_ref2va.safetensors", path: "D:/models/minimax_h3_ref2va.safetensors" };
    useStore.setState({
      caps: { ...VIDEO_CAPS, model } as never,
      mode: "vid_gen", mainModel: model.path, familyOverride: "minimax-h3-ref2va",
      refImages: ["data:image/png;base64,cmVm"],
      initImage: "data:image/png;base64,aW5pdA==", endImage: "data:image/png;base64,ZW5k",
    });
    render(<GenerationUI />);
    const generate = await screen.findByRole("button", { name: "生成" });
    fireEvent.click(generate);
    expect(apiMocks.sdcppSubmit).not.toHaveBeenCalled();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.msg).toContain("不能与初始图片 / 结束帧同时使用");
    act(() => useStore.setState({ initImage: null, endImage: null }));
    fireEvent.click(generate);
    await waitFor(() => expect(apiMocks.sdcppSubmit).toHaveBeenCalledTimes(1));
    expect(apiMocks.sdcppSubmit.mock.calls[0][1].ref_images).toEqual(["data:image/png;base64,cmVm"]);
  });

  it("uses PNG preview frames, restarts step labels per pass, and never carries a frame to another job", async () => {
    const job = { id: "a", kind: "img_gen" as const, status: "generating" as const,
      config: { mode: "img_gen" as const, params: { ...CAPS.defaults_by_mode.img_gen, output_format: "jpeg" } },
      preview: { pass: 1, step: 5, total_steps: 20, b64_json: "first" },
    };
    useStore.setState({ jobs: [job] });
    render(<GenerationUI />);
    expect(await screen.findByAltText("生成预览")).toHaveAttribute("src", "data:image/png;base64,first");
    act(() => useStore.setState({ jobs: [{ ...job, preview: { pass: 2, step: 1, total_steps: 10, b64_json: "second" } }] }));
    expect(screen.getByText("生成预览 · 第 2 段 · 1/10 步")).toBeTruthy();
    act(() => useStore.setState({ jobs: [{ ...job, status: "completed" }, { id: "b", kind: "vid_gen", status: "queued" }] }));
    expect(screen.queryByAltText("生成预览")).toBeNull();
    act(() => useStore.setState({ jobs: [{ id: "b", kind: "vid_gen", status: "generating", preview: { pass: 1, step: 1, total_steps: 5, b64_json: "video-preview" } }] }));
    expect(screen.getByAltText("生成预览")).toHaveAttribute("src", "data:image/png;base64,video-preview");
  });

  it("keeps the L2P hint free of development metadata", async () => {
    useStore.setState({ mainModel: CAPS.model.path, familyOverride: "zimage-l2p" });
    render(<GenerationUI />);
    fireEvent.click(await screen.findByLabelText("打开参数面板"));
    const hint = await screen.findByRole("note");
    expect(hint.textContent).toContain("BF16");
    expect(hint.textContent).not.toMatch(/上游|docs\/|#2075|18\.6/);
  });

  it("渲染浮动指令条、画布工作区与空状态", async () => {
    render(<GenerationUI />);
    await waitFor(() => expect(screen.getByLabelText("正向提示词")).toBeTruthy());
    // 提示词升级为画布底部中央的浮动指令条
    expect(document.querySelector(".prompt-dock")).toBeTruthy();
    expect(screen.getByLabelText("切换反向提示词输入")).toBeTruthy();
    // 任务队列默认收起为抽屉开关
    expect(screen.getByLabelText("切换任务队列面板")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "当前结果" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "历史画廊" })).toBeTruthy();
    // 参数面板移入召唤式 Sheet（懒加载后按需就绪,关闭时保持挂载）,
    // 首个面板带仪表编号样式
    await waitFor(() =>
      expect(document.querySelector(".params-sheet .panel")).toBeTruthy()
    );
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

    // 参数移入召唤式 Sheet：关闭时整层 inert(不可达),须先唤起再查询
    screen.getByLabelText("打开参数面板").click();
    expect(await screen.findByRole("slider", { name: /图生视频强度/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "8 帧" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "16 帧" })).toBeTruthy();
    expect(screen.getByLabelText("帧数")).toHaveAttribute("aria-valuenow", "16");
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

  it("hides and omits control frames for LTX even when the protocol advertises them", async () => {
    const caps = {
      ...CONTROL_FRAME_VIDEO_CAPS,
      model: {
        name: "ltx-video-2b.safetensors",
        path: "D:/models/ltx-video-2b.safetensors",
      },
    };
    useStore.setState({
      caps: caps as never,
      mode: "vid_gen",
      params: null,
      mainModel: caps.model.path,
      familyOverride: "ltx",
      controlFrames: ["data:image/png;base64,stale-frame"],
      seedRandom: false,
    });
    render(<GenerationUI />);

    const generate = await screen.findByRole("button", { name: "生成" });
    expect(screen.queryByRole("button", { name: "添加条件帧" })).toBeNull();
    fireEvent.click(generate);

    await waitFor(() => expect(apiMocks.sdcppSubmit).toHaveBeenCalledTimes(1));
    const requestBody = apiMocks.sdcppSubmit.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(requestBody.control_frames).toBeUndefined();
    expect(
      useStore.getState().jobs[0]?.config?.images?.controlFrames
    ).toEqual([]);
  });

  it("restricts SenseNova to text-to-image and filters stale editing inputs", async () => {
    const caps = {
      ...CAPS,
      model: { name: "SenseNova-U1.5", path: "D:/models/SenseNova-U1.5/model.safetensors.index.json" },
      features_by_mode: { img_gen: { init_image: true, mask_image: true, control_image: true, ip_adapter_image: true, ref_images: true, vae_tiling: true, hires: true } },
      defaults_by_mode: { img_gen: { ...CAPS.defaults_by_mode.img_gen, width: 2049, height: 2048, hires: { enabled: true }, vae_tiling_params: { enabled: true } } },
    };
    useStore.setState({
      caps: caps as never, params: null, mainModel: caps.model.path, familyOverride: "sensenova-u1",
      initImage: "stale-init", maskImage: "stale-mask", controlImage: "stale-control", ipAdapterImage: "stale-adapter",
      refImages: ["stale-reference"], seedRandom: false,
    });
    render(<GenerationUI />);
    await screen.findByRole("button", { name: "生成" });
    fireEvent.click(screen.getByLabelText("打开参数面板"));
    expect(await screen.findByRole("note")).toHaveTextContent("仅支持 non-thinking 文生图");
    expect(screen.queryByText("VAE 分块")).not.toBeInTheDocument();
    expect(screen.queryByText("初始图片")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "生成" }));
    await waitFor(() => expect(apiMocks.sdcppSubmit).toHaveBeenCalledTimes(1));
    const body = apiMocks.sdcppSubmit.mock.calls[0][1];
    for (const key of ["init_image", "mask_image", "control_image", "ip_adapter_image", "ref_images"]) expect(body).not.toHaveProperty(key);
    expect(body).toMatchObject({ width: 2080, height: 2048, hires: { enabled: false }, vae_tiling_params: { enabled: false } });
    expect(useStore.getState().jobs[0]?.config?.images?.initImage).toBeNull();
  });

  it("shows control frames for a VACE model", async () => {
    const caps = {
      ...CONTROL_FRAME_VIDEO_CAPS,
      model: {
        name: "Wan2.1-VACE-1.3B.safetensors",
        path: "D:/models/Wan2.1-VACE-1.3B.safetensors",
      },
    };
    useStore.setState({
      caps: caps as never,
      mode: "vid_gen",
      params: null,
      mainModel: caps.model.path,
      familyOverride: "wan-t2v",
    });
    render(<GenerationUI />);

    screen.getByLabelText("打开参数面板").click();
    expect(
      await screen.findByRole("button", { name: "添加条件帧" })
    ).toBeTruthy();
  });

  it("hides control frames for a non-Wan file that merely contains 'vace'", async () => {
    const caps = {
      ...CONTROL_FRAME_VIDEO_CAPS,
      model: {
        name: "notvace.safetensors",
        path: "D:/models/notvace.safetensors",
      },
    };
    useStore.setState({
      caps: caps as never,
      mode: "vid_gen",
      params: null,
      mainModel: caps.model.path,
      familyOverride: "wan-t2v",
    });
    render(<GenerationUI />);

    await screen.findByRole("button", { name: "生成" });
    expect(screen.queryByRole("button", { name: "添加条件帧" })).toBeNull();
  });
});
