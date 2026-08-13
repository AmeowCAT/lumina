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
 */
export const processedJobs = new Set<string>();

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
            store.setJobs((j) =>
              j.map((x) =>
                x.id === d.id
                  ? {
                      ...d,
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
  if (!entry) return;
  if (entry.saves?.[key]?.status === "saving") return;
  const dir = store.settings.outputDir;
  if (!dir) {
    store.toast("未配置输出目录，请先到控制台设置", true);
    return;
  }
  const ext = entry.result.output_format || "png";
  const b64 =
    key === "v"
      ? entry.result.b64_json
      : entry.result.images?.[Number(key)]?.b64_json;
  if (!b64) return;
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
  processedJobs.add(d.id);
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
