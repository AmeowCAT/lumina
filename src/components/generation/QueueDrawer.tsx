import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * 任务队列右侧抽屉。保留 queue-overlay / queue-backdrop 标记类;
 * 开关由 AnimatePresence 编排,退出动画期间元素短暂驻留。
 */
export function QueueDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && [
        <motion.div
          key="queue-backdrop"
          className="queue-backdrop"
          onClick={onClose}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        />,
        <motion.div
          key="queue-drawer"
          className="queue-overlay"
          role="dialog"
          aria-label="任务队列"
          initial={{ x: "-100%" }}
          animate={{ x: 0 }}
          exit={{ x: "-100%" }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>,
      ]}
    </AnimatePresence>
  );
}
