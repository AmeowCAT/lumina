import { memo, useRef, useState } from "react";
import type { Features, GenMode } from "../../../types";
import { FAMILY_CONFIG, isH3VideoFamily } from "../../../config/families";
import { useStore } from "../../../store";
import { InfoTip, Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Select } from "../../ui/Select";
import { ImageUpload } from "../../ui/ImageUpload";
import { RefMediaSection } from "./RefMediaSection";
import { IC } from "../../ui/Icons";
import {
  CONTROL_TYPES,
  featureEnabled,
  formatNumberForInput,
  MAX_PROMPT_IMAGES,
  readFileAsDataUrl,
  setStringArgValue,
  stringArgValue,
} from "../../../lib/utils";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 多图输入行：缩略图 + 逐个删除 + 追加。参考图片与 VACE 条件帧共用。 */
function MultiImageRow({
  label,
  images,
  onChange,
  addLabel,
}: {
  label: string;
  images: string[];
  onChange: (updater: (r: string[]) => string[]) => void;
  addLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const toast = useStore((s) => s.toast);
  return (
    <div className="form-row">
      <div className="form-label">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {images.map((img, i) => (
          <div
            key={i}
            className="relative h-14 w-14 overflow-hidden rounded-md border border-line bg-well"
          >
            <img src={img} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              className="upload-remove upload-remove-sm"
              aria-label={`移除第 ${i + 1} 张`}
              onClick={() => onChange((r) => r.filter((_, j) => j !== i))}
            >
              {IC.x}
            </button>
          </div>
        ))}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (!files.length) return;
            const invalid = files
              .map((f) =>
                !f.type.startsWith("image/")
                  ? `${f.name}（非图片格式）`
                  : f.size > MAX_UPLOAD_BYTES
                    ? `${f.name}（超过 100MB）`
                    : null,
              )
              .filter((x): x is string => !!x);
            if (invalid.length) {
              toast(`已跳过 ${invalid.length} 个无效文件：${invalid.join("、")}`, true);
            }
            const valid = files.filter(
              (f) => f.type.startsWith("image/") && f.size <= MAX_UPLOAD_BYTES,
            );
            if (!valid.length) return;
            // 条件帧顺序即上游条件帧顺序：显式按文件名排序，
            // 不依赖浏览器的 FileList 顺序。
            valid.sort((a, b) => a.name.localeCompare(b.name));
            Promise.all(valid.map(readFileAsDataUrl)).then((urls) =>
              onChange((p) => [...p, ...urls]),
            );
            // 文件对话框是原生模态：关闭后把焦点还给追加按钮
            requestAnimationFrame(() => addBtnRef.current?.focus());
          }}
        />
        <button
          ref={addBtnRef}
          type="button"
          aria-label={addLabel}
          className="grid h-14 w-14 cursor-pointer place-items-center rounded-md border border-dashed border-line2 bg-transparent text-muted transition-colors hover:border-accent hover:text-accent-hi"
          onClick={() => inputRef.current?.click()}
        >
          {IC.plus}
        </button>
      </div>
    </div>
  );
}

function makeUniquePromptImageId(existing: Record<string, string>, fileName: string): string {
  const stem =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/>/g, "")
      .trim() || "img";
  if (!(stem in existing)) return stem;
  let n = 2;
  while (`${stem}_${n}` in existing) n++;
  return `${stem}_${n}`;
}

function PromptImageRow({
  id,
  src,
  allIds,
  onRename,
  onInsert,
  onRemove,
}: {
  id: string;
  src: string;
  allIds: string[];
  onRename: (oldId: string, nextId: string) => void;
  onInsert?: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState(id);
  const toast = useStore((s) => s.toast);
  const commit = () => {
    const next = draft.trim();
    if (next === id) return;
    if (!next || next.includes(">")) {
      toast('图片 ID 不能为空且不能包含 ">"', true);
      setDraft(id);
      return;
    }
    if (allIds.includes(next)) {
      toast(`图片 ID「${next}」已存在`, true);
      setDraft(id);
      return;
    }
    onRename(id, next);
  };
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-line bg-well">
        <img src={src} alt={id} className="h-full w-full object-cover" />
      </div>
      <input
        type="text"
        className="input flex-1 font-mono text-[11.5px]"
        aria-label={`内联图片 ${id} 的 ID`}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {onInsert && (
        <button
          type="button"
          className="btn btn-sm shrink-0"
          title={`在正向提示词末尾插入 <image:${id}>`}
          aria-label={`插入 <image:${id}>`}
          onClick={() => onInsert(id)}
        >
          插入
        </button>
      )}
      <button
        type="button"
        className="icon-btn shrink-0"
        aria-label={`移除内联图片 ${id}`}
        onClick={() => onRemove(id)}
      >
        {IC.x}
      </button>
    </div>
  );
}

