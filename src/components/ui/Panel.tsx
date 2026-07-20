import { useState, type ReactNode } from "react";
import { IC } from "./Icons";

export function Panel({
  title,
  collapsed,
  children,
  badge,
}: {
  title: ReactNode;
  collapsed?: boolean;
  children: ReactNode;
  badge?: ReactNode;
}) {
  const [c, setC] = useState(!!collapsed);
  const toggle = () => setC((v) => !v);
  return (
    <div className={`panel${c ? " collapsed" : ""}`}>
      <div
        className="panel-head"
        role="button"
        tabIndex={0}
        aria-expanded={!c}
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
            <span className="tag" style={{ marginLeft: 6 }}>
              {badge}
            </span>
          ) : null}
        </span>
        <span className="panel-chevron" aria-hidden="true">
          {IC.chev}
        </span>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}
