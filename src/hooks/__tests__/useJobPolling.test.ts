import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { saveEntryPart, trimResultsToBudget } from "../useJobPolling";

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

describe("trimResultsToBudget（按字节的内存上限）", () => {
  const entry = (
    jobId: string,
    b64: string,
    images: { index: number; b64_json: string }[] = []
  ) =>
    ({
      jobId,
      mode: "img_gen",
      result: { b64_json: b64, images: images.length ? images : undefined },
    }) as never as import("../../store").ResultEntry;

  it("caps by count when the byte budget is not exceeded", () => {
    const arr = [entry("a", "x"), entry("b", "y"), entry("c", "z"), entry("d", "w")];
    const trimmed = trimResultsToBudget(arr, 3, 1000);
    expect(trimmed.map((e) => e.jobId)).toEqual(["a", "b", "c"]);
  });

  it("evicts oldest results when the byte budget is exceeded", () => {
    // 每条 ≈ 75 字节（"A".repeat(100) → 4 字节约 3 字节），三条共 225 字节。
    const big = "A".repeat(100);
    const arr = [
      entry("new", big),
      entry("mid", big),
      entry("old", big),
    ];
    // 预算 150 字节 → 只挤出最旧的一条。
    const trimmed = trimResultsToBudget(arr, 60, 150);
    expect(trimmed.map((e) => e.jobId)).toEqual(["new", "mid"]);
  });

  it("keeps a single entry even when it alone exceeds the budget", () => {
    const big = "A".repeat(100);
    const trimmed = trimResultsToBudget([entry("only", big)], 60, 10);
    expect(trimmed.map((e) => e.jobId)).toEqual(["only"]);
  });

  it("counts batch image bytes and video bytes together", () => {
    const video = entry("v", "A".repeat(60)); // ≈ 45 字节（最新）
    const batch = entry("b", "", [
      { index: 0, b64_json: "A".repeat(60) },
      { index: 1, b64_json: "A".repeat(60) },
    ]); // ≈ 90 字节（更旧）
    // 视频 + 批次 = 135 字节，超过 120 字节预算 → 挤出最旧的批次。
    const trimmed = trimResultsToBudget([video, batch], 60, 120);
    expect(trimmed.map((e) => e.jobId)).toEqual(["v"]);
  });
});
