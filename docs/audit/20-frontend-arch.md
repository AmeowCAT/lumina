# 前端架构 · 状态管理 · 性能与内存 审查报告

> 审查对象：`D:\Project\AmeowCAT\lumina`（HEAD `d442371`，v0.8.6），`src/**` 中除
> `config/families.ts` 的家族数据内容之外的全部前端代码。
> 方法：纯静态阅读 + 只读 grep/统计 + 在系统临时目录跑 node 微基准（不写仓库、
> 不跑 `npm test`/`tsc`/`vite`，见简报 §6 分工）。

## 0. 结论摘要

1. **未发现 P0 级缺陷**。前端的状态机、轮询收割、内存预算与 revoke 逻辑比多数同类
   客户端成熟（多处注释能对应到真实的旧 bug），问题集中在**预算模型不完整**与
   **订阅粒度/生命周期不匹配**两类。
2. **P1** `HistoryGallery` 的 512MB 视频 blob 缓存只在删除/淘汰时 revoke，**组件卸载时
   一个都不 revoke**；而它每次切 tab 都会卸载 → 每切一次泄漏一次（`HistoryGallery.tsx:341`）。
3. **P2** 结果区内存预算只按 base64 记账（1 GiB），未计入同一条结果的
   Blob、解码位图、以及历史画廊三份独立缓存（128 + 512 + 512 MB）→ 长视频会话下
   WebView2 渲染进程上限约 2.5 GiB，机器被模型吃满 RAM 时会被 OS 杀掉（未保存结果全丢）。
   单看预算口径是 P2，**与第 2 条叠加后按 P1 级风险对待**。
4. **P2** 日志面板订阅整个 `logs` 数组，每次 rAF flush 都把最多 2000 行重新 reconcile，
   且用 `key={i}` + 裁头策略让所有行内容整体错位（`LogPanel.tsx:125`、`store.ts:178`）。
5. **P2** 历史画廊每加载完**一张**缩略图就 `cacheSnapshot()` 复制整个缓存 Map 并整表重渲染
   → 一个 2000 文件的目录是 O(N²) 的渲染与拷贝（`HistoryGallery.tsx:228-232,252`）。
6. **P2** `Dashboard` 订阅了 `jobs`/`results`，于是**打开控制台期间每 2 秒整页重渲染**
   （1476 行 JSX + `buildLaunchConfig` + 每个组件字段一次全量 `files.filter`）。
7. **P2** `jobs[].config.images` 没有任何字节预算（`results` 有）：300 条任务计数上限挡住
   条数，挡不住 VACE 条件帧/批量输入图把内存顶上去（`utils.ts:189` vs `useJobPolling.ts:270`）。
8. **P2** App 的 3 秒状态轮询没有 in-flight 保护，且**在正常切换模型过程中会弹一条红色
   "与服务器的连接已断开"**，随后再弹"服务器就绪"（`App.tsx:126-131`、`useModelSwitch.ts:172-179`）。
9. **P2** 键盘快捷键只给 Esc 做了浮层门禁，`Ctrl+Enter`/`Ctrl+R` 在 Lightbox / 参数面板 /
   队列抽屉打开时仍会命中后台（`useKeyboardShortcuts.ts:19-27`）——作者只给放大对话框加了锁。
10. **P3** 其余项（§2.13–§2.17）：`virtualGrid` 缺 grid→scroller 的偏移项、mode 切换丢 300ms
    防抖内的参数、`families.ts` 让代码分割完全失效、`deepMerge` 的 `__proto__` 语义、
    motion `layout+filter` 在 60 张卡上的开销、`withTimeout` 残留定时器、结果数封顶后
    不再自动回顶等。

**总计：P0 × 0、P1 × 1、P2 × 11、P3 × 5（§2.1–§2.17 共 17 节；§2.17 内含 5 个零散小项）。**
其中 §2.1/§2.2（内存）、§2.4/§2.5/§2.6（渲染）、§2.7/§2.9（状态竞态）是同一批"订阅粒度与
生命周期"根因的不同表现，合并修复的性价比最高。

---

## 1. 审查范围与方法

**通读**（全文）：`store.ts`、`App.tsx`、`main.tsx`、`api.ts`、`types.ts`、
`hooks/*`（`useBlobUrlCache`、`useJobPolling`、`useModelSwitch`、`useFocusTrap`、
`useKeyboardShortcuts`、`useVideoPoster`、`useSystemIntegration`）、
`lib/*`（`utils`、`byteCache`、`virtualGrid`、`theme`、`diagnostics`、`logFormat`、
`systemIntegration`、`launchConfig`）、`components/generation/{GenerationUI,ResultsGrid,
HistoryGallery,GenerationParamsSheet,PromptDock,JobQueue}.tsx`、
`components/dashboard/Dashboard.tsx`、`components/ui/{LogPanel,Lightbox,ProgressBar}.tsx`。

> 行号口径：本报告一律用 `Get-Content` 的总行数（含空行）。因此 `families.ts` 2083、
> `Dashboard.tsx` 1476、`GenerationUI.tsx` 1264、`ResultsGrid.tsx` 827、`HistoryGallery.tsx` 755，
> 与任务描述里的 2053 / 1443 / 1224 / 803 / 722 略有差别——后者是"非空行"口径，不影响结论。

**统计**（脚本）：`src/**` 非测试源码的行数排行、`useStore(` 订阅点分布（83 处，
`GenerationUI` 34、`Dashboard` 16）、`memo()` 覆盖（14 个组件 memo，24 个 `export function`
未 memo）、`any` 出现次数（0）、`as` 断言 71 处、`as unknown as` 4 处、`eslint-disable` 3 处、
34 个测试文件 / 5649 行。

**微基准**（`%TEMP%\lumina-audit\bench-*.mjs`，node v24，仅用于标注数量级）：

- `b64ToBlobUrl` 的 base64→字节转换：1.5MB 约 3.5ms、8MB 约 10ms；
  120 张 1024²PNG 首次批量转换 ≈ **203ms 主线程**。
- `getImageUrl` 的 cache-hit 路径（含 `b64.includes(",")` 全串扫描）：
  1.5MB 字符串 0.04ms/次，8MB 0.21ms/次。

---

## 2. 问题清单

### 2.1 历史画廊的视频 blob 缓存从不随组件卸载释放

