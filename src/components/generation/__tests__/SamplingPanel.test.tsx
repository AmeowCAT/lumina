import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SamplingPanel } from "../panels/SamplingPanel";

describe("SamplingPanel option fallbacks", () => {
  it("echoes the current sampler/scheduler even when caps omit them", () => {
    render(
      <SamplingPanel
        samplers={["euler"]}
        schedulers={["karras"]}
        sampleMethod="euler"
        scheduler="discrete"
        steps={20}
        txtCfg={7}
        distilled={undefined}
        showDistilled={false}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText("调度器")).toHaveTextContent("Discrete");
    expect(screen.getByLabelText("采样器")).toHaveTextContent("Euler");
  });
});
