import { describe, expect, it } from "vitest";
import { logSeverity } from "../logFormat";

describe("logSeverity", () => {
  it("recognizes the single-letter tags upstream #2104 introduced", () => {
    expect(logSeverity("[E] failed to load model --- model_loader.cpp:120")).toBe("error");
    expect(logSeverity("[W] can not found lora lora.safetensors --- common.cpp:2323")).toBe(
      "warn"
    );
    expect(logSeverity("[I] loading model from disk")).toBe("other");
    expect(logSeverity("[D] backend device list")).toBe("other");
    expect(logSeverity("[V] tensor layout")).toBe("other");
    // 未知等级沿用上游的 "?" 标签，上游用黄色渲染。
    expect(logSeverity("[?] something odd")).toBe("warn");
  });

  it("still recognizes the older padded tags", () => {
    expect(logSeverity("[ERROR  ] unsupported output format")).toBe("error");
    expect(logSeverity("[WARN   ] can not found lora abc")).toBe("warn");
    expect(logSeverity("[INFO   ] loading")).toBe("other");
    expect(logSeverity("[DEBUG  ] x")).toBe("other");
    expect(logSeverity("[VERBOSE] y")).toBe("other");
  });

  it("treats a recognized non-error tag as authoritative over the message text", () => {
    // 正文里出现 "error" 只是描述（例如计数），等级仍是 info。
    expect(logSeverity("[I] 0 errors during load")).toBe("other");
    // 标签为准：正文里的 failed 不会把 warn 升级成 error。
    expect(logSeverity("[W] sampler fallback for failed backend")).toBe("warn");
  });

  it("falls back to message keywords for untagged lines", () => {
    expect(logSeverity("failed to bind 127.0.0.1:1234")).toBe("error");
    expect(logSeverity("panic: index out of range")).toBe("error");
    expect(logSeverity("warning: deprecated option")).toBe("warn");
    expect(logSeverity("  |====>     | 5/20 - 1.23s/it")).toBe("other");
    // 标签认不出来（第三方前缀）时仍按正文判定。
    expect(logSeverity("[CUDA] error: out of memory")).toBe("error");
    expect(logSeverity("[ggml] warn: falling back to CPU")).toBe("warn");
  });
});