- **级别**：P1
- **位置**：`src/components/generation/HistoryGallery.tsx:341`（缓存本体）、
  `:367`（仅淘汰时 revoke）、`:574`（仅删除单文件时 revoke）；对照 `src/hooks/useBlobUrlCache.ts:109-116`
- **现状**：
  ```ts
  const videoSrcsRef = useRef(new ByteBudgedCache<string>(VIDEO_CACHE_BYTES)); // 341
  for (const [, oldUrl] of evicted) URL.revokeObjectURL(oldUrl); // 367
  ```
  全文件没有任何 `useEffect(() => () => {...revoke...}, [])`。
- **问题**：`ByteBudgedCache` 只负责把超预算的 key 挤出来交给调用方 revoke；组件卸载时
  `videoSrcsRef` 连同 Map 一起被丢弃，而 **blob URL 的注册存在于 document 上，不会因为
  JS 引用消失而释放**（必须显式 `revokeObjectURL` 或销毁 document）。`GenerationUI` 用
  `AnimatePresence` + `key="workspace-results|history"` 在两个 tab 间切换
  （`GenerationUI.tsx:1109-1164`），**每次切走都会卸载 HistoryGallery**，于是单次最多
  `VIDEO_CACHE_BYTES = 512MB` 的视频数据永久驻留；切 N 次累积 N 份。
  这直接抵消了作者为同类问题在 `useBlobUrlCache` 里专门写的卸载清理
  （`useBlobUrlCache.ts:109-116` 逐条 revoke + clear）——两处缓存的释放策略不一致。
- **上游/对照依据**：`URL.revokeObjectURL` 的语义（blob URL 存活到 revoke 或 document 销毁）：
  https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL 。
  仓库自身的 `useBlobUrlCache` 与本文件 `deleteFile` 都已按此语义写，属同一约定的漏网处。
- **建议**：在 HistoryGallery 里补一个卸载清理，与 `useBlobUrlCache.ts:109-116` 对齐：
  ```ts
  useEffect(
    () => () => {
      const c = videoSrcsRef.current;
      for (const k of [...c.keys()]) {
        const u = c.get(k);
        if (u) URL.revokeObjectURL(u);
      }
      c.clear();
    },
    [],
  );
  ```
  更彻底的做法是把「字节预算 + 卸载 revoke」抽成 `useByteBlobCache(capacity)` 一个 hook，
  让 `useBlobUrlCache` 与 HistoryGallery 共用（当前两份实现语义已经漂移）。

### 2.2 结果区内存预算口径不完整：只算 base64，不算 Blob / 解码位图 / 另三份缓存

- **级别**：P2
- **位置**：`src/hooks/useJobPolling.ts:260,270,278-300`、`src/lib/utils.ts:188`、
  `src/hooks/useBlobUrlCache.ts:30-41`、`src/components/generation/HistoryGallery.tsx:218,285,339`
- **现状**：
  ```ts
  export const MAX_RESULTS_BYTES = 1024 * 1024 * 1024; // 1 GiB，按 base64 长度估算
  return trimResultsToBudget([entry, ...r], MAX_RESULTS, MAX_RESULTS_BYTES);
  ```
  注释（`:266-270`）写明"blob URL 与 base64 双份常驻，再乘 2 也远低于失控叠加"，但：
  1. `getImageUrl` 的 key 就是 base64 本身（`:34`），命中时不复制，所以"双份"其实不存在；
     真正的第二份是**解码后的位图**（每条可见结果 `<img>` 都要解码，1080p ≈ 8MB/张），
     它完全不受任何预算约束；
  2. `HistoryGallery` 另有 128MB（缩略图）+ 512MB（原图）+ 512MB（视频）三份独立预算，
     与结果区的 1 GiB **互不相干**，可同时打满。
- **问题**：真实峰值 ≈ 1 GiB base64 + 可见结果的位图 + 1.1 GiB 历史缓存 ≈ 2.2–2.6 GiB
  WebView2 渲染进程。`stable-diffusion.cpp` 侧模型常吃掉 8–16GB 主机内存，此时渲染进程
  被 OS 终止 = 用户**未保存的结果与全部参数一次性丢失**。这不是"作者已自觉的取舍"——
  取舍文字只覆盖了 base64/Blob 两项。
- **上游/对照依据**：同类 GUI 的做法是"结果区只留最近 N 条 + 落盘即从内存移除"
  （InvokeAI 的 image 一旦写入 gallery 就从内存移除；ComfyUI 直接引用磁盘文件 URL，
  不经 base64）。Lumina 已经具备 `save_output`/`list_output_files`/`read_thumbnail`
  全套后端能力，具备改成"结果落盘 + 引用路径"的条件。
- **建议**：最小改动按顺序做三件：
  (a) `resultEntryBytes` 里对每条结果额外加 `images.length * 估算位图字节(width*height*4)`——
  但 store 里没有尺寸信息，更简单的是 (b)；
  (b) 把 `MAX_RESULTS_BYTES` 降到 256MB，并把 `HistoryGallery` 的三份预算改成全局共享一个
  `ByteBudgedCache` 总账（把 total bytes 暴露到 store，结果区录入时读它）；
  (c) 中期：结果区收到已完成任务后**自动**调 `api.saveOutput`（作者已删掉自动保存，
  可改为"仅当内存紧张时保存到临时目录并降级为路径引用"）。

### 2.3 任务队列的 `config.images` 没有字节预算

- **级别**：P2
- **位置**：`src/components/generation/GenerationUI.tsx:419-431`、`src/lib/utils.ts:189`
  （`MAX_JOBS = 300`）、`src/hooks/useJobPolling.ts:100,108,256-260`
- **现状**：
  ```ts
  config: { mode, params: deepClone(activeParams),
            images: { ...images, refImages: [...images.refImages], controlFrames: [...images.controlFrames] } }
  ```
  而结果侧的收割是 `trimResultsToBudget([entry, ...r], MAX_RESULTS, MAX_RESULTS_BYTES)`
  （`useJobPolling.ts:260`）——**同一份大对象，在结果侧有字节预算，在任务侧只有条数上限**。
- **问题**：`config.images` 是 dataURL（每张 1080p 输入 ≈ 2–8MB base64）。VACE 家族的
  `controlFrames` 是**一整段条件帧序列**（`types.ts:425-426`），单条任务即可达数十 MB。
  用户做视频编辑/多轮 img2img 时，`jobs` 会一路涨到 300 × 几十 MB；注释里"字符串引用共享，
  无额外内存拷贝"只对**提交那一刻**成立，之后用户换图，旧字符串被 300 条任务各钉住一份。
