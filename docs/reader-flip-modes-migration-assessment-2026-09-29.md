# react-native-reader 多模式翻页迁移评估

> 目标：实现 `@tangfeifan/react-native-reader` 的五种翻页模式（上下/覆盖/平移/仿真/无动画）。  
> 结论先行：**「仿真」模式依赖 Skia（需 RN ≥0.78 + 新架构 + React 19），触发四层叠加迁移。**  
> 本文档评估这四层迁移的真实代价、步骤、依赖矩阵与回滚方案，供评审决策。  
> 生成日期：2026-09-29。基线：`12237fb`（兜底分支 `pre-rn-upgrade-0.74` 已建）。

---

## 1. 五种模式的落地边界（先厘清「哪些需要迁移」）

| 模式  | 英文别名         | 动画语义                  | 实现依赖                                       | 当前技术栈能否落地             |
| --- | ------------ | --------------------- | ------------------------------------------ | --------------------- |
| 上下  | `vertical`   | 连续纵向滚动                | 原生 FlatList                                | ✅ 已实现（= 现有 scroll 模式） |
| 覆盖  | `cover`      | 当前页横向覆盖切换             | RN `Animated`                              | ✅ 可落地（零新依赖）           |
| 平移  | `slide`      | 前后页面同步平移              | RN `Animated`                              | ✅ 可落地（零新依赖）           |
| 无动画 | `none`       | 点击直接切页                | 无                                          | ✅ 可落地（零新依赖）           |
| 仿真  | `simulation` | Skia RuntimeEffect 卷页 | Skia + Gesture Handler + Reanimated（UI 线程） | ❌ **需四层迁移**           |

**关键事实**：五种里四种**不需要迁移**，只有「仿真」需要。而「仿真」的依赖链是：

```
仿真翻页 → @shopify/react-native-skia ≥2.6.9
         → Skia 要求 RN ≥0.78 + React 19 + Reanimated ≥3.19.1
         → RN 0.78+ 强制新架构（0.82 起旧架构永久禁用，无法回退）
         → 新架构迫使 MMKV V2→V4、quick-sqlite → nitro 方案
```

---

## 2. 四层迁移叠加（风险指数级的原因）

| 层                  | 从            | 到                 | 破坏性                                                                     | 独立风险                      |
| ------------------ | ------------ | ----------------- | ----------------------------------------------------------------------- | ------------------------- |
| **① RN**           | 0.74.7       | 0.83.x            | 跨 9 个小版本；旧架构强制关                                                         | gradle/kotlin/ndk/AGP 全升级 |
| **② React**        | 18.2.0       | 19.x              | 主版本                                                                     | 全依赖 peer 重验               |
| **③ MMKV**         | ^2.12.0 (V2) | V4（Nitro Module）  | API 破坏（`new MMKV()` → `createMMKV()` + 新增 `react-native-nitro-modules`） | 持久化层重写 + 数据兼容             |
| **④ quick-sqlite** | ^8.2.7       | nitro-sqlite 或新版本 | 自定义 `quickSqliteFlags`（FTS5）需重验                                         | FTS 全文搜索回归                |

**叠加效应**：四层**互相阻塞**——MMKV 不升级 RN 升不上去；RN 不升 Skia 装不了；Skia 装不了仿真做不了。任何一层卡在 native 编译错误或真机白屏，整个迁移停滞。

---

## 3. 工具链差距清单（本机实测，2026-09-29）

| 工具             | 现状                                            | RN 0.83 要求            | 结论          |
| -------------- | --------------------------------------------- | --------------------- | ----------- |
| Node           | 22.22.2                                       | 20/22                 | ✅ 满足        |
| JDK            | 17.0.9-tem（sdkman，current）                    | JDK 17                | ✅ 满足        |
| Xcode          | 26.6 (17F113)                                 | 16+                   | ✅ 满足        |
| Android SDK    | platform **android-35** 已装、build-tools 35.0.0 | compileSdk 35         | ✅ 满足        |
| **NDK**        | **❌ 无 ndk 目录**                                | NDK 26+（新架构编译 C++）    | ❌ **需安装**   |
| **CocoaPods**  | **❌ 未装**                                      | iOS pod install       | ❌ 需装（仅 iOS） |
| gradle wrapper | 8.6                                           | 8.x（AGP 8.x，可能需 8.7+） | ⚠ 可能需升      |

**现状小结**：本机工具链**大部分已就绪**（JDK 17 / Xcode 26 / Android 35 都齐）。真正缺口只有 **NDK**（Android 新架构硬性要求）和 **CocoaPods**（仅 iOS）。这与最初「工具链全要重来」的印象不同——**迁移的瓶颈不在工具链，而在三个原生库的兼容性重验**。

---

## 4. 依赖升级矩阵（待验证，非最终值）

| 依赖                             | 现版本     | 目标版本         | 风险点                       |
| ------------------------------ | ------- | ------------ | ------------------------- |
| react                          | ^18.2.0 | 19.x         | 全依赖 peer 重验               |
| react-native                   | 0.74.7  | 0.83.x       | native 模板重生成              |
| @types/react                   | ^18.2.0 | ^19          | 类型破坏性变更                   |
| @react-native/metro-config     | ^0.74.0 | 随 RN         | —                         |
| react-native-mmkv              | ^2.12.0 | ^4.x         | **API 破坏**，+nitro-modules |
| react-native-quick-sqlite      | ^8.2.7  | nitro-sqlite | **FTS5 自定义编译重验**          |
| react-native-reanimated        | 3.10.1  | ≥3.19.1      | worklets 插件配置             |
| react-native-gesture-handler   | 2.16.2  | ≥2.30        | —                         |
| @shopify/react-native-skia     | 无       | ≥2.6.9       | **新增重量级 native 依赖**       |
| react-native-screens           | ^3.29.0 | 最新           | 新架构兼容                     |
| react-native-safe-area-context | ^4.9.0  | 最新           | 新架构兼容                     |
| @gorhom/bottom-sheet           | ^4.6.0  | 最新           | reanimated 依赖联动           |
| @notifee/react-native          | 9.1.8   | 新架构兼容版       | 待确认                       |

