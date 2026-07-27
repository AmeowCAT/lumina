import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
					saveStatus: "failed",
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
        })
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
        })
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
        })
      )
    );
  });
});
