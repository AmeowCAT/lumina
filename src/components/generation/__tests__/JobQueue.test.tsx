import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, Job } from "../../../types";
import { setTheme } from "../../../lib/theme";
import { JobQueue } from "../JobQueue";

function capsWith(cancelGenerating: boolean | undefined): Capabilities {
  return {
    model: { name: "m.safetensors", stem: "m", path: "D:/models/m.safetensors" },
    current_mode: "img_gen",
    supported_modes: ["img_gen"],
    defaults_by_mode: { img_gen: {} },
    output_formats_by_mode: { img_gen: ["png"] },
    features_by_mode: {
      img_gen: cancelGenerating === undefined ? {} : { cancel_generating: cancelGenerating },
    },
    limits: {},
    samplers: [],
    schedulers: [],
    loras: [],
    upscalers: [],
  } as unknown as Capabilities;
}

function generatingJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_ms_1",
    kind: "img_gen",
    status: "generating",
    created: 1_760_000_000_000,
    started: 1_760_000_001_000,
    config: { mode: "img_gen", params: { prompt: "p" } as never },
    ...overrides,
  };
}

const baseProps = {
  activeJobs: 1,
  maxQueue: 4,
  mode: "img_gen" as const,
  onApplyConfig: vi.fn(),
  onCancel: vi.fn(),
  onRemove: vi.fn(),
  onClear: vi.fn(),
  onDownload: vi.fn(async () => undefined),
};

beforeEach(() => {
  baseProps.onCancel.mockClear();
});

afterEach(() => {
  cleanup();
  setTheme("lumina");
});

describe("JobQueue interrupt state", () => {
  it("shows an interrupt-pending state and blocks duplicate cancel requests", () => {
    // 上游 #2190：取消受理后 status 仍是 generating，靠 cancel_requested 表达。
    render(
      <JobQueue
        {...baseProps}
        jobs={[generatingJob({ cancel_requested: true })]}
        caps={capsWith(true)}
      />,
    );
    expect(screen.getByText("中断中…")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "取消任务 job_ms_1" });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(baseProps.onCancel).not.toHaveBeenCalled();
  });

  it("keeps the cancel button available before the request is accepted", () => {
    render(<JobQueue {...baseProps} jobs={[generatingJob()]} caps={capsWith(true)} />);
    expect(screen.getByText("生成中")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "取消任务 job_ms_1" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(baseProps.onCancel).toHaveBeenCalledWith("job_ms_1");
  });

  it("hides the cancel button when the kernel does not advertise cancellation", () => {
    // 旧内核（#2190 之前）capabilities.cancel_generating=false，只剩排队任务可取消。
    render(<JobQueue {...baseProps} jobs={[generatingJob()]} caps={capsWith(false)} />);
    expect(screen.queryByRole("button", { name: "取消任务 job_ms_1" })).toBeNull();
  });
});
