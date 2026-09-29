# RN 0.74 → 0.83 四层迁移执行计划（启用 simulation 翻页前置）

> 分支：`rn-upgrade-0.83`（从 `945956e` 切出；保底分支 `pre-rn-upgrade-0.74` = `12237fb`）
> 目标：解锁 `@tangfeifan/react-native-reader`「仿真」模式（Skia 卷页）所需的最小版本墙——
> RN≥0.78 + React≥19 + 新架构 + Skia≥2.6.9 + Reanimated≥3.19.1。
> 状态（2026-09-29）：**计划 + 调用点清点已完成；代码落地被本机工具链缺口阻断，见 §6。**

## 1. 目标版本矩阵

| 依赖 | 当前 | 目标 | 类型 | 代码改动面 |
|---|---|---|---|---|
| react-native | 0.74.7 | 0.83.x | 框架 | 原生脚手架 + 新架构 |
| react | 18.2.0 | 19.x | 框架 | 极少（StrictMode/ref 语义） |
| @types/react | 18.2 | 19.x | dev | 类型 |
| react-native-mmkv | 2.12.0 | 4.x (Nitro) | 数据 | `new MMKV()`→`createMMKV()`，7 处 |
| react-native-quick-sqlite | 8.2.7 | nitro-sqlite | 数据 | **同步→异步 API 重写**，最大风险 |
| react-native-reanimated | 3.10.1 | ≥3.19.1 | 动画 | 仅版本号（src 零直接导入） |
| @shopify/react-native-skia | — | ≥2.6.9 | 新增 | simulation 实现时引入 |
| newArchEnabled | false | true | 原生 | gradle.properties + Podfile + 原生代码 |

## 2. 四层依赖关系（互相阻塞）

```
RN 0.74→0.83  ──┐
React 18→19   ──┼─(强制)→ newArchEnabled=true ──→ 所有原生模块须新架构兼容
MMKV V2→V4   ──┤
quick-sqlite→nitro ─┘
```
RN 0.82 起旧架构被**永久禁用**，newArchEnabled 必须 true。新架构下 MMKV V4 / nitro-sqlite /
Reanimated / Skia 均提供 TurboModule/C++ 实现，旧架构原生模块会编译失败。

## 3. 调用点精确清点（已现测）

### 层 A — MMKV V2→V4（低风险，机械替换）
`new MMKV()` → `createMMKV()`，共 7 处 + 1 处测试 mock：
- `src/store/useSettingsStore.ts:50`
- `src/store/useReaderStore.ts:14`
- `src/store/useDictStore.ts:14`
- `src/store/useReadingOverrideStore.ts:31`
- `src/store/useAchievementStore.ts:20`
- `src/services/DeviceTierService.ts:390`
- `src/services/SearchService.ts:23`
- 测试 mock：`src/store/__tests__/useSettingsStore.test.ts:175`（`MMKV.prototype` 桩，V4 无 class，需改 mock）
- jestSetupFile.js 的 MMKV mock 需确认 V4 兼容

### 层 B — quick-sqlite → nitro-sqlite（高风险，同步→异步重写）
入口 `open({ name, location })` 同步句柄 + `db.execute(sql, params)` 同步执行：
- `src/services/StorageService.ts`：`import { open }` @23；`open({name:DB_NAME})` @64；`instance.execute(...)` **~40 处**（全同步）
- `src/services/UserBookService.ts`：`import { open }` @24；`open(...)` @273/287/307；`instance.execute(...)` **~50 处**
- `src/services/CanonService.ts`：`import { open }` @14；`open(...)` @99/113；`db.execute(...)` @144/160
- nitro-sqlite 异步 API：`prepareAsync` / `executeAsync` / `executeSync`（若提供）；FTS5 自定义编译需等价重验
- 测试：`src/__tests__/importShelfRegistrationGuard.test.ts:53` 的 `jest.mock('react-native-quick-sqlite')` 须改包名

> ⚠ 数据无损迁移：现有 `.sqlite` 库文件 V4/nitro 能否直接打开需实机验证；必要时导出重建。

### 层 C — Reanimated（零业务改动）
src 内 grep `react-native-reanimated` **零命中**（仅 gesture-handler / RN 间接依赖）。仅 package.json 提 3.10.1→≥3.19.1。

### 层 D — Skia（新增，simulation 实现时）
src 当前仅注释提及，未安装。实现 simulation 翻页时新增 `@shopify/react-native-skia` 并在 FlipMode 扩展 `simulation` 分支（RuntimeEffect 卷页）。本计划只含版本墙迁移，simulation 实现单列任务。

## 4. 执行步骤（每步带构建/真机门）

1. **工具链就绪**：装 NDK r27（Android 原生编译必需）、CocoaPods（iOS pod install）、pnpm（corepack 或 nvm pnpm）、确认网络。
2. **RN 升级脚手架**：`npx @react-native-community/cli@latest init` 差异合并 / 手动升 `react-native` + `@react-navigation` 系列 + 原生 `MainApplication`/`ReactActivityDelegate`/`Podfile` 至新架构模板。
3. **newArchEnabled=true**：`android/gradle.properties:39` 改 `true`；`ios/Podfile` 新架构开关开。
4. **层 C**：Reanimated 版本号提 ≥3.19.1，`pnpm install`。
5. **层 A**：MMKV 7 处 `createMMKV()` + 测试 mock 迁移，`pnpm install`，`tsc` + jest（MMKV mock 档）。
6. **层 B**：nitro-sqlite 替换 + 全同步 `execute`→异步；StorageService/UserBookService/CanonService 重写；FTS5 重验；jest（sqlite mock 档）。
7. **层 D（后续）**：加 Skia，实现 simulation 翻页。
8. **构建+真机门**：Android `assembleRelease` + iOS 模拟器/真机；逐项回归（含历史像素级真机结论全部作废需重测）。

## 5. 回滚

- 每步独立 commit；失败 `git revert` 单步。
- 整轮放弃：`git checkout master` + 删 `rn-upgrade-0.83`；`pre-rn-upgrade-0.74` 保底分支仍在。
- 数据回滚：升级前对 `.sqlite` / MMKV 文件做全量备份。

## 6. 本机工具链缺口（阻断项，2026-09-29 现测）

| 项 | 状态 | 影响 |
|---|---|---|
| NDK | **缺失**（`$ANDROID_HOME/ndk` 空） | Android 原生编译不可能 |
| CocoaPods | **缺失**（`pod` 不在 PATH） | iOS pod install 不可能 |
| pnpm | **不在 PATH**（managed node bin 无；npm install 因 EISDIR 失败） | 依赖安装受阻，需 corepack/nvm pnpm |
| newArchEnabled | false | 须 true，但无 NDK 无法验证新架构原生编译 |

**结论**：死代码删除已落地并提交（`6d1387e`）。四层迁移的代码落地（版本号/原生配置/MMKV/sqlite 改写）**无法在本环境 install/build/device 验证**——违反「无证据即回退」铁律，故不在此散落未验证改动。本计划文档即「启动」交付物；代码落地须在已配齐 NDK+CocoaPods+pnpm 的机器执行 §4，每步过构建/真机门后再提交。

## 7. 已完成（本会话）

- 死代码 `flingMath.ts` / `pageFlow.ts` 及其测试删除并提交 `6d1387e`（jest 94 套/1227 例全绿）。
- 四层调用点精确清点（§3）。
- 本执行计划。
