import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";
import type { Capabilities, ScanResult, Settings } from "../../../types";
import { Dashboard } from "../Dashboard";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  scanModels: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  switchModel: vi.fn(),
}));

vi.mock("../../../api", () => ({ api: mocks }));
vi.mock("../../../hooks/useModelSwitch", () => ({
  useModelSwitch: () => ({
    switchModel: mocks.switchModel,
    switching: false,
    phase: "",
  }),
}));

const settings: Settings = {
  exeDir: "",
  modelDir: "/models",
  outputDir: "",
  backend: "",
  refImagePreset: "",
  vaeFormat: "",
  extraArgs: "",
  offloadCpu: false,
  quantType: "",
  maxQueueSize: 4,
  sdPort: 1234,
  modelSnapshots: {},
};

function scanFor(family: string): ScanResult {
  return {
    baseDir: "/models",
    count: 1,
    families: { "/models/main.safetensors": family },
    files: [
      {
        name: "main.safetensors",
        stem: "main",
        path: "/models/main.safetensors",
        relPath: "main.safetensors",
        sizeMb: 1024,
        dir: "/models",
        ext: "safetensors",
        category: "model",
      },
    ],
    warnings: [],
    truncated: false,
    partial: false,
  };
}

// Radix Select 是组合控件而非表单元素：点击触发器展开，再点击目标选项。
async function pickOption(label: string, optionName: string | RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(label));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

