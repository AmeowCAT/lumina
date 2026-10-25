import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { IC } from "../ui/Icons";
import { Slider } from "../ui/Slider";
import { TwoTapButton } from "../ui/TwoTapButton";
import { cn } from "../ui/cn";
import { useTheme } from "../../lib/theme";
import { formatNumberForInput } from "../../lib/utils";
import { api } from "../../api";
import { FAMILY_CONFIG } from "../../config/families";
import { useStore } from "../../store";
import type { Limits } from "../../types";

/**
 * 提示词 token 粗估。
 *
 * 用真实 tokenizer 不现实：每个家族的词表都不同（Qwen3-VL / T5 / Gemma 2 …），
 * 前端没有词表也付不起这个成本。按 `ceil(字符数 / 3.5)` 估算——英文约 4 字符
 * 一个 token、中文约 1.5–2 字符一个 token、标点更密；3.5 是两者之间的保守
 * 折中，宁可稍微高估，让超限提示早一点出现（审查 F-17）。
 */
const CHARS_PER_TOKEN = 3.5;
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 模型路径 → 家族。Rust 侧 `detect_family` 是纯字符串匹配（无 IO），但仍按
 *  路径记忆化，避免每次挂载/切模型都付一次 IPC。 */
const familyByPath = new Map<string, string>();

/** 与 GenerationUI.modelSelectionMatches 同义的路径比较（大小写/分隔符归一）。 */
function sameModelPath(reported: string, selected: string): boolean {
  if (!reported || !selected) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const r = norm(reported);
  const s = norm(selected);
  const name = s.split("/").pop() || s;
  return r === s || r.endsWith("/" + name);
}

/**
 * 解析当前生效的家族（只在调用方没有传 `family` 时使用）。
 *
 * GenerationUI 已经算好了家族并直接传 prop，所以生产路径不会走这里；保留它是
 * 为了让单独渲染 PromptDock 的场景（测试、未来复用）仍能显示 token 上限。
 * **上限表不写在前端**：拿不到家族就只显示估算值，不显示上限。
 */
function useActiveFamily(enabled: boolean): string {
  const override = useStore((s) => s.familyOverride);
  const mainModel = useStore((s) => s.mainModel);
  const caps = useStore((s) => s.caps);
  const modelPath = caps?.model?.path || caps?.model?.name || "";
  const overrideActive =
    enabled && !!override && !!FAMILY_CONFIG[override] && sameModelPath(modelPath, mainModel);
  const [detected, setDetected] = useState(
    () => (enabled && modelPath && familyByPath.get(modelPath)) || "",
  );

  useEffect(() => {
    if (!enabled) return;
    if (overrideActive) return; // 覆盖值优先，不必探测
    if (!modelPath) {
      setDetected("");
      return;
    }
    const cached = familyByPath.get(modelPath);
    if (cached) {
      setDetected(cached);
      return;
    }
    let alive = true;
    api
      .detectFamily(modelPath)
      .then((family) => {
        if (!family) return;
        familyByPath.set(modelPath, family);
        if (alive) setDetected(family);
      })
      .catch(() => {
        // 探测失败按"无已知上限"处理：计数仍然显示，不打断输入。
      });
    return () => {
      alive = false;
    };
  }, [enabled, overrideActive, modelPath]);

  return overrideActive ? override : detected;
}

interface Props {
  prompt: string;
  negative: string;
  negativeVisible: boolean;
  seedRandom: boolean;
  submitting: boolean;
  generating: boolean;
  disabled: boolean;
  showLingbotTools: boolean;
  width: number;
  height: number;
  /** 宽 / 高滑杆的每跳像素数（界面偏好，默认 1）。 */
  sizeStep: number;
  steps: number;
  txtCfg: number;
  limits: Limits | undefined;
  /**
   * 当前生效的家族 id（GenerationUI 已解析）。用于提示词 token 上限展示；
   * 缺省时 PromptDock 内部按 store 复算一次（仅测试/复用场景会走到）。
   */
  family?: string;
  onUpdate: (path: string, v: unknown) => void;
  onToggleNegative: () => void;
  onRandomSeed: () => void;
  onGenerate: () => void;
  onInsertLingbot: () => void;
  onOpenSheet: (target: "size" | "sampling") => void;
}

