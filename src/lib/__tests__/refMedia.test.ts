import { describe, expect, it } from "vitest";
import {
  isWavFile,
  REF_VIDEO_FPS,
  REF_VIDEO_MAX_FRAMES,
  validateRefMediaCounts,
  videoFrameTimes,
} from "../refMedia";

// 上游 #2194：JSON 通道的参考视频固定按 24fps 解释（common.cpp
// to_sd_vid_gen_params_t 硬编码 24），抽帧时间点必须同帧率均匀采样。
describe("videoFrameTimes", () => {
  it("samples uniformly at the protocol frame rate", () => {
    const times = videoFrameTimes(2, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    expect(times).toHaveLength(48);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(1 / 24);
    expect(times[47]).toBeCloseTo(47 / 24);
  });

  it("keeps at least one frame for very short clips", () => {
    expect(videoFrameTimes(0.01, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES)).toEqual([0]);
  });

  it("caps long clips at the frame limit", () => {
    // 60s 素材远超 481 帧上限：截断而不是无限抽帧（内存护栏）。
    const times = videoFrameTimes(60, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    expect(times).toHaveLength(REF_VIDEO_MAX_FRAMES);
    expect(times[times.length - 1]).toBeCloseTo((REF_VIDEO_MAX_FRAMES - 1) / 24);
  });

  it("returns nothing for invalid input", () => {
    expect(videoFrameTimes(0, 24, 481)).toEqual([]);
    expect(videoFrameTimes(-1, 24, 481)).toEqual([]);
    expect(videoFrameTimes(NaN, 24, 481)).toEqual([]);
    expect(videoFrameTimes(1, 0, 481)).toEqual([]);
    expect(videoFrameTimes(1, 24, 0)).toEqual([]);
  });
});

describe("validateRefMediaCounts", () => {
  it("allows soundtracks up to the video count", () => {
    expect(validateRefMediaCounts([["f"], ["f"]], ["a"])).toBeNull();
    expect(validateRefMediaCounts([["f"]], ["a"])).toBeNull();
    expect(validateRefMediaCounts([], [])).toBeNull();
    // 独立参考音频不参与配对计数。
    expect(validateRefMediaCounts([["f"]], [])).toBeNull();
  });

  it("rejects more soundtracks than videos", () => {
    expect(validateRefMediaCounts([["f"]], ["a", "a"])).toMatch(/不能多于参考视频/);
    expect(validateRefMediaCounts([], ["a"])).toMatch(/不能多于参考视频/);
  });
});

describe("isWavFile", () => {
  function fileOf(bytes: number[], name = "a.wav"): File {
    return new File([new Uint8Array(bytes)], name);
  }
  const riff = [0x52, 0x49, 0x46, 0x46]; // RIFF
  const wave = [0x57, 0x41, 0x56, 0x45]; // WAVE

  it("accepts a RIFF/WAVE header", async () => {
    expect(await isWavFile(fileOf([...riff, 0, 0, 0, 0, ...wave, 0, 0]))).toBe(true);
  });

  it("rejects non-WAV containers and truncated files", async () => {
    // MP3 的 ID3 头、OGG 的 OggS 头都会被内核 load_wav_from_memory 拒绝。
    expect(await isWavFile(fileOf([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(await isWavFile(fileOf([...riff, 0, 0, 0, 0]))).toBe(false);
    expect(await isWavFile(fileOf([]))).toBe(false);
  });
});
