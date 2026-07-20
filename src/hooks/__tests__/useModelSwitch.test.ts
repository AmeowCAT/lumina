import { describe, expect, it } from "vitest";
import type { Capabilities } from "../../types";
import { capabilitiesMatchModel } from "../useModelSwitch";

const caps = (path?: string, name = "Flux Model") =>
  ({ model: { path, name } }) as Capabilities;

describe("model switch readiness", () => {
  it("accepts capabilities that only expose a display name", () => {
    expect(capabilitiesMatchModel(caps(undefined), "D:/models/flux.safetensors")).toBe(true);
  });

  it("matches reported paths across slash and case differences", () => {
    expect(
      capabilitiesMatchModel(
        caps("d:\\MODELS\\flux.safetensors"),
        "D:/models/flux.safetensors"
      )
    ).toBe(true);
  });

  it("rejects an explicitly reported different model path", () => {
    expect(
      capabilitiesMatchModel(
        caps("D:/models/other.safetensors"),
        "D:/models/flux.safetensors"
      )
    ).toBe(false);
  });
});
