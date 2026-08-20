import { useEffect, useRef } from "react";
import { api } from "../api";
import { useStore, type ImageSaveState, type ResultEntry } from "../store";
import type { Job } from "../types";
import { extractApiError, formatError, MAX_RESULTS } from "../lib/utils";
import { flashWindow, notifyIfUnfocused } from "../lib/systemIntegration";

const POLL_FAILURE_THRESHOLD = 3;
/** 单次任务查询的软超时：底层 invoke 无法中断，超时后放弃本轮结果继续
 * 下一个任务，避免一个挂起的请求把整个轮询停摆（对抗性审查 B3）。
 * Rust 侧 reqwest 另有 30s 硬超时兜底。 */
const POLL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

/**
 * 已领过结果的任务 id。模块级单例（而非 hook ref）：轮询逻辑挂在 App 级
 * 常驻运行（切到控制台也继续轮询/自动保存），GenerationUI 需要访问同一个
 * 集合来做"删除任务后不再重复收货"的判断。
 * 长会话下只增不减会无界增长,收顶:超过上限时按插入序淘汰最旧的一半
 * （被淘汰的 id 对应结果早已超出 MAX_RESULTS 保留窗,重复收割风险可忽略）。
 */
export const processedJobs = new Set<string>();
const PROCESSED_JOBS_MAX = 2000;

function rememberProcessedJob(id: string) {
  if (processedJobs.size >= PROCESSED_JOBS_MAX) {
    const drop = Math.floor(PROCESSED_JOBS_MAX / 2);
    let i = 0;
    for (const old of processedJobs) {
      if (i++ >= drop) break;
      processedJobs.delete(old);
    }
  }
  processedJobs.add(id);
}

