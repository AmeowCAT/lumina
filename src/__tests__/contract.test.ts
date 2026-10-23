import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * TS ↔ Rust 命令面契约（审查 60-build-test §2.5 / 99-final §5.1）。
 *
 * `src/api.ts` 的每个 `invoke("命令名", {参数键})` 与 Rust 侧
 * `tauri::generate_handler![...]` 是**两处手写的同一事实**：命令名拼错、Rust 侧
 * 改名、`#[tauri::command]` 去掉，TypeScript 都看不出来；而 7 个交互测试把
 * 整个 `api` 模块 mock 掉，363 个用例仍会全绿。这条快照测试是唯一能立刻发现
 * 两侧漂移的地方——改名时它会失败，要求把新名字显式写进这里的双向断言。
 */
const apiSource = readFileSync("src/api.ts", "utf8");
const libSource = readFileSync("src-tauri/src/lib.rs", "utf8");

function invokeNames(source: string): string[] {
  // 允许泛型参数跨行（`invoke<{ ... }>("name"`）。
  const pattern = /invoke(?:<[\s\S]*?>)?\(\s*"([a-z0-9_]+)"/g;
  const names = [...source.matchAll(pattern)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

function handlerNames(source: string): string[] {
  const block = /tauri::generate_handler!\[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
  const names = [...block.matchAll(/([a-z0-9_]+)\s*,/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

const declCommands = (source: string): string[] => {
  // 命令函数可能是 `async fn` 也可能不是（例如 `detect_family`）。
  const names = [...source.matchAll(/#\[tauri::command\][\s\S]{0,80}?\bfn ([a-z0-9_]+)/g)].map(
    (m) => m[1],
  );
  return [...new Set(names)].sort();
};

describe("Tauri 命令面契约", () => {
  it("api.ts 调用的命令与 Rust 注册的命令完全一致", () => {
    const invoked = invokeNames(apiSource);
    const registered = handlerNames(libSource);
    expect(invoked.length).toBeGreaterThan(10);
    expect(registered).toEqual(invoked);
  });

  it("Rust 里声明的 #[tauri::command] 都被注册（没有死命令）", () => {
    const declared = declCommands(libSource);
    const registered = handlerNames(libSource);
    expect(declared).toEqual(registered);
  });
});