- **上游/对照依据**：与作者自己在 `useJobPolling.ts:97-99` 写的原则（"完成任务的大体积
  result 只保留在结果画廊，任务队列只留状态/元数据，避免同一份数据两端重复持有"）矛盾：
  `result` 被剥离了，`config.images` 没有。
- **建议**：给 `jobs` 加与 `trimResultsToBudget` 同构的 `trimJobsToBudget`，对 `config.images`
  按字节记账（复用 `resultEntryBytes` 的思路，对 `GenImages` 求 `b64ByteLength` 之和），
  超预算时把最旧任务的 `config.images` 置为 `undefined`（"应用此配置"会因此丢图片输入，
  需在 UI 上降级为"仅恢复参数"，可在 toast 里说明）。

### 2.4 日志面板：每次 flush 全量 reconcile 最多 2000 行，且 `key={i}` 让裁头后整体错位

- **级别**：P2
- **位置**：`src/components/ui/LogPanel.tsx:15,19,32-36,122-143`、`src/store.ts:178-180,343-385`、
  `src/App.tsx:154-191`
- **现状**：
  ```tsx
  const logs = useStore((s) => s.logs);          // LogPanel.tsx:15
  {logs.map((l, i) => (<div key={i} ...>{l}</div>))}   // :125-142
  bodyRef.current.scrollTop = bodyRef.current.scrollHeight;  // :34（每次 flush 强制 reflow）
  ```
  ```ts
  function capLogs(logs: string[]) {
    return logs.length >= 2000 ? logs.slice(-1500) : logs;
  } // store.ts:178
  ```
- **问题**：三条独立后果，都被同一次 flush 触发：
  1. `flushLogs` 无论如何都返回新数组（`store.ts:348` `let logs = s.logs.slice()`），
     订阅整个 `logs` 的 LogPanel 于是**每帧 flush 都重渲染**；
  2. 展开状态下每次都重建最多 2000 个 `<div>`，并与前一棵树 diff；
  3. `capLogs` 触发时 `slice(-1500)` 把头 500 行砍掉，**索引整体前移 500**，
     `key={i}` 于是把"所有 key 都还在、但内容全变了"送给 React → 1500 行必须逐个重写
     text，等于一次全量重排；`role="log" aria-live="polite"`（`:117-119`）还会让每次
     重写都进无障碍播报队列。
     另外 `scrollTop = scrollHeight` 在**刚改完 2000 行 DOM 之后**读 `scrollHeight`，
     是典型的强制同步布局，把 flush 的开销再放大一次。
- **上游/对照依据**：React 对列表 key 的要求（索引 key 在列表头部变动时退化为"全部替换"）：
  https://react.dev/learn/rendering-lists#why-does-react-need-keys 。
  同类做法：日志视图按"增量 id"渲染，或超过 N 行后改用虚拟列表（仓库已有
  `lib/virtualGrid.ts` 可直接复用）。
- **建议**：最小改动两点：(a) 给日志行分配单调 id（`LogEvent` 里带 `seq`，或 `logs` 改成
  `{id, text}[]`），让 `key` 稳定；(b) `capLogs` 用环形缓冲/`slice` 后同时返回被砍掉的
  条数，让调用方知道"整体位移"；(c) 折叠状态下不要订阅整个 `logs`——只订阅
  `logs[logs.length-1]`（`live` 文案用单独一个 `lastLog: string` 字段维护），可把每次
  flush 的重渲染从 LogPanel 完全去掉。

### 2.5 历史画廊：每加载一张缩略图就全量快照缓存 + 整表重渲染（O(N²)）

- **级别**：P2
- **位置**：`src/components/generation/HistoryGallery.tsx:226-232,247-253,671-686`
- **现状**：
  ```ts
  const [thumbVersion, setThumbVersion] = useState(0);
  const thumbSrcs = useMemo(() => cacheSnapshot(thumbSrcsRef.current), [thumbVersion]);   // :228-232
  ...
  cache.set(f.path, `data:${mime};base64,${b64}`, b64ByteLength(b64));
  setThumbVersion((v) => v + 1);                                                          // :252
  ```
- **问题**：`thumbVersion` 每完成**一张**缩略图就 +1 → `cacheSnapshot` 把整个缓存
  （最多 128MB / 上千条 dataURL 字符串）复制进新 Map → 整张网格（虚拟化时是视口内 ~50 个
  瓦片，非虚拟化时是全部 N 个）重渲染 → `lightboxItems` 的 `sortedFiles.map`
  （`:482-492`）也重跑一遍。一个 2000 文件的目录首次进入时，缩略图队列会推进 2000 次，
  即 2000 次全量 Map 复制 + 2000 次全网格渲染 —— 典型 O(N²)。
  另外 `useRef(new ByteBudgedCache(...))`（`:221,288,341`）会在**每次渲染**都构造一个新
  缓存对象再丢弃（`useRef` 的初值表达式每次求值），在上面的高频重渲染下被放大 3×N 次。
- **上游/对照依据**：`THUMB_CONCURRENCY = 4` 的并发闸（`:220`）说明作者关心后端压力，
  但前端侧的更新粒度没跟着收敛；RN/React 生态的惯例是"外部可变缓存 + `useSyncExternalStore`
  按 key 订阅"，避免整表失效。
- **建议**：(a) 把 `thumbSrcs` 改成 **按 path 的局部 state**（`HistoryTile` 自己
  `useState` + 一个 `subscribe(path, cb)` 注册表），一张图完成只重渲染一个瓦片；
  (b) 退一步：`setThumbVersion` 用 rAF/50ms 合并（`queueMicrotask` + 标志位），把 N 次
  重渲染压成 ~每秒若干次；(c) `useRef(new X())` 改成惰性初始化
  `useRef<X | null>(null)` + `if (!ref.current) ref.current = new X()`。

### 2.6 Dashboard 订阅 `jobs`/`results`：打开控制台期间每 2 秒整页重渲染

- **级别**：P2
- **位置**：`src/components/dashboard/Dashboard.tsx:47-48,212-217,249-258,458-476`
- **现状**：
  ```tsx
  const jobs = useStore((s) => s.jobs); // :47   ← 只用于 :458 统计 activeJobs
  const results = useStore((s) => s.results); // :48   ← 只用于 :465 统计 unsavedResults
  ```
