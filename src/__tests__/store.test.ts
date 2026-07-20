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
      expect(useStore.getState().logs).toContain("test line");
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
      expect(logs[0]).toBe("progress 2");
    });

    it("replaces parsed step progress instead of appending every update", () => {
      useStore.getState().updateProgress("step 1/20");
      useStore.getState().updateProgress("step 2/20");
      const logs = useStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe("step 2/20");
    });
  });

  describe("seedRandom persistence", () => {
    it("defaults to true", () => {
      expect(useStore.getState().seedRandom).toBe(true);
    });
  });
});
