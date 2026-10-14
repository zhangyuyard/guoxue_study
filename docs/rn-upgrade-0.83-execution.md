# RN 0.74 → 0.83 四层迁移执行计划（启用 simulation 翻页前置）

> 分支：`rn-upgrade-0.83`（从 `945956e` 切出；保底分支 `pre-rn-upgrade-0.74` = `12237fb`）
> 目标：解锁 `@tangfeifan/react-native-reader`「仿真」模式（Skia 卷页）所需的最小版本墙——
> RN≥0.78 + React≥19 + 新架构 + Skia≥2.6.9 + Reanimated≥3.19.1。
> 状态（2026-09-29）：**代码落地进行中——JS 层（MMKV `createMMKV` + sqlite 经 `sqliteClient` 适配层 + `newArchEnabled=true` + gradle FTS5 配置）已改完；tsc/jest/原生构建因本机 sandbox 资源紧张暂未跑（见 §6），待恢复后过门。**

## 1. 目标版本矩阵

| 依赖 | 当前 | 目标 | 类型 | 代码改动面 |
|---|---|---|---|---|
| react-native | 0.74.7 | 0.83.x | 框架 | 原生脚手架 + 新架构 |
| react | 18.2.0 | 19.x | 框架 | 极少（StrictMode/ref 语义） |
| @types/react | 18.2 | 19.x | dev | 类型 |
| react-native-mmkv | 2.12.0 | 4.3.2 (NitroModules) | 数据 | `new MMKV()`→`createMMKV()`，7 处；**V4 为 Nitro（非 TurboModule），需 `react-native-nitro-modules` 运行时** |
| react-native-quick-sqlite | 8.2.7 | @op-engineering/op-sqlite 15.1.6 | 数据 | 经 `src/services/sqliteClient.ts` 适配层桥接，同步 `execute` 契约**零改写** |
| react-native-reanimated | 3.10.1 | ≥3.19.1 | 动画 | 仅版本号（src 零直接导入） |
| @shopify/react-native-skia | — | ≥2.6.9 | 新增 | simulation 实现时引入 |
| newArchEnabled | false | true | 原生 | gradle.properties + Podfile + 原生代码 |

## 2. 四层依赖关系（互相阻塞）

```
RN 0.74→0.83  ──┐
React 18→19   ──┼─(强制)→ newArchEnabled=true ──→ 所有原生模块须新架构兼容
MMKV V2→V4   ──┤
quick-sqlite→op-sqlite ─┘
```
RN 0.82 起旧架构被**永久禁用**，newArchEnabled 必须 true。新架构下 op-sqlite（TurboModule）/
Reanimated / Skia 提供 TurboModule/C++ 实现；MMKV V4 则是 **NitroModules**（mrousavy 的独立 C++ JSI
子系统，**非** RN TurboModule），需额外安装 `react-native-nitro-modules` 运行时且走 Nitro 自有 codegen。
旧架构原生模块会编译失败。

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

> ⚠ **层 A 新增阻断点（2026-09-30 静态自检发现）**：MMKV V4 是 **NitroModules**，其
> `peerDependencies` 含 `react-native-nitro-modules`，但本机 node_modules 与原 package.json **均未安装该包**
> （根因：前次 `npm install` 用了 `--legacy-peer-deps`，npm 不自动装 peer 依赖）。
> 缺它会致 iOS/Android 原生构建失败（Nitro codegen 与原生模块缺失）。
> **已修**：package.json 显式加 `"react-native-nitro-modules": "0.35.9"`（精确 pin，匹配 MMKV 4.3.2
> 构建时所用的 Nitro 版本，保证原生 ABI 一致；勿用最新 0.37.1，以免与 MMKV 4.3.2 预编译原生代码 ABI 错配）。
> 待 bash 恢复后 `npm install`（不再带 `--legacy-peer-deps`，或显式依赖已加故带也行）→ `pod install` → 原生构建。
> **回退方案**：若 Nitro 在 RN 0.83 原生编译/运行不兼容，降级 `react-native-mmkv` 到 `^3`（仍是 TurboModule、
> 仍提供 `createMMKV()`、零代码改动）。当前 7 处 `createMMKV()` + jest mock 对 V3/V4 通用。

