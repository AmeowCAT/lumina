import { useRef, useState, type ReactNode } from "react";
import { Select as RxSelect } from "radix-ui";
import { Check } from "lucide-react";
import { IC } from "./Icons";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** typeahead 搜索文本（label 为非字符串 ReactNode 时必须提供） */
  textValue?: string;
}

// Radix Select 不允许空字符串作为 item 值；空值在原生 <select> 里常作
// 占位项（"-- 请选择 --"），这里用哨兵值与调用方的 "" 互译。
const EMPTY = "__lumina_empty__";
const toRx = (v: string) => (v === "" ? EMPTY : v);
const fromRx = (v: string) => (v === EMPTY ? "" : v);

/** 超过该数量时在下拉顶部提供过滤输入框 */
const SEARCH_THRESHOLD = 8;

export function Select({
  id,
  value,
  onChange,
  options,
  ariaLabel,
  className,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchable = options.length > SEARCH_THRESHOLD;
  const q = query.trim().toLocaleLowerCase();
  const visible = searchable && q
    ? options.filter((o) =>
        (o.textValue ?? (typeof o.label === "string" ? o.label : ""))
          .toLocaleLowerCase()
          .includes(q)
      )
    : options;

  return (
    <RxSelect.Root
      value={toRx(value)}
      onValueChange={(v) => onChange(fromRx(v))}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        else if (searchable) {
          // Radix Select 默认把焦点给内容容器;搜索框在场时改交给输入框
          requestAnimationFrame(() => searchRef.current?.focus());
        }
      }}
      disabled={disabled}
    >
      <RxSelect.Trigger
        id={id}
        className={cn("select-trigger", className)}
        aria-label={ariaLabel}
      >
        <span className="select-value">
          <RxSelect.Value />
        </span>
        <RxSelect.Icon className="select-icon">{IC.chev}</RxSelect.Icon>
      </RxSelect.Trigger>
      <RxSelect.Portal>
        <RxSelect.Content
          className="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          {searchable && (
            <div className="select-search">
              <input
                ref={searchRef}
                className="input"
                type="text"
                value={query}
                placeholder="搜索…"
                aria-label="搜索选项"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <RxSelect.Viewport className="select-viewport">
            {visible.length === 0 ? (
              <div className="select-empty">无匹配项</div>
            ) : (
              visible.map((o) => (
                <RxSelect.Item
                  key={toRx(o.value)}
                  value={toRx(o.value)}
                  textValue={o.textValue ?? (typeof o.label === "string" ? o.label : undefined)}
                  className="select-item"
                >
                  <RxSelect.ItemText className="select-item-text">
                    {o.label}
                  </RxSelect.ItemText>
                  <RxSelect.ItemIndicator className="select-item-indicator">
                    <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                  </RxSelect.ItemIndicator>
                </RxSelect.Item>
              ))
            )}
          </RxSelect.Viewport>
        </RxSelect.Content>
      </RxSelect.Portal>
    </RxSelect.Root>
  );
}
