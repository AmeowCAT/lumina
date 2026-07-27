import type { ReactNode } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";

/**
 * 召唤式参数 Sheet:右侧玻璃覆盖,⌘, 或参数 chip 呼唤。
 * 关闭时子树保持挂载(平移出画布)——折叠/展开状态与表单值
 * 不随开合丢失,行为与旧常驻侧栏等价。
 */
export function ParamsSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <motion.div
        className="sheet-backdrop"
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: 0.2 }}
        style={{ pointerEvents: open ? "auto" : "none" }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        className="params-sheet"
        role="dialog"
        aria-label="生成参数"
        initial={false}
        animate={{ x: open ? 0 : "105%" }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        style={{ pointerEvents: open ? "auto" : "none" }}
      >
        <div className="params-sheet-head">
          <h3>生成参数</h3>
          <span className="kbd">⌘,</span>
          <div className="header-spacer" />
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭参数面板"
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="params-sheet-scroll">{children}</div>
      </motion.div>
    </>
  );
}
