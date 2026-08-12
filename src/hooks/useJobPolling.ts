import { useEffect, useRef } from "react";
import { api } from "../api";
import { useStore, type ResultEntry } from "../store";
import type { Job } from "../types";
import { extractApiError, formatError, MAX_RESULTS } from "../lib/utils";

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
            const cfg = store.jobs.find((x) => x.id === d.id)?.config;
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
            if (d.status === "completed" && d.result && !processedJobs.has(d.id)) {
              processedJobs.add(d.id);
              const result = d.result;
              const autoSave = !!store.settings.outputDir;
              store.setResults((r) => {
                const entry: ResultEntry = {
                  jobId: d.id,
                  mode: d.kind,
                  result,
                  created: d.created,
                  completedAt: Date.now(),
                  config: cfg,
                  saveStatus: autoSave ? "saving" : "not_configured",
                };
                // 结果内存上限：最新在前，超出丢弃最旧（对抗性审查 B5）。
                return [entry, ...r].slice(0, MAX_RESULTS);
              });
              if (autoSave) {
                void saveResult(result, d.id).then((summary) => {
                  const latest = useStore.getState();
                  latest.setResults((entries) =>
                    entries.map((entry) =>
                      entry.jobId === d.id
                        ? {
                            ...entry,
                            saveStatus: summary.status,
                            savePaths: summary.paths,
                            saveError: summary.error,
                          }
                        : entry
                    )
                  );
                  if (summary.status === "failed" || summary.status === "partial") {
                    latest.toast(
                      summary.status === "partial"
                        ? `自动保存部分失败：${summary.error}`
                        : `自动保存失败：${summary.error}`,
                      true
                    );
                  }
                });
              }
            }
            if (d.status === "failed")
              store.toast(`任务失败: ${extractApiError(d)}`, true);
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

export interface SaveSummary {
  status: "saved" | "partial" | "failed";
  paths: string[];
  error?: string;
}

export async function saveResult(
  result: {
    output_format?: string;
    images?: { b64_json: string }[];
    b64_json?: string;
  },
  jobId: string
): Promise<SaveSummary> {
  const dir = useStore.getState().settings.outputDir;
  if (!dir) return { status: "failed", paths: [], error: "未配置输出目录" };
  const ext = result.output_format || "png";
  let imgs: string[] = [];
  if (result.images) imgs = result.images.map((i) => i.b64_json);
  else if (result.b64_json) imgs = [result.b64_json];
  const paths: string[] = [];
  const errors: string[] = [];
  for (let k = 0; k < imgs.length; k++) {
    if (!imgs[k]) continue;
    try {
      const saved = await api.saveOutput(
        imgs[k],
        ext,
        `sdcpp_${jobId}${imgs.length > 1 ? "_" + k : ""}`,
        dir
      );
      if (saved.saved && saved.path) paths.push(saved.path);
      else errors.push(saved.reason || `第 ${k + 1} 个文件保存失败`);
    } catch (e) {
      errors.push(formatError(e));
    }
  }
  if (errors.length === 0 && paths.length > 0) return { status: "saved", paths };
  if (paths.length > 0) {
    return { status: "partial", paths, error: errors.join("；") };
  }
  return {
    status: "failed",
    paths,
    error: errors.join("；") || "没有可保存的输出数据",
  };
}

/** 自动保存重试（ResultsGrid 的"重试保存"按钮）。模块级函数，供
 * GenerationUI 经稳定引用转发给 memo 子组件。 */
export async function retrySave(jobId: string): Promise<void> {
  const store = useStore.getState();
  const entry = store.results.find((result) => result.jobId === jobId);
  if (!entry) return;
  store.setResults((results) =>
    results.map((result) =>
      result.jobId === jobId
        ? { ...result, saveStatus: "saving", saveError: undefined }
        : result
    )
  );
  const summary = await saveResult(entry.result, jobId);
  useStore.getState().setResults((results) =>
    results.map((result) =>
      result.jobId === jobId
        ? {
            ...result,
            saveStatus: summary.status,
            savePaths: summary.paths,
            saveError: summary.error,
          }
        : result
    )
  );
  if (summary.status === "saved") useStore.getState().toast("自动保存重试成功");
  else useStore.getState().toast(`保存重试失败：${summary.error}`, true);
}
