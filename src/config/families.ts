// 家族逻辑与重导出（审查 20-frontend-arch §2.11）。
//
// 数据表在 `families.data.ts`；这里保留纯函数并 `export *` 出去，
// 使既有调用方（GenerationUI / launchConfig / Dashboard …）无需改动导入路径。

import {
  EXTERNAL_TOKENIZER_FAMILIES,
  SIZE_SPATIAL_ALIGN,
  VIDEO_FRAME_ALIGN,
} from "./families.data";
import type { Limits } from "../types";

export * from "./families.data";

/** 该家族是否强制要求外部 tokenizer。 */
export function familyNeedsExternalTokenizer(family: string): boolean {
	return (EXTERNAL_TOKENIZER_FAMILIES as readonly string[]).includes(family);
}

/** 返回该家族下 `frames` 实际生效的帧数；不对齐的家族原样返回。 */
export function alignVideoFrames(family: string, frames: number): number {
	// MiniMax-H3：17k+5 网格向上取整、最小 5（src/stable-diffusion.cpp
	// align_video_frames）。50 → 56，5 → 5，6 → 22。
	if (family.startsWith("minimax-h3")) {
		if (!Number.isFinite(frames)) return frames;
		if (frames <= 5) return 5;
		return Math.ceil((frames - 5) / 17) * 17 + 5;
	}
	const step = VIDEO_FRAME_ALIGN[family];
	if (!step || !Number.isFinite(frames) || frames <= 1) return frames;
	return Math.floor((frames - 1) / step) * step + 1;
}

/** 返回该家族下 `dim` 实际生效的宽/高；无对齐要求的家族原样返回。 */
export function alignSizeUp(family: string, dim: number): number {
	const multiple = SIZE_SPATIAL_ALIGN[family];
	if (!multiple || !Number.isFinite(dim) || dim <= 0) return dim;
	return Math.ceil(dim / multiple) * multiple;
}

/**
 * 把基准宽高按 `scale` 等比缩放：各维**就近**对齐到家族空间基数
 * （无对齐要求时退化为 16，与上游 `align_image_size` 的常规基数一致），
 * 再 clamp 到 limits。与 `alignSizeUp` 的向上对齐不同，就近取整让
 * 缩放结果更贴合用户拖到的比例；剩余偏差由引擎对齐（及面板提示）兜底。
 */
export function scaleSize(
	family: string,
	baseW: number,
	baseH: number,
	scale: number,
	limits?: Limits,
): { w: number; h: number } {
	const multiple = SIZE_SPATIAL_ALIGN[family] ?? 16;
	const scaleDim = (base: number, min: number, max: number) => {
		const v = Math.max(multiple, Math.round((base * scale) / multiple) * multiple);
		return Math.min(max, Math.max(min, v));
	};
	return {
		w: scaleDim(baseW, limits?.min_width || 64, limits?.max_width || 4096),
		h: scaleDim(baseH, limits?.min_height || 64, limits?.max_height || 4096),
	};
}

