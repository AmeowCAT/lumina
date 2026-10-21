import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Capabilities, Job, ServerStatus } from "../types";
import App from "../App";

/**
 * App 的阶段机（`checking | dashboard | running`）是整个界面唯一的入口判据：
 * 它决定了首屏是骨架、控制台还是生成界面。四类真实回归点：
 *  1. 服务器可达但没有能力信息时**不能**进生成界面（否则 GenerationUI 返回
 *     null，用户看到全黑 = 对抗性审查 M7）。
 *  2. 失联时弹「连接已断开」，但**在控制台里切换模型导致的不可达不许报错**
 *     （审查 20-frontend §2.7：切换模型必然先 stopServer）。
 *  3. 服务器被停（running=false 且非 external）要立刻回控制台，不必等 3 秒轮询。
 *  4. IPC 异常要落在控制台，而不是永远停在骨架。
 *
 * 生成界面与控制台都用桩替换：本文件测的是阶段判定，不测子组件内部。
 * 3 秒轮询用真实定时器（首帧的 check() 是同步触发的），用例都在下一跳之前结束。
 */
const mocks = vi.hoisted(() => ({
  serverStatus: vi.fn(),
  sdcppCapabilities: vi.fn(),
  sdcppSubmit: vi.fn(),
  sdcppJob: vi.fn(),
  sdcppCancel: vi.fn(),
  detectFamily: vi.fn(),
}));

vi.mock("../api", () => ({ api: mocks }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));
vi.mock("../lib/systemIntegration", () => ({
  setTaskbarProgress: vi.fn(),
  flashWindow: vi.fn(),
  notifyIfUnfocused: vi.fn(),
}));
vi.mock("../components/generation/GenerationUI", () => ({
  GenerationUI: () => <div data-testid="generation-ui" />,
}));
vi.mock("../components/dashboard/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard" />,
}));

const caps = (): Capabilities => ({
  model: { name: "测试模型", stem: "test", path: "/models/test.safetensors" },
  current_mode: "",
  supported_modes: [],
  defaults_by_mode: {},
  limits: {},
  samplers: [],
  schedulers: [],
  output_formats_by_mode: {},
  features_by_mode: {},
  loras: [],
  upscalers: [],
});

const status = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  running: true,
  reachable: true,
  external: false,
  pid: 4321,
  model: "测试模型",
  sdPort: 1234,
  phase: "ready",
  startedAt: 1_000,
  ...over,
});

/** 最后一次 toast（阶段机的用户可见后果几乎都体现在这里） */
const lastToast = () => {
  const toasts = useStore.getState().toasts;
  return toasts[toasts.length - 1];
};

const errorToasts = () => useStore.getState().toasts.filter((t) => t.error);

beforeEach(() => {
  mocks.serverStatus.mockReset().mockResolvedValue(status());
  mocks.sdcppCapabilities.mockReset().mockResolvedValue(caps());
  mocks.sdcppJob.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.sdcppSubmit.mockReset();
  mocks.sdcppCancel.mockReset();
  mocks.detectFamily.mockReset().mockResolvedValue("custom");
  useStore.setState({
    serverStatus: null,
    caps: null,
    dashboardOpen: false,
    jobs: [],
    results: [],
    toasts: [],
    logs: [],
    mode: "img_gen",
    progressStep: 0,
    progressTotal: 0,
    progressStartedAt: 0,
  });
});

afterEach(() => {
  cleanup();
});

describe("App 阶段机", () => {
  it("首帧显示检查中骨架（splash）", () => {
    // 状态查询悬挂不返回：阶段停在 checking。
    mocks.serverStatus.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(
      screen.getByText(/正在检查启动器和服务器状态/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("generation-ui")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });

  it("服务器可达且能力就绪 → 进入生成界面，并提示服务器就绪", async () => {
    render(<App />);

    expect(await screen.findByTestId("generation-ui")).toBeInTheDocument();
    await waitFor(() => expect(useStore.getState().caps).not.toBeNull());
    expect(lastToast()?.msg).toContain("服务器就绪");
  });

  it("可达但取不到能力信息 → 退回控制台并给出可读提示（不让主界面空白，M7）", async () => {
    mocks.sdcppCapabilities.mockRejectedValue(new Error("still loading"));

    render(<App />);

    // 能力拿不到时不能进入 running（GenerationUI 无 params 会返回 null）。
    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("generation-ui")).not.toBeInTheDocument();
    expect(lastToast()?.msg).toContain("无法获取服务器能力信息");
    expect(lastToast()?.error).toBe(true);
  });

  it("在工作室里失联 → 报「连接已断开」并清空能力信息", async () => {
    useStore.setState({ caps: caps(), dashboardOpen: false });
    mocks.serverStatus.mockResolvedValue(
      status({ running: false, reachable: false, external: false, phase: "stopped" })
    );

    render(<App />);

    await waitFor(() => expect(useStore.getState().caps).toBeNull());
    expect(lastToast()?.msg).toContain("与服务器的连接已断开");
    expect(lastToast()?.error).toBe(true);
    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("在控制台里切模型导致的不可达 → 静默清空能力，不弹假错误（§2.7 回归）", async () => {
    useStore.setState({ caps: caps(), dashboardOpen: true });
    mocks.serverStatus.mockResolvedValue(
      status({ running: false, reachable: false, external: false, phase: "stopped" })
    );

    render(<App />);

    await waitFor(() => expect(useStore.getState().caps).toBeNull());
    // 切换模型必然先 stopServer；此时报错是假错误。
    expect(errorToasts()).toHaveLength(0);
  });

  it("运行中服务器被停止（running=false 且非 external）→ 立刻切回控制台", async () => {
    render(<App />);
    await screen.findByTestId("generation-ui");

    act(() => {
      useStore.setState({
        serverStatus: status({ running: false, reachable: false, phase: "stopped" }),
      });
    });

    // 不必等 3 秒轮询：store 变化后 effect 立刻收尾。
    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("生成中服务器被停止 → 回控制台但保留任务记录（收割由 App 级轮询负责）", async () => {
    const generating: Job = { id: "job-1", kind: "vid_gen", status: "generating" };
    useStore.setState({ jobs: [generating] });

    render(<App />);
    await screen.findByTestId("generation-ui");

    act(() => {
      useStore.setState({
        serverStatus: status({ running: false, reachable: false, phase: "stopped" }),
      });
    });

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
    expect(useStore.getState().jobs.map((job) => job.id)).toEqual(["job-1"]);
  });

  it("状态查询 IPC 抛错 → 落到控制台，不卡在骨架", async () => {
    mocks.serverStatus.mockRejectedValue(new Error("ipc unavailable"));

    render(<App />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("dashboardOpen=true 时即使能力就绪也不进入生成界面", async () => {
    useStore.setState({ dashboardOpen: true });

    render(<App />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
    await waitFor(() => expect(useStore.getState().caps).not.toBeNull());
    expect(screen.queryByTestId("generation-ui")).not.toBeInTheDocument();
  });

  it("失联后恢复（可达 + 能力就绪）→ 回到生成界面", async () => {
    mocks.serverStatus.mockResolvedValue(
      status({ running: false, reachable: false, external: false, phase: "stopped" })
    );

    render(<App />);
    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();

    // 服务器重新就绪：store 被轮询/事件更新，阶段机应自动回到 running。
    act(() => {
      useStore.setState({ caps: caps(), serverStatus: status() });
    });

    expect(await screen.findByTestId("generation-ui")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });
});
