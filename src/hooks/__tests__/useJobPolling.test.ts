import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { saveResult } from "../useJobPolling";

const mocks = vi.hoisted(() => ({ saveOutput: vi.fn() }));
vi.mock("../../api", () => ({ api: mocks }));

describe("automatic result saving", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState((state) => ({
      settings: { ...state.settings, outputDir: "/output" },
    }));
  });

  it("reports all saved output paths", async () => {
    mocks.saveOutput
      .mockResolvedValueOnce({ saved: true, path: "/output/a.png" })
      .mockResolvedValueOnce({ saved: true, path: "/output/b.png" });

    const result = await saveResult(
      { output_format: "png", images: [{ b64_json: "a" }, { b64_json: "b" }] },
      "job"
    );
    expect(result).toEqual({
      status: "saved",
      paths: ["/output/a.png", "/output/b.png"],
    });
  });

  it("reports partial and total failures instead of silently succeeding", async () => {
    mocks.saveOutput
      .mockResolvedValueOnce({ saved: true, path: "/output/a.png" })
      .mockRejectedValueOnce({ code: "save_output_failed", message: "disk full" });
    const partial = await saveResult(
      { images: [{ b64_json: "a" }, { b64_json: "b" }] },
      "job"
    );
    expect(partial.status).toBe("partial");
    expect(partial.error).toContain("disk full");

    mocks.saveOutput.mockReset().mockRejectedValue(new Error("permission denied"));
    const failed = await saveResult({ images: [{ b64_json: "a" }] }, "job");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("permission denied");
  });
});
