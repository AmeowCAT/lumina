import { describe, expect, it } from "vitest";
import { buildDiagnosticArgs, diagnosticsFor, scaleValidationError } from "../diagnostics";
import { buildLaunchConfig } from "../launchConfig";

const runtime = { backend: "", refImagePreset: "", extraArgs: "", offloadCpu: false, quantType: "" };

describe("startup diagnostic arguments", () => {
  it("does not add flags for old settings or restored legacy snapshots", () => {
    expect(diagnosticsFor({})).toEqual({ logLevel: "", linearScale: "", attnScale: "" });
    expect(buildDiagnosticArgs({})).toEqual({ args: {}, errors: [] });
  });
  it("passes explicit values, including zero and one, only as startup flags", () => {
    expect(buildDiagnosticArgs({ logLevel: "debug", linearScale: "0", attnScale: "1" })).toEqual({
      args: { "log-level": "debug", "linear-scale": "0", "attn-scale": "1" }, errors: [],
    });
    const launch = buildLaunchConfig({
      family: "sensenova-u1", modelPath: "/models/model.safetensors.index.json", components: {},
      runtime: { ...runtime, logLevel: "verbose", linearScale: " 0.0078125 ", attnScale: "0x1p-7" },
    });
    expect(launch.args).toMatchObject({ "log-level": "verbose", "linear-scale": "0.0078125", "attn-scale": "0x1p-7" });
    expect(launch.args).not.toHaveProperty("sample_params");
    expect(launch.missing).toEqual([]);
  });
  it.each(["0", "-0", "1", ".5", "1e-3", "0x1p-7", "0x.8p1", "0e-999"])("accepts valid f32 scale %s", (value) => {
    expect(scaleValidationError(value)).toBeNull();
  });
  it.each(["NaN", "Infinity", "-1", "-0x1p-7", "1e39", "1e-40", "1e-50", "1e-999", "0x1p-9999", "1,2", "1px"])("rejects invalid/underflow scale %s", (value) => {
    expect(scaleValidationError(value)).not.toBeNull();
  });
  it("flags bad persisted values instead of throwing during dashboard rendering", () => {
    const launch = buildLaunchConfig({
      family: "hidream", modelPath: "/models/model.safetensors", components: {},
      runtime: { ...runtime, logLevel: "trace", linearScale: "-1", attnScale: "NaN" },
    });
    expect(launch.missing).toHaveLength(3);
    expect(launch.args["linear-scale"]).toBe("-1");
  });
});
