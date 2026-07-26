import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";
import type { ScanResult, Settings } from "../../../types";
import { Dashboard } from "../Dashboard";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  scanModels: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
}));

vi.mock("../../../api", () => ({ api: mocks }));

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

    const model = await screen.findByLabelText("主模型");
    fireEvent.change(model, { target: { value: "/models/main.safetensors" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("还缺");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
  });

  it("allows PATH-based startup for a self-contained model", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    const model = await screen.findByLabelText("主模型");
    fireEvent.change(model, { target: { value: "/models/main.safetensors" } });

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

    const model = await screen.findByLabelText("主模型");
    fireEvent.change(model, { target: { value: "/models/main.safetensors" } });

    await waitFor(() =>
      expect(screen.getByLabelText("自定义 --backend")).toHaveValue("cuda0")
    );
    expect(screen.getByLabelText("CPU 卸载（--offload-to-cpu）")).toBeChecked();
    expect(screen.getByLabelText("加载时量化（--type）")).toHaveValue("q8_0");
    expect(screen.getByLabelText("处理预设")).toHaveValue("krea2_edit");
    expect(screen.getByLabelText("附加启动参数")).toHaveValue("--threads 8");
    expect(screen.getByLabelText("最大队列数量")).toHaveValue(7);
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

    fireEvent.change(await screen.findByLabelText("主模型"), {
      target: { value: "/models/main.safetensors" },
    });
    fireEvent.change(
      await screen.findByLabelText("AnimateDiff Motion Module (可选，仅 SD 1.5)"),
      { target: { value: "/models/mm_sd15_v3.safetensors" } }
    );
    fireEvent.change(screen.getByLabelText("处理预设"), {
      target: { value: "flux_kontext" },
    });
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

    fireEvent.change(await screen.findByLabelText("主模型"), {
      target: { value: "/models/pid_flux1_512_to_2048.safetensors" },
    });

    const format = await screen.findByLabelText("VAE 格式");
    expect(format).toHaveValue("flux");
    fireEvent.change(format, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();

    fireEvent.change(format, { target: { value: "flux" } });
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

    fireEvent.change(await screen.findByLabelText("主模型"), {
      target: { value: "/models/hunyuanvideo1.5_720p_t2v.safetensors" },
    });
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