- **问题**：`useJobPolling` 每个周期都对 jobs 做 `store.setJobs(j => j.map(...))`
  （`useJobPolling.ts:101-114`），**只要有 1 个活动任务，`jobs` 数组引用每 2 秒变一次**；
  于是"用户在控制台改设置、任务在后台跑"这个最常见的场景下，1476 行的 Dashboard
  每 2 秒整体重渲染一次，连带：
  - `buildLaunchConfig(...)`（`:249-258`）在渲染体内调用 → 每次重算整套 CLI 参数；
  - 每个家族字段一次全量 `files.filter`（`:217` `getOptions`，`:1008-1014` 循环内调用）
    → 5000 个模型文件 × 8 个字段 = 4 万次比较/次渲染；
  - 大量内联 `options={[...]}`（如 `:1154-1173`、`:1368-1403` 的 30 项量化列表）每次重建；
  - `settings` 的防抖保存 effect（`:114-145`）也会因为 `settings` 对象被
    `modelSnapshots` 快照 effect（`:372-388`）替换而反复武装定时器。
    这两个订阅**完全可以不订阅整个数组**：activeJobs/unsavedResults 只用于点击"切换模型"
    时的确认文案（`:458-476`），在 `startServer` 里用 `useStore.getState().jobs` 现取即可。
- **上游/对照依据**：`App.tsx:50-68` 已经为完全同类的问题写过"de-dupe：只有字段真的变了
  才 setState"的补丁（注释里写明是为了避免下拉框闪关）——同样的判据没有用到 `jobs`/`results`。
- **建议**：删掉 `:47-48` 两个订阅，改写 `startServer`：
  ```ts
  const { jobs, results } = useStore.getState();
  ```
  （它本来就在事件回调里调用，不受渲染期快照影响）；后续如需展示实时计数，用
  `useStore((s) => s.jobs.filter(a).length)` 这类**标量** selector。

### 2.7 App 的 3 秒状态轮询：无 in-flight 保护，且模型切换过程中会误报"连接已断开"

- **级别**：P2
- **位置**：`src/App.tsx:44-143`（`setInterval(check, 3000)` 在 `:138`）、
  `:126-131`（断开提示）、`src/hooks/useModelSwitch.ts:172-179`
- **现状**：
  ```ts
  const iv = setInterval(check, 3000);   // App.tsx:138 —— check 是 async，无互斥
  ...
  } else {                                // 不可达
    if (useStore.getState().caps) { setCaps(null); toast("与服务器的连接已断开", true); }
  ```
- **问题**：
  1. **无互斥**：`check()` 内含两次 IPC（`serverStatus` + `sdcppCapabilities`，Rust 侧
     reqwest 硬超时 30s 见 `useJobPolling.ts:14-17` 注释）。一次请求慢于 3s 就会叠加下一轮，
     多轮结果**乱序**回写 `setCaps`/`lastCapsSync.current`，出现"先返回的旧 caps 覆盖新 caps"。
     对照 `useJobPolling` 特意加了 `pollBusy` + `withTimeout`（`:17-24,61`），这里完全没有。
  2. **模型切换必然误报**：`useModelSwitch.switchModel` 的执行序列是
     `stopServer()` → `startAndWait()`（最多 180s，`useModelSwitch.ts:92-111`）。
     `stopServer` 之后 `serverStatus.reachable === false`，而 `caps` 仍是旧模型的能力
     （`setCaps` 只在成功后调用，`:176`）→ App 的下一轮 `check` 一定命中 `:126-131`，
     **弹一条红色"与服务器的连接已断开"**；新服务起来后再弹一条"服务器就绪 — <模型>"。
     用户视角是"切个模型报了两次错/两次提示"。
  3. 相同时刻 `useModelSwitch` 自己也会 `toast("已切换到 …")`（`:179`），三条 toast 抢 3 个
     toast 槽位（`store.ts:143` `MAX_TOASTS = 3`），很可能把"切换成功"挤掉。
- **上游/对照依据**：同文件 `:56-68` 的字段级 de-dupe 与 `:91-100` 的 `freshIdentity`
  判定已经把"什么变化才算换了服务器"想得很细，缺的只是"正在切换中"这一状态位。
- **建议**：(a) `check` 加 `checkBusy` ref 互斥，并给 `sdcppCapabilities` 套
  `withTimeout(…, 15_000)` 与 `useJobPolling` 一致；(b) 把 `useModelSwitch` 的
  `switching` 提到 store（`switching`/`switchPhase` 已存在但只在 hook 内），
  App 的 `check` 在 `switching === true` 时跳过"断开"提示与 `setCaps(null)`；
  (c) 用 `switchPhase` 驱动 Dashboard 的按钮文案（已这么做，`:765-775`）即可，
  不再需要 App 侧的兜底提示。

### 2.8 快捷键只给 Esc 做了浮层门禁，`Ctrl+Enter`/`Ctrl+R` 会命中后台

- **级别**：P2
- **位置**：`src/hooks/useKeyboardShortcuts.ts:17-31`、`src/components/generation/GenerationUI.tsx:996-1001,352-356`
- **现状**：
  ```ts
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    genRef.current();
  } // 无任何浮层判断
  if (e.key === "Escape" && handlers.escapeActive) escRef.current(); // 只有 Esc 有门禁
  ```
  ```ts
  useKeyboardShortcuts({ ..., escapeActive: !!(lightbox || sheetOpen || queueOpen || upscaleTarget !== null) });
  ```
- **问题**：`escapeActive` 只把"是否有浮层"传给了 Esc 分支。用户在 Lightbox 里看图、
  在参数面板里调参、在队列抽屉里翻任务时按 `Ctrl+Enter`，会**在后台提交一次生成**并
  把提示词发到服务器；`Ctrl+R` 会静默翻转 `seedRandom`。作者显然意识到这个问题——但只在
  `handleGenerate` 里加了放大对话框的专用锁：
  ```ts
  if (upscaleOpenRef.current) return; // GenerationUI.tsx:356
  ```
  同一个 `upscaleOpenRef` 也被 `randomSeed`（`:571`）使用，说明"模态内不允许改后台状态"
  是既定原则，只是锁的范围漏了另外三个浮层。
- **上游/对照依据**：仓库自身的 `useFocusTrap`（`hooks/useFocusTrap.ts`）已经把
  "浮层期间的焦点与后台隔离"当成统一约定；快捷键应与它同源，而不是各自判断。
