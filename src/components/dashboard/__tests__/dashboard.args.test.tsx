// 注意：本 import 必须排在 `../Dashboard` 之前——`vi.mock` 的工厂要读 kit 里的
// `mocks`，而 Vite SSR 按 import 源码顺序求值，kit 必须先完成初始化。
import { mocks, pickOption, resetDashboard, scanFor, settings } from "./dashboardTestKit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

// 提升到文件顶层的 vi.mock 不能进共享 kit，否则 mock 不生效。
vi.mock("../../../api", () => ({ api: mocks }));
vi.mock("../../../hooks/useModelSwitch", () => ({
  useModelSwitch: () => ({
    switchModel: mocks.switchModel,
    switching: false,
    phase: "",
  }),
}));

describe("Dashboard launch arguments", () => {
  beforeEach(resetDashboard);

  // 审查 40-cli §2.5：附加启动参数原本是纯自由文本，拼错要到启动失败才发现。
  // 内核 `--help` 里的选项名现在进 datalist，输入框因此可以补全。
  it("offers the kernel's own option names as extra-arg suggestions", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    await waitFor(() => {
      const list = document.getElementById(
        "dashboard-extra-arg-options"
      ) as HTMLDataListElement | null;
      expect(list).toBeTruthy();
      expect([...list!.options].map((o) => o.value)).toContain("--threads");
    });
    expect(screen.getByLabelText("附加启动参数").getAttribute("list")).toBe(
      "dashboard-extra-arg-options"
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

  // 上游 #1874（taeh3）起 MiniMax-H3 也能用 TAE；GUI 对所有非 FakeVAE 家族
  // 都暴露可选的 TAE 组件，并把选中的权重作为 --taesd 传给 sd-server。
  it("passes the optional TAE weights to sd-server with its weight hint shown", async () => {
    const scan = scanFor("sd");
    scan.files.push({
      name: "taesd.safetensors",
      stem: "taesd",
      path: "/models/taesd.safetensors",
      relPath: "taesd.safetensors",
      sizeMb: 5,
      dir: "/models",
      ext: "safetensors",
      category: "taesd",
    });
    scan.count = 2;
    mocks.scanModels.mockResolvedValue(scan);
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await pickOption("TAE 快速解码 (可选)", "taesd.safetensors (5 MB)");

    // 组件说明（该家族该用哪种 TAE 权重）必须可见，否则用户只能靠猜。
    expect(screen.getByText(/taesd（SD 1\.x/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "SD 1.x / 2.x",
        null,
        expect.objectContaining({ taesd: "/models/taesd.safetensors" }),
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
    // 上游 #1974：PiD / Lens 不再内嵌词表，VAE 格式齐全但没有 tokenizer 仍不能启动。
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
    expect(screen.getByLabelText("Tokenizer")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tokenizer"), {
      target: { value: "/models/tokenizer_gemma2.json" },
    });
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
          tokenizer: "/models/tokenizer_gemma2.json",
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
          "flash-attn": "off,diffusion=on",
        }),
        1234
      )
    );
  });

  // 审查 §2.9：--threads / --params-backend / --rpc-servers 三个参数此前只能手写
  // 在「附加启动参数」里（且拼错要到启动瞬间才发现）。语义见上游 common.cpp：
  // --threads 在 threads <= 0 时由内核取 CPU 物理核数，所以 0 就是「不传」。
  it("passes --threads only for a positive core count", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    const threads = screen.getByLabelText("计算线程数");
    await userEvent.clear(threads);
    await userEvent.type(threads, "8");
    fireEvent.blur(threads);

    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({ threads: 8 }),
        1234
      )
    );
  });

  it("omits --threads by default so the kernel picks physical cores", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() => expect(mocks.startServer).toHaveBeenCalled());
    const args = mocks.startServer.mock.calls[0][3] as Record<string, unknown>;
    expect(args).not.toHaveProperty("threads");
  });

  it("passes --params-backend and blocks device lists before launch", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    const paramsBackend = screen.getByLabelText("参数驻留后端（--params-backend）");
    // 上游 --params-backend 明确不接受 `&` 设备列表（docs/backend.md），
    // 拦在 GO/NO-GO 而不是让 sd-server 启动即退。
    fireEvent.change(paramsBackend, { target: { value: "te=cpu&cuda0" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled()
    );

    fireEvent.change(paramsBackend, { target: { value: "te=cpu,vae=cpu" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({ "params-backend": "te=cpu,vae=cpu" }),
        1234
      )
    );
  });

  it("passes --rpc-servers endpoints and rejects a malformed port", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    mocks.startServer.mockResolvedValue({ pid: 123 });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    const rpcServers = screen.getByLabelText("RPC 服务器（--rpc-servers）");
    // 上游对连不上的端点只打日志、不中止启动，写错端口表现为"多机显卡没出现"。
    fireEvent.change(rpcServers, { target: { value: "127.0.0.1" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled()
    );

    fireEvent.change(rpcServers, {
      target: { value: "127.0.0.1:50052,192.168.1.10:50052" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /启动服务器/ }));

    await waitFor(() =>
      expect(mocks.startServer).toHaveBeenCalledWith(
        "sd-server",
        "HiDream-O1",
        null,
        expect.objectContaining({
          "rpc-servers": "127.0.0.1:50052,192.168.1.10:50052",
        }),
        1234
      )
    );
  });
});
