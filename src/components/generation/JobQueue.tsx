import { memo } from "react";
import type { Capabilities, GenMode, Job, JobConfig } from "../../types";
import { useStore } from "../../store";
import { useTheme } from "../../lib/theme";
import { IC } from "../ui/Icons";

interface Props {
  jobs: Job[];
  activeJobs: number;
  maxQueue: number;
  mode: GenMode;
  caps: Capabilities | null;
  onApplyConfig: (config?: JobConfig, seedOffset?: number) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  /** 逐张“另存为”下载；返回 Promise 以便批量场景串行 await */
  onDownload: (
    b64: string,
    fmt?: string,
    mime?: string,
    seed?: number,
    suffix?: string
  ) => Promise<void>;
}

// 状态文案随主题语境:暗房用直白流程词;太空(vostok)走任务链语言
// 待发 → 推进中 → 已回传(与页头 dreamText、画布空态"测控台/回传"一致)。
// 失败/取消两态两主题保持同词——告警与终态不含糊。
function statusLabel(status: Job["status"], vostok: boolean): string {
  switch (status) {
    case "queued":
      return vostok ? "待发" : "排队中";
    case "generating":
      return vostok ? "推进中" : "生成中";
    case "completed":
      return vostok ? "已回传" : "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    default:
      return "状态未知";
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function elapsedLabel(created?: number, endedAt?: number): string {
  if (!created) return "";
  // created 来自上游 unix_timestamp_now()（秒），endedAt 是前端毫秒时间戳，
  // 相减前必须统一单位，否则会显示数百万分钟。
  const ms = (endedAt ?? Date.now()) - created * 1000;
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export const JobQueue = memo(function JobQueue({
  jobs,
  activeJobs,
  maxQueue,
  mode,
  caps,
  onApplyConfig,
  onCancel,
  onRemove,
  onClear,
  onDownload,
}: Props) {
  const progressStep = useStore((s) => s.progressStep);
  const progressTotal = useStore((s) => s.progressTotal);
  const vostok = useTheme() === "vostok";
  // 完成任务的大体积 result 在收割后已从 jobs 剥离（避免 300 条任务重复
  // 持有 base64），下载入口从结果画廊取回同任务结果。
  const results = useStore((s) => s.results);
  const pct =
    progressTotal > 0 ? Math.min(100, Math.round((progressStep / progressTotal) * 100)) : 0;

  return (
    <div className="job-queue">
      <div className="jq-header">
        <h4>任务队列</h4>
        <span className="jq-count">
          {activeJobs} / {maxQueue}
        </span>
        {jobs.length > 0 && (
          <button
            type="button"
            className="btn btn-sm jq-clear"
            onClick={onClear}
            aria-label="清理任务记录"
            title="清理任务列表，不删除生成结果"
          >
            清理任务记录
          </button>
        )}
      </div>
      {jobs.length === 0 ? (
        <div className="empty-state">暂无任务</div>
      ) : (
        jobs.map((j) => {
          const generating = j.status === "generating";
          const terminal =
            j.status === "completed" ||
            j.status === "failed" ||
            j.status === "cancelled";
          const jobResult = results.find((r) => r.jobId === j.id)?.result;
          // 终态但没有成功轮询时间戳（404/410 失效路径）：耗时无法定格，
          // 显示空而不是随渲染继续增长的数字。
          const elapsed =
            terminal && !j.lastPollSuccess
              ? ""
              : elapsedLabel(j.created, terminal ? j.lastPollSuccess : undefined);
          return (
            <div key={j.id} className="job-row-wrap">
              <div className="job-row">
                <span className="job-id" title={`任务 ${j.id}`}>
                  {shortId(j.id)}
                </span>
                <span className="job-mode">
                  {(j.kind || mode) === "img_gen" ? "IMG" : "VID"}
                </span>
                <span
                  className={`job-status ${j.status}`}
                  title={j.error?.message}
                  role={j.status === "failed" ? "alert" : "status"}
                >
                  {statusLabel(j.status, vostok)}
                </span>
                <span className="job-prompt">{j.config?.params?.prompt || ""}</span>
                <span className="job-elapsed" aria-hidden="true">
                  {elapsed}
                </span>
                <div className="job-actions">
                  <button
                    className="btn btn-sm"
                    title="应用此配置"
                    aria-label={`应用任务 ${j.id} 的配置`}
                    onClick={() => onApplyConfig(j.config)}
                  >
                    {IC.refresh}
                  </button>
                  {(j.status === "queued" ||
                    (generating &&
                      caps?.features_by_mode?.[j.kind || mode]
                        ?.cancel_generating)) && (
                    <button
                      className="btn btn-sm btn-danger"
                      aria-label={`取消任务 ${j.id}`}
                      onClick={() => onCancel(j.id)}
                    >
                      取消
                    </button>
                  )}
                  {j.status === "completed" &&
                    (jobResult ? (
                      <button
                        className="btn btn-sm"
                        aria-label={`下载任务 ${j.id} 的结果`}
                        title={
                          (jobResult.images?.length || 0) > 1
                            ? `下载全部 ${jobResult.images!.length} 张`
                            : "下载结果"
                        }
                        onClick={async () => {
                          // 批次多图逐张下载，避免只取第一张静默丢图。
                          // 串行 await：onDownload 内部是原生“另存为”对话框，
                          // 并发触发多个对话框行为不稳定。
                          const images = jobResult.images?.length
                            ? jobResult.images
                            : jobResult.b64_json
                              ? [{ b64_json: jobResult.b64_json }]
                              : [];
                          // 文件名带批次信息：有固定种子时各张种子唯一
                          // （seed+k）；随机种子时追加 1-based 批次序号，
                          // 避免同批全部落成同名文件。
                          const baseSeed = j.config?.params?.seed;
                          for (let i = 0; i < images.length; i++) {
                            const img = images[i];
                            if (!img.b64_json) continue;
                            await onDownload(
                              img.b64_json,
                              jobResult.output_format,
                              jobResult.mime_type,
                              baseSeed != null && baseSeed >= 0
                                ? baseSeed + (img.index ?? i)
                                : undefined,
                              images.length > 1 ? `_${i + 1}` : undefined
                            );
                          }
                        }}
                      >
                        {IC.dl}
                      </button>
                    ) : (
                      // 结果画廊有保留上限，被淘汰后 base64 已不在内存：给出
                      // 可见的禁用态而不是让下载按钮无声消失（对抗性审查 M1）。
                      <button
                        className="btn btn-sm"
                        disabled
                        aria-label={`任务 ${j.id} 的结果已不可下载`}
                        title="结果已超出内存保留上限，无法下载（已保存到磁盘的不受影响）"
                      >
                        {IC.dl}
                      </button>
                    ))}
                  <button
                    className="btn btn-sm jq-remove"
                    title="移除任务记录"
                    aria-label={`移除任务 ${j.id} 的记录`}
                    onClick={() => onRemove(j.id)}
                  >
                    {IC.x}
                  </button>
                </div>
              </div>
              {generating && progressTotal > 0 && (
                <div
                  className="job-progress"
                  role="progressbar"
                  aria-label="任务生成进度"
                  aria-valuemin={0}
                  aria-valuemax={progressTotal}
                  aria-valuenow={Math.min(progressStep, progressTotal)}
                >
                  <div className="job-progress-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
});
