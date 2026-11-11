// Ref2VA 参考视频/音频输入（上游 #2194：/sdcpp/v1 vid_gen 接受
// ref_videos / ref_audios / ref_video_audios）。
//
// 协议要点（examples/common/common.cpp）：
// - ref_videos 是「帧数组的数组」，每帧 base64 图片；**JSON 通道固定按
//   24fps 解释**（to_sd_vid_gen_params_t 硬编码 24），所以抽帧必须按
//   24fps 采样，否则素材变速。
// - ref_audios / ref_video_audios 只认 **WAV**（load_wav_from_memory），
//   其它容器直接 400。
// - ref_video_audios 与 ref_videos 按序配对，数量不得超过视频数。

/** JSON 通道的参考视频固定帧率（上游硬编码，非素材原帧率）。 */
export const REF_VIDEO_FPS = 24;
/** 单个参考视频的抽帧上限：H3 生成上限同值（≈20s），也约束内存占用。 */
export const REF_VIDEO_MAX_FRAMES = 481;
/** 抽帧短边上限：内核参考图 TE 输入本就是 1024 短边，再大只增负载。 */
export const REF_VIDEO_SHORT_EDGE = 1024;
/** JPEG 质量：照片内容 0.92 足够，单帧约 80–150KB。 */
const FRAME_JPEG_QUALITY = 0.92;

/**
 * 按固定帧率对 [0, duration) 均匀采样的时间点列表。
 * 至少 1 帧（t=0）；超过上限截断（调用方提示用户）。
 */
export function videoFrameTimes(duration: number, fps: number, maxFrames: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || fps <= 0 || maxFrames <= 0) return [];
  const count = Math.min(Math.max(1, Math.floor(duration * fps)), Math.floor(maxFrames));
  return Array.from({ length: count }, (_, i) => i / fps);
}

/** 参考视频/音轨数量校验：音轨按序配对视频，不得多于视频数。 */
export function validateRefMediaCounts(
  refVideos: string[][],
  refVideoAudios: string[],
): string | null {
  if (refVideoAudios.length > refVideos.length) {
    return `视频音轨（${refVideoAudios.length}）不能多于参考视频（${refVideos.length}），请按顺序配对`;
  }
  return null;
}

/** WAV 头校验：RIFF....WAVE。内核只认 WAV，其它格式提交必 400。 */
export async function isWavFile(file: File): Promise<boolean> {
  if (file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const tag = (off: number) => String.fromCharCode(...head.slice(off, off + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("视频抽帧超时")), 10_000);
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });
}

/**
 * 从视频文件按 24fps 抽帧（短边缩到 ≤1024，JPEG）。返回 dataURL 数组，
 * 可直接进请求体 ref_videos。失败抛错，调用方 toast。
 */
export async function extractVideoFrames(file: File): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("无法读取视频，浏览器可能不支持该格式"));
    });
    const times = videoFrameTimes(video.duration, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    if (!times.length) throw new Error("视频时长无效，无法抽帧");
    if (!video.videoWidth || !video.videoHeight) throw new Error("视频没有画面轨道");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    const scale = Math.min(1, REF_VIDEO_SHORT_EDGE / Math.min(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const frames: string[] = [];
    for (const t of times) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 读音频文件为 dataURL（先做 WAV 头校验）。 */
export async function readWavAsDataUrl(file: File): Promise<string> {
  if (!(await isWavFile(file))) {
    throw new Error("参考音频只支持 WAV 格式（内核 load_wav_from_memory 不认其它容器）");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取音频文件失败"));
    reader.readAsDataURL(file);
  });
}