### 层 B — quick-sqlite → op-sqlite（经适配层，同步契约零改写）
**关键决策修正（2026-09-29 落地）**：放弃 nitro-sqlite（异步 API 需重写 ~90 处同步 `execute`），改选
`@op-engineering/op-sqlite` 15.1.6（维护分支、新架构 TurboModule、预编译含 FTS5）。
但 op-sqlite v15 的 `execute` 已是 **async（返回 Promise）**，同步版 `executeSync` 返回 `QueryResult.rows`
（扁平数组），与旧 quick-sqlite 的「同步 `execute` + `{ rows: { _array } }`」**不兼容**。

为把重写爆炸面压到最小，新增薄适配层 **`src/services/sqliteClient.ts`** 作为唯一桥接点：
- 生产：`open(params)` 内部调 op-sqlite `open` + `executeSync`，把结果包成旧形
  `{ rows: { _array }, rowsAffected, insertId }`；并转发 `executeBatch`（op-sqlite 无 sync 版，用
  `executeSync` 循环实现）、`close`、`delete`（UserBookService 用到 `delete()`）。
- 5 个生产文件**只改 import 行**（`react-native-quick-sqlite` → `@/services/sqliteClient`），其余 SQL 零改动。
- 18 个测试文件**只改 mock/require 目标字符串**（`react-native-quick-sqlite` → `@/services/sqliteClient`），
  其内存适配器（含 better-sqlite3 真适配器）仍按旧 `{ rows: { _array } }` 形状返回，逻辑零改动。

入口与调用点（import 已改，调用体不变）：
- `src/services/StorageService.ts`：`import { open }`；`open({name:DB_NAME})`；`instance.execute(...)` ~40 处
- `src/services/UserBookService.ts`：`open(...)`；`instance.execute(...)` ~50 处；`db.delete()`
- `src/services/CanonService.ts`：`open(...)`；`db.execute(...)`；`db.close()`
- `src/services/dict/DictDatabase.ts`：`open(...)`；`executeBatch` + `db.close()`
- `src/services/SearchService.ts`：`open(...)`；`db.execute(...)`

> ⚠ 数据无损迁移：现有 `.sqlite` 库文件 op-sqlite 能否直接打开（加密/SQLCipher 兼容性）需实机验证；
> op-sqlite 默认 SQLite（非 SQLCipher）若与原库格式冲突，必要时导出重建。FTS5 由 op-sqlite 预编译自带，
> 已删除 gradle.properties 的 `quickSqliteFlags`（旧库专属）。
>
> ⚠ **路径锚定（2026-09-30 读 op-sqlite C++ 原生代码发现，已修）**：op-sqlite 的 `location` 基准目录
> 与原 quick-sqlite / 应用 `RNFS.DocumentDirectoryPath` **双平台都不一致**——
> - Android：`_base_path` = `context.getDatabasePath("").absolutePath`（`.../databases/`），应用用 `getFilesDir()`（`.../files/`）。
> - iOS：`_base_path` = `NSLibraryDirectory`（`.../Library/`），应用用 `NSDocumentDirectory`（`.../Documents/`）。
> 不修正则 op-sqlite 在错误目录新建空库、找不到旧数据 = **升级即丢数据**（StorageService 主库 / 词典 / Canon / user_books 全中招）。
> **已修**：`sqliteClient.ts` 的 `resolveLocation()` 把 `location` 一律锚定到 `RNFS.DocumentDirectoryPath`
> （无 location→DocumentDirectoryPath；相对→DocumentDirectoryPath/相对；绝对/`:memory:`→透传），最终文件 =
> `锚定目录/name`（op-sqlite 不加扩展名）。业务 SQL 与旧库文件名完全对齐。

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
8. **构建+真机门**：
   - **iOS 前置**：`rm ios/Podfile.lock`（锁了已移除的 `react-native-quick-sqlite`，不删则 `pod install` 找不到该 pod 报错）→ `PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH" pod install`（CocoaPods 1.11.3）。
   - `npm install`（拉取新加的 `react-native-nitro-modules`；勿带 `--legacy-peer-deps`）→ Android `assembleRelease` + iOS 模拟器/真机；逐项回归（含历史像素级真机结论全部作废需重测）。

