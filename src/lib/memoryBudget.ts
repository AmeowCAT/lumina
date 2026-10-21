/**
 * 渲染进程内存预算总账（审查 20-frontend-arch §2.2）。
 *
 * 旧状：结果区 1 GiB + 任务输入 256 MB + 画廊缩略图 128 MB + 原图 512 MB +
 * 视频 512 MB —— 五份**互不知情**的预算，同时打满就是约 2.4 GiB 的渲染进程
 * 占用，而 sd-server 还要另外吃显存。更麻烦的是它们各自独立淘汰：某一个打满
 * 时另外四个不会让路，用户看到的是"内存占用忽高忽低、偶发整体卡顿"。
 *
 * 现在收敛到一个总账：每层拿固定份额，**总和就是天花板**（≈1.6 GiB），
 * 任何一层超限只淘汰自己，但整体不会被无限叠加。调整层级大小时请同时改
 * 这里和 `memoryBudget.test.ts` 里的期望，不要在各 hook/组件里另写魔数。
 */
const MB = 1024 * 1024;

export const MEMORY_BUDGET = {
  /** 结果区：base64 字符串与 blob URL 双份常驻，按 4/3 膨胀系数估算。 */
  results: 640 * MB,
  /** 队列里任务自带的图片输入（`jobs[].config.images`）。 */
  jobs: 128 * MB,
  /** 历史画廊缩略图（每张约 8–24 KB）。 */
  galleryThumbs: 128 * MB,
  /** 历史画廊原图（灯箱查看时才解码）。 */
  galleryFull: 384 * MB,
  /** 历史画廊视频 blob（显式 revoke，卸载时全部释放）。 */
  galleryVideos: 384 * MB,
} as const;

/** 五层份额之和：渲染进程的可预期占用上限。 */
export const MEMORY_BUDGET_TOTAL = Object.values(MEMORY_BUDGET).reduce(
  (sum, bytes) => sum + bytes,
  0
);
