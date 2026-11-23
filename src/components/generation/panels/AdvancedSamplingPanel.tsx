import { memo, useEffect, useRef, useState } from "react";
import type {
  CacheOptionDraft,
  GenMode,
  SlgGuidance,
  VaeTilingParams,
  VaeTilingProtocol,
} from "../../../types";
import { CACHE_MODES } from "../../../config/families";
import {
  cacheModeGroup,
  cacheOptionFields,
  clearLegacyLatentTiling,
  formatLayerList,
  formatNumberForInput,
  legacyLatentTilingAxes,
  legacyTilingDroppedOnPixels,
  parseCacheOption,
  parseLayerList,
  pixelTilingDroppedOnLatent,
  sanitizeCacheOptionsForMode,
  scmMaskAppliesToMode,
  setTilingArgValue,
  tilingArgValue,
  validateScmMask,
  validateSlgWindow,
} from "../../../lib/utils";
import { InfoTip, Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";
import { cn } from "../../ui/cn";

interface Props {
  eta: number | undefined;
  flowShift: number | undefined;
  /** 时间步平移（0/undefined = 内核默认）；F-18 补的入口。 */
  shiftedTimestep?: number | undefined;
  slg: SlgGuidance | undefined;
  vaeTilingParams: VaeTilingParams | undefined;
  showVaeTiling?: boolean;
  /** 所选内核使用哪套分块字段（上游 #2059 前后不同）。 */
  vaeTilingProtocol?: VaeTilingProtocol;
  /** 视频模式才显示时间维分块（审查 30-api §2.9）。 */
  mode?: GenMode;
  /** 家族 id：Wan2.2 TI2V 5B 的组解码帧数只在它下面出现（上游 #2196）。 */
  family?: string;
  cacheMode: string | undefined;
  /** 结构化缓存微调草稿（`cache_option` 的界面态，不直接进请求体）。 */
  cacheOptions?: CacheOptionDraft;
  /** 原始 `cache_option` 串（元数据恢复/旧设置），用于保留界面不认识的键。 */
  cacheOption?: string;
  /** SCM 步掩码原文（非法值由界面拦住、请求体不下发）。 */
  scmMask?: string;
  clipSkip: number | undefined;
  extraSampleArgs: string | undefined;
  /** 内核是否支持原生 SLG（上游 #2396+ 已迁入 DGL 脚本，发送即 400）。 */
  supportsSlg?: boolean;
  /** 内核是否支持原生 shifted_timestep（上游 #2396+ 已迁入 DGL 脚本，发送即 400）。 */
  supportsShiftedTimestep?: boolean;
  /** 所选内核是否为上游 #2396+ DGL 架构（用于隐藏已失效的块级缓存 Fn/Bn 控件）。 */
  dglBackend?: boolean;
  onUpdate: (path: string, v: unknown) => void;
}

export const AdvancedSamplingPanel = memo(function AdvancedSamplingPanel({
  eta,
  flowShift,
  shiftedTimestep,
  slg,
  vaeTilingParams,
  showVaeTiling = true,
  vaeTilingProtocol = "pixels",
  mode = "img_gen",
  family = "",
  cacheMode,
  cacheOptions,
  cacheOption,
  scmMask,
  clipSkip,
  extraSampleArgs,
  supportsSlg = true,
  supportsShiftedTimestep = true,
  dglBackend = false,
  onUpdate,
}: Props) {
  const tilingEnabled = !!vaeTilingParams?.enabled;
  // 旧内核的 latent 单位数值在新内核上不会被读取——提示重设，而不是替用户
  // 乘一个猜出来的 VAE 缩放因子；反向（像素值遇到旧内核）同样要提示。
  const droppedLegacyTiling = legacyTilingDroppedOnPixels(vaeTilingParams);
  const legacyAxes = legacyLatentTilingAxes(vaeTilingParams);
  const droppedPixelTiling = pixelTilingDroppedOnLatent(vaeTilingParams);
  const isPixels = vaeTilingProtocol === "pixels";
  // 相对尺寸在上游 get_tile_sizes 里优先于绝对尺寸（factor > 0 直接换算），
  // 只看绝对输入框会以为"改了没生效"。
  const relativeOverrides = [
    (vaeTilingParams?.rel_size_w ?? 0) > 0 ? "宽" : null,
    (vaeTilingParams?.rel_size_h ?? 0) > 0 ? "高" : null,
  ].filter(Boolean) as string[];
  // 视频时间维分块（审查 30-api §2.9）：上游把它放在 extra_tiling_args 里，
  // 是长视频解码 OOM 的主要缓解手段，界面此前完全没有入口。
  const temporalOn = !!vaeTilingParams?.temporal_tiling;
  const temporalFrames = tilingArgValue(vaeTilingParams?.extra_tiling_args, "temporal_tile_frames");
  const temporalOverlap = tilingArgValue(
    vaeTilingParams?.extra_tiling_args,
    "temporal_tile_overlap",
  );
  // Wan2.2 TI2V 5B 才消费 temporal_decode_frames（上游 #2196）：每个时间分块里
  // 一次解码的 latent 帧数，越大越吃显存。
  const temporalDecodeFrames = tilingArgValue(
    vaeTilingParams?.extra_tiling_args,
    "temporal_decode_frames",
  );
  const setTemporalArg = (key: string, value: number | null) =>
    onUpdate("vae_tiling_params", {
      ...vaeTilingParams,
      extra_tiling_args: setTilingArgValue(vaeTilingParams?.extra_tiling_args, key, value),
    });

  // ── F-18：缓存微调 / SCM 掩码 / SLG 子项 ────────────────────────────
  // 语义来源 docs/audit/95-f18-semantics.md：cache_option 是 key=value 串且
  // 同名键跨模式含义不同、scm_mask 非法会让内核 terminate、SLG 的 layers
  // 空数组等于关闭。这里只负责渲染与「按模式裁剪」，拼串在 utils 里做。
  const cacheFields = cacheOptionFields(cacheMode, { dglBackend });
  const cacheDraft = cacheOptions || {};
  const unknownCachePairs = parseCacheOption(cacheOption).unknownPairs;
  const writeCacheOption = (key: keyof CacheOptionDraft, value: number | boolean) =>
    onUpdate("cache_options", { ...cacheDraft, [key]: value });
  const changeCacheMode = (nextMode: string) => {
    onUpdate("cache_mode", nextMode);
    // 新模式不认的键必须丢掉：留着只会「界面上有值、内核根本不读」；
    // threshold/warmup 还会跨分组改语义（EasyCache 0.2 ≠ dbcache 残差阈值）。
    onUpdate("cache_options", sanitizeCacheOptionsForMode(nextMode, cacheDraft, cacheMode));
  };
  const scmVisible = scmMaskAppliesToMode(cacheMode);
  const scmError = validateScmMask(scmMask);
  // 跳层索引是文本输入：只在解析成功时写入参数，非法输入保留文本、只提示。
  // 空串 = 不设置（不下发该键），绝不写空数组（上游空数组等于关闭 SLG）。
  const layersFromProps = formatLayerList(slg?.layers);
  const [layersText, setLayersText] = useState(layersFromProps);
  const layersCommitted = useRef(layersFromProps);
  useEffect(() => {
    if (layersFromProps !== layersCommitted.current) {
      layersCommitted.current = layersFromProps;
      setLayersText(layersFromProps);
    }
  }, [layersFromProps]);
  const layersParse = parseLayerList(layersText);
  const layersError = layersParse.ok ? null : layersParse.error;
  const writeSlg = (patch: Partial<SlgGuidance>) =>
    onUpdate("sample_params.guidance.slg", { ...(slg || { scale: 0 }), ...patch });
  const slgWindowError = validateSlgWindow(slg?.layer_start, slg?.layer_end);
  return (
    <Panel title="高级采样" collapsed>
      <Slider
        label="Eta"
        value={eta ?? 1}
        onChange={(v) => onUpdate("sample_params.eta", v)}
        min={0}
        max={1}
        step={0.05}
      />
      <Slider
        label="Flow Shift"
        value={flowShift ?? 0}
        onChange={(v) => onUpdate("sample_params.flow_shift", v)}
        min={0}
        max={20}
        step={0.1}
      />
      {/* 审查 50-ux F-18：`shifted_timestep` 一直会随请求体发送（utils.ts），
          但界面没有入口——Flow 类模型微调时间步的第二个旋钮。0 表示用内核默认。
          上游 #2396+（DGL 架构）原生接口拒绝 shifted_timestep 与 SLG，按内核能力隐藏。 */}
      {supportsShiftedTimestep && (
        <Slider
          label="Shifted Timestep"
          value={shiftedTimestep ?? 0}
          onChange={(v) => onUpdate("sample_params.shifted_timestep", v)}
          min={0}
          max={1000}
          step={10}
          sublabel="0 = 自动"
        />
      )}
      {supportsSlg && (
        <>
          <Slider
            label="SLG Scale"
            value={slg?.scale ?? 0}
            onChange={(v) => writeSlg({ scale: v })}
            min={0}
            max={10}
            step={0.1}
            sublabel="0 = 关闭"
          />
          {/* 审查 F-18：SLG 的另外三个上游参数此前没有入口。
              layers 缺省 = 不下发（沿用内核 --skip-layers）；layer_start/end 是
              **总步数的分数**，按 int(start*N) < step < int(end*N) 生效
              （src/runtime/guidance.cpp:313-315），start>=end 时静默不生效。 */}
          <div className="form-grid">
            <div className="form-row">
              <label className="form-label" htmlFor="slg-layer-start">
                SLG 起始比例
              </label>
              <NumberInput
                id="slg-layer-start"
                value={slg?.layer_start ?? 0.01}
                onChange={(v) => writeSlg({ layer_start: v })}
                min={0}
                max={1}
                step={0.01}
              />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="slg-layer-end">
                SLG 结束比例
              </label>
              <NumberInput
                id="slg-layer-end"
                value={slg?.layer_end ?? 0.2}
                onChange={(v) => writeSlg({ layer_end: v })}
                min={0}
                max={1}
                step={0.01}
              />
            </div>
          </div>
          {slgWindowError && (
            <div
              className="mb-3.5 rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn"
              role="alert"
            >
              {slgWindowError}
            </div>
          )}
          <div className="form-row">
            <div className="form-label-row">
              <label className="form-label" htmlFor="slg-layers">
                跳层索引
              </label>
              <span className="field-anchor">逗号分隔</span>
            </div>
            <input
              id="slg-layers"
              className={cn("input font-mono text-[11.5px]", layersError && "invalid")}
              type="text"
              inputMode="numeric"
              value={layersText}
              spellCheck={false}
              placeholder="7,8,9"
              aria-invalid={layersError ? true : undefined}
              aria-describedby={layersError ? "slg-layers-error" : undefined}
              onChange={(e) => {
                const text = e.target.value;
                setLayersText(text);
                const parsed = parseLayerList(text);
                if (!parsed.ok) return; // 非法：保留文本，只提示，不写参数
                layersCommitted.current = formatLayerList(parsed.layers);
                writeSlg({ layers: parsed.layers });
              }}
            />
          </div>
          {layersError && (
            <div
              id="slg-layers-error"
              className="mb-3.5 rounded-md border border-danger/30 bg-danger-dim px-2.5 py-2 text-[11px] leading-relaxed text-danger"
              role="alert"
            >
              {layersError}
            </div>
          )}
        </>
      )}
      {(!supportsSlg || !supportsShiftedTimestep) && (
        <div className="mb-3.5 rounded-md border border-line bg-well px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
          当前版本内核需通过 DGL 脚本配置 SLG 与时间步偏移
        </div>
      )}
      {showVaeTiling && (
        <div className="form-section">
          <Toggle
            label="VAE 分块"
            checked={tilingEnabled}
            onChange={(v) => onUpdate("vae_tiling_params", { ...vaeTilingParams, enabled: v })}
            hint="大图或显存不足时开启"
          />
          {tilingEnabled && isPixels && (
            <>
              <div className="form-grid">
                <div className="form-row">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="vae-tile-w">
                      分块宽
                    </label>
                    <span className="field-anchor">0 = 自动</span>
                  </div>
                  <NumberInput
                    id="vae-tile-w"
                    value={vaeTilingParams?.tile_size_w ?? 0}
                    onChange={(v) =>
                      onUpdate("vae_tiling_params", {
                        ...vaeTilingParams,
                        tile_size_w: v,
                        // 相对尺寸会覆盖绝对尺寸；改绝对值时一并清零，
                        // 否则用户输入的数字根本不会生效。
                        rel_size_w: 0,
                      })
                    }
                    min={0}
                    max={8192}
                    step={32}
                  />
                </div>
                <div className="form-row">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="vae-tile-h">
                      分块高
                    </label>
                    <span className="field-anchor">0 = 自动</span>
                  </div>
                  <NumberInput
                    id="vae-tile-h"
                    value={vaeTilingParams?.tile_size_h ?? 0}
                    onChange={(v) =>
                      onUpdate("vae_tiling_params", {
                        ...vaeTilingParams,
                        tile_size_h: v,
                        rel_size_h: 0,
                      })
                    }
                    min={0}
                    max={8192}
                    step={32}
                  />
                </div>
              </div>
              {relativeOverrides.length > 0 && (
                <div className="mb-3.5 flex flex-col gap-2 rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn">
                  <span>
                    相对尺寸正在覆盖分块{relativeOverrides.join(" / ")}（rel_size_w=
                    {vaeTilingParams?.rel_size_w ?? 0}，rel_size_h=
                    {vaeTilingParams?.rel_size_h ?? 0}），上方像素值暂不生效。
                  </span>
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        onUpdate("vae_tiling_params", {
                          ...vaeTilingParams,
                          rel_size_w: 0,
                          rel_size_h: 0,
                        })
                      }
                    >
                      清除相对尺寸
                    </button>
                  </div>
                </div>
              )}
              {mode === "vid_gen" && (
                <>
                  <Toggle
                    label="视频时间维分块"
                    checked={temporalOn}
                    onChange={(v) =>
                      onUpdate("vae_tiling_params", {
                        ...vaeTilingParams,
                        temporal_tiling: v,
                      })
                    }
                    hint="长视频显存不足时开启"
                  />
                  {temporalOn && (
                    <>
                      <div className="form-grid">
                        <div className="form-row">
                          <label className="form-label" htmlFor="vae-temporal-frames">
                            时间分块帧数
                          </label>
                          <NumberInput
                            id="vae-temporal-frames"
                            value={temporalFrames ?? 0}
                            onChange={(v) =>
                              setTemporalArg("temporal_tile_frames", v > 0 ? v : null)
                            }
                            min={0}
                            max={256}
                            step={1}
                          />
                        </div>
                        <div className="form-row">
                          <label className="form-label" htmlFor="vae-temporal-overlap">
                            时间分块重叠
                          </label>
                          <NumberInput
                            id="vae-temporal-overlap"
                            value={temporalOverlap ?? 0}
                            onChange={(v) =>
                              setTemporalArg("temporal_tile_overlap", v > 0 ? v : null)
                            }
                            min={0}
                            max={32}
                            step={1}
                          />
                        </div>
                      </div>
                      {family === "wan-ti2v" && (
                        <div className="form-row">
                          <label className="form-label" htmlFor="vae-temporal-decode-frames">
                            组解码帧数
                          </label>
                          <NumberInput
                            id="vae-temporal-decode-frames"
                            value={temporalDecodeFrames ?? 0}
                            onChange={(v) =>
                              setTemporalArg("temporal_decode_frames", v > 0 ? v : null)
                            }
                            min={0}
                            max={64}
                            step={1}
                          />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {droppedLegacyTiling && (
                <div
                  className="mb-3.5 last:mb-0 flex flex-col gap-2 rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn"
                  role="alert"
                >
                  <span>
                    检测到旧版分块设置（
                    {[
                      legacyAxes.tileX != null
                        ? `tile_size_x=${formatNumberForInput(legacyAxes.tileX)}`
                        : null,
                      legacyAxes.tileY != null
                        ? `tile_size_y=${formatNumberForInput(legacyAxes.tileY)}`
                        : null,
                      legacyAxes.relX != null
                        ? `rel_size_x=${formatNumberForInput(legacyAxes.relX)}`
                        : null,
                      legacyAxes.relY != null
                        ? `rel_size_y=${formatNumberForInput(legacyAxes.relY)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("、")}
                    ），新版已改用像素尺寸，请重新设置后清除旧值。
                  </span>
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        onUpdate("vae_tiling_params", clearLegacyLatentTiling(vaeTilingParams))
                      }
                    >
                      清除旧值
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {tilingEnabled && !isPixels && (
            <div
              className="rounded-md border border-warn/30 bg-warn-dim px-2.5 py-2 text-[11px] leading-relaxed text-warn"
              role="alert"
            >
              当前内核使用旧版分块协议，仅沿用原有配置。
              {droppedPixelTiling && "上方像素尺寸不会下发到该内核，建议升级内核。"}
            </div>
          )}
        </div>
      )}
      <div className="form-row form-section">
        <label className="form-label" htmlFor="cache-mode">
          缓存
        </label>
        <Select
          id="cache-mode"
          value={cacheMode || "disabled"}
          onChange={changeCacheMode}
          options={CACHE_MODES.map((c) => ({ value: c.v, label: c.l }))}
        />
      </div>
      {/* 审查 F-18：cache_option 此前没有任何入口（只能从 PNG 元数据恢复）。
          上游按 key=value 逗号串解析且**同名键跨模式写不同字段**，所以做结构化
          控件 + 固定键序拼串，不做自由文本框（examples/common/common.cpp:2434-2494）。 */}
      {cacheFields.length > 0 && (
        <>
          <div className="mb-2.5 flex items-center justify-between gap-2 text-[11px] text-fg2">
            <span className="font-medium">缓存微调</span>
            {dglBackend && cacheModeGroup(cacheMode) === "block" && (
              <InfoTip label="说明" tone="accent">
                当前内核仅使用条件级缓存
              </InfoTip>
            )}
          </div>
          {cacheFields.map((spec) => {
            const raw = cacheDraft[spec.key];
            if (spec.kind === "toggle") {
              const checked = typeof raw === "boolean" ? raw : spec.defaultValue === true;
              return (
                <Toggle
                  key={spec.key}
                  label={`${spec.label}（${spec.key}）`}
                  checked={checked}
                  onChange={(v) => writeCacheOption(spec.key, v)}
                />
              );
            }
            return (
              <Slider
                key={spec.key}
                label={`${spec.label}（${spec.key}）`}
                value={typeof raw === "number" ? raw : undefined}
                onChange={(v) => writeCacheOption(spec.key, v)}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                sublabel={`默认 ${spec.defaultValue}`}
                hint={spec.hint || undefined}
              />
            );
          })}
          {unknownCachePairs.length > 0 && (
            <div className="field-hint field-hint-flush mb-3">
              保留附加项：{unknownCachePairs.map((p) => `${p.key}=${p.value}`).join("、")}
            </div>
          )}
          <button
            type="button"
            className="btn btn-sm mb-3.5"
            onClick={() => onUpdate("cache_options", {})}
          >
            还原缓存默认
          </button>
        </>
      )}
      {/* SCM 步掩码只在块级缓存下被消费；非法值一律拦住不下发——上游
          parse_scm_mask 对每段直接 std::stoi 且无 try/catch，异常逸出会让
          sd-server 的 worker 线程 terminate（src/runtime/cache_dit.hpp:558-575
          + examples/server/main.cpp:119）。 */}
      {scmVisible && (
        <>
          <div className="form-row">
            <div className="form-label-row">
              <label className="form-label" htmlFor="scm-mask">
                SCM 步掩码
              </label>
              <span className="field-anchor">0/1 序列</span>
            </div>
            <input
              id="scm-mask"
              className={cn("input font-mono text-[11.5px]", scmError && "invalid")}
              type="text"
              inputMode="numeric"
              value={scmMask ?? ""}
              spellCheck={false}
              placeholder="1,1,1,0,0,1,0,0,1,0"
              aria-invalid={scmError ? true : undefined}
              aria-describedby={scmError ? "scm-mask-error" : undefined}
              onChange={(e) => onUpdate("scm_mask", e.target.value)}
            />
          </div>
          {scmError && (
            <div
              id="scm-mask-error"
              className="mb-3.5 rounded-md border border-danger/30 bg-danger-dim px-2.5 py-2 text-[11px] leading-relaxed text-danger"
              role="alert"
            >
              {scmError}
            </div>
          )}
        </>
      )}
      <div className="form-row form-section">
        <label className="form-label" htmlFor="clip-skip">
          CLIP Skip
        </label>
        <Select
          id="clip-skip"
          value={String(clipSkip ?? -1)}
          onChange={(v) => onUpdate("clip_skip", parseInt(v))}
          options={[
            { value: "-1", label: "自动（随版本）" },
            { value: "1", label: "1 · 最后一层" },
            { value: "2", label: "2 · 倒数第二层" },
            { value: "3", label: "3" },
          ]}
        />
      </div>
      <div className="form-row">
        <div className="form-label-row">
          <div className="flex items-center gap-1.5">
            <label className="form-label" htmlFor="extra-sample-args">
              额外采样参数
            </label>
            <span className="field-anchor">key=value</span>
          </div>
          <InfoTip label="格式" side="top">
            以逗号分隔 key=value 键值对，同名键会覆盖上方设置。
          </InfoTip>
        </div>
        <input
          id="extra-sample-args"
          className="input font-mono text-[11.5px]"
          type="text"
          value={extraSampleArgs ?? ""}
          onChange={(e) => onUpdate("sample_params.extra_sample_args", e.target.value)}
          placeholder="例如 gamma=3,apg_eta=0.8,slg_uncond=true"
        />
      </div>
    </Panel>
  );
});
