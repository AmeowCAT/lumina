# 同步上游 checklist

上游 `stable-diffusion.cpp` 的 README 自己写着 _"API and command-line option may
change frequently"_，实测一天 3 个提交。Lumina 的价值（60 个家族的必需组件、默认
参数、尺寸对齐、CLI 门控）全都是手工跟随的，所以每次同步按这张单子走一遍，不要凭记忆。

## 机器先跑

```bash
node scripts/upstream-diff.mjs                 # 对齐提交 → 上游 master 的参数/字段增删
node scripts/upstream-diff.mjs --coverage      # 上游接受的请求体字段是否都有落点
```

CI 的 `upstream` job 也会跑第一条（`continue-on-error`，只提示不阻断）。

## 再按顺序人工确认

1. **新 CLI 参数**（脚本输出的「上游新增的启动参数」）
   - 该给控件吗？→ `src/lib/launchConfig.ts` / `src/lib/diagnostics.ts` + 控制台面板
   - 只能写「附加启动参数」吗？→ 在 `README` 或面板提示里写清楚写法
   - 明确不支持？→ 记进 `docs/audit/40-cli-families.md` 的矩阵或 README 已知限制
2. **新请求体字段**（脚本输出的「上游新增的请求体字段」）
   - 接进 `src/types.ts` → `src/lib/utils.ts::buildRequestBody` → 面板控件
   - 界面不接的，登记到 `scripts/upstream-diff.mjs` 的 `KNOWN_UNSUPPORTED`，必须写理由
3. **字段改名 / 单位变化 / 语义变化**（脚本无法判断语义，只能靠 diff 上游 commit）
   - 重点看 `examples/server/routes_sdcpp.cpp`、`examples/server/api.md`、
     `examples/common/common.cpp`：键名、类型、默认值、单位、错误码
   - 本次已经踩过：`tile_size_x/y`→`tile_size_w/h` 且单位从 latent 改成像素（#2059）
   - 本次又踩过一次：任务 `created` / `started` / `completed` 从**秒**改成**毫秒**
     （随 #2176 落地，PR 标题是「recipe 模型管理」，看标题完全发现不了）。
     前端一律经 `toEpochMs`（`src/lib/utils.ts`）归一，禁止直接乘除 1000
   - 处理方式：**按内核实际声明的键名/单位发送**（`vaeTilingProtocolFromCapabilities`
     是范本），不要按 Lumina 自身版本猜
4. **新模型家族**（`docs/*.md` 新增一篇）
   - `src-tauri/src/family.rs`: 识别规则（先跑一遍 `cargo test` 的 family 用例）
   - `src/config/families.ts`: `FAMILY_CONFIG` 一条（fields / fixedArgs / genDefaults /
     promptTokenLimit / disabledFeatures / requiredInputsByMode / SIZE_SPATIAL_ALIGN）
   - `src/config/families.ts` 的 `VIDEO_FRAME_PRESETS` / `VIDEO_FRAME_ALIGN`（视频家族）
   - README 的「已适配的模型家族（N 个）」数字与清单**一起改**
5. **上游删除/改名某家族或参数** → 同步删掉本仓库的映射，别留死配置
6. **更新 README 的对齐提交号**（`当前对齐上游 master @ \`<sha>\``），脚本靠它取起点

## 已裁定「不接」的上游参数

脚本每次都会把它们重新报一遍，这里登记裁定理由，避免重复讨论。

| 参数          | 上游语义                                                                                                                                                                                                     | 为什么不接                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--model-dir` | sd-server 的模型根（可重复，缺省 `./models`），同时是 `recipes/` 的搜索根与 `/sdcpp/v1/model-files` 返回的文件 ID 基准；不带模型启动时靠它配合 `/models/load` 换模型（上游 #2176，`examples/server/api.md`） | Lumina 自己扫描模型目录（`src-tauri/src/scanner.rs`）并把组件路径显式传给 `-m` / `--vae` / `--llm` 等，从不走服务端的文件目录与 ID 体系；传它只会让内核在启动时多扫一遍 `<exe目录>/models`。需要的人可写在「附加启动参数」里（旧内核会在启动时报 unknown argument） |
| ADetailer     | `--ad-model` 配置检测器后，sd-server 会在每次 `img_gen` 结束后自动检测 + 局部重绘；请求体 `ad_prompt` / `ad_negative_prompt` / `extra_ad_args` 会被消费，`ad_model` 不参与选检测器（上游 #2164）             | 界面本轮没有检测器选择与 prompt 覆盖控件；写进附加启动参数的用户会在启动预检收到警告（`cli.rs::validate_args`）。接入排期见 `docs/UPSTREAM-SYNC-2026-10-24.md` §2.3 的 B 选项                                                                                       |

## 默认值的口径

上游自 #2176 起在 `examples/server/recipes/*.json` 里给每个任务预设提供机器可读的
`defaults`，但那只服务于上游 WebUI 的 recipe 模型管理，且有「步数默认上限 20」这类
产品政策。**Lumina 的家族默认值以 `docs/*.md` 的发布方推荐为准，recipes 只用于核对
组件与能力声明**；两边不一致时不要照抄 recipe（实例：MiniT2I 的 docs 写 100 步 /
CFG 6，recipe 写 20 步 / CFG 2.5）。

## 收尾

```bash
npm run check:version     # 5 处版本号一致
npm test                  # 363+ 前端用例
cd src-tauri && cargo test
```

若本轮的同步改变了 `families.ts` 的家族数，记得同步 README 清单——上一版就是因为
手写清单漏了 LLaDA-Image 与 SenseNova U1.5，数量还写着 58（实际 60）。
