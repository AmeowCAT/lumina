import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdvancedSamplingPanel } from "../panels/AdvancedSamplingPanel";

const baseProps = {
  eta: undefined,
  flowShift: undefined,
  slg: undefined,
  cacheMode: undefined,
  clipSkip: undefined,
  extraSampleArgs: undefined,
};

describe("AdvancedSamplingPanel VAE 分块", () => {
  // 上游 get_tile_sizes 里相对尺寸优先于绝对尺寸：改绝对值却不清掉相对值，
  // 用户会看到"输入的数字根本没生效"。
  it("编辑分块宽/高时清除该轴的相对尺寸覆盖", async () => {
    const onUpdate = vi.fn();
    render(
      <AdvancedSamplingPanel
        {...baseProps}
        onUpdate={onUpdate}
        vaeTilingProtocol="pixels"
        vaeTilingParams={{ enabled: true, tile_size_w: 256, rel_size_w: 0.5 }}
      />
    );

    const width = screen.getByLabelText(/分块宽/);
    await userEvent.clear(width);
    await userEvent.type(width, "512{Enter}");

    expect(onUpdate).toHaveBeenCalledWith(
      "vae_tiling_params",
      expect.objectContaining({ tile_size_w: 512, rel_size_w: 0 })
    );
  });

  it("相对尺寸存在时给出提示并可一键清除", async () => {
    const onUpdate = vi.fn();
    render(
      <AdvancedSamplingPanel
        {...baseProps}
        onUpdate={onUpdate}
        vaeTilingProtocol="pixels"
        vaeTilingParams={{ enabled: true, tile_size_w: 256, rel_size_w: 0.5 }}
      />
    );

    expect(screen.getByText(/相对尺寸正在覆盖分块宽/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "清除相对尺寸" }));

    expect(onUpdate).toHaveBeenCalledWith(
      "vae_tiling_params",
      expect.objectContaining({ rel_size_w: 0, rel_size_h: 0 })
    );
  });

  // 旧 latent 值是逐轴的：只要还在就提示，且提示里点名具体字段，
  // 不能因为"已经有像素值"就静默——那些像素值可能只是启动默认值。
  it("旧 latent 尺寸逐轴提示，并在清除后只移除旧字段", async () => {
    const onUpdate = vi.fn();
    render(
      <AdvancedSamplingPanel
        {...baseProps}
        onUpdate={onUpdate}
        vaeTilingProtocol="pixels"
        vaeTilingParams={{
          enabled: true,
          tile_size_w: 512,
          tile_size_x: 16,
          rel_size_y: 0,
        }}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("tile_size_x=16");

    await userEvent.click(screen.getByRole("button", { name: "清除旧值" }));

    const [path, value] = onUpdate.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("vae_tiling_params");
    expect(value.tile_size_x).toBeUndefined();
    // 像素值属于用户设置，清除旧值时不能被顺手抹掉。
    expect(value.tile_size_w).toBe(512);
  });

  // 旧内核上跑像素值时给出反方向提示（对称缺口）。
  it("旧协议内核下提示像素值不会下发", () => {
    render(
      <AdvancedSamplingPanel
        {...baseProps}
        onUpdate={vi.fn()}
        vaeTilingProtocol="latent"
        vaeTilingParams={{ enabled: true, tile_size_w: 512, tile_size_h: 512 }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/不会下发到该内核/);
  });
});