/**
 * 提示词内联图片（上游 #2341，`prompt_images` + `<image:ID>`）：
 * 与参考图（`ref_images`）独立，按 ID 绑定给 Qwen2.5-VL / Qwen3-VL / Qwen3.5
 * 视觉语言编码器，最多 32 张。
 */
function PromptImagesSection({
  promptImages,
  onChange,
  onInsert,
}: {
  promptImages: Record<string, string>;
  onChange: (updater: (r: Record<string, string>) => Record<string, string>) => void;
  onInsert?: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const toast = useStore((s) => s.toast);
  const entries = Object.entries(promptImages);
  const allIds = entries.map(([k]) => k);

  const handleRename = (oldId: string, nextId: string) => {
    onChange((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldId ? nextId : k] = v;
      }
      return next;
    });
  };

  const handleRemove = (id: string) => {
    onChange((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <div className="form-row form-section">
      <div className="form-label-row">
        <div className="form-label">
          <span>提示内联图片</span>
          <span className="field-anchor">
            &lt;image:ID&gt; · {entries.length}/{MAX_PROMPT_IMAGES}
          </span>
        </div>
        <InfoTip label="用法" tone="accent">
          在提示词中用 &lt;image:ID&gt; 引用对应图片（最多 32 张），需模型支持视觉输入。
        </InfoTip>
      </div>
      <div className="flex flex-col gap-2">
        {entries.map(([id, src]) => (
          <PromptImageRow
            key={id}
            id={id}
            src={src}
            allIds={allIds}
            onRename={handleRename}
            onInsert={onInsert}
            onRemove={handleRemove}
          />
        ))}
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              if (!files.length) return;
              const invalid = files
                .map((f) =>
                  !f.type.startsWith("image/")
                    ? `${f.name}（非图片格式）`
                    : f.size > MAX_UPLOAD_BYTES
                      ? `${f.name}（超过 100MB）`
                      : null,
                )
                .filter((x): x is string => !!x);
              if (invalid.length) {
                toast(`已跳过 ${invalid.length} 个无效文件：${invalid.join("、")}`, true);
              }
              const valid = files.filter(
                (f) => f.type.startsWith("image/") && f.size <= MAX_UPLOAD_BYTES,
              );
              if (!valid.length) return;
              const remaining = MAX_PROMPT_IMAGES - entries.length;
              if (remaining <= 0) {
                toast(`单次请求最多支持 ${MAX_PROMPT_IMAGES} 张提示内联图片`, true);
                return;
              }
              const accepted = valid.slice(0, remaining);
              if (valid.length > remaining) {
                toast(`最多保留 ${MAX_PROMPT_IMAGES} 张，已跳过超出部分`, true);
              }
              Promise.all(
                accepted.map(async (f) => ({ name: f.name, url: await readFileAsDataUrl(f) })),
              ).then((loaded) => {
                onChange((prev) => {
                  const next = { ...prev };
                  for (const item of loaded) {
                    if (Object.keys(next).length >= MAX_PROMPT_IMAGES) break;
                    const id = makeUniquePromptImageId(next, item.name);
                    next[id] = item.url;
                  }
                  return next;
                });
              });
              requestAnimationFrame(() => addBtnRef.current?.focus());
            }}
          />
          <button
            ref={addBtnRef}
            type="button"
            className="btn btn-sm"
            aria-label="添加提示内联图片"
            disabled={entries.length >= MAX_PROMPT_IMAGES}
            onClick={() => inputRef.current?.click()}
          >
            {IC.plus} 添加内联图片
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  features: Features;
  mode: GenMode;
  family: string;
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  ipAdapterImage: string | null;
  endImage: string | null;
  refImages: string[];
  controlFrames: string[];
  /** 视频侧参考图参数串（`ref_image_args`，MiniMax-H3 的 ref_image_size）。 */
  refImageArgs?: string;
  /** 内核是否支持原生 `ref_image_args` 覆盖（上游 #2396+ DGL 内核发送即 400）。 */
  refImageOverridesSupported?: boolean;
  /** 提示词内联图片（上游 #2341，`prompt_images`）。 */
  promptImages?: Record<string, string>;
  promptImagesSupported?: boolean;
  onSetPromptImages?: (updater: (r: Record<string, string>) => Record<string, string>) => void;
  onInsertPromptImageRef?: (id: string) => void;
  controlFramesSupported: boolean;
  refImagesSupported: boolean;
  /** Ref2VA 参考媒体（上游 #2194）：仅 ref2va 家族且内核声明 feature 时渲染。 */
  refVideos: string[][];
  refAudios: string[];
  refVideoAudios: string[];
  refVideosSupported: boolean;
  refAudiosSupported: boolean;
  refVideoAudiosSupported: boolean;
  onSetRefVideos: (updater: (r: string[][]) => string[][]) => void;
  onSetRefAudios: (updater: (r: string[]) => string[]) => void;
  onSetRefVideoAudios: (updater: (r: string[]) => string[]) => void;
  strength: number | undefined;
  controlStrength: number | undefined;
  /** 控制图类型（上游 #2284，SDXL ControlNet Union 必需）。 */
  controlType: string | undefined;
  /** 内核默认值里是否出现 control_type 键（旧内核隐藏控件）。 */
  controlTypeSupported: boolean;
  ipAdapterStrength: number | undefined;
  /** VACE 的条件强度（审查 50-ux F-18：上游 webui 有、Lumina 请求体已接但无控件）。 */
  vaceStrength: number | undefined;
  imgCfg: number | undefined;
  txtCfg: number | undefined;
  onUpdate: (path: string, v: unknown) => void;
  onSetImage: (
    which: "initImage" | "maskImage" | "controlImage" | "ipAdapterImage" | "endImage",
    v: string | null,
  ) => void;
  onSetRefImages: (updater: (r: string[]) => string[]) => void;
  onSetControlFrames: (updater: (r: string[]) => string[]) => void;
  onInitSize: (w: number, h: number) => void;
}

