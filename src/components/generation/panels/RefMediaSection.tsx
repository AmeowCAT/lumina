import { memo, useRef, useState } from "react";
import { useStore } from "../../../store";
import {
  extractVideoFrames,
  readWavAsDataUrl,
  REF_VIDEO_FPS,
  REF_VIDEO_MAX_FRAMES,
  REF_VIDEO_MIN_FRAMES,
} from "../../../lib/refMedia";
import { IC } from "../../ui/Icons";

/**
 * Ref2VA 参考媒体输入（上游 #2194）：参考视频（按 24fps 抽帧）、独立参考
 * 音频、与视频按序配对的音轨。仅 Ref2VA 家族且内核声明对应 feature 时渲染。
 *
 * 协议约束（examples/common/common.cpp）：JSON 通道的参考视频固定按 24fps
 * 解释，音频只认 WAV；音轨数不得超过视频数（提交前还有一道校验）。
 */
interface Props {
  refVideos: string[][];
  refAudios: string[];
  refVideoAudios: string[];
  videosSupported: boolean;
  audiosSupported: boolean;
  videoAudiosSupported: boolean;
  onSetRefVideos: (updater: (r: string[][]) => string[][]) => void;
  onSetRefAudios: (updater: (r: string[]) => string[]) => void;
  onSetRefVideoAudios: (updater: (r: string[]) => string[]) => void;
}

export const RefMediaSection = memo(function RefMediaSection({
  refVideos,
  refAudios,
  refVideoAudios,
  videosSupported,
  audiosSupported,
  videoAudiosSupported,
  onSetRefVideos,
  onSetRefAudios,
  onSetRefVideoAudios,
}: Props) {
  const toast = useStore((s) => s.toast);
  const [extracting, setExtracting] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const trackInputRef = useRef<HTMLInputElement>(null);

  if (!videosSupported && !audiosSupported && !videoAudiosSupported) return null;

  const addWavFiles = async (files: File[], append: (urls: string[]) => void, kind: string) => {
    const urls: string[] = [];
    const invalid: string[] = [];
    for (const file of files) {
      try {
        urls.push(await readWavAsDataUrl(file));
      } catch {
        invalid.push(file.name);
      }
    }
    if (invalid.length)
      toast(`已跳过 ${invalid.length} 个非 WAV 文件：${invalid.join("、")}`, true);
    if (urls.length) {
      append(urls);
      toast(`已添加 ${urls.length} 个${kind}`);
    }
  };

  return (
    <>
      {videosSupported && (
        <div className="form-row">
          <div className="form-label-row">
            <label className="form-label">参考视频</label>
            <span className="field-anchor">
              {REF_VIDEO_FPS}fps · {REF_VIDEO_MIN_FRAMES}–{REF_VIDEO_MAX_FRAMES}帧
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {refVideos.map((frames, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-well px-2 py-1 font-mono text-[11px] tabular-nums text-fg2"
              >
                <span>{`视频 ${i + 1} · ${frames.length} 帧 ≈ ${(frames.length / REF_VIDEO_FPS).toFixed(1)}s`}</span>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-danger-dim hover:text-danger"
                  aria-label={`移除参考视频第 ${i + 1} 项`}
                  onClick={() => onSetRefVideos((r) => r.filter((_, j) => j !== i))}
                >
                  {IC.x}
                </button>
              </span>
            ))}
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setExtracting(true);
                extractVideoFrames(file)
                  .then((frames) => {
                    onSetRefVideos((r) => [...r, frames]);
                    toast(
                      `已抽取 ${frames.length} 帧（${REF_VIDEO_FPS}fps ≈ ${(frames.length / REF_VIDEO_FPS).toFixed(1)}s）`,
                    );
                  })
                  .catch((err) => toast(`参考视频抽帧失败：${String(err?.message || err)}`, true))
                  .finally(() => setExtracting(false));
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              aria-label="添加参考视频"
              disabled={extracting}
              onClick={() => videoInputRef.current?.click()}
            >
              {extracting ? "抽帧中…" : IC.plus}
            </button>
          </div>
        </div>
      )}
      {audiosSupported && (
        <div className="form-row">
          <div className="form-label-row">
            <label className="form-label">参考音频</label>
            <span className="field-anchor">WAV</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {refAudios.map((_, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-well px-2 py-1 font-mono text-[11px] tabular-nums text-fg2"
              >
                <span>{`音频 ${i + 1}`}</span>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-danger-dim hover:text-danger"
                  aria-label={`移除参考音频第 ${i + 1} 项`}
                  onClick={() => onSetRefAudios((r) => r.filter((_, j) => j !== i))}
                >
                  {IC.x}
                </button>
              </span>
            ))}
            <input
              ref={audioInputRef}
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                if (files.length) {
                  void addWavFiles(
                    files,
                    (urls) => onSetRefAudios((r) => [...r, ...urls]),
                    "参考音频",
                  );
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              aria-label="添加参考音频"
              onClick={() => audioInputRef.current?.click()}
            >
              {IC.plus}
            </button>
          </div>
        </div>
      )}
      {videoAudiosSupported && (
        <div className="form-row">
          <div className="form-label-row">
            <label className="form-label">视频音轨</label>
            <span className="field-anchor">WAV · 与视频配对</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {refVideoAudios.map((_, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-well px-2 py-1 font-mono text-[11px] tabular-nums text-fg2"
              >
                <span>{`音轨 ${i + 1} → 视频 ${i + 1}`}</span>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-danger-dim hover:text-danger"
                  aria-label={`移除视频音轨第 ${i + 1} 项`}
                  onClick={() => onSetRefVideoAudios((r) => r.filter((_, j) => j !== i))}
                >
                  {IC.x}
                </button>
              </span>
            ))}
            <input
              ref={trackInputRef}
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                if (files.length) {
                  void addWavFiles(
                    files,
                    (urls) => onSetRefVideoAudios((r) => [...r, ...urls]),
                    "视频音轨",
                  );
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              aria-label="添加视频音轨"
              onClick={() => trackInputRef.current?.click()}
            >
              {IC.plus}
            </button>
          </div>
        </div>
      )}
    </>
  );
});
