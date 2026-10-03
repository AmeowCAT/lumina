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
      const active = document.activeElement as HTMLElement | null;
      // 1) 焦点彻底丢失（提交按钮被禁用后浏览器把焦点交给 body）：拉回圈内。
      if (!active || active === document.body || !document.body.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // 2) 焦点在容器外：可能是 Radix 下拉菜单这类 portal 浮层（它自己处理
      //    Tab），也可能是用户把焦点留在了后台——两种情况都不在这里抢，
      //    否则菜单会关不掉、焦点乱跳。后台由模态的 inert 与快捷键门禁负责。
      if (!el.contains(active)) return;
      // 3) 焦点还在容器内但已不可聚焦（例如提交按钮刚变成 disabled）：
      //    浏览器会顺着 Tab 一路走到容器外的后台控件上，必须拦下来。
      if (!focusable.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
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
