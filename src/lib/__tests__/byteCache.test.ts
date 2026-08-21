import { describe, expect, it } from "vitest";
import { ByteBudgedCache } from "../byteCache";
import { b64ByteLength } from "../utils";

describe("ByteBudgedCache（按字节预算的 FIFO 缓存）", () => {
  it("keeps entries under the byte budget and evicts oldest first", () => {
    const cache = new ByteBudgedCache<string>(100);
    expect(cache.set("a", "A", 40)).toEqual([]);
    expect(cache.set("b", "B", 40)).toEqual([]);
    // 超预算：挤出最旧的 a。
    expect(cache.set("c", "C", 40)).toEqual([["a", "A"]]);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("reports evicted values so callers can revoke resources", () => {
    const cache = new ByteBudgedCache<string>(10);
    cache.set("v1", "blob:1", 6);
    const evicted = cache.set("v2", "blob:2", 6);
    expect(evicted).toEqual([["v1", "blob:1"]]);
  });

  it("keeps a single oversized entry (功能优先,预算只约束总体)", () => {
    const cache = new ByteBudgedCache<string>(16);
    expect(cache.set("big", "B", 100)).toEqual([]);
    expect(cache.get("big")).toBe("B");
    // 第二条约超预算时挤出 big,而不是把自己拒之门外。
    expect(cache.set("small", "S", 4)).toEqual([["big", "B"]]);
    expect(cache.get("small")).toBe("S");
  });

  it("re-inserting an existing key moves it to the newest position", () => {
    const cache = new ByteBudgedCache<string>(50);
    cache.set("a", "A1", 20);
    cache.set("b", "B", 20);
    // 重插 a：账目更新且 a 移到最新位置（顺序 b → a）。
    cache.set("a", "A2", 20);
    // 再插入 c 超预算：挤出的最旧项是 b，而不是被重插过的 a。
    expect(cache.set("c", "C", 20)).toEqual([["b", "B"]]);
    expect(cache.get("a")).toBe("A2");
  });

  it("delete removes the entry and its bytes", () => {
    const cache = new ByteBudgedCache<string>(100);
    cache.set("a", "A", 40);
    cache.set("b", "B", 40);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("missing")).toBe(false);
    // b 独自 40 字节,继续插入 40 字节不触发淘汰。
    expect(cache.set("c", "C", 40)).toEqual([]);
    expect(cache.get("b")).toBe("B");
    expect(cache.size).toBe(2);
  });
});

describe("b64ByteLength", () => {
  it("estimates raw bytes from base64 length (4 chars ≈ 3 bytes)", () => {
    expect(b64ByteLength("")).toBe(0);
    // "image" 的 base64 是 "aW1hZ2U="（8 字符）→ 6 字节
    expect(b64ByteLength("aW1hZ2U=")).toBe(6);
    // data URL 前缀被剔除后再估算。
    expect(b64ByteLength("data:image/png;base64,aW1hZ2U=")).toBe(6);
  });
});
