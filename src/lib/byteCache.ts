/**
 * 按字节记账的 FIFO 缓存。
 *
 * 历史画廊的三类缓存（缩略图 / 原图 / 历史视频）此前只有条数上限：
 * 单条最长 256MB 的原图，6 条即成 1.5GB；与结果区的批量大视频 base64
 * 叠加后长会话内存可达数 GB。这里统一改为**字节预算**：超预算时从最旧
 * 开始淘汰，被淘汰的 key 返回给调用方以便释放资源（revokeObjectURL）。
 *
 * 单条本身超过预算时仍保留（功能优先），预算只约束总体；与旧实现的
 * “命中不重插、纯 FIFO”语义保持一致。
 */
export class ByteBudgedCache<T> {
  private map = new Map<string, T>();
  private bytes = new Map<string, number>();
  private total = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  /** 写入并记账（重复写会先扣旧账再记新值，仍是 FIFO 的“最后一次写入
   * 的位置”语义）。返回本次被淘汰的 `[key, value]` 列表，调用方负责释放
   * 资源（如 revokeObjectURL）。 */
  set(key: string, value: T, bytes: number): [string, T][] {
    if (this.map.has(key)) {
      this.total -= this.bytes.get(key) ?? 0;
      this.bytes.delete(key);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes.set(key, bytes);
    this.total += bytes;
    const evicted: [string, T][] = [];
    while (this.total > this.capacity && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      if (oldest == null || oldest === key) break;
      const oldValue = this.map.get(oldest) as T;
      this.remove(oldest);
      evicted.push([oldest, oldValue]);
    }
    return evicted;
  }

  delete(key: string): boolean {
    return this.remove(key);
  }

  private remove(key: string): boolean {
    const had = this.map.delete(key);
    if (had) {
      this.total -= this.bytes.get(key) ?? 0;
      this.bytes.delete(key);
    }
    return had;
  }
}
