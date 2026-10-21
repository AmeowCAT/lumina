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
3. **字段改名 / 单位变化**（脚本无法判断语义，只能靠 diff 上游 commit）
   - 重点看 `examples/server/routes_sdcpp.cpp`、`examples/common/common.cpp`：
     键名、类型、默认值、单位
   - 本次已经踩过：`tile_size_x/y`→`tile_size_w/h` 且单位从 latent 改成像素（#2059）
   - 处理方式：**按内核实际声明的键名发送**（`vaeTilingProtocolFromCapabilities`
     是范本），不要按 Lumina 自身版本猜
4. **新模型家族**（`docs/*.md` 新增一篇）
   - `src-tauri/src/family.rs`: 识别规则（先跑一遍 `cargo test` 的 family 用例）
   - `src/config/families.ts`: `FAMILY_CONFIG` 一条（fields / fixedArgs / genDefaults /
     promptTokenLimit / disabledFeatures / requiredInputsByMode / SIZE_SPATIAL_ALIGN）
   - `src/config/families.ts` 的 `VIDEO_FRAME_PRESETS` / `VIDEO_FRAME_ALIGN`（视频家族）
   - README 的「已适配的模型家族（N 个）」数字与清单**一起改**
5. **上游删除/改名某家族或参数** → 同步删掉本仓库的映射，别留死配置
6. **更新 README 的对齐提交号**（`当前对齐上游 master @ \`<sha>\``），脚本靠它取起点

## 收尾

```bash
npm run check:version     # 5 处版本号一致
npm test                  # 363+ 前端用例
cd src-tauri && cargo test
```

若本轮的同步改变了 `families.ts` 的家族数，记得同步 README 清单——上一版就是因为
手写清单漏了 LLaDA-Image 与 SenseNova U1.5，数量还写着 58（实际 60）。
