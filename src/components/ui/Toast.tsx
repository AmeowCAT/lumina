import { AnimatePresence, motion } from "motion/react";
import { TriangleAlert } from "lucide-react";
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
            initial={{ opacity: 0, x: -28, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -28, scale: 0.97, transition: { duration: 0.14 } }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={cn("toast", t.error && "error")}
            role={t.error ? "alert" : "status"}
            aria-live={t.error ? "assertive" : "polite"}
          >
            {t.error && (
              <TriangleAlert
                size={14}
                strokeWidth={2.2}
                className="toast-icon"
                aria-hidden="true"
              />
            )}
            <span className="toast-message">{t.msg}</span>
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
              className="toast-dismiss"
              aria-label="关闭通知"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