export function useJobPolling() {
  const pollBusy = useRef(false);
  const jobsRef = useRef(useStore.getState().jobs);

  useEffect(() => {
    const unsub = useStore.subscribe((s) => {
      jobsRef.current = s.jobs;
    });
    return unsub;
  }, []);

  useEffect(() => {
    const iv = setInterval(async () => {
      if (pollBusy.current) return;
      const active = jobsRef.current.filter(
        (j) =>
          j.status === "queued" || j.status === "generating" || j.status === "unknown"
      );
      if (!active.length) return;
      pollBusy.current = true;
      // 服务器重启会让所有陈旧任务同时 404/410——逐条弹 toast 会形成风暴，
      // 这里聚合成单条提示（对抗性审查 B3）。
      const expired: string[] = [];
      try {
        for (const job of active) {
          try {
            const res = await withTimeout(api.sdcppJob(job.id), POLL_TIMEOUT_MS);
            if (res === "timeout") {
              recordPollFailure(job.id, "查询超时");
              continue;
            }
            const { status, body } = res;
            const store = useStore.getState();
            if (status === 404 || status === 410) {
              expired.push(job.id);
              store.setJobs((j) =>
                j.map((x) =>
                  x.id === job.id
                    ? { ...x, status: "failed", error: { message: "任务已失效（服务器重启或任务过期）" } }
                    : x
                )
              );
              continue;
            }
            if (status !== 200) {
              recordPollFailure(job.id, extractApiError(body, status));
              continue;
            }
            const d = body as Job;
            // 完成的 result（含完整 base64）只保留在结果画廊（上限 60），
            // 任务队列（上限 300）仅保留状态/元数据，避免同一份大视频/
            // 批次图在两端重复持有（对抗性审查 B5 的补充）。
            const jobResult = d.status === "completed" ? null : d.result;
            store.setJobs((j) =>
              j.map((x) =>
                x.id === d.id
                  ? {
                      ...d,
                      result: jobResult,
                      config: x.config,
                      pollFailures: 0,
                      lastPollSuccess: Date.now(),
                    }
                  : x
              )
            );
            ingestCompletedJob(d);
            if (d.status === "failed") {
              const msg = extractApiError(d);
              store.toast(`任务失败: ${msg}`, true);
              flashWindow();
              void notifyIfUnfocused("流光 · 任务失败", msg);
            }
          } catch (e) {
            recordPollFailure(job.id, formatError(e));
          }
        }
      } finally {
        pollBusy.current = false;
      }
      if (expired.length > 0) {
        useStore
          .getState()
          .toast(
            `${expired.length} 个任务已失效（服务器重启或任务过期）`,
            true
          );
      }
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  return { processedJobs };
}

function recordPollFailure(id: string, message: string) {
  const store = useStore.getState();
  store.setJobs((jobs) =>
    jobs.map((job) => {
      if (job.id !== id) return job;
      const failures = (job.pollFailures || 0) + 1;
      if (failures < POLL_FAILURE_THRESHOLD) {
        return { ...job, pollFailures: failures };
      }
      return {
        ...job,
        status: "unknown",
        pollFailures: failures,
        error: {
          message: `连续 ${failures} 次无法查询任务状态：${message}`,
        },
      };
    })
  );
}

/** 单张图片/视频手动保存到输出目录。key 为图片索引字符串(视频为 "v")。
 * 与"下载"(save-as 弹窗选路径)区分:本按钮一键落盘到配置的输出目录,
 * 生成过程不再自动保存(用户明确要求)。 */
export async function saveEntryPart(jobId: string, key: string): Promise<void> {
  const store = useStore.getState();
  const entry = store.results.find((r) => r.jobId === jobId);
  if (!entry) {
    // 结果画廊有保留上限，超限被淘汰后 base64 已不在内存（对抗性审查 M1）。
    store.toast("该任务的结果已超出内存保留上限，无法再保存", true);
    return;
  }
  if (entry.saves?.[key]?.status === "saving") return;
  const dir = store.settings.outputDir;
  if (!dir) {
    store.toast("未配置输出目录，请先到控制台设置", true);
    return;
  }
  const ext = entry.result.output_format || "png";
  // key 是服务端批次索引(img.index,见 ResultsGrid.imageKey),不是数组
  // 下标:部分删除一张图后数组被 compact 但 img.index 保留原值,按下标
  // 取会存成错图或静默失败(审查 M2)。按键值匹配批次索引定位。
  const images = entry.result.images;
  const b64 =
    key === "v"
      ? entry.result.b64_json
      : images?.find((im, pos) => (im.index ?? pos) === Number(key))?.b64_json;
  if (!b64) {
    store.toast("未找到对应图片,可能已被移除", true);
    return;
  }
  const name = key === "v" ? `sdcpp_${jobId}` : `sdcpp_${jobId}_${key}`;
  const mark = (
    status: ImageSaveState["status"],
    extra?: Partial<ImageSaveState>
  ) =>
    useStore.getState().setResults((rs) =>
      rs.map((r) =>
        r.jobId === jobId
          ? { ...r, saves: { ...r.saves, [key]: { status, ...extra } } }
          : r
      )
    );
  mark("saving");
  try {
    const saved = await api.saveOutput(b64, ext, name, dir);
    if (saved.saved && saved.path) {
      mark("saved", { path: saved.path });
      useStore.getState().toast(`已保存到输出目录：${saved.path}`);
    } else {
      const reason = saved.reason || "未知原因";
      mark("failed", { error: reason });
      useStore.getState().toast(`保存失败：${reason}`, true);
    }
  } catch (e) {
    const msg = formatError(e);
    mark("failed", { error: msg });
    useStore.getState().toast(`保存失败：${msg}`, true);
  }
}

/**
 * 收割一个已完成任务的结果（进画廊）。轮询循环与"取消时任务
 * 恰好已完成"两条路径共用：取消响应里的 completed 任务不会再被轮询处理
 * （轮询只跟踪 queued/generating/unknown），必须在这里直接收割，否则结果
 * 永久丢失（审查 P1）。返回是否实际收割（幂等）。
 */
export function ingestCompletedJob(d: Job): boolean {
  if (d.status !== "completed" || !d.result || processedJobs.has(d.id)) {
    return false;
  }
  const store = useStore.getState();
  rememberProcessedJob(d.id);
  const result = d.result;
  const what = result.b64_json
    ? "视频已就绪"
    : result.images && result.images.length > 1
      ? `${result.images.length} 张图片就绪`
      : "图片已就绪";
  // 系统级提醒:失焦时闪任务栏 + 原生通知(聚焦时界面内动画已足够)
  flashWindow();
  void notifyIfUnfocused("流光 · 生成完成", what);
  const cfg = store.jobs.find((x) => x.id === d.id)?.config;
  store.setResults((r) => {
    const entry: ResultEntry = {
      jobId: d.id,
      mode: d.kind,
      result,
      created: d.created,
      completedAt: Date.now(),
      config: cfg,
    };
    // 结果内存上限：最新在前，超出丢弃最旧（对抗性审查 B5）。
    return [entry, ...r].slice(0, MAX_RESULTS);
  });
  store.toast(`生成完成 · ${what}`);
  return true;
}

/**
 * 被用户从队列移除、但服务器侧仍在生成的任务：脱离队列继续低频轮询，
 * 完成后照常收割进结果画廊——否则"将在后台跑完"的提示是空头支票，
 * 结果永久丢失（对抗性审查 M3）。终态或任务失效即停；2 小时兜底停止。
 * 与主轮询对等:单次查询带软超时(否则服务器挂起时 3s 间隔会叠加
 * in-flight 请求),并按 id 去重避免重复追踪(审查 L1)。
 */
const detachedTracking = new Set<string>();

export function trackDetachedJob(id: string) {
  if (detachedTracking.has(id)) return;
  detachedTracking.add(id);
  let iv: ReturnType<typeof setInterval> | null = null;
  let failsafe: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (iv != null) clearInterval(iv);
    if (failsafe != null) clearTimeout(failsafe);
    detachedTracking.delete(id);
  };
  iv = setInterval(async () => {
    try {
      const res = await withTimeout(api.sdcppJob(id), POLL_TIMEOUT_MS);
      if (res === "timeout") return; // 本轮放弃,下一轮再试
      const { status, body } = res;
      if (status === 404 || status === 410) {
        stop();
        return;
      }
      if (status !== 200) return;
      const d = body as Job;
      if (d.status === "completed") {
        ingestCompletedJob(d);
        stop();
      } else if (d.status === "failed" || d.status === "cancelled") {
        stop();
      }
    } catch {
      // 网络抖动继续重试，由兜底定时器收尾。
    }
  }, 3000);
  failsafe = setTimeout(stop, 2 * 60 * 60 * 1000);
}