describe("Dashboard onboarding validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSettings.mockResolvedValue(settings);
    mocks.saveSettings.mockResolvedValue(undefined);
    useStore.setState({
      settings,
      scanResult: null,
      mainModel: "",
      familyOverride: "",
      components: {},
      serverStatus: null,
      dashboardOpen: true,
    });
  });

  it("blocks startup and lists missing required split-model components", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("flux"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    expect(await screen.findByRole("alert")).toHaveTextContent("还缺");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
  });

  it("allows PATH-based startup for a self-contained model", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).not.toBeDisabled()
    );
  });

  it("half-supports MiniMax-H3 Ref2VA without an unsupported banner", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("minimax-h3-ref2va"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    // 半支持：不再显示"暂不支持"横幅，家族下拉也没有"（暂不支持）"后缀。
    expect(screen.queryByText(/暂不支持/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("识别类型")).not.toHaveTextContent("暂不支持");
    // 检查单退回常规组件缺口把关（Ref2VA 需要视频 VAE + LLM，此处只给了主模型）。
    expect(await screen.findByRole("alert")).toHaveTextContent("还缺");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it("restores the latest snapshot when a configured model is selected", async () => {
    const configured = {
      ...settings,
      modelSnapshots: {
        "/models/main.safetensors": {
          familyOverride: "hidream",
          components: {},
          backend: "cuda0",
          refImagePreset: "krea2_edit",
          extraArgs: "--threads 8",
          offloadCpu: true,
          quantType: "q8_0",
          maxQueueSize: 7,
        },
      },
    };
    mocks.loadSettings.mockResolvedValue(configured);
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    await waitFor(() =>
      expect(screen.getByLabelText("自定义 --backend")).toHaveValue("cuda0")
    );
    expect(screen.getByLabelText("CPU 卸载（--offload-to-cpu）")).toBeChecked();
    expect(screen.getByLabelText("加载时量化（--type）")).toHaveTextContent("Q8_0");
    expect(screen.getByLabelText("处理预设")).toHaveTextContent("Krea2 Edit 768");
    expect(screen.getByLabelText("附加启动参数")).toHaveValue("--threads 8");
    expect(screen.getByLabelText("最大队列数量")).toHaveValue(7);
  });

  it("records component config on change and restores it after switching away and back", async () => {
    // 回归：快照曾只在启动成功后保存，且切换路径的防抖保存会随 Dashboard
    // 卸载被丢弃——"选中后组件配置没有记录并沿用"的根因。这里验证：
    // 组件变更即记录快照；切到别的模型再切回时组件配置被恢复。
    const baseFile = scanFor("flux").files[0];
    const twoModels: ScanResult = {
      ...scanFor("flux"),
      count: 4,
      families: {
        "/models/a.safetensors": "flux",
        "/models/b.safetensors": "flux",
      },
      files: [
        { ...baseFile, name: "a.safetensors", stem: "a", path: "/models/a.safetensors" },
        { ...baseFile, name: "b.safetensors", stem: "b", path: "/models/b.safetensors" },
        { ...baseFile, name: "ae1.sft", stem: "ae1", path: "/models/ae1.sft", category: "vae" },
        { ...baseFile, name: "ae2.sft", stem: "ae2", path: "/models/ae2.sft", category: "vae" },
      ],
    };
    mocks.scanModels.mockResolvedValue(twoModels);
    render(<Dashboard />);

    await pickOption("主模型", "a.safetensors (1.0 GB)");
    // 两个 VAE 候选：自动补选不生效，组件初始为空。
    expect(useStore.getState().components).toEqual({});

    // 用户在组件面板选择 VAE → 快照立即记录当前模型配置。
    act(() =>
      useStore.getState().setComponents(() => ({ vae: "/models/ae1.sft" }))
    );
    await waitFor(() => {
      const snap =
        useStore.getState().settings.modelSnapshots["/models/a.safetensors"];
      expect(snap?.components).toEqual({ vae: "/models/ae1.sft" });
    });

    // 切到 b（无快照、组件清空）再切回 a：配置被恢复。
    await pickOption("主模型", "b.safetensors (1.0 GB)");
    expect(useStore.getState().components).toEqual({});
    await pickOption("主模型", "a.safetensors (1.0 GB)");
    await waitFor(() =>
      expect(useStore.getState().components).toEqual({ vae: "/models/ae1.sft" })
    );
  });

	it("echoes a custom --backend value in the preset select", async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			backend: "clip=cpu,diffusion=cuda0",
		});
		mocks.scanModels.mockResolvedValue(scanFor("hidream"));
		render(<Dashboard />);

		expect(await screen.findByLabelText("后端预设")).toHaveTextContent(
			"自定义（clip=cpu,diffusion=cuda0）",
		);
	});

	it("confirms a model switch inline when results are unsaved", async () => {
		mocks.switchModel.mockResolvedValue(true);
		mocks.scanModels.mockResolvedValue(scanFor("hidream"));
		useStore.setState({
			serverStatus: {
				running: true,
				reachable: true,
				external: false,
				pid: 42,
				model: "/models/old.safetensors",
				sdPort: 7860,
				phase: "ready",
			},
			caps: {
				model: {
					name: "old.safetensors",
					stem: "old",
					path: "/models/old.safetensors",
				},
			} as Capabilities,
			results: [
				{
					jobId: "j1",
					mode: "img_gen",
					result: {
						output_format: "png",
						images: [{ index: 0, b64_json: "eA==" }],
					},
					saves: { "0": { status: "failed", error: "disk full" } },
				},
			],
			jobs: [],
		});
		render(<Dashboard />);

		await pickOption("主模型", "main.safetensors (1.0 GB)");
		fireEvent.click(
			await screen.findByRole("button", { name: /切换到此模型/ }),
		);

		// 不直接切换,先在启动坞弹出影响确认条
		expect(mocks.switchModel).not.toHaveBeenCalled();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"尚未安全保存",
		);

		fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
		await waitFor(() =>
			expect(mocks.switchModel).toHaveBeenCalledWith(
				"/models/main.safetensors",
			),
		);
	});

	it("passes AnimateDiff and reference-image presets to sd-server", async () => {
    const scan = scanFor("sd");
    scan.files.push({
      name: "mm_sd15_v3.safetensors",
      stem: "mm_sd15_v3",
      path: "/models/mm_sd15_v3.safetensors",
      relPath: "mm_sd15_v3.safetensors",
      sizeMb: 836,
      dir: "/models",
      ext: "safetensors",
      category: "motion_module",
    });
    scan.count = 2;
    mocks.scanModels.mockResolvedValue(scan);
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await pickOption(
      "AnimateDiff Motion Module (可选，仅 SD 1.5)",
      "mm_sd15_v3.safetensors (836 MB)"
    );
    await pickOption("处理预设", "Flux Kontext");
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "SD 1.x / 2.x",
        null,
        expect.objectContaining({
          model: "/models/main.safetensors",
          "motion-module": "/models/mm_sd15_v3.safetensors",
          "ref-image-args": "preset=flux_kontext",
        }),
        1234
      )
    );
  });

  it("launches sd-server on the port configured in the dashboard", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("sd"));
    mocks.startServer.mockResolvedValue({ pid: 123, sdPort: 8188 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    const port = screen.getByLabelText("sd-server 启动端口");
    await userEvent.clear(port);
    await userEvent.type(port, "8188");
    fireEvent.blur(port);
    await waitFor(() => expect(port).toHaveValue(8188));

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "SD 1.x / 2.x",
        null,
        expect.objectContaining({ model: "/models/main.safetensors" }),
        8188
      )
    );
  });

  it("omits --max-vram unless a budget mode is chosen", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() => expect(mocks.startServer).toHaveBeenCalled());
    const args = mocks.startServer.mock.calls[0][3];
    expect(args).not.toHaveProperty("max-vram");
  });

  it("passes a fixed --max-vram budget to sd-server", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await pickOption("显存预算（--max-vram）", "固定预算（GiB）");

    const budget = screen.getByLabelText("显存预算 GiB");
    // 联动输入框与模式下拉必须在同一行（同一 flex 父容器）——此前各自块级
    // 换行 + margin 造成异常缩进的回归守卫。
    expect(budget.parentElement).toBe(
      screen.getByLabelText("显存预算（--max-vram）").parentElement
    );
    await userEvent.clear(budget);
    await userEvent.type(budget, "7.5");
    fireEvent.blur(budget);
    await waitFor(() => expect(budget).toHaveValue(7.5));

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({ "max-vram": "7.5" }),
        1234
      )
    );
  });

  it("passes a negative --max-vram for the auto-reserve mode", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await pickOption("显存预算（--max-vram）", "自动探测（保留空闲余量）");

    const reserve = screen.getByLabelText("保留的空闲显存 GiB");
    await userEvent.clear(reserve);
    await userEvent.type(reserve, "3");
    fireEvent.blur(reserve);
    await waitFor(() => expect(reserve).toHaveValue(3));

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({ "max-vram": "-3" }),
        1234
      )
    );
  });

  it("passes per-device --max-vram assignments through verbatim", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await pickOption("显存预算（--max-vram）", "按设备自定义");

    const custom = screen.getByLabelText("按设备自定义显存预算");
    await userEvent.type(custom, "cuda0=6,vulkan0=4");

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({ "max-vram": "cuda0=6,vulkan0=4" }),
        1234
      )
    );
  });

  it("clamps an out-of-range port back into the allowed span", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("sd"));
    mocks.startServer.mockResolvedValue({ pid: 123, sdPort: 1024 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    const port = screen.getByLabelText("sd-server 启动端口");
    await userEvent.clear(port);
    await userEvent.type(port, "80");
    fireEvent.blur(port);
    // NumberInput clamps to `min` on commit, so a privileged port never reaches
    // the backend's own validation.
    await waitFor(() => expect(port).toHaveValue(1024));

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "SD 1.x / 2.x",
        null,
        expect.anything(),
        1024
      )
    );
  });

  it("requires and passes the PiD VAE format", async () => {
    const scan = scanFor("pid");
    scan.files[0] = {
      ...scan.files[0],
      name: "pid_flux1_512_to_2048.safetensors",
      stem: "pid_flux1_512_to_2048",
      path: "/models/pid_flux1_512_to_2048.safetensors",
    };
    scan.families = { [scan.files[0].path]: "pid" };
    scan.files.push(
      {
        name: "ae.sft",
        stem: "ae",
        path: "/models/ae.sft",
        relPath: "ae.sft",
        sizeMb: 160,
        dir: "/models",
        ext: "sft",
        category: "vae",
      },
      {
        name: "gemma_2_2b.safetensors",
        stem: "gemma_2_2b",
        path: "/models/gemma_2_2b.safetensors",
        relPath: "gemma_2_2b.safetensors",
        sizeMb: 900,
        dir: "/models",
        ext: "safetensors",
        category: "llm",
      }
    );
    scan.count = scan.files.length;
    mocks.scanModels.mockResolvedValue(scan);
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "pid_flux1_512_to_2048.safetensors (1.0 GB)");

    const format = await screen.findByLabelText("VAE 格式");
    expect(format).toHaveTextContent("Flux / Z-Image（flux）");
    await pickOption("VAE 格式", "-- 必需，请匹配 PiD 模型 --");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();

    await pickOption("VAE 格式", "Flux / Z-Image（flux）");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "PiD / PiD 1.5",
        null,
        expect.objectContaining({
          "diffusion-model": "/models/pid_flux1_512_to_2048.safetensors",
          vae: "/models/ae.sft",
          llm: "/models/gemma_2_2b.safetensors",
          "vae-format": "flux",
        }),
        1234
      )
    );
  });

  it("passes HunyuanVideo's split components and video launch mode", async () => {
    const scan = scanFor("hunyuan-video");
    scan.files[0] = {
      ...scan.files[0],
      name: "hunyuanvideo1.5_720p_t2v.safetensors",
      stem: "hunyuanvideo1.5_720p_t2v",
      path: "/models/hunyuanvideo1.5_720p_t2v.safetensors",
    };
    scan.families = { [scan.files[0].path]: "hunyuan-video" };
    scan.files.push(
      {
        name: "hunyuanvideo15_vae.safetensors",
        stem: "hunyuanvideo15_vae",
        path: "/models/hunyuanvideo15_vae.safetensors",
        relPath: "hunyuanvideo15_vae.safetensors",
        sizeMb: 900,
        dir: "/models",
        ext: "safetensors",
        category: "vae",
      },
      {
        name: "qwen_2.5_vl_7b.safetensors",
        stem: "qwen_2.5_vl_7b",
        path: "/models/qwen_2.5_vl_7b.safetensors",
        relPath: "qwen_2.5_vl_7b.safetensors",
        sizeMb: 900,
        dir: "/models",
        ext: "safetensors",
        category: "llm",
      },
      {
        name: "byt5_small_glyphxl_fp16.safetensors",
        stem: "byt5_small_glyphxl_fp16",
        path: "/models/byt5_small_glyphxl_fp16.safetensors",
        relPath: "byt5_small_glyphxl_fp16.safetensors",
        sizeMb: 800,
        dir: "/models",
        ext: "safetensors",
        category: "t5xxl",
      }
    );
    scan.count = scan.files.length;
    mocks.scanModels.mockResolvedValue(scan);
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "hunyuanvideo1.5_720p_t2v.safetensors (1.0 GB)");
    fireEvent.click(await screen.findByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HunyuanVideo 1.5",
        "vid_gen",
        expect.objectContaining({
          "diffusion-model": "/models/hunyuanvideo1.5_720p_t2v.safetensors",
          vae: "/models/hunyuanvideo15_vae.safetensors",
          llm: "/models/qwen_2.5_vl_7b.safetensors",
          t5xxl: "/models/byt5_small_glyphxl_fp16.safetensors",
          "diffusion-fa": true,
        }),
        1234
      )
    );
  });
});
