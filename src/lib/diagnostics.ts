import type { RuntimeDiagnostics, ServerArgs } from "../types";

export const LOG_LEVELS = ["debug", "verbose", "info", "warn", "error"] as const;

/** Always clear absent legacy snapshot fields instead of inheriting another model's overrides. */
export function diagnosticsFor(source?: RuntimeDiagnostics): Required<RuntimeDiagnostics> {
  return {
    logLevel: source?.logLevel ?? "",
    linearScale: source?.linearScale ?? "",
    attnScale: source?.attnScale ?? "",
  };
}

const NUMBER_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?)$/;

/** Mirror upstream finite f32 / reciprocal checks, including C99 hex floats. */
export function scaleValidationError(raw?: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const invalid = "必须为有限正数，或 0 保留模型默认；不能为负数、溢出或过小值";
  if (!NUMBER_RE.test(text)) return invalid;
  let value: number;
  let nonzeroMantissa: boolean;
  if (/^[+-]?0x/i.test(text)) {
    const unsigned = text.replace(/^[+-]/, "").slice(2);
    const [mantissa, exponent] = unsigned.split(/[pP]/);
    const [whole, fraction = ""] = mantissa.split(".");
    value = ((whole ? parseInt(whole, 16) : 0) +
      (fraction ? parseInt(fraction, 16) / 16 ** fraction.length : 0)) * 2 ** Number(exponent || 0);
    if (text.startsWith("-")) value = -value;
    nonzeroMantissa = /[1-9a-f]/i.test(mantissa);
  } else {
    value = Number(text);
    nonzeroMantissa = /[1-9]/.test(text.split(/[eE]/)[0]);
  }
  const scale = Math.fround(value);
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(scale) ||
      nonzeroMantissa && (scale === 0 || !Number.isFinite(Math.fround(1 / scale)))) return invalid;
  return null;
}

export function buildDiagnosticArgs(source: RuntimeDiagnostics): { args: ServerArgs; errors: string[] } {
  const values = diagnosticsFor(source);
  const args: ServerArgs = {};
  const errors: string[] = [];
  const level = values.logLevel.trim();
  if (level) {
    args["log-level"] = level;
    if (!(LOG_LEVELS as readonly string[]).includes(level)) errors.push("日志等级必须为 debug / verbose / info / warn / error");
  }
  for (const [raw, flag, label] of [
    [values.linearScale, "linear-scale", "Linear 输入缩放"],
    [values.attnScale, "attn-scale", "Attention K/V 缩放"],
  ]) {
    const value = raw.trim();
    if (value) args[flag] = value;
    const error = scaleValidationError(raw);
    if (error) errors.push(`${label}${error}`);
  }
  return { args, errors };
}
