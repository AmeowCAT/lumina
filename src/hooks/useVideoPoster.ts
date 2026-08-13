import { useEffect, useState } from "react";

/**
 * 从视频 URL 抽取首帧作为 poster(纯前端 canvas 方案,无后端依赖)。
 * 使用一次性离屏 <video>:加载元数据后 seek 到 ~0.1s 截帧,随后立刻
 * 释放。失败(格式不支持 / 组件卸载)静默回落 null,不影响播放。
 */
export function useVideoPoster(url: string | null): string | null {
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setPoster(null);
      return;
    }
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    const cleanup = () => {
      video.removeAttribute("src");
      // readyState>0 才真正需要 abort 缓冲;jsdom 恒为 0,跳过避免噪音
      if (video.readyState > 0) {
        try {
          video.load();
        } catch {
          /* noop */
        }
      }
    };

    const capture = () => {
      if (cancelled) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) {
        cleanup();
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        setPoster(canvas.toDataURL("image/webp", 0.72));
      } catch {
        /* 解码失败:无 poster,不打扰 */
      } finally {
        cleanup();
      }
    };

    const onLoaded = () => {
      if (cancelled) return;
      const t = Math.min(0.1, (video.duration || 0) / 2);
      if (t <= 0) {
        capture();
        return;
      }
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = t;
      } catch {
        cleanup();
      }
    };
    const onSeeked = () => capture();
    const onError = () => cleanup();

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      video.removeEventListener("seeked", onSeeked);
      cleanup();
    };
  }, [url]);

  return poster;
}