## 5. 回滚

- 每步独立 commit；失败 `git revert` 单步。
- 整轮放弃：`git checkout master` + 删 `rn-upgrade-0.83`；`pre-rn-upgrade-0.74` 保底分支仍在。
- 数据回滚：升级前对 `.sqlite` / MMKV 文件做全量备份。

## 6. 本机工具链现状（2026-09-29 现测 + 已补齐）

| 项 | 状态 | 影响 |
|---|---|---|
| NDK r27 | **已下载**（`/tmp/ndk-r27.zip`，745MB），待解压到 `$ANDROID_HOME/ndk/27.0.12077973` 并验 `ndk-build` | Android 原生编译就绪前最后一步 |
| CocoaPods | **已装** 1.11.3（ruby 2.6 逐个 pin 兼容旧版绕过），`~/.gem/ruby/2.6.0/bin` 须加 PATH | iOS pod install 可执行 |
| 依赖安装 | **npm 已装**（715 包，`--ignore-scripts --legacy-peer-deps`，pnpm 因 CodeBuddy broker 拒绝 symlink + `_tmp_` 死锁放弃） | JS 依赖齐；**`--legacy-peer-deps` 致 peer 依赖不自动装（即 Nitro 缺失根因）**；原生 postinstall 待 `pod install`/`gradle` 跑 |
| react-native-nitro-modules | **锁文件已解析 `0.37.1`**（pnpm-lock.yaml；package.json 旧 pin `0.35.9` 与锁/MMKV 4.3.2 的 nitro peer 冲突，已回退 `0.37.1`）；node_modules 待 `pnpm install` 落地 | MMKV V4 的 Nitro 运行时，**必须 = MMKV 4.3.2 解析到的 `0.37.1`**（共享 Nitro C++ 运行时，版本错配 = 原生崩溃） |
| newArchEnabled | **true**（gradle.properties 已改） | 须 true；新架构原生编译待 NDK 解压后验证 |
| sandbox/bash | **资源紧张**：Bash 工具所有命令被 SIGTERM 杀（疑 NDK zip + node_modules 压内存），Write 偶发 backup 超时但可重跑 | tsc/jest/原生构建暂未跑，待环境恢复 |

**结论**：死代码删除已落地（`6d1387e`）。JS 层代码落地已完成（MMKV `createMMKV` ×7 + 测试 mock、
sqlite 经 `sqliteClient` 适配层 ×5 生产 + ×18 测试、newArchEnabled、gradle FTS5 配置）。
仅剩 tsc/jest 复绿与原生构建（NDK 解压 → `assembleRelease` / `pod install` + iOS 构建）待环境恢复后执行，
每步过门再提交。

## 7. 已完成（本会话）

- 死代码 `flingMath.ts` / `pageFlow.ts` 及其测试删除并提交 `6d1387e`（jest 94 套/1227 例全绿）。
- 四层调用点精确清点（§3）。
- 本执行计划（§1-§5）。
- **JS 层迁移改写（未提交，待 tsc/jest 验证）**：
  - 新增 `src/services/sqliteClient.ts` 适配层（op-sqlite → 旧同步契约）。
  - 5 生产文件 import 改走适配层；18 测试文件 mock/require 目标改 `@/services/sqliteClient`。
  - 7 处 MMKV `new MMKV()`→`createMMKV()` + jestSetupFile MMKV mock 加 `createMMKV`（保留 `MMKV` 类供 `MMKV.prototype` 打桩）。
  - `android/gradle.properties`：`newArchEnabled=true`，删除旧 `quickSqliteFlags`（op-sqlite 自带 FTS5）。
