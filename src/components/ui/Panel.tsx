import { useEffect, useId, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { IC } from "./Icons";
import { cn } from "./cn";

export function Panel({
  title,
  collapsed,
  children,
  badge,
  forceOpen,
}: {
  title: ReactNode;
  collapsed?: boolean;
  children: ReactNode;
  badge?: ReactNode;
  /**
   * 深链展开：参数 chip 召唤 Sheet 时把目标面板打开。
   * 只在 forceOpen 从 false 变 true 的那一次生效（边沿触发），此后用户
   * 可以正常点击标题收起。旧实现是电平覆盖（forceOpen 期间 c 被忽略），
   * 点标题只有内部状态在翻、视觉纹丝不动，面板被永久钉在展开态。
   */
  forceOpen?: boolean;
}) {
  const [c, setC] = useState(!!collapsed);
  useEffect(() => {
    if (forceOpen) setC(false);
  }, [forceOpen]);
  const toggle = () => setC((v) => !v);
  const bodyId = useId();
  return (
    <div className={cn("panel", c && "collapsed")}>
      <div
        className="panel-head"
        role="button"
        tabIndex={0}
        aria-expanded={!c}
        aria-controls={bodyId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="panel-title">
          {title}
          {badge ? (
            <span className="tag ml-1.5">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="panel-chevron" aria-hidden="true">
          {IC.chev}
        </span>
      </div>
      {/* 折叠时子树保持挂载（高度归零）:折叠面板里的表单控件值仍在 DOM 中,
          行为与原 display:none 实现等价,但换得高度展开动画。 */}
      <motion.div
        id={bodyId}
        initial={false}
        animate={{ height: c ? 0 : "auto", opacity: c ? 0 : 1 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ overflow: "hidden" }}
      >
        <div className="panel-body">{children}</div>
      </motion.div>
    </div>
  );
}