**待查证的三个原生库新架构兼容性**（迁移前必须逐个确认，这是最大不确定源）：

1. `react-native-mmkv` V4 对现有 persist 数据的读取兼容（V2 → V4 数据是否可无缝读）；
2. `react-native-quick-sqlite` 的 FTS5 自定义编译（`quickSqliteFlags`）在新架构/新库下的等价方案；
3. `@notifee/react-native` 的新架构版本。

---

## 5. 分阶段迁移计划（每阶段可验证、可回滚）

> 原则：**每次只动一层，构建 + 真机验证通过后再进下一层**。禁止一次改多层。

### 阶段 0：前置准备（可独立完成，零风险）

- [ ] 安装 Android NDK 26+（`sdkmanager "ndk;26.x"` 或升级现 ndkVersion）
- [ ] 安装 CocoaPods（仅 iOS）
- [ ] 全量备份：确认兜底分支 `pre-rn-upgrade-0.74` 在 `12237fb`
- [ ] 记录当前 APK 产物基线（可复现的 build 命令 + sha256）

### 阶段 1：RN 0.74 → 0.83（最大风险，单独一个 PR）

- [ ] 用 `@react-native-community/cli` 的 upgrade 或 `npx @rnx-kit/align-deps` 对齐版本
- [ ] 重生成 android/ios 模板（对比 0.83 官方模板 diff）
- [ ] gradle/kotlin/AGP/compileSdk 升级到 0.83 要求
- [ ] `newArchEnabled` 从 false → true（0.82+ 强制）
- [ ] **验证**：debug APK 构建成功 + 真机冷启动无白屏

### 阶段 2：React 18 → 19 + 依赖 peer 对齐

- [ ] `@types/react` 升 ^19，跑 `tsc --noEmit` 修类型错误
- [ ] 逐个验证 zustand/navigation/gesture-handler/reanimated 的 React 19 兼容
- [ ] **验证**：全量 jest 通过 + 真机核心页面（阅读/设置/背诵）不崩

### 阶段 3：MMKV V2 → V4（数据持久化重写，高风险）

- [ ] `new MMKV()` → `createMMKV()` + 加 `react-native-nitro-modules`
- [ ] zustand persist adapter 适配
- [ ] **验证**：旧数据（阅读进度/设置/划线）升级后仍可读（**数据兼容是核心验收项**）

### 阶段 4：quick-sqlite → nitro-sqlite（FTS 回归，高风险）

- [ ] 迁移 SQLite 绑定 + FTS5 编译 flag 等价方案
- [ ] **验证**：全文搜索（FTS）功能回归

### 阶段 5：引入 react-native-reader + Skia（最终目标）

- [ ] 装 `@tangfeifan/react-native-reader` + Skia + 升级 reanimated/gesture-handler
- [ ] `GestureHandlerRootView` 包裹 + babel worklets 插件配置
- [ ] 实现五模式翻页 UI 切换
- [ ] **验证**：真机五模式逐一验收（仿真模式需 logcat 查 `[Reader][Simulation]`）

---

## 6. 回滚方案

- **兜底分支**：`pre-rn-upgrade-0.74`（=`12237fb`）已建，任何阶段失败可 `git reset --hard` 回到。
- **每阶段独立提交**：禁止把多层改动压进一个 commit，保证可 `git revert` 单层。
- **产物备份**：阶段 0 记录基线 APK sha256，迁移后对比包体/启动耗时。
- **数据兜底**：MMKV/quick-sqlite 迁移前导出持久化数据快照，验证升级后数据可读才放行。

---

## 7. 风险与建议

**最大不确定源**（不是工具链，是原生库兼容性）：

1. MMKV V2→V4 的**数据迁移**是否无损（阅读进度/设置/划线全依赖它）；
2. quick-sqlite 的 **FTS5 自定义编译**在新方案下的等价性（全文搜索是核心功能）；
3. 新架构下自绘组件（LineRow/PinyinText）的渲染行为是否变化（历史所有「像素级真机验证」结论作废，需重测）。

**建议的降级路径（若不想冒四层迁移的险）**：

- 用现有 RN 0.74 的 `Animated` 实现 **覆盖/平移/无动画** 三种（零迁移），上下已有；
- 「仿真」模式用「覆盖」或「无动画」降级，等 RN 升级时机成熟再补真仿真。
- 这样能**今天就交付四模式翻页的完整 UI**，把「仿真」作为独立后置项。

---

## 8. 决策点（待确认）

- [ ] 是否接受「仿真」模式延后（其余四模式零迁移可落地）？
- [x] 若坚持做仿真，是否接受阶段 3/4 的数据迁移风险（MMKV/quick-sqlite 是核心持久化层）？
- [ ] 迁移是否只做 Android（本项目以 Android 真机为主），iOS 暂缓（可省 CocoaPods/新架构 iOS 验证）？
