import { useStore } from "../../store";

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toast-container" aria-label="通知">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.error ? " error" : ""}`}
          role={t.error ? "alert" : "status"}
          aria-live={t.error ? "assertive" : "polite"}
        >
          <span className="toast-message">
            {t.error ? "⚠ " : ""}
            {t.msg}
          </span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="关闭通知"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