- **建议**：把 `escapeActive` 改名为 `overlayActive` 并在三个分支共用：
  ```ts
  const blocked = handlers.overlayActive;
  if (e.ctrlKey && e.key === "Enter" && !blocked) { ... }
  if (e.ctrlKey && e.key === "r" && !blocked) { ... }
  ```
  同时删掉 `useKeyboardShortcuts.ts:15` 那行重复的 `escRef.current = handlers.onEscape;`
  （`:14`/`:15` 完全相同，复制粘贴残留）。

### 2.9 切换 img_gen ↔ vid_gen 会丢掉 300ms 防抖窗口内的参数改动

- **级别**：P2
- **位置**：`src/components/generation/GenerationUI.tsx:301-312`（防抖写）、`:284-299`（读回）、
  `:314-350`（`switchMode`）；另一写入者 `src/lib/launchConfig.ts:221-255`
- **现状**：
  ```ts
  useEffect(() => {
    if (!params) return;
    const t = setTimeout(() => {
      localStorage.setItem("sdcpp:params:" + mode, JSON.stringify(params));
    }, 300);
    return () => clearTimeout(t); // ← mode 变更时把未触发的写取消掉
  }, [params, mode]);
  ```
- **问题**：`sdcpp:params:<mode>` 有**三个互不知情的写入者**：本 effect（防抖，真源是 store）、
  `applyConfig`（`:780-784`，同步写）、`persistFamilyDefaults`（`launchConfig.ts:242`，
  切换/启动成功时用家族默认值**覆盖**整份记录、只保留 prompt）。读回只在
  `[mode, caps]` 变化时发生（`:284-299`）。于是：
  1. 用户拖动"步数"滑杆 → 300ms 内点 vid_gen tab → `switchMode` 改 `mode` → cleanup
     `clearTimeout` → **这次改动永远不会落盘**；切回来时 init effect 读到旧值，
     界面上数值"自己变回去了"（无任何提示）；
  2. `persistFamilyDefaults` 覆盖写时，store 里的 `params` 仍是旧值，直到 `caps` 变化
     触发 init effect 才同步——两者短暂不一致，而这期间任何一次防抖写都会把旧值写回去
     （若组件仍挂载）。
- **上游/对照依据**：`store.ts:405-414,425-432` 对 `seedRandom`/`sizeStep` 的持久化明确写了
  "只在该字段真正变化时写盘"的补丁（对抗性审查 B6），说明作者认可"单一写入者 + 精确判据"
  的约定；`sdcpp:params` 这一路没有照此收口。
- **建议**：(a) `switchMode` 里在 `setMode` 之前 `flush()` 一次当前模式的写（把定时器
  改成可手动触发的 `writeNow()`）；(b) 更稳的做法：把 `sdcpp:params:<mode>` 的读改写都收到
  一个 `lib/paramsStorage.ts`，`persistFamilyDefaults` 改成调用它并**同时** `setParams`，
  消灭"localStorage 是真相、store 是快照"的双真相。

### 2.10 结果网格首次渲染一次性解码全部 base64；每次渲染都重建 lightbox 索引

- **级别**：P2
- **位置**：`src/components/generation/ResultsGrid.tsx:122-158,500-506`、
  `src/hooks/useBlobUrlCache.ts:31-41`、`src/lib/utils.ts:163-168`
- **现状**：
  ```tsx
  const { items, indexOf } = buildLightboxItems(results, getImageUrl, getVideoUrl); // :502，非 memo
  ```
  ```ts
  getImageUrl: const raw = b64.includes(",") ? b64.split(",")[1] : b64; // 命中缓存前先扫全串
  url = b64ToBlobUrl(raw, `image/${fmt}`); // 未命中：atob + 逐字符循环
  ```
- **问题**：
  1. `buildLightboxItems` 对**所有**结果的**所有**图片调用 `getImageUrl`（包括屏幕外的），
     而 `getImageUrl` 的 miss 路径是 `atob` + `charCodeAt` 逐字节循环（`utils.ts:165-166`）。
     实测 120 张 1024²PNG ≈ **203ms 主线程**——结果区第一次出现 60 条结果时会有一段
     200–500ms 的卡顿（含 Blob 构造），与"新图出现要做 1.2s 显影动画"叠在一起，
     低端机上会看到动画掉帧开场。
  2. 这个函数在**每次** ResultsGrid 渲染都重跑。生成过程中 `previewSrc` 每 2 秒变一次
     （`GenerationUI.tsx:253-257` → `ResultsGrid` 的 props 变），于是每 2 秒对 120 个
     大字符串各做一次 `includes(",")` 全串扫描 + Map 查询（实测 4.8ms/轮）。
  3. lightbox 只在用户点击时才需要，现在却常驻构建 `items` + `indexOf` 两个 O(全部图片) 结构。
- **上游/对照依据**：同文件对视频用了**按 jobId 命中缓存后才 split** 的写法
  （`useBlobUrlCache.ts:11-20`：先 `cache.get(jobId)`，miss 才切串），图片一路没照做。
- **建议**：(a) `getImageUrl` 先按 `fmt + 前 64 字节` 之类的轻量指纹查表，或干脆在
  `ResultEntry`/`images[]` 里带一个稳定 id（`jobId:index` 已经在用了）做缓存 key，
  避免用整段 base64 当 key；(b) `buildLightboxItems` 包进 `useMemo([results])`，
  并把 blob URL 的创建推迟到 Lightbox 真正打开时（懒 `getImageUrl`）；(c) `b64ToBlobUrl`
  改成 `fetch("data:…")` 或让 Rust 直接返回字节，去掉主线程的逐字符循环。

### 2.11 `families.ts` 让全部代码分割失效（2083 行数据进主 chunk）

- **级别**：P2
- **位置**：`src/App.tsx:17-21`（Dashboard 懒加载）、`src/components/generation/GenerationUI.tsx:6,55-62`
  （Sheet/History 懒加载）、`src/config/families.ts:400`（`FAMILY_CONFIG`）
- **现状**：`App.tsx` 用 `lazy()` 拆了 Dashboard，`GenerationUI` 又用 `lazy()` 拆了
  `GenerationParamsSheet` 与 `HistoryGallery`（注释称"降低首屏解析成本"），但
  ```ts
  import { alignSizeUp, scaleSize, FAMILY_CONFIG, DISTILL_FAMILIES } from "../../config/families"; // GenerationUI.tsx:6
  ```
  `GenerationUI` 是**立即 import 的**，`useModelSwitch.ts:4`、`launchConfig.ts:7` 也是。
  共 11 个模块 import 它。
