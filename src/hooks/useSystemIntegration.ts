import { useEffect } from "react";
import { useStore } from "../store";
import { setTaskbarProgress } from "../lib/systemIntegration";

/**
 * 挂在 App 生命周期:把 store 里的生成进度映射到任务栏图标进度。
 * 只订阅 progressStep/progressTotal 两个字段,日志/结果等高频更新
 * 不触发任何系统调用。
 */
export function useSystemIntegration() {
  useEffect(() => {
    let lastStep = useStore.getState().progressStep;
    let lastTotal = useStore.getState().progressTotal;
    setTaskbarProgress(lastStep, lastTotal);
    const unsub = useStore.subscribe((s) => {
      if (s.progressStep === lastStep && s.progressTotal === lastTotal) return;
      lastStep = s.progressStep;
      lastTotal = s.progressTotal;
      setTaskbarProgress(s.progressStep, s.progressTotal);
    });
    return () => {
      unsub();
      setTaskbarProgress(0, 0);
    };
  }, []);
}
