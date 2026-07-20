import { useStore } from "../../store";

function etaStr(step: number, total: number, startedAt: number): string {
  if (step <= 0 || total <= 0 || startedAt <= 0) return "";
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < 0.5) return "";
  const eta = (elapsed / step) * (total - step);
  if (eta < 1) return "不足 1 秒";
  if (eta < 60) return `${Math.round(eta)} 秒`;
  const m = Math.floor(eta / 60);
  const s = Math.round(eta % 60);
  return `${m} 分 ${s} 秒`;
}

export function ProgressBar() {
  const step = useStore((s) => s.progressStep);
  const total = useStore((s) => s.progressTotal);
  const startedAt = useStore((s) => s.progressStartedAt);

  if (total <= 0 || step <= 0) return null;

  const pct = Math.min(100, Math.round((step / total) * 100));
  const eta = etaStr(step, total, startedAt);

  return (
    <div className="progress-bar-wrap">
      <div
        className="progress-bar-track"
        role="progressbar"
        aria-label="生成进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(step, total)}
        aria-valuetext={`第 ${step} 步，共 ${total} 步，${pct}%${
          eta ? `，预计剩余 ${eta}` : ""
        }`}
      >
        <div
          className="progress-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="progress-bar-text" aria-hidden="true">
        步骤 {step}/{total}（{pct}%）
        {eta ? ` · 剩余 ${eta}` : ""}
      </span>
    </div>
  );
}