- **问题**：`families.ts` 的 2083 行（其中 `FAMILY_CONFIG` 从第 400 行起 ~1650 行字面量）
  必然进入入口 chunk，`lazy()` 只省下了 Sheet/Gallery 自身的组件代码。也就是说：首屏仍要
  解析整个家族数据库；而这份数据同时是 UI 展示、启动参数、输入校验、家族特性的**唯一耦合点**
  （11 个 import 者横跨组件层与 lib 层）。这是"巨型数据文件"在架构上的真实成本，
  不是行数美观问题。
- **上游/对照依据**：仓库自己的 `api.detectFamily` 注释（`api.ts:46`）已经把"家族检测的唯一
  实现放在 Rust"作为原则；家族**数据**同样可以只存在于 Rust（`family.rs` 已经在做识别），
  由 `capabilities`/`scan_models` 一次性下发需要的那部分。
- **建议**：(a) 低成本：把 `FAMILY_CONFIG` 拆成 `families/<family>.ts` 并按需
  `import()`（`useModelSwitch` 只在切换时需要整份配置）；(b) 中成本：`GenParams` 默认值、
  size presets、feature 限制改由后端 `capabilities` 提供（现在已有
  `defaults_by_mode`/`features_by_mode`），前端只保留**展示文案**，把 1650 行数据压到几百行。

### 2.12 核心逻辑的测试缺口（具体到函数）

- **级别**：P2
- **位置**：`src/hooks/useBlobUrlCache.ts`（全文件）、`src/App.tsx`（无测试文件）、
  `src/hooks/useKeyboardShortcuts.ts`、`src/hooks/useSystemIntegration.ts`、
  `src/components/ui/LogPanel.tsx`、`src/components/generation/HeaderBar.tsx`
- **现状**：34 个测试文件 / 5649 行，`utils`、`launchConfig`、`virtualGrid`、`byteCache`、
  `trimResultsToBudget`、`useJobPolling.saveEntryPart` 覆盖得很好（`byteCache.test.ts` 甚至
  测了"单条超预算仍保留"），但以下**最容易回归且已经回归过**的代码完全没有测试：
  1. `useBlobUrlCache` 的剪枝 effect（`useBlobUrlCache.ts:59-107`）——它是"结果淘汰后
     blob URL 要被回收"的唯一守卫，也是 §2.1 里两份缓存语义漂移的那一半；
  2. `App.tsx` 的阶段机 + caps 身份判定（`:44-143`，约 100 行，含 `identityChanged`、
     `capsIdentityChanged`、`lastCapsSync` 节流、`current_mode` 只在 freshIdentity 同步）
     ——作者为这些判据写了 B3/M6/M7 三轮注释，说明每一行都对应一个真实 bug，却没有一行测试；
  3. `useKeyboardShortcuts`（§2.8 的浮层门禁）；
  4. `LogPanel` 的日志行渲染/`capLogs` 位移（§2.4）。
- **上游/对照依据**：仓库对纯函数（`lib/**`）的测试密度很高，说明作者并非不测，而是
  "只测能被 vitest 直接调用的纯逻辑"，订阅/生命周期/快捷键这类需要 `renderHook` 的部分
  被跳过了；`useJobPolling.test.ts` 与 `useFocusTrap.test.tsx` 证明这条路的成本并不高。
- **建议**：优先补 3 个用例：(a) `useBlobUrlCache`：mount → 塞两条结果 → 删除一条 →
  断言被删的 blob URL 被 revoke（`vi.spyOn(URL, "revokeObjectURL")`）；
  (b) `useKeyboardShortcuts`：`overlayActive=true` 时 Ctrl+Enter 不触发 handler；
  (c) `LogPanel`：2001 条日志触发裁头后，行的 DOM 文本与最后 1500 条一致（暴露 `key={i}` 问题）。

---

### 2.13 `virtualGrid` 缺"网格在滚动容器内的偏移"，靠 overscan 侥幸兜住；无滚动锚定

- **级别**：P3
- **位置**：`src/lib/virtualGrid.ts:50-68`、`src/components/generation/HistoryGallery.tsx:442,449-477`；
  CSS 依据 `src/styles.css:634`（`.output-main { padding: 48px 26px 190px; overflow-y: auto }`）
- **现状**：
  ```ts
  const range = computeVisibleRange(layout, scroll.top, scroll.height); // scroll.top = scroller.scrollTop
  const firstRow = Math.max(0, Math.floor(scrollTop / layout.rowH) - overscanRows);
  ```
- **问题**：`scroll.top` 取自最近的滚动祖先（`.output-main`），而瓷砖的 `top` 是相对
  `.history-grid-virtual` 的。网格在 scroller 内还有约 48px padding + Panel 标题/搜索行
  ≈ 130–140px 的偏移（≈1.5 行，`rowH ≈ 94`），公式没有减掉它。目前 **`overscanRows = 2`
  恰好盖住了这 ~1.5 行的误差**（代入 `rowH≈94`、`origin≈138`、`scrollTop=1000` 得 `floor(1000/94)-2 = 8 < floor((1000-138)/94) = 9`，即多渲染一行、方向在安全侧），
  所以"能用"。但这是巧合而非契约：加高搜索栏、给 Panel 加说明文字、或把 `minTile`
  调大（`rowH` 变小会放大行数误差）都会让它失效，表现为顶部出现一条空白带。
  另外删除/刷新后 `scrollTop` 不变而内容整体上移（`:564-585`），绝对定位子元素不参与
  浏览器的滚动锚定，视觉上会跳。
- **上游/对照依据**：`virtualGrid.ts:1-6` 的注释自称"与 CSS `auto-fill minmax` 规则一致"，
  即把 CSS 布局当契约；那么"网格原点在滚动容器中的位置"也应作为入参显式建模。
- **建议**：`findScrollParent` 之后多量一次 `grid.getBoundingClientRect().top -
scroller.getBoundingClientRect().top + scroller.scrollTop`，作为 `origin` 传进
  `computeVisibleRange`；`deleteFile`/`load` 后按被删项的行号补偿 `scrollTop`。

### 2.14 `useVideoPoster`：全分辨率 canvas + `preload="auto"`

