import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Capabilities } from "../../types";
import { capabilitiesMatchModel, useModelSwitch } from "../useModelSwitch";
import { useStore } from "../../store";

const mocks = vi.hoisted(() => ({
  preflightServer: vi.fn(), stopServer: vi.fn(), startServer: vi.fn(), detectFamily: vi.fn(),
  serverStatus: vi.fn(), sdcppCapabilities: vi.fn(),
}));
vi.mock("../../api", () => ({ api: mocks }));

const caps = (path?: string, name = "Flux Model") =>
  ({ model: { path, name } }) as Capabilities;

describe("model switch preflight", () => {
  it("keeps the current model running when new CLI arguments are invalid", async () => {
    vi.clearAllMocks();
    mocks.preflightServer.mockRejectedValue(new Error("请更新裸 --auto-fit"));
    useStore.setState({
      familyOverride: "hidream",
      components: {},
      caps: caps("/models/previous.safetensors"),
      settings: { ...useStore.getState().settings, exeDir: "/bin/sd-server", extraArgs: "--auto-fit", modelSnapshots: {} },
    });
    const { result } = renderHook(() => useModelSwitch());
    await act(async () => { await result.current.switchModel("/models/next.safetensors"); });
    expect(mocks.preflightServer).toHaveBeenCalled();
    expect(mocks.stopServer).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(useStore.getState().caps?.model.path).toBe("/models/previous.safetensors");
    expect(result.current.phase).toBe("idle");
  });
});

describe("model switch runtime settings", () => {
  it.each(["8", "0"])("passes tokenizer, SageAttention and cache size %s through preflight and startup", async (cacheSize) => {
    vi.resetAllMocks();
    mocks.preflightServer.mockResolvedValue({ warnings: [] });
    mocks.stopServer.mockResolvedValue({ stopped: true });
    mocks.startServer.mockResolvedValue({ pid: 1 });
    mocks.serverStatus.mockResolvedValue({ reachable: true });
    mocks.sdcppCapabilities.mockResolvedValue(caps("/models/next.safetensors"));
    useStore.setState({
      familyOverride: "llada-image",
      components: { vae: "/models/vae", llm: "/models/llm", embeddings: "/models/connectors" },
      caps: caps("/models/previous.safetensors"),
      settings: { ...useStore.getState().settings, exeDir: "/bin/sd-server", extraArgs: "",
        tokenizer: "/models/tokenizer.json", sageAttn: true, conditioningCacheSize: cacheSize,
        modelSnapshots: { "/models/previous.safetensors": {
          familyOverride: "hidream", components: {}, backend: "", refImagePreset: "", extraArgs: "",
          offloadCpu: false, quantType: "", maxQueueSize: 4,
        } },
      },
    });
    const { result } = renderHook(() => useModelSwitch());
    await act(async () => {
      expect(await result.current.switchModel("/models/next.safetensors")).toBe("llada-image");
    });
    const expected = { tokenizer: "/models/tokenizer.json", "sage-attn": true, "conditioning-cache-size": Number(cacheSize) };
    expect(mocks.preflightServer).toHaveBeenCalledTimes(1);
    expect(mocks.preflightServer.mock.calls[0][1]).toMatchObject(expected);
    expect(mocks.startServer).toHaveBeenCalledTimes(1);
    expect(mocks.startServer.mock.calls[0][3]).toMatchObject(expected);
    expect(useStore.getState().caps?.model.path).toBe("/models/next.safetensors");
  });
});

