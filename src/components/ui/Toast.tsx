import { AnimatePresence, motion } from "motion/react";
import { TriangleAlert, X } from "lucide-react";
import { useStore } from "../../store";
import { cn } from "./cn";

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const pauseToasts = useStore((s) => s.pauseToasts);
  const resumeToasts = useStore((s) => s.resumeToasts);
  return (
    <div
      className="toast-container"
      aria-label="通知"
      onMouseEnter={pauseToasts}
      onMouseLeave={resumeToasts}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn("toast", t.error && "error")}
            role={t.error ? "alert" : "status"}
            aria-live={t.error ? "assertive" : "polite"}
          >
            {t.error && (
              <TriangleAlert
                size={14}
                strokeWidth={1.9}
                className="toast-icon"
                aria-hidden="true"
              />
            )}
            <span className="toast-message">{t.msg}</span>
            {(t.count ?? 1) > 1 && (
              <span className="toast-count font-variant-tnum" aria-label={`重复 ${t.count} 次`}>
                ×{t.count}
              </span>
            )}
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-dismiss inline-flex items-center justify-center"
              aria-label="关闭通知"
              onClick={() => dismiss(t.id)}
            >
              <X size={13} strokeWidth={1.85} aria-hidden="true" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