- **级别**：P3
- **位置**：`src/hooks/useVideoPoster.ts:20,35-53`、`ResultsGrid.tsx:15-28,748`
- **现状**：
  ```ts
  video.preload = "auto"; // :20
  canvas.width = w;
  canvas.height = h; // :45-46  原始分辨率
  setPoster(canvas.toDataURL("image/webp", 0.72)); // :53
  ```
- **问题**：每张视频瓦片都创建一个 `preload="auto"` 的离屏 `<video>`，即让解码器立刻开始
  整片 demux/缓冲（数据源是已经是内存 Blob 的 blob URL）；随后按 **1080p 原始分辨率**
  建 canvas（RGBA ≈ 8MB）并 `toDataURL` 出 100–300KB 的 dataURL 常驻 state。
  `ResultsGrid` 的"更早结果"网格里每个视频都是一个 `VideoTile`（`:748`），
  60 条结果里 10 个视频 = 10 次全分辨率截帧 + 10 个常驻 poster；在低端机上进入结果页
  会看到明显的解码尖峰。截帧只需要 ~384px 宽的图。
- **上游/对照依据**：`api.read_thumbnail`（`api.ts:106-108`，Rust 端降采样到 384px）说明
  本项目在图片侧已经确立了"瓦片用缩略图"的原则，视频 poster 是唯一没走这条原则的路径。
- **建议**：`const scale = Math.min(1, 384 / w); canvas.width = Math.round(w*scale);`
  同时把 `preload` 降到 `"metadata"`（`loadedmetadata` 后 seek 会按需取帧）。

### 2.15 motion：`layout` + `filter` 动画铺满每张结果卡

- **级别**：P3
- **位置**：`src/components/generation/ResultsGrid.tsx:162-175,253-258,618-626`
- **现状**：
  ```ts
  const cardMotion = { layout: true, initial: {... filter: "saturate(0.55) brightness(0.9)" },
                       animate: { ..., filter: "saturate(1) brightness(1)" }, ... } as const;
  ```
- **问题**：`layout: true` 会让 motion 为**每个**卡片挂投影/测量节点（`older` 网格最多
  60 个），`filter` 是**非合成**属性，动画期间每帧都要重绘整张卡的画面（含已解码的大图），
  `transition={{ duration: 1.2 }}` 又拉长了重绘窗口；批量 4 张时还有 `delay: ii*0.08` 的
  阶梯（`:624`），4 张卡的 filter 动画在时间上是重叠的。`main.tsx:18` 已经设了
  `MotionConfig reducedMotion="user"`，说明作者在意动画成本，但这里的属性选择本身偏贵。
- **上游/对照依据**：motion 官方对 `layout` 的建议是"只给需要位置过渡的少量元素"，
  filter/box-shadow 类属性会让动画退化为 CPU 光栅化。
- **建议**：`layout` 只保留在 `FeaturedResult`（一次最多一批）；卡片动画改成
  `opacity + scale`（两者都可合成），去掉 `filter` 或用 CSS `@starting-style` 一次性过渡。

### 2.16 `deepMerge` 的 `__proto__`/`null` 语义；`b64ByteLength` 的冗余切片

- **级别**：P3
- **位置**：`src/lib/utils.ts:141-161,180-184`；调用点
  `GenerationUI.tsx:295,586`、`launchConfig.ts:216`
- **现状**：
  ```ts
  for (const k of Object.keys(src)) { ... r[k] = sv; }         // 无 __proto__ 过滤
  const raw = comma >= 0 ? b64.slice(comma + 1) : b64;         // 有前缀时复制整串
  return Math.floor((raw.length * 3) / 4);
  ```
- **问题**：
  1. `deepMerge` 的目标是 `{...target}`（普通对象）。若 `source` 来自
     `JSON.parse(localStorage.getItem("sdcpp:params:"+mode))` 且含自有键 `"__proto__"`
     （`JSON.parse` 会创建自有属性），则 `r["__proto__"] = sv` 走的是
     `Object.prototype.__proto__` 的 setter，**改写合并结果的原型**而不是写入属性；
     之后 `params.width` 之类的读取会穿透到该原型上，界面出现无法解释的"默认值回来了"。
     （不会污染全局 `Object.prototype`——递归返回的是新对象，所以只是单对象级污染。）
     `null` 值则会被 `else` 分支原样写回（`sv` falsy），把默认值覆盖成 `null`，
     依赖 `?.` 的调用点能兜住，但 `params.sample_params.guidance` 这类必填字段会变成 `null`。
  2. `b64ByteLength` 在有 `data:` 前缀时会 `slice` 复制整串——所有实际调用点
     （`resultEntryBytes`、HistoryGallery 的 `cache.set`）传入的都是无前缀的原始 base64，
     所以目前不产生复制；一旦有人把 dataURL 传进来（`HistoryGallery.tsx:310` 拼好的值
     就在手边，很容易被顺手传入），一次 `trimResultsToBudget` 就会对每条结果复制一遍整串。
- **上游/对照依据**：`store.ts:258-280` 的 `updateParam` 对数组/缺失中间节点都做了
  显式处理并引用了"对抗性审查 B6"，说明作者对这类结构性输入的健壮性是有关注的；
  `deepMerge` 是同一类的唯一漏网处。
- **建议**：
  ```ts
  for (const k of Object.keys(src)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (src[k] === undefined) continue;      // undefined 不覆盖默认值
    ...
  }
  ```
  `b64ByteLength` 改成 `const len = comma >= 0 ? b64.length - comma - 1 : b64.length;`
  零复制。

### 2.17 其它一致性/微性能项（合并列出）