describe("model switch rollback safety", () => {
  it("restores the old tokenizer and runtime flags from its own complete snapshot", async () => {
    vi.resetAllMocks();
    mocks.preflightServer.mockResolvedValue({ warnings: [] });
    mocks.stopServer.mockResolvedValue({ stopped: true });
    mocks.startServer.mockRejectedValueOnce(new Error("load failed")).mockResolvedValueOnce({ pid: 1 });
    mocks.serverStatus.mockResolvedValue({ reachable: true });
    mocks.sdcppCapabilities.mockResolvedValue(caps("/models/previous.safetensors"));
    useStore.setState({
      familyOverride: "hidream", components: {}, caps: caps("/models/previous.safetensors"),
      settings: { ...useStore.getState().settings, extraArgs: "", tokenizer: "/target/tokenizer.json",
        sageAttn: true, conditioningCacheSize: "8",
        modelSnapshots: { "/models/previous.safetensors": {
          familyOverride: "llada-image", components: { vae: "/old/vae", llm: "/old/llm", embeddings: "/old/connectors" },
          backend: "", refImagePreset: "", extraArgs: "", offloadCpu: false, quantType: "", maxQueueSize: 4,
          tokenizer: "/old/tokenizer.json", sageAttn: false, conditioningCacheSize: "0",
        } },
      },
    });
    const { result } = renderHook(() => useModelSwitch());
    await act(async () => { await result.current.switchModel("/models/next.safetensors"); });
    expect(mocks.startServer).toHaveBeenCalledTimes(2);
    expect(mocks.startServer.mock.calls[1][3]).toMatchObject({
      tokenizer: "/old/tokenizer.json", "conditioning-cache-size": 0,
      "diffusion-model": "/models/previous.safetensors", vae: "/old/vae", llm: "/old/llm",
    });
    expect(mocks.startServer.mock.calls[1][3]).not.toHaveProperty("sage-attn");
    expect(useStore.getState().caps?.model.path).toBe("/models/previous.safetensors");
  });

  it.each(["missing snapshot", "legacy tokenizer", "empty tokenizer"])("preserves the running model with %s instead of borrowing target settings", async (scenario) => {
    vi.resetAllMocks();
    mocks.preflightServer.mockResolvedValue({ warnings: [] });
    const snapshot = {
      familyOverride: "llada-image", components: { vae: "/old/vae", llm: "/old/llm", embeddings: "/old/connectors" },
      backend: "", refImagePreset: "", extraArgs: "", offloadCpu: false, quantType: "", maxQueueSize: 4,
      ...(scenario === "empty tokenizer" ? { tokenizer: "" } : {}),
    };
    useStore.setState({
      familyOverride: "hidream", components: {}, caps: caps("/models/previous.safetensors"),
      settings: { ...useStore.getState().settings, extraArgs: "", tokenizer: "/target/wrong-tokenizer.json",
        modelSnapshots: scenario === "missing snapshot" ? {} : { "/models/previous.safetensors": snapshot },
      },
    });
    const toast = vi.spyOn(useStore.getState(), "toast");
    try {
      const { result } = renderHook(() => useModelSwitch());
      await act(async () => { expect(await result.current.switchModel("/models/next.safetensors")).toBeUndefined(); });
      expect(mocks.stopServer).not.toHaveBeenCalled();
      expect(mocks.startServer).not.toHaveBeenCalled();
      expect(useStore.getState().caps?.model.path).toBe("/models/previous.safetensors");
      expect(result.current.phase).toBe("idle");
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("已保留运行中的模型"), true);
    } finally {
      toast.mockRestore();
    }
  });
});

describe("model switch diagnostic snapshots", () => {
  it("passes the next diagnostics and restores the previous snapshot on rollback", async () => {
    vi.clearAllMocks();
    mocks.preflightServer.mockResolvedValue({ warnings: [] });
    mocks.detectFamily.mockResolvedValue("hidream");
    mocks.stopServer.mockResolvedValue({ stopped: true });
    mocks.startServer.mockRejectedValueOnce(new Error("load failed")).mockResolvedValueOnce({ pid: 1 });
    mocks.serverStatus.mockResolvedValue({ reachable: true });
    mocks.sdcppCapabilities.mockResolvedValue(caps("/models/previous.safetensors"));
    useStore.setState({
      familyOverride: "hidream", components: {}, caps: caps("/models/previous.safetensors"),
      settings: { ...useStore.getState().settings, exeDir: "/bin/sd-server", extraArgs: "",
        logLevel: "debug", linearScale: "0.5", attnScale: "0.5",
        tokenizer: "/target/tokenizer.json", sageAttn: true, conditioningCacheSize: "8",
        modelSnapshots: { "/models/previous.safetensors": {
          familyOverride: "hidream", components: {}, backend: "", refImagePreset: "", extraArgs: "",
          offloadCpu: false, quantType: "", maxQueueSize: 4, logLevel: "warn", linearScale: "0.25",
        } },
      },
    });
    const { result } = renderHook(() => useModelSwitch());
    await act(async () => { await result.current.switchModel("/models/next.safetensors"); });
    expect(mocks.startServer).toHaveBeenCalledTimes(2);
    expect(mocks.startServer.mock.calls[0][3]).toMatchObject({ "log-level": "debug", "linear-scale": "0.5", "attn-scale": "0.5" });
    expect(mocks.startServer.mock.calls[1][3]).toMatchObject({ "log-level": "warn", "linear-scale": "0.25" });
    expect(mocks.startServer.mock.calls[1][3]).not.toHaveProperty("attn-scale");
    expect(mocks.startServer.mock.calls[1][3]).not.toHaveProperty("tokenizer");
    expect(mocks.startServer.mock.calls[1][3]).not.toHaveProperty("sage-attn");
    expect(mocks.startServer.mock.calls[1][3]).not.toHaveProperty("conditioning-cache-size");
    expect(useStore.getState().caps?.model.path).toBe("/models/previous.safetensors");
  });
});

describe("model switch readiness", () => {
  it("accepts capabilities that only expose a display name", () => {
    expect(capabilitiesMatchModel(caps(undefined), "D:/models/flux.safetensors")).toBe(true);
  });

  it("matches reported paths across slash and case differences", () => {
    expect(
      capabilitiesMatchModel(
        caps("d:\\MODELS\\flux.safetensors"),
        "D:/models/flux.safetensors"
      )
    ).toBe(true);
  });

  it("rejects an explicitly reported different model path", () => {
    expect(
      capabilitiesMatchModel(
        caps("D:/models/other.safetensors"),
        "D:/models/flux.safetensors"
      )
    ).toBe(false);
  });
});
