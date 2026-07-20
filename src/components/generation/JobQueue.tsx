import { memo } from "react";
import type { Capabilities, GenMode, Job, JobConfig } from "../../types";
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
  onDownload: (b64: string, fmt?: string, mime?: string) => void;
}

function statusLabel(status: Job["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "generating":
      return "生成中";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    default:
      return "状态未知";
  }
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
  return (
    <div className="job-queue">
      <div className="jq-header">
        <h4>任务队列</h4>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted)",
          }}
        >
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
        jobs.map((j) => (
          <div key={j.id} className="job-row">
            <span className="job-id">{j.id}</span>
            <span className="job-mode">
              {(j.kind || mode) === "img_gen" ? "IMG" : "VID"}
            </span>
            <span
              className={`job-status ${j.status}`}
              title={j.error?.message}
              role={j.status === "failed" ? "alert" : "status"}
            >
              {statusLabel(j.status)}
            </span>
            <span className="job-prompt">{j.prompt || ""}</span>
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
                (j.status === "generating" &&
                  caps?.features_by_mode?.[j.kind || mode]?.cancel_generating)) && (
                <button
                  className="btn btn-sm btn-danger"
                  aria-label={`取消任务 ${j.id}`}
                  onClick={() => onCancel(j.id)}
                >
                  取消
                </button>
              )}
              {j.status === "completed" && j.result && (
                <button
                  className="btn btn-sm"
                  aria-label={`下载任务 ${j.id} 的结果`}
                  onClick={() => {
                    const img =
                      j.result?.images?.[0]?.b64_json || j.result?.b64_json;
                    if (img)
                      onDownload(img, j.result?.output_format, j.result?.mime_type);
                  }}
                >
                  {IC.dl}
                </button>
              )}
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
        ))
      )}
    </div>
  );
});