- **级别**：P3
- **位置/现状**：
  1. `useJobPolling.ts:19-24` `withTimeout` 用 `setTimeout` 做 `Promise.race`，
     **胜出后从不 `clearTimeout`**：N 个活动任务 × 每 2s 一轮 = 稳态 7.5N 个空转定时器
     （maxQueue=4 时 ~30 个，无害但无谓）；任务还是**串行** `await`（`:72`），
     一个 15s 超时的任务会把同轮其他任务的进度更新一起推迟 15s。
  2. `GenerationUI.tsx:89-149` 一个组件 34 个 `useStore(selector)`：每次 store 变更都要跑
     34 个 selector（zustand v5 每个 hook 一个 `useSyncExternalStore` 订阅）。功能正确，
     但把"哪些字段该一起更新"这件事交给了 34 个独立订阅去猜；`jobs`/`results`/`params`
     都在其中，而 `Dashboard` 侧另有 16 个。
  3. `GenerationUI.tsx:596-755`（`cancelJob`/`removeJob`/`clearJobs`/`removeResult`）与
     `:761-820`（`applyConfig`/`download`）全是"`useStore.getState()` + api + toast"，
     **不依赖任何组件本地状态**，却挤在 1264 行的组件里并被列进 `useCallback` 依赖。
     同理 `:492-556 runUpscale`、`:352-468 handleGenerate`。
     → 这 400 行应下沉到 `lib/actions.ts`（或作为 store 的 actions），组件只剩编排。
  4. `removeResult`（`GenerationUI.tsx:724-747`）在 `setResults` 的 updater 里做
     `revokeImageUrl` 并改写闭包变量 `removedWholeEntry`——updater 不纯。`main.tsx:17`
     开了 `StrictMode`，开发模式下 updater 会被调用两次（revoke 幂等所以不炸，
     但这是"测试环境与生产行为不同"的典型来源）。
  5. `ResultsGrid.tsx:509-514` 的"新结果自动回顶"只看 `results.length`：
     ```ts
     if (results.length > prevLen.current) wrapRef.current?.parentElement?.scrollTo?.({ top: 0, ... })
     ```
     结果数一旦稳定在 `MAX_RESULTS = 60`（`utils.ts:188`）的上限，每来一条新的就淘汰一条
     最旧的，长度**不再增长** → 长会话里第 60 条之后的新图不再自动回到视野，用户会以为
     "生成没反应"。应改为按"最新结果的 jobId 变化"判定（`results[0]?.jobId`）。
  6. `utils.ts:136-138` `deepClone = JSON.parse(JSON.stringify(o))` 对 `undefined` 抛错——
     `GenerationUI.tsx:582` 已经手动兜了一次（注释写明），但另三个调用点
     （`:295`、`:421`、`:764`）依赖入参非空。

---

## 3. 待验证假设

> 以下为静态阅读推出、但缺少运行时证据或需要跨组确认的项，未写入上面的正式结论。

1. **预览帧的实际体积与频率**：`JobPreview.b64_json` 是"当前预览帧的 PNG base64"
   （`types.ts:449-450`），但上游按什么分辨率出预览帧、`preview_interval=1` 时一步一帧
   还是多步一帧，我没有读 `examples/server/routes_sdcpp.cpp` 确认（属 api-alignment 组范围）。
   若预览是**全分辨率** PNG（1024²≈1.5MB base64），则每 2 秒一次 IPC + `b64ToDataUrl`
   复制 + `<img>` 解码 ≈ 3–5MB/2s 的瞬时分配；若只是缩略图则影响可忽略。
   影响 §2.10 的量级判断。
2. **`<video>` 在 blob URL 上 `preload="auto"` 是否真的额外缓冲整片**：这与浏览器的
   media cache 策略有关，可能只是 demux 头 + 少量帧。§2.14 的"整片再读一份"需要实测
   WebView2 的 `Memory` profiler 才能定论；"canvas 全分辨率"部分是确定的。
3. **`clearLogs` 与 `capLogs` 的交互**：`LogPanel` 的 `key={i}` 问题需要在展开状态下
   且日志超过 2000 行才显性化；若实际生成任务的 stdout 量级远低于 2000 行，
   §2.4 的第三条后果会退化为"每次 flush 重建 N 行"（仍成立，只是 N 小）。
   需要一次真实长任务的日志量统计。
4. **`sdcpp:params:<mode>` 的防抖丢失**（§2.9）是否被用户实际观察到：需要确认
   `HeaderBar` 的 mode tab 点击后 `switchMode` 到 init effect 读完 localStorage 之间
   是否还有别处补偿写入（我读到的是没有）。
5. **`Dashboard` 每 2 秒重渲染是否有可见代价**：`buildLaunchConfig`/`files.filter` 都是
   纯 CPU（几 ms 级），在弱机上才会表现为输入延迟（在路径输入框连续输入时尤其明显）。
   需要 profile 确认；但我把"订阅了整个 `jobs`/`results` 数组"作为事实陈述，那部分是确定的。
6. **`families.ts` 的实际 chunk 归属**：结论基于"静态 import 必然进入口 chunk"这一打包
   语义（rolldown/vite 均如此），未跑构建验证（构建归 build-test 组）。

## 4. 与其它组可能重叠的点（供 Lead 合并）

1. **预览帧 / `preview` 语义**（与 api-alignment）：`types.ts:442-451` 的 `pass/step/total_steps`
   是"当前采样段"而非总进度，前端已在 `GenerationUI.tsx:258-267` 与
   `ResultsGrid.tsx:52-56` 两处重复解释同一语义——若上游改字段，需要改两处文案。
2. **`HistoryGallery` 视频格式判定**（与 cli-families/api-alignment）：`VIDEO_EXTS`
   （`HistoryGallery.tsx:38`）在前端硬编码 webm/mp4/mkv/mov/avi/m4v，而实际可输出格式
   由 `caps.output_formats_by_mode` 决定；两边不一致时会出现"服务端只出 webm，画廊却把
   `.mp4` 当成可播"。
3. **日志等级判定**（与 api-alignment）：`lib/logFormat.ts` 按上游 `log.cpp` 的两代表签
   形状写死（注释引用了 `#2104`），上游再改标签就是静默失色（不报错、只是高亮消失）。
4. **`stopServer` 的两处入口**（与 backend-rust / ux-a11y）：`LogPanel.tsx:41-64` 直接
   `useStore.setState({caps:null, serverStatus:{...}})` 拼了一个 `ServerStatus` 字面量，
   与 `api.serverStatus()` 的返回形状是**第二份真值**；后端加字段时这里不会报错但会丢字段。
5. **无障碍**（与 ux-a11y）：`LogPanel` 的 `role="log" aria-live="polite"` + 每 flush 全量
   重渲染（§2.4）会让读屏软件持续播报；`aria-relevant="additions text"` 在 `key={i}`
   位移时无法区分"新增"与"改写"。建议把 §2.4 的修复一起做。
6. **`families.ts` 是否应下沉到 Rust**（与 cli-families）：§2.11 的建议 (b) 需要
   `family.rs` 提供更多数据（size presets / gen defaults / feature 限制），属于该组的判断范围。
