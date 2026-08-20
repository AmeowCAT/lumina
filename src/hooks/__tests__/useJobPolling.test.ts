import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { saveEntryPart } from "../useJobPolling";

const mocks = vi.hoisted(() => ({ saveOutput: vi.fn() }));
vi.mock("../../api", () => ({ api: mocks }));

function seedEntry() {
  useStore.setState((state) => ({
    settings: { ...state.settings, outputDir: "/output" },
    results: [
      {
        jobId: "job",
        mode: "img_gen",
        result: {
          output_format: "png",
          images: [
            { index: 0, b64_json: "a" },
            { index: 1, b64_json: "b" },
          ],
        },
      },
    ],
    toasts: [],
  }));
}

describe("saveEntryPart (manual save to output dir)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedEntry();
  });

  it("saves a single image with per-index name and records state", async () => {
    mocks.saveOutput.mockResolvedValue({ saved: true, path: "/output/sdcpp_job_1.png" });

    await saveEntryPart("job", "1");

    expect(mocks.saveOutput).toHaveBeenCalledWith("b", "png", "sdcpp_job_1", "/output");
    expect(useStore.getState().results[0].saves?.["1"]).toEqual({
      status: "saved",
      path: "/output/sdcpp_job_1.png",
    });
  });

  it("prompts when output dir is not configured and writes nothing", async () => {
    useStore.setState((s) => ({ settings: { ...s.settings, outputDir: "" } }));

    await saveEntryPart("job", "0");

    expect(mocks.saveOutput).not.toHaveBeenCalled();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.msg).toContain("未配置输出目录");
  });

  it("marks failure and keeps the error for retry", async () => {
    mocks.saveOutput.mockRejectedValue(new Error("disk full"));

    await saveEntryPart("job", "0");

    const state = useStore.getState().results[0].saves?.["0"];
    expect(state?.status).toBe("failed");
    expect(state?.error).toContain("disk full");
  });

  it("ignores duplicate clicks while already saving", async () => {
    let resolveSave: (v: unknown) => void = () => {};
    mocks.saveOutput.mockReturnValue(new Promise((r) => (resolveSave = r)));

    const first = saveEntryPart("job", "0");
    await Promise.resolve(); // let the first call mark "saving"
    await saveEntryPart("job", "0");
    expect(mocks.saveOutput).toHaveBeenCalledTimes(1);

    resolveSave({ saved: true, path: "/output/x.png" });
    await first;
    expect(useStore.getState().results[0].saves?.["0"]?.status).toBe("saved");
  });

  it("locates images by batch index after a partial removal compacts the array", async () => {
    // 删除批次中的一张后,数组被 compact 但 img.index 保留原值:
    // 位置 0 上是 index=1。按数组下标取图会存成错图(审查 M2 回归)。
    useStore.setState(() => ({
      results: [
        {
          jobId: "job",
          mode: "img_gen" as const,
          result: {
            output_format: "png",
            images: [
              { index: 1, b64_json: "b" },
              { index: 2, b64_json: "c" },
            ],
          },
        },
      ],
    }));
    mocks.saveOutput.mockResolvedValue({ saved: true, path: "/output/x.png" });

    await saveEntryPart("job", "2");
    expect(mocks.saveOutput).toHaveBeenCalledWith("c", "png", "sdcpp_job_2", "/output");

    await saveEntryPart("job", "1");
    expect(mocks.saveOutput).toHaveBeenCalledWith("b", "png", "sdcpp_job_1", "/output");
  });

  it("reports instead of silently returning when the image is gone", async () => {
    mocks.saveOutput.mockResolvedValue({ saved: true, path: "/output/x.png" });

    await saveEntryPart("job", "9");

    expect(mocks.saveOutput).not.toHaveBeenCalled();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.msg).toContain("未找到对应图片");
  });
});