export const ImageInputsPanel = memo(function ImageInputsPanel({
  features,
  mode,
  family,
  initImage,
  maskImage,
  controlImage,
  ipAdapterImage,
  endImage,
  refImages,
  controlFrames,
  refImageArgs,
  refImageOverridesSupported = true,
  promptImages,
  promptImagesSupported = false,
  onSetPromptImages,
  onInsertPromptImageRef,
  controlFramesSupported,
  refImagesSupported,
  refVideos,
  refAudios,
  refVideoAudios,
  refVideosSupported,
  refAudiosSupported,
  refVideoAudiosSupported,
  onSetRefVideos,
  onSetRefAudios,
  onSetRefVideoAudios,
  strength,
  controlStrength,
  controlType,
  controlTypeSupported,
  ipAdapterStrength,
  vaceStrength,
  imgCfg,
  txtCfg,
  onUpdate,
  onSetImage,
  onSetRefImages,
  onSetControlFrames,
  onInitSize,
}: Props) {
  return (
    <Panel title="图片输入" collapsed={!featureEnabled(features, "init_image")}>
      {featureEnabled(features, "init_image") && (
        <ImageUpload
          label="初始图片"
          value={initImage}
          onChange={(v) => onSetImage("initImage", v)}
          onSizeDetected={onInitSize}
        />
      )}
      {featureEnabled(features, "mask_image") && mode === "img_gen" && (
        <ImageUpload label="蒙版" value={maskImage} onChange={(v) => onSetImage("maskImage", v)} />
      )}
      {featureEnabled(features, "control_image") && mode === "img_gen" && (
        <ImageUpload
          label="Control 图片"
          value={controlImage}
          onChange={(v) => onSetImage("controlImage", v)}
        />
      )}
      {featureEnabled(features, "ip_adapter_image") && mode === "img_gen" && (
        <ImageUpload
          label="IP-Adapter 图片"
          value={ipAdapterImage}
          onChange={(v) => onSetImage("ipAdapterImage", v)}
        />
      )}
      {featureEnabled(features, "end_image") && mode === "vid_gen" && (
        <ImageUpload label="结束帧" value={endImage} onChange={(v) => onSetImage("endImage", v)} />
      )}
      {(featureEnabled(features, "init_image") || featureEnabled(features, "control_image")) &&
        mode === "img_gen" && (
          <>
            <Slider
              label="重绘强度"
              value={strength ?? 0.75}
              onChange={(v) => onUpdate("strength", v)}
              min={0}
              max={1}
              step={0.05}
            />
            <Slider
              label="Control 强度"
              value={controlStrength ?? 0.9}
              onChange={(v) => onUpdate("control_strength", v)}
              min={0}
              max={1}
              step={0.05}
            />
            {/* 上游 #2284：SDXL ControlNet Union 必需的控制类型；其它
                ControlNet 忽略。仅新内核（默认值含 control_type 键）显示。 */}
            {controlTypeSupported && (
              <div className="form-row">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="control-type">
                    控制类型
                  </label>
                  <span className="field-anchor">Union</span>
                </div>
                <Select
                  id="control-type"
                  value={controlType ?? ""}
                  onChange={(v) => onUpdate("control_type", v || undefined)}
                  options={[{ value: "", label: "未设置（非 Union 模型）" }, ...CONTROL_TYPES]}
                />
              </div>
            )}
            <Slider
              label="CFG (图像)"
              value={imgCfg}
              onChange={(v) => onUpdate("sample_params.guidance.img_cfg", v)}
              min={0}
              max={30}
              step={0.5}
              sublabel={
                imgCfg != null ? undefined : `跟随文本 (${formatNumberForInput(txtCfg ?? 0)})`
              }
            />
          </>
        )}
      {featureEnabled(features, "ip_adapter_image") && mode === "img_gen" && (
        <Slider
          label="IP-Adapter 强度"
          value={ipAdapterStrength ?? 1.0}
          onChange={(v) => onUpdate("ip_adapter_strength", v)}
          min={0}
          max={2}
          step={0.05}
        />
      )}
      {featureEnabled(features, "init_image") && mode === "vid_gen" && (
        <Slider
          label="图生视频强度"
          value={strength ?? 0.75}
          onChange={(v) => onUpdate("strength", v)}
          min={0}
          max={1}
          step={0.05}
        />
      )}
      {refImagesSupported && (
        <MultiImageRow
          label={
            "参考图片" +
            // 只在「参考图本身」是必填项时标必需；Ref2VA 属于「任一条件」，
            // 标成必需会误导成必须给图。
            (FAMILY_CONFIG[family]?.requiredInputsByMode?.[mode]?.includes("ref_images")
              ? "（必需）"
              : "")
          }
          images={refImages}
          onChange={onSetRefImages}
          addLabel="添加参考图片"
        />
      )}
      {refImagesSupported &&
        refImageOverridesSupported &&
        mode === "vid_gen" &&
        isH3VideoFamily(family) && (
          <div className="form-row">
            <label className="form-label" htmlFor="ref-image-size">
              参考图尺寸
            </label>
            <Select
              id="ref-image-size"
              value={stringArgValue(refImageArgs, "ref_image_size") || "match"}
              onChange={(v) =>
                onUpdate(
                  "ref_image_args",
                  setStringArgValue(refImageArgs, "ref_image_size", v === "match" ? null : v),
                )
              }
              options={[
                { value: "match", label: "匹配画布（默认）" },
                { value: "max", label: "最高 2048 短边（更慢）" },
              ]}
            />
          </div>
        )}
      {mode === "vid_gen" &&
        (family === "minimax-h3-ref2va" || family === "hyperflow-h3-flash-ref2va") && (
          <RefMediaSection
            refVideos={refVideos}
            refAudios={refAudios}
            refVideoAudios={refVideoAudios}
            videosSupported={refVideosSupported}
            audiosSupported={refAudiosSupported}
            videoAudiosSupported={refVideoAudiosSupported}
            onSetRefVideos={onSetRefVideos}
            onSetRefAudios={onSetRefAudios}
            onSetRefVideoAudios={onSetRefVideoAudios}
          />
        )}
      {controlFramesSupported && mode === "vid_gen" && (
        <>
          <MultiImageRow
            label="条件帧（VACE）"
            images={controlFrames}
            onChange={onSetControlFrames}
            addLabel="添加条件帧"
          />
          {/* 审查 50-ux F-18：上游 webui 有 VACE Strength，Lumina 请求体一直会发
              vace_strength（utils.ts），但界面没有入口——VACE 的唯一行为旋钮。 */}
          <Slider
            label="VACE 条件强度"
            value={vaceStrength ?? 1.0}
            onChange={(v) => onUpdate("vace_strength", v)}
            min={0}
            max={2}
            step={0.05}
          />
        </>
      )}
      {promptImagesSupported && onSetPromptImages && (
        <PromptImagesSection
          promptImages={promptImages ?? {}}
          onChange={onSetPromptImages}
          onInsert={onInsertPromptImageRef}
        />
      )}
    </Panel>
  );
});
