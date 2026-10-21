import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore, type ResultEntry } from "../../store";
import type { Job } from "../../types";
import { useBlobUrlCache } from "../useBlobUrlCache";

/**
 * blob URL 的 revoke 时机是内存泄漏的唯一守门人：结果被淘汰、任务被移除、
 * 组件卸载，三种路径都必须把 URL 还回去。jsdom 没有 Blob URL 注册表，这里
 * 用一个可记录的假实现替换 `URL.createObjectURL/revokeObjectURL`——被测的是
 * 「何时创建、何时撤销、撤销几次」，与浏览器的实际实现无关。
 *
 * 注意：`b64ToBlobUrl` 会走 `atob`，所以下面必须用**合法**的 base64
 *（"QUJD" = "ABC"）；用 "a"/"b" 这类长度不合法的串会抛 InvalidCharacterError。
 */
const urlApi = URL as unknown as Record<string, unknown>;
const realCreateObjectURL = urlApi.createObjectURL;
const realRevokeObjectURL = urlApi.revokeObjectURL;

let seq = 0;
let created: string[] = [];
let revoked: string[] = [];

const IMG_A = "QUJD"; // "ABC"
const IMG_B = "REVG"; // "DEF"

const entry = (jobId: string, images: string[]): ResultEntry => ({
  jobId,
  mode: "img_gen",
  result: {
    output_format: "png",
    images: images.map((b64, index) => ({ index, b64_json: b64 })),
  },
});

const job = (id: string, b64: string): Job => ({
  id,
  kind: "vid_gen",
  status: "completed",
  result: { output_format: "webm", mime_type: "video/webm", b64_json: b64 },
});

beforeEach(() => {
  seq = 0;
  created = [];
  revoked = [];
  urlApi.createObjectURL = vi.fn(() => {
    const url = `blob:lumina-${++seq}`;
    created.push(url);
    return url;
  });
  urlApi.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  useStore.setState({ results: [], jobs: [], toasts: [] });
});

afterEach(() => {
  // 卸载会触发本 hook 的清理 effect，此时 URL 已被替换成假实现，安全。
  cleanup();
  urlApi.createObjectURL = realCreateObjectURL;
  urlApi.revokeObjectURL = realRevokeObjectURL;
  useStore.setState({ results: [], jobs: [], toasts: [] });
});

describe("useBlobUrlCache 的 blob URL 生命周期", () => {
  it("同一张 base64 第二次取值复用同一个 blob URL，只创建一次", () => {
    const { result } = renderHook(() => useBlobUrlCache());

    const first = result.current.getImageUrl(IMG_A, "png");
    const second = result.current.getImageUrl(IMG_A, "png");

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);
  });

  it("带 data: 前缀与裸 base64 共享同一缓存条目（避免同一张图两份 URL）", () => {
    const { result } = renderHook(() => useBlobUrlCache());

    const prefixed = result.current.getImageUrl(`data:image/png;base64,${IMG_A}`, "png");
    const bare = result.current.getImageUrl(IMG_A, "png");

    expect(bare).toBe(prefixed);
    expect(created).toHaveLength(1);
  });

  it("revokeImageUrl 撤销后再次取值会重建 URL，而不是复用已销毁的旧 URL", () => {
    const { result } = renderHook(() => useBlobUrlCache());

    const first = result.current.getImageUrl(IMG_A, "png");
    act(() => result.current.revokeImageUrl(IMG_A));

    expect(revoked).toEqual([first]);

    const second = result.current.getImageUrl(IMG_A, "png");
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("视频按 jobId 缓存：同一任务复用，不同任务各自创建", () => {
    const { result } = renderHook(() => useBlobUrlCache());

    const a1 = result.current.getVideoUrl("job-1", IMG_A, "video/webm");
    const a2 = result.current.getVideoUrl("job-1", IMG_A, "video/webm");
    const b = result.current.getVideoUrl("job-2", IMG_B, "video/webm");

    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    expect(created).toHaveLength(2);
  });

  it("卸载时撤销图片与视频缓存里的全部 blob URL（泄漏守门人）", () => {
    const { result, unmount } = renderHook(() => useBlobUrlCache());

    const imageUrl = result.current.getImageUrl(IMG_A, "png");
    const videoUrl = result.current.getVideoUrl("job-1", IMG_B, "video/webm");
    expect(created).toHaveLength(2);

    unmount();

    expect(revoked).toHaveLength(2);
    expect(revoked).toEqual(expect.arrayContaining([imageUrl, videoUrl]));
  });

  it("结果从 store 移除后剪枝撤销其图片 URL，仍被引用的条目保留", () => {
    useStore.setState({
      results: [entry("job-1", [IMG_A]), entry("job-2", [IMG_B])],
    });
    const { result } = renderHook(() => useBlobUrlCache());

    const keptUrl = result.current.getImageUrl(IMG_B, "png");
    const droppedUrl = result.current.getImageUrl(IMG_A, "png");

    // 用户删除了第一条结果（数组引用变化 → 触发剪枝）。
    act(() => useStore.setState({ results: [entry("job-2", [IMG_B])] }));

    expect(revoked).toEqual([droppedUrl]);
    // 存活条目仍在缓存里，不会因为一次剪枝被重建。
    expect(result.current.getImageUrl(IMG_B, "png")).toBe(keptUrl);
  });

  it("视频任务从 jobs 移除后剪枝撤销其 blob URL", () => {
    useStore.setState({ jobs: [job("job-1", IMG_A)] });
    const { result } = renderHook(() => useBlobUrlCache());

    const videoUrl = result.current.getVideoUrl("job-1", IMG_A, "video/webm");
    act(() => useStore.setState({ jobs: [] }));

    expect(revoked).toEqual([videoUrl]);
  });

  it("与 results/jobs 无关的 store 更新不触发剪枝（引用早退，审查 P4d）", () => {
    useStore.setState({ results: [entry("job-1", [IMG_A])] });
    const { result } = renderHook(() => useBlobUrlCache());

    const url = result.current.getImageUrl(IMG_A, "png");
    // results/jobs 引用未变：即使本次更新与缓存无关，也不该全量重扫/误撤销。
    act(() => useStore.setState({ progressStep: 3 }));

    expect(revoked).toHaveLength(0);
    expect(result.current.getImageUrl(IMG_A, "png")).toBe(url);
  });

  it("clearCaches 撤销两类缓存的全部条目并清空", () => {
    const { result } = renderHook(() => useBlobUrlCache());

    const imageUrl = result.current.getImageUrl(IMG_A, "png");
    const videoUrl = result.current.getVideoUrl("job-1", IMG_B, "video/webm");

    act(() => result.current.clearCaches());

    expect(revoked).toEqual(expect.arrayContaining([imageUrl, videoUrl]));
    expect(revoked).toHaveLength(2);

    // 清空后再次取值会重新创建，说明缓存 Map 也真的空了。
    expect(result.current.getImageUrl(IMG_A, "png")).not.toBe(imageUrl);
    expect(result.current.getVideoUrl("job-1", IMG_B, "video/webm")).not.toBe(
      videoUrl
    );
  });
});