/** chip 即编辑器:点击直接在原位弹出对应滑杆,不再只是面板二传手 */
function ChipEditor({
  chipText,
  title,
  children,
  moreLabel,
  onMore,
}: {
  chipText: string;
  title: string;
  children: ReactNode;
  moreLabel: string;
  onMore: () => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="param-chip" title={title}>
          {chipText}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="chip-pop"
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={14}
        >
          {children}
          <Popover.Close asChild>
            <button type="button" className="chip-pop-more" onClick={onMore}>
              {moreLabel}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const PromptDock = memo(function PromptDock({
  prompt,
  negative,
  negativeVisible,
  seedRandom,
  submitting,
  generating,
  disabled,
  showLingbotTools,
  width,
  height,
  sizeStep,
  steps,
  txtCfg,
  limits,
  family: familyProp,
  onUpdate,
  onToggleNegative,
  onRandomSeed,
  onGenerate,
  onInsertLingbot,
  onOpenSheet,
}: Props) {
  const vostok = useTheme() === "vostok";
  // 提示词 token 计数（审查 F-17）：上限只从家族配置读，前端绝不写死上限表；
  // 家族解析不到时只显示估算值（见 useActiveFamily 的注释）。
  const internalFamily = useActiveFamily(!familyProp);
  const family = familyProp || internalFamily;
  const tokenLimit = FAMILY_CONFIG[family]?.promptTokenLimit;
  const tokenCount = useMemo(() => estimatePromptTokens(prompt), [prompt]);
  const overLimit = tokenLimit != null && tokenCount > tokenLimit;
  const familyName = FAMILY_CONFIG[family]?.name || family || "当前家族";
  // 说明里点出"含模板后缀"：Iris-3B 的 300 token 上限包含内核套用的模板，
  // 所以 prompt 本体实际可用的额度比 300 略少，计数只是保守提示。
  const tokenTitle = overLimit
    ? `估算 ≈${tokenCount} tokens，已超出${familyName}的 ${tokenLimit} token 上限（含模板后缀）；超出部分会被内核截断（不报错）。按字符数/3.5 粗估。`
    : tokenLimit != null
      ? `估算 ≈${tokenCount} / ${tokenLimit} tokens（${familyName}上限，含模板后缀）；按字符数/3.5 粗估，超出部分会被内核截断。`
      : `按字符数/3.5 粗估；${familyName}没有已知的提示词上限。`;
  const tokenText =
    tokenLimit != null ? `≈${tokenCount} / ${tokenLimit} tokens` : `≈${tokenCount} tokens`;
  const showTokenCount = tokenLimit != null || tokenCount > 0;
  return (
    <div className="prompt-dock">
      {negativeVisible && (
        <textarea
          id="negative-prompt"
          className="dock-negative"
          value={negative}
          onChange={(e) => onUpdate("negative_prompt", e.target.value)}
          placeholder="反向提示词：描述你想排除的内容…"
          rows={2}
          aria-label="反向提示词"
        />
      )}
      <div style={{ position: "relative" }}>
        <textarea
          id="positive-prompt"
          className="dock-prompt"
          value={prompt}
          onChange={(e) => onUpdate("prompt", e.target.value)}
          placeholder="描述你想生成的画面…（Ctrl + Enter 生成）"
          rows={3}
          aria-label="正向提示词"
          aria-describedby={showTokenCount ? "prompt-token-count" : undefined}
          /* 给右下角的计数留一行，避免长提示词的最后一行被压在计数下面 */
          style={{ paddingBottom: 16 }}
        />
        {showTokenCount && (
          <span
            id="prompt-token-count"
            className={overLimit ? "text-warn" : "text-muted"}
            title={tokenTitle}
            style={{
              position: "absolute",
              right: 8,
              bottom: 2,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.03em",
              lineHeight: 1.2,
            }}
          >
            {tokenText}
          </span>
        )}
      </div>
      <div className="param-chips">
        <button
          type="button"
          className={cn("param-chip", negativeVisible && "active")}
          onClick={onToggleNegative}
          aria-pressed={negativeVisible}
          aria-label="切换反向提示词输入"
          title="反向提示词"
        >
          反
        </button>
        <button
          className={cn("param-chip", seedRandom && "active")}
          onClick={onRandomSeed}
          aria-label="切换每次生成使用随机种子"
          aria-pressed={seedRandom}
          title="随机种子"
        >
          {IC.dice}
        </button>
        <ChipEditor
          chipText={`${width}×${height}`}
          title="快速调整尺寸"
          moreLabel="尺寸与种子全部设置 →"
          onMore={() => onOpenSheet("size")}
        >
          <Slider
            label="宽度"
            value={width}
            onChange={(v) => onUpdate("width", v)}
            min={limits?.min_width || 64}
            max={limits?.max_width || 4096}
            step={sizeStep}
          />
          <Slider
            label="高度"
            value={height}
            onChange={(v) => onUpdate("height", v)}
            min={limits?.min_height || 64}
            max={limits?.max_height || 4096}
            step={sizeStep}
          />
        </ChipEditor>
        <ChipEditor
          chipText={`步数 ${steps}`}
          title="快速调整步数"
          moreLabel="采样全部设置 →"
          onMore={() => onOpenSheet("sampling")}
        >
          <Slider
            label="步数"
            value={steps}
            onChange={(v) => onUpdate("sample_params.sample_steps", v)}
            min={1}
            max={100}
          />
        </ChipEditor>
        <ChipEditor
          chipText={`CFG ${txtCfg == null ? "—" : formatNumberForInput(txtCfg)}`}
          title="快速调整 CFG"
          moreLabel="采样全部设置 →"
          onMore={() => onOpenSheet("sampling")}
        >
          <Slider
            label="CFG (文本)"
            value={txtCfg}
            onChange={(v) => onUpdate("sample_params.guidance.txt_cfg", v)}
            min={0}
            max={30}
            step={0.5}
          />
        </ChipEditor>
        <button className="btn btn-primary generate-btn" onClick={onGenerate} disabled={disabled}>
          {submitting ? (
            <>
              <span className="spinner" /> 提交中
            </>
          ) : generating ? (
            <>
              {/* 进行态随主题语境:暗房"生成中" ↔ 太空"推进中"(与页头
                  dreamText、任务队列状态链一致);空闲态"生成"不动——
                  空态提示"点击 生成"引用它。 */}
              <span className="spinner" /> {vostok ? "推进中" : "生成中"}
            </>
          ) : (
            <>{IC.play} 生成</>
          )}
        </button>
      </div>
      {showLingbotTools && (
        <div className="prompt-tools">
          <TwoTapButton
            className="size-preset"
            label="插入 LingBot JSON 模板"
            armedLabel="确认替换当前提示词"
            armedTitle="当前提示词将被模板替换"
            needsConfirm={prompt.trim().length > 0}
            onConfirm={onInsertLingbot}
            idle={"插入 LingBot JSON 模板"}
            armed={"确认替换?"}
          />
          <span className="field-hint">也可继续使用普通文本；以 JSON 开头时会在提交前校验格式</span>
        </div>
      )}
    </div>
  );
});
