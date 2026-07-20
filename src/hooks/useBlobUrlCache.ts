import { useCallback, useEffect, useRef } from "react";
import { b64ToBlobUrl } from "../lib/utils";

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
