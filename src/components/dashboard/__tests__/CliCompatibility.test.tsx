import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliCapabilities } from "../../../types";
import { CliCompatibility } from "../CliCompatibility";

const mocks = vi.hoisted(() => ({ inspectServer: vi.fn(), preflightServer: vi.fn() }));
vi.mock("../../../api", () => ({ api: mocks }));
const modern: CliCapabilities = {
  executable: "/bin/sd-server", version: "7f410a3", verified: true,
  options: ["--auto-fit", "--disable-segmented-compute"],
  autoFit: "on-off", memoryMode: "automatic", warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectServer.mockResolvedValue(modern);
  mocks.preflightServer.mockResolvedValue(modern);
});

describe("CLI compatibility inspection", () => {
  it("only probes on request and does not need a model", async () => {
    render(<CliCompatibility exePath="" port={1234} />);
    expect(mocks.inspectServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检测内核兼容性" }));
    expect(await screen.findByRole("status")).toHaveTextContent("7f410a3");
    expect(screen.getByRole("status")).toHaveTextContent("0 不禁用分段");
    expect(mocks.inspectServer).toHaveBeenCalledWith("sd-server");
  });

  it("preflights the current argv without editing saved arguments", async () => {
    const args = { model: "/models/main.gguf", extra_args: "--stream-layers" };
    mocks.preflightServer.mockRejectedValue(new Error("请删除 --stream-layers"));
    render(<CliCompatibility exePath="/new/sd-server" args={args} port={8188} />);
    fireEvent.click(screen.getByRole("button", { name: "检测内核兼容性" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请删除 --stream-layers");
    expect(mocks.preflightServer).toHaveBeenCalledWith("/new/sd-server", args, 8188);
    expect(args.extra_args).toBe("--stream-layers");
  });

  it("shows legacy and unknown help without claiming new semantics", async () => {
    mocks.inspectServer.mockResolvedValue({ ...modern, autoFit: "flag", memoryMode: "legacy" });
    render(<CliCompatibility exePath="/old/sd-server" port={1234} />);
    fireEvent.click(screen.getByRole("button", { name: "检测内核兼容性" }));
    expect(await screen.findByRole("status")).toHaveTextContent("旧版裸开关");
    expect(screen.getByRole("status")).not.toHaveTextContent("0 不禁用分段");
  });

  it("ignores a stale result after the executable changes", async () => {
    let resolve!: (value: CliCapabilities) => void;
    mocks.inspectServer.mockReturnValue(new Promise<CliCapabilities>((r) => { resolve = r; }));
    const { rerender } = render(<CliCompatibility exePath="/old/sd-server" port={1234} />);
    fireEvent.click(screen.getByRole("button", { name: "检测内核兼容性" }));
    rerender(<CliCompatibility exePath="/new/sd-server" port={1234} />);
    await act(async () => resolve(modern));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "检测内核兼容性" })).not.toBeDisabled();
  });
});
