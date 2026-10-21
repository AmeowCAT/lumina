import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import type { GenParams } from "../types";

describe("store", () => {
  beforeEach(() => {
    useStore.setState({
      params: {
        width: 512,
        height: 512,
        seed: 0,
        prompt: "",
        negative_prompt: "",
        sample_params: {
          sample_method: "euler",
          sample_steps: 20,
          scheduler: "discrete",
          guidance: { txt_cfg: 7, distilled_guidance: 0 },
        },
        lora: [],
      },
      jobs: [],
      results: [],
      logs: [],
    });
  });

  describe("updateParam", () => {
    it("updates a top-level field", () => {
      useStore.getState().updateParam("width", 1024);
      expect(useStore.getState().params?.width).toBe(1024);
    });

    it("updates a nested field via dot path", () => {
      useStore.getState().updateParam("sample_params.sample_steps", 50);
      expect(useStore.getState().params?.sample_params?.sample_steps).toBe(50);
    });

    it("updates deeply nested guidance field", () => {
      useStore.getState().updateParam("sample_params.guidance.txt_cfg", 10);
      expect(useStore.getState().params?.sample_params?.guidance?.txt_cfg).toBe(10);
    });

    it("handles paths with null intermediates", () => {
      useStore.setState({ params: { width: 64, height: 64, seed: 0, sample_params: { guidance: { txt_cfg: 1 } } as unknown as GenParams["sample_params"] } });
      useStore.getState().updateParam("sample_params.guidance.img_cfg", 5);
      const sp = useStore.getState().params?.sample_params as { guidance?: { img_cfg?: number } } | undefined;
      expect(sp?.guidance?.img_cfg).toBe(5);
    });
  });

  describe("appendLog", () => {
    it("appends a log line", () => {
      useStore.getState().appendLog("test line");
      expect(useStore.getState().logs.map((l) => l.text)).toContain("test line");
    });

    it("assigns monotonically increasing ids for stable React keys", () => {
      const before = useStore.getState().logs;
      useStore.getState().appendLog("a");
      useStore.getState().appendLog("b");
      const after = useStore.getState().logs;
      expect(after.length).toBe(before.length + 2);
      expect(after[after.length - 1].id).toBeGreaterThan(after[after.length - 2].id);
    });

    it("trims logs when exceeding 2000 lines", () => {
      const s = useStore.getState();
      for (let i = 0; i < 2001; i++) s.appendLog(`line ${i}`);
      const logs = useStore.getState().logs;
      expect(logs.length).toBeLessThanOrEqual(1501);
    });
  });

  describe("updateProgress", () => {
    it("parses step X/Y and sets progress", () => {
      useStore.getState().updateProgress("step 5/50");
      expect(useStore.getState().progressStep).toBe(5);
      expect(useStore.getState().progressTotal).toBe(50);
    });

    it("replaces previous progress line on consecutive calls", () => {
      useStore.getState().updateProgress("progress 1");
      useStore.getState().updateProgress("progress 2");
      const logs = useStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toBe("progress 2");
    });

    it("replaces parsed step progress instead of appending every update", () => {
      useStore.getState().updateProgress("step 1/20");
      useStore.getState().updateProgress("step 2/20");
      const logs = useStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toBe("step 2/20");
    });
  });

  describe("seedRandom persistence", () => {
    it("defaults to true", () => {
      expect(useStore.getState().seedRandom).toBe(true);
    });
  });

  // 审查 50-ux F-21：轮询失败每 3 秒一条、批量保存每张一条，同文案会堆满屏幕。
  describe("toast 合并", () => {
    beforeEach(() => {
      useStore.setState({ toasts: [] });
    });

    it("merges identical repeated messages into one card with a count", () => {
      useStore.getState().toast("网络错误: boom", true);
      useStore.getState().toast("网络错误: boom", true);
      useStore.getState().toast("网络错误: boom", true);

      const toasts = useStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].count).toBe(3);
    });

    it("keeps different messages as separate cards", () => {
      useStore.getState().toast("网络错误: boom", true);
      useStore.getState().toast("队列已满", true);

      expect(useStore.getState().toasts).toHaveLength(2);
    });

    it("does not merge a non-error message with an error of the same text", () => {
      useStore.getState().toast("已停止");
      useStore.getState().toast("已停止", true);

      expect(useStore.getState().toasts).toHaveLength(2);
    });
  });
});
