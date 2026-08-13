import { useId, useState, type ReactNode } from "react";
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
  /** 深链展开:参数 chip 召唤 Sheet 时强制展开目标面板(用户仍可手动折叠) */
  forceOpen?: boolean;
}) {
  const [c, setC] = useState(!!collapsed);
  const effective = forceOpen ? false : c;
  const toggle = () => setC((v) => !v);
  const bodyId = useId();
  return (
    <div className={cn("panel", effective && "collapsed")}>
      <div
        className="panel-head"
        role="button"
        tabIndex={0}
        aria-expanded={!effective}
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
        animate={{ height: effective ? 0 : "auto", opacity: effective ? 0 : 1 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ overflow: "hidden" }}
      >
        <div className="panel-body">{children}</div>
      </motion.div>
    </div>
  );
}
