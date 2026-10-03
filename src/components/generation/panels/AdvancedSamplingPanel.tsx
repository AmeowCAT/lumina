import { memo } from "react";
import type {
  SlgGuidance,
  VaeTilingParams,
  VaeTilingProtocol,
} from "../../../types";
import { CACHE_MODES } from "../../../config/families";
import {
  clearLegacyLatentTiling,
  legacyLatentTilingAxes,
  legacyTilingDroppedOnPixels,
  pixelTilingDroppedOnLatent,
} from "../../../lib/utils";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";

interface Props {
  eta: number | undefined;
  flowShift: number | undefined;
  slg: SlgGuidance | undefined;
  vaeTilingParams: VaeTilingParams | undefined;
  showVaeTiling?: boolean;
  /** 所选内核使用哪套分块字段（上游 #2059 前后不同）。 */
  vaeTilingProtocol?: VaeTilingProtocol;
  cacheMode: string | undefined;
  clipSkip: number | undefined;
  extraSampleArgs: string | undefined;
  onUpdate: (path: string, v: unknown) => void;
}

export const AdvancedSamplingPanel = memo(function AdvancedSamplingPanel({
  eta,
  flowShift,
  slg,
  vaeTilingParams,
  showVaeTiling = true,
  vaeTilingProtocol = "pixels",
  cacheMode,
  clipSkip,
  extraSampleArgs,
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
  return (
    <Panel title="高级采样" collapsed>
      <Slider
        label="Eta"
        value={eta ?? 1}
        onChange={(v) => onUpdate("sample_params.eta", v)}
        min={0}
        max={1}
        step={0.05}
        hint="随机噪声强度，通常保持推荐值"
      />
      <Slider
        label="Flow Shift"
        value={flowShift ?? 0}
        onChange={(v) => onUpdate("sample_params.flow_shift", v)}
        min={0}
        max={20}
        step={0.1}
        hint="Flow 类模型的时间步偏移"
      />
      <Slider
        label="SLG Scale"
        value={slg?.scale ?? 0}
        onChange={(v) =>
          onUpdate("sample_params.guidance.slg", {
            ...(slg || { layers: [7, 8, 9] }),
            scale: v,
          })
        }
        min={0}
        max={10}
        step={0.1}
        hint="跳层引导，0 表示关闭"
      />
      {showVaeTiling && (
        <>
          <Toggle
            label="VAE 分块"
            checked={tilingEnabled}
            onChange={(v) =>
              onUpdate("vae_tiling_params", { ...vaeTilingParams, enabled: v })
            }
          />
          {tilingEnabled && isPixels && (
            <>
              <div className="form-row mt-2">
                <label className="form-label" htmlFor="vae-tile-w">
                  分块宽
                  <span className="form-sublabel">
                    图像像素；0 用内核默认 256。编码与解码共用该尺寸
                  </span>
                </label>
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
                <label className="form-label" htmlFor="vae-tile-h">
                  分块高
                </label>
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
              {relativeOverrides.length > 0 && (
                <div className="field-hint field-hint-flush">
                  相对尺寸正在覆盖分块{relativeOverrides.join(" / ")}
                  （rel_size_w={vaeTilingParams?.rel_size_w ?? 0}、
                  rel_size_h={vaeTilingParams?.rel_size_h ?? 0}）：上游优先用相对值，
                  绝对尺寸不会生效。
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
              )}
              {droppedLegacyTiling && (
                <div className="field-hint field-hint-flush" role="alert">
                  旧内核的 latent 单位尺寸仍在设置里：
                  {[
                    legacyAxes.tileX != null ? `tile_size_x=${legacyAxes.tileX}` : null,
                    legacyAxes.tileY != null ? `tile_size_y=${legacyAxes.tileY}` : null,
                    legacyAxes.relX != null ? `rel_size_x=${legacyAxes.relX}` : null,
                    legacyAxes.relY != null ? `rel_size_y=${legacyAxes.relY}` : null,
                  ]
                    .filter(Boolean)
                    .join("、")}
                  。新版内核按图像像素解释，这些值不会下发；请按上面的像素尺寸重新设置
                  （8× VAE 的旧 32 大致对应 256 像素），确认后清除它们。
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      onUpdate(
                        "vae_tiling_params",
                        clearLegacyLatentTiling(vaeTilingParams)
                      )
                    }
                  >
                    清除旧值
                  </button>
                </div>
              )}
            </>
          )}
          {tilingEnabled && !isPixels && (
            <div className="field-hint field-hint-flush" role="alert">
              所选 sd-server 使用旧版分块协议（tile_size_x/y，latent 单位）：界面只
              读回旧值并原样下发，不会写入新版像素字段。
              {droppedPixelTiling &&
                "当前参数里只有新版像素尺寸，这组值不会下发到该内核；请按 latent 单位重新设置，或升级内核。"}
            </div>
          )}
          <div className="field-hint field-hint-flush">
            设置空间分块（编码与解码共用，默认 256 图像像素）；时间分块独立开关，
            不受 auto-fit 限制。新版内核只在主 VAE **解码分配失败**时自动缩小分块重试，
            执行失败不重试，编码也没有自动重试。
          </div>
        </>
      )}
      <div className="form-row mt-2">
        <label className="form-label" htmlFor="cache-mode">
          缓存
        </label>
        <Select
          id="cache-mode"
          value={cacheMode || "disabled"}
          onChange={(v) => onUpdate("cache_mode", v)}
          options={CACHE_MODES.map((c) => ({ value: c.v, label: c.l }))}
        />
      </div>
      <div className="form-row">
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
      <div className="form-row mt-2">
        <label className="form-label" htmlFor="extra-sample-args">
          额外采样参数
        </label>
        <input
          id="extra-sample-args"
          className="input"
          type="text"
          value={extraSampleArgs ?? ""}
          onChange={(e) => onUpdate("sample_params.extra_sample_args", e.target.value)}
          placeholder="例如 gamma=3,apg_eta=0.8,slg_uncond=true"
        />
        <div className="field-hint field-hint-flush mt-0.5">
          上游 extra_sample_args 的 key=value 列表（逗号分隔），兜底界面未暴露的
          采样器 / 调度器 / 引导参数：flux 的 base_shift·max_shift、lcm 的
          noise_clip_std、euler_ge 的 gamma、APG 的 apg_*、slg_uncond、
          guidance_schedule（分段写法 1x5+6x15，段间用 + 而不是逗号）、
          llada_image 的 uniform=1，以及注入噪声的采样器的
          noise_sampler=iid|brownian_tree（brownian_tree 可再配
          brownian_tree_rng=cpu|cuda|std_default|sampler_rng）等；同名键会覆盖
          上面的滑杆值
        </div>
      </div>
    </Panel>
  );
});
