import { describe, expect, it } from "vitest";
import {
  alignRefVideoFrames,
  isWavFile,
  REF_VIDEO_FPS,
  REF_VIDEO_MAX_FRAMES,
  REF_VIDEO_MIN_FRAMES,
  validateRefMedia,
  validateRefMediaCounts,
  validateRefVideoFrames,
  videoFrameTimes,
} from "../refMedia";

// 上游 #2194：JSON 通道的参考视频固定按 24fps 解释（common.cpp
// to_sd_vid_gen_params_t 硬编码 24），抽帧时间点必须同帧率均匀采样。
// 帧数还要满足内核 video.cpp 的约束：>= 5 帧、落在 17k+5 网格。
describe("alignRefVideoFrames", () => {
  it("rounds down to the kernel's 17k+5 grid", () => {
    expect(alignRefVideoFrames(5)).toBe(5);
    expect(alignRefVideoFrames(22)).toBe(22);
    expect(alignRefVideoFrames(56)).toBe(56);
    // 内核用 while (n % 17 != 5) --，与这里同方向。
    expect(alignRefVideoFrames(47)).toBe(39);
    expect(alignRefVideoFrames(48)).toBe(39);
    expect(alignRefVideoFrames(50)).toBe(39);
    expect(alignRefVideoFrames(51)).toBe(39);
    expect(alignRefVideoFrames(52)).toBe(5 + 17 * 2);
  });

  it("rejects frame counts below the kernel minimum", () => {
    expect(alignRefVideoFrames(0)).toBe(0);
    expect(alignRefVideoFrames(1)).toBe(0);
    expect(alignRefVideoFrames(4)).toBe(0);
    expect(alignRefVideoFrames(-5)).toBe(0);
    expect(alignRefVideoFrames(NaN)).toBe(0);
  });
});

describe("videoFrameTimes", () => {
  it("samples uniformly at the protocol frame rate and aligns the count", () => {
    // 2s @24fps = 48 帧 → 向下对齐到 39（17×2+5）。
    const times = videoFrameTimes(2, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    expect(times).toHaveLength(39);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(1 / 24);
    expect(times[38]).toBeCloseTo(38 / 24);
  });

  it("keeps exactly 5 frames for very short clips that still qualify", () => {
    // 0.25s @24fps = 6 帧 → 对齐到 5。
    expect(videoFrameTimes(0.25, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES)).toHaveLength(5);
  });

  it("returns nothing for clips too short to satisfy the minimum", () => {
    // 0.1s @24fps = 2 帧，内核会以 needs at least 5 frames 拒绝。
    expect(videoFrameTimes(0.1, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES)).toEqual([]);
    expect(videoFrameTimes(0.01, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES)).toEqual([]);
  });

  it("caps long clips at the frame limit and still lands on the grid", () => {
    // 60s 素材远超 481 帧上限：截断后 481 = 17×28+5，正好落在网格上。
    const times = videoFrameTimes(60, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    expect(times).toHaveLength(481);
    expect(times[times.length - 1]).toBeCloseTo(480 / 24);
    // 上限本身若不是网格值，也要向下对齐。
    expect(videoFrameTimes(60, REF_VIDEO_FPS, 400)).toHaveLength(alignRefVideoFrames(400));
  });

  it("returns nothing for invalid input", () => {
    expect(videoFrameTimes(0, 24, 481)).toEqual([]);
    expect(videoFrameTimes(-1, 24, 481)).toEqual([]);
    expect(videoFrameTimes(NaN, 24, 481)).toEqual([]);
    expect(videoFrameTimes(1, 0, 481)).toEqual([]);
    expect(videoFrameTimes(1, 24, 0)).toEqual([]);
  });
});

// 提交前校验：帧数下限 + 音轨配对数量（内核直接拒绝的组合提前拦）。
describe("validateRefVideoFrames", () => {
  const frames = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  it("accepts the kernel minimum and above", () => {
    expect(validateRefVideoFrames([])).toBeNull();
    expect(validateRefVideoFrames([frames(REF_VIDEO_MIN_FRAMES)])).toBeNull();
    expect(validateRefVideoFrames([frames(22), frames(56)])).toBeNull();
  });

  it("reports short reference videos by index", () => {
    expect(validateRefVideoFrames([frames(4)])).toMatch(/参考视频 1 只有 4 帧/);
    expect(validateRefVideoFrames([frames(22), frames(2)])).toMatch(/参考视频 2 只有 2 帧/);
  });
});

describe("validateRefMediaCounts", () => {
  // 用合法帧数（≥5）构造，避免与帧数下限校验混在一起断言。
  const ok = Array.from({ length: REF_VIDEO_MIN_FRAMES }, (_, i) => `f${i}`);

  it("allows soundtracks up to the video count", () => {
    expect(validateRefMediaCounts([ok, ok], ["a"])).toBeNull();
    expect(validateRefMediaCounts([ok], ["a"])).toBeNull();
    expect(validateRefMediaCounts([], [])).toBeNull();
    // 独立参考音频不参与配对计数。
    expect(validateRefMediaCounts([ok], [])).toBeNull();
  });

  it("rejects more soundtracks than videos", () => {
    expect(validateRefMediaCounts([ok], ["a", "a"])).toMatch(/不能多于参考视频/);
    expect(validateRefMediaCounts([], ["a"])).toMatch(/不能多于参考视频/);
  });
});

// 提交路径统一入口：先查帧数下限（不可恢复），再查音轨配对。
describe("validateRefMedia", () => {
  const ok = Array.from({ length: REF_VIDEO_MIN_FRAMES }, (_, i) => `f${i}`);

  it("passes when frames and pairing are both valid", () => {
    expect(validateRefMedia([], [])).toBeNull();
    expect(validateRefMedia([ok], [])).toBeNull();
    expect(validateRefMedia([ok, ok], ["a"])).toBeNull();
  });

  it("reports the frame problem before the pairing problem", () => {
    // 两者都不合法时，帧数问题更不可恢复，优先报它。
    expect(validateRefMedia([["x"]], ["a", "a"])).toMatch(/只有 1 帧/);
    expect(validateRefMedia([ok], ["a", "a"])).toMatch(/不能多于参考视频/);
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
