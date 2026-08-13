import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), video[controls], [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 浮层焦点圈(统一 Lightbox / ParamsSheet / QueueDrawer 行为):
 * 开启时把焦点移入容器、Tab 在容器内循环,关闭时把焦点还给触发元素。
 * `active` 为 false 时不生效——供"保持挂载、平移出画布"的浮层使用。
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  opts: { restoreFocus?: boolean } = {}
) {
  const { restoreFocus = true } = opts;
  const ref = useRef<T | null>(null);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    previous.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const target =
        el.querySelector<HTMLElement>("[data-autofocus]") ||
        el.querySelector<HTMLElement>(FOCUSABLE);
      if (target) target.focus();
      else el.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (restoreFocus) {
        requestAnimationFrame(() => previous.current?.focus());
      }
    };
  }, [active, restoreFocus]);

  return ref;
}
