import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { b64ToBlobUrl } from "../lib/utils";

function rawKey(b64: string): string {
  return b64.includes(",") ? b64.split(",")[1] : b64;
}

export function useBlobUrlCache() {
  const videoUrlCache = useRef<Map<string, string>>(new Map());
  const getVideoUrl = useCallback((jobId: string, b64: string, mime: string) => {
    const cache = videoUrlCache.current;
    let url = cache.get(jobId);
    if (!url) {
      const raw = b64.includes(",") ? b64.split(",")[1] : b64;
      url = b64ToBlobUrl(raw, mime);
      cache.set(jobId, url);
    }
    return url;
  }, []);
  const revokeVideoUrl = useCallback((jobId: string) => {
    const cache = videoUrlCache.current;
    const url = cache.get(jobId);
    if (url) {
      URL.revokeObjectURL(url);
      cache.delete(jobId);
    }
  }, []);

  const imageUrlCache = useRef<Map<string, string>>(new Map());
  const getImageUrl = useCallback((b64: string, fmt: string) => {
    if (!b64) return "";
    const cache = imageUrlCache.current;
    const raw = b64.includes(",") ? b64.split(",")[1] : b64;
    let url = cache.get(raw);
    if (!url) {
      url = b64ToBlobUrl(raw, `image/${fmt}`);
      cache.set(raw, url);
    }
    return url;
  }, []);
  const revokeImageUrl = useCallback((b64: string) => {
    const cache = imageUrlCache.current;
    const raw = b64.includes(",") ? b64.split(",")[1] : b64;
    const url = cache.get(raw);
    if (url) {
      URL.revokeObjectURL(url);
      cache.delete(raw);
    }
  }, []);

  const clearCaches = useCallback(() => {
    videoUrlCache.current.forEach((u) => URL.revokeObjectURL(u));
    videoUrlCache.current.clear();
    imageUrlCache.current.forEach((u) => URL.revokeObjectURL(u));
    imageUrlCache.current.clear();
  }, []);

  // 剪枝：缓存只保留当前 results/jobs 仍引用的条目，已从 store 移除的
  // 结果其 blob URL 一并 revoke，避免缓存 Map 随结果增删单调增长
  // （对抗性审查 B5——结果数组本身有上限，这里让缓存同步收缩）。
  // 引用早退（审查 P4d）：只有 results/jobs 数组引用变化才需要重建存活
  // 集合——日志/进度/toast 等高频 store 更新与缓存无关，直接跳过，避免
  // 每次更新都全量扫描。
  const lastResultsRef = useRef(useStore.getState().results);
  const lastJobsRef = useRef(useStore.getState().jobs);
  useEffect(() => {
    const unsub = useStore.subscribe((s) => {
      if (s.results === lastResultsRef.current && s.jobs === lastJobsRef.current) {
        return;
      }
      lastResultsRef.current = s.results;
      lastJobsRef.current = s.jobs;
      const live = new Set<string>();
      for (const r of s.results) {
        if (r.result?.b64_json) live.add(rawKey(r.result.b64_json));
        r.result?.images?.forEach((img) => {
          if (img.b64_json) live.add(rawKey(img.b64_json));
        });
      }
      for (const j of s.jobs) {
        if (j.result?.b64_json) live.add(rawKey(j.result.b64_json));
        j.result?.images?.forEach((img) => {
          if (img.b64_json) live.add(rawKey(img.b64_json));
        });
      }
      const jobIds = new Set([
        ...s.results.map((r) => r.jobId),
        ...s.jobs.map((j) => j.id),
      ]);
      for (const key of [...imageUrlCache.current.keys()]) {
        if (!live.has(key)) {
          const url = imageUrlCache.current.get(key);
          if (url) URL.revokeObjectURL(url);
          imageUrlCache.current.delete(key);
        }
      }
      for (const key of [...videoUrlCache.current.keys()]) {
        if (!jobIds.has(key)) {
          const url = videoUrlCache.current.get(key);
          if (url) URL.revokeObjectURL(url);
          videoUrlCache.current.delete(key);
        }
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    return () => {
      videoUrlCache.current.forEach((u) => URL.revokeObjectURL(u));
      videoUrlCache.current.clear();
      imageUrlCache.current.forEach((u) => URL.revokeObjectURL(u));
      imageUrlCache.current.clear();
    };
  }, []);

  return { getVideoUrl, revokeVideoUrl, getImageUrl, revokeImageUrl, clearCaches };
}