- **本会话新增修正（含静态自检发现的阻断点）**：
  - `ios/Podfile`：`use_react_native!` 补 `:new_arch_enabled => true`，与 Android `gradle.properties` 对齐（原缺失→iOS 新架构默认关，op-sqlite/MMKV V4 的 TurboModule/Nitro 在 iOS 不启用）。
  - `package.json`：显式加 `"react-native-nitro-modules"`（MMKV V4 的 Nitro 运行时 peer）。**版本以 pnpm-lock.yaml 解析为准 = `0.37.1`**（MMKV 4.3.2 的 nitro peer 经 `autoInstallPeers` 解析到 0.37.1；MMKV V4 与 nitro 共享 Nitro C++ 运行时必须同版本，故锁文件是 ABI 唯一真源。前轮 WebFetch 误判「MMKV 4.3.2 用 0.35.9 构建」曾 pin 0.35.9，已回退为 0.37.1 防原生 ABI 崩溃）。
  - 实测核实：op-sqlite 15.1.6 `DB` 实例确有 `delete/executeSync/close`（`QueryResult.rows` 扁平数组），适配层 `sqliteClient.ts` 类型与运行时调用 100% 吻合；`createMMKV()` 无参合法。
  - **路径锚定修复（关键数据迁移正确性）**：读 op-sqlite C++ 原生（`OPSqlite.cpp`/`OPSQLiteBridge.kt`/`OPSQLite.mm`）确认其 `location` 基准（`.../databases/` Android、`.../Library/` iOS）≠ 应用 `RNFS.DocumentDirectoryPath`（`.../files/`/`.../Documents/`）→ 不修正升级即丢数据。`sqliteClient.ts` 新增 `resolveLocation()` 把 `location` 锚定到 `RNFS.DocumentDirectoryPath`，双平台对齐 quick-sqlite 旧行为。
  - **已知风险（待建门验证）**：`react-native-fs@2.20.0` 在 newArchEnabled=true 下原生模块兼容性未验证（应用已广泛 import RNFS，属迁移既有问题，非本适配层引入）；若其旧架构原生不兼容新架构，需换 `@dr.pogodin/react-native-fs` 等新架构分支或剥离 RNFS。本适配层仅新增一处 RNFS import，与既有用法一致。

## 8. 恢复后执行顺序（待本机 bash/sandbox 恢复）

> sandbox 资源紧张时 Bash 工具被 SIGTERM 杀，以下步骤均待环境恢复后逐条执行、每步过门再继续。

1. **探活**：`echo alive` —— 确认 Bash 工具可用。
2. **拉依赖（pnpm 为本项目配置 PM：`.npmrc` 含 `node-linker=hoisted` + pnpm-lock.yaml 已含 nitro `0.37.1`）**：`pnpm install`（broker symlink 若再死锁则回退 `npm install`，但须先删/刷新 `package-lock.json` 避免旧 pin 残留）；勿带 `--legacy-peer-deps`。nitro-modules 已显式入 dependencies 且版本 = `0.37.1`，装后即与 MMKV 4.3.2 同 Nitro 运行时。
3. **JS 类型门**：`npx tsc --noEmit` —— 验证 MMKV/sqlite 适配层类型。
4. **单测门**：`npx jest` —— 96 套/1251 例（含 2 个 better-sqlite3 真适配测试）应全绿；验证 `sqliteClient` 适配层 + `createMMKV` mock 不破坏既有断言。
5. **Android 原生**：`unzip -q /tmp/ndk-r27.zip -d "$ANDROID_HOME/ndk/27.0.12077973" && ls "$ANDROID_HOME/ndk/27.0.12077973/ndk-build`（NDK 校验）→ `cd android && ./gradlew assembleRelease`。
6. **iOS 原生**：`rm ios/Podfile.lock` → `PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH" pod install`（CocoaPods 1.11.3）→ Xcode 构建 / 模拟器跑。
   - **锁文件状态（清理结论）**：`ios/Podfile.lock` 是唯一需删的锁（锁了已移除的 `react-native-quick-sqlite`，`pod install` 自动重解，无害）；`pnpm-lock.yaml` + `package-lock.json` 均为合法依赖锁（项目以 pnpm 为配置 PM，见 `.npmrc`），**非残留，勿删**。
7. **真机数据迁移门（最高优先）**：装升级包，确认 StorageService 主库 / 词典 / Canon / user_books 旧数据可被 op-sqlite 在 `RNFS.DocumentDirectoryPath` 锚定目录读到（路径锚定修复的实机证据）；历史像素级真机结论全部作废需重测。
8. **分步提交**：MMKV 层 / sqlite 适配层(+路径锚定) / Nitro 依赖 / gradle+Podfile 新架构 / 文档，各独立 commit。
