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
//
// 内核侧硬约束（src/pipeline/video.cpp:653-666，此前界面没校验）：
// - 归一后**至少 5 帧**，否则 `needs at least 5 frames at 24 fps` 直接失败；
// - 帧数会被**递减**到 `17k+5` 网格（`while (normalized_frames % 17 != 5) --`），
//   抽帧时先向下对齐可以让「界面显示的帧数」与「内核实际用的帧数」一致；
// - 参考视频会被缩放到 768 短边、面积上限 768×1344，抽帧超过该尺度只是白占内存。

/** JSON 通道的参考视频固定帧率（上游硬编码，非素材原帧率）。 */
export const REF_VIDEO_FPS = 24;
/** 单个参考视频的抽帧上限：H3 生成上限同值（≈20s），也约束内存占用。 */
export const REF_VIDEO_MAX_FRAMES = 481;
/** 内核要求的最小参考帧数（归一后按 24fps 计），低于它生成必失败。 */
export const REF_VIDEO_MIN_FRAMES = 5;
/** 参考视频的帧网格步长：内核把帧数递减到 `17k+5`。 */
export const REF_VIDEO_FRAME_STEP = 17;
/**
 * 抽帧短边上限：内核把参考视频缩放到 768 短边（面积上限 768×1344），
 * 抽更大只增内存与请求体体积，不会提升效果。
 */
export const REF_VIDEO_SHORT_EDGE = 768;
/** JPEG 质量：照片内容 0.92 足够，单帧约 60–120KB。 */
const FRAME_JPEG_QUALITY = 0.92;

/**
 * 把帧数向下对齐到内核的 `17k+5` 网格（`src/pipeline/video.cpp` 用的是
 * 同一个方向的递减）。不足最小帧数时返回 0，表示该素材无法用作参考视频。
 */
export function alignRefVideoFrames(frames: number): number {
  if (!Number.isFinite(frames) || frames < REF_VIDEO_MIN_FRAMES) return 0;
  const n = Math.floor(frames);
  return n - ((n - REF_VIDEO_MIN_FRAMES) % REF_VIDEO_FRAME_STEP);
}

/**
 * 按固定帧率对 [0, duration) 均匀采样的时间点列表。
 *
 * 帧数先向下对齐到内核查的 `17k+5` 网格（避免界面显示 N 帧、内核实际用更少），
 * 再受 `maxFrames` 约束。总帧数不足 5 时返回空数组——内核会直接拒绝该素材。
 */
export function videoFrameTimes(duration: number, fps: number, maxFrames: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || fps <= 0 || maxFrames <= 0) return [];
  const raw = Math.min(Math.floor(duration * fps), Math.floor(maxFrames));
  const count = alignRefVideoFrames(raw);
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => i / fps);
}

/**
 * 参考媒体整体校验：帧数下限 + 音轨配对数量。返回可读错误或 null。
 * 提交路径只需调这一个函数（内部顺序：先帧数再数量，前者更不可恢复）。
 */
export function validateRefMedia(refVideos: string[][], refVideoAudios: string[]): string | null {
  return validateRefVideoFrames(refVideos) ?? validateRefMediaCounts(refVideos, refVideoAudios);
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

/**
 * 参考视频帧数校验（提交前）。内核要求归一后至少 5 帧，且会把帧数递减到
 * `17k+5`；界面在抽帧时就已对齐，这里兜住「旧快照 / 手工构造」等旁路数据。
 */
export function validateRefVideoFrames(refVideos: string[][]): string | null {
  for (let i = 0; i < refVideos.length; i++) {
    const frames = refVideos[i]?.length ?? 0;
    if (frames < REF_VIDEO_MIN_FRAMES) {
      return `参考视频 ${i + 1} 只有 ${frames} 帧，内核要求至少 ${REF_VIDEO_MIN_FRAMES} 帧（按 ${REF_VIDEO_FPS}fps 归一），请换更长的素材`;
    }
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
 * 从视频文件按 24fps 抽帧（短边缩到内核需要的 768，JPEG）。帧数自动向下
 * 对齐到内核要求的 `17k+5` 网格。返回 dataURL 数组，可直接进请求体
 * `ref_videos`。失败抛错（含「太短」的可读原因），调用方 toast。
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
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("视频时长无效，无法抽帧");
    }
    const times = videoFrameTimes(video.duration, REF_VIDEO_FPS, REF_VIDEO_MAX_FRAMES);
    if (!times.length) {
      // 归一到 24fps 后不足最小帧数：内核会以 needs at least N frames 直接拒绝。
      throw new Error(
        `视频太短：按 ${REF_VIDEO_FPS}fps 归一后不足 ${REF_VIDEO_MIN_FRAMES} 帧（参考视频至少需要约 ${(REF_VIDEO_MIN_FRAMES / REF_VIDEO_FPS).toFixed(2)} 秒），请换更长的素材`,
      );
    }
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
