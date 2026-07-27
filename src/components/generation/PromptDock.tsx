import { memo, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { IC } from "../ui/Icons";
import { Slider } from "../ui/Slider";
import { TwoTapButton } from "../ui/TwoTapButton";
import { cn } from "../ui/cn";
import type { Limits } from "../../types";

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
  steps: number;
  txtCfg: number;
  limits: Limits | undefined;
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
  steps,
  txtCfg,
  limits,
  onUpdate,
  onToggleNegative,
  onRandomSeed,
  onGenerate,
  onInsertLingbot,
  onOpenSheet,
}: Props) {
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
      <textarea
        id="positive-prompt"
        className="dock-prompt"
        value={prompt}
        onChange={(e) => onUpdate("prompt", e.target.value)}
        placeholder="描述你想生成的画面…（Ctrl + Enter 生成）"
        rows={3}
        aria-label="正向提示词"
      />
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
            step={64}
          />
          <Slider
            label="高度"
            value={height}
            onChange={(v) => onUpdate("height", v)}
            min={limits?.min_height || 64}
            max={limits?.max_height || 4096}
            step={64}
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
          chipText={`CFG ${txtCfg}`}
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
        <button
          className="btn btn-primary generate-btn"
          onClick={onGenerate}
          disabled={disabled}
        >
          {submitting ? (
            <>
              <span className="spinner" /> 提交中
            </>
          ) : generating ? (
            <>
              <span className="spinner" /> 生成中
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
          <span className="field-hint">
            也可继续使用普通文本；以 JSON 开头时会在提交前校验格式
          </span>
        </div>
      )}
    </div>
  );
});
